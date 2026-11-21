// 把 /api/* 全部接进浏览器内引擎。
//
// 必须在 app.js 之前安装：页面里的 fetch(api('/api/home/state')) 会走进来，
// 拿到一份和服务器版同构的 JSON，于是表现层一行都不用改。
//
// 这里同时导出 handleApi()：双人模式下房主要在自己的页面里"扮演服务器"，
// 客人那边把请求通过 DataChannel 发过来，房主用同一个分发器处理。
// 两条路径共用一份实现，所以单机、房主、客人的行为不会分叉。
import {
  bootEngine, homeSnapshot, act, gardenSnapshot, gardenAct, gardenControl, persist
} from '../engine/home-engine.js';
import { store } from '../engine/storage.js';
import { profile, noteAction, noteGarden, roomViewFor } from './profile.js';
import { localReply } from './chat.js';
// 通道语义与网页版共用同一份（src/room-channel.js 刻意不 import node:*，
// 所以 esbuild 能把它整块打进单机包，两边算出来的会话键完全一致）。
import {
  GROUP_CONTEXT_LINES,
  PEER_LOG_MAX,
  channelOf,
  createRingLog,
  formatSpeakerLine,
  normalizePeerId,
  normalizePid,
  peerThreadKey,
  residentName,
  resolveGroupSpeaker,
  sanitizeKeyForFile
} from '../../src/room-channel.js';

const encoder = new TextEncoder();

// 单机包的环形日志：玩家互通按串分，群聊一条。
// 落盘借 storage.js 的虚拟文件表（localStorage 后端），换设备导出存档也能带走。
const peerLogs = new Map();
function peerLogFor(key) {
  const k = String(key || 'peer:room');
  let entry = peerLogs.get(k);
  if (!entry) {
    const log = createRingLog(PEER_LOG_MAX);
    const file = `room-peer-log-${sanitizeKeyForFile(k)}.json`;
    try {
      const raw = store.read(file);
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved?.messages)) log.hydrate(saved.messages);
    } catch { /* 没有存档就从空开始 */ }
    entry = { key: k, file, log, save: () => {
      try { store.write(file, JSON.stringify({ messages: log.list() })); } catch { /* 写不进去不影响聊 */ }
    } };
    peerLogs.set(k, entry);
  }
  return entry;
}

const groupLog = createRingLog();
function saveGroupLog() {
  try { store.write('room-group-log.json', JSON.stringify({ messages: groupLog.list() })); } catch { /* 忽略 */ }
}
// 启动时恢复群聊现场：刷新页面后她还能接上刚才那几句。
(function hydrateGroupLog() {
  try {
    const raw = store.read('room-group-log.json');
    const saved = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved?.messages)) groupLog.hydrate(saved.messages);
  } catch { /* 没有存档就从空开始 */ }
})();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function pathOf(input) {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  try {
    const u = new URL(raw, 'http://game.local');
    return u.pathname.replace(/^\/proxy\/\d+/, '') || '/';
  } catch {
    return String(raw);
  }
}

async function bodyOf(init) {
  const body = init?.body;
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (body instanceof FormData) return Object.fromEntries(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try { return JSON.parse(new TextDecoder().decode(body)); } catch { return {}; }
  }
  return {};
}

/**
 * 取 URL 上的查询参数。
 *
 * pathOf() 只返回 pathname，GET 的 ?pid=…&since=… 会丢；而房主/客人的通道只传
 * (path, method, body) 三元组，没法再带一份 query。所以统一把 query 摊进 body：
 * 服务端那侧的处理器本来也只用 `body.xxx` 读参数，两边写法因此一致。
 */
function queryOf(input) {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  try {
    const u = new URL(raw, 'http://game.local');
    const out = {};
    for (const [k, v] of u.searchParams) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// 双人模式下房主额外注入的东西：在线玩家表、动态流、两人之间的聊天。
// 由 net-duo.js 用 setDuoState() 塞进来；单机模式下是 null，行为与原来一致。
let duoState = null;

/** @param {{players:Function,feed:Function,chat:Function}} next */
export function setDuoState(next) { duoState = next; }

/**
 * 处理一条 /api/* 请求，返回纯数据。
 * 单机版：直接被 installNetShim 的 fetch 包装调用。
 * 双人版：房主在 DataChannel 上收到请求后调用它，把结果回给客人。
 *
 * @returns {Promise<{status:number, data:any}>}
 */
export async function handleApi(path, method = 'GET', body = {}) {
  const m = String(method || 'GET').toUpperCase();
  switch (path) {
    case '/api/home/state': {
      const view = homeSnapshot();
      const base = { ...view, room: roomViewFor(), memory: { topics: [] } };
      if (duoState) base.net = duoState.snapshot();
      return { status: 200, data: base };
    }
    case '/api/home/act': {
      const result = act(body);
      // claim（小柜子兑换）不是「对角色做了一个动作」：它花的是同行点数，
      // 记进今日任务/玩家动态会变成一条「做了点什么」的噪音，跳过。
      if (result.ok && result.changed && body.action !== 'claim') {
        try { noteAction(body.action, body, result, duoState ? body.by : ''); } catch { /* 统计失败不影响游玩 */ }
        if (duoState) duoState.noteAct(body, result);
      }
      return { status: 200, data: { ...result, room: roomViewFor() } };
    }
    case '/api/garden/state':
      return { status: 200, data: gardenSnapshot() };
    case '/api/garden/act': {
      const result = gardenAct(body);
      if (result.ok) { try { noteGarden(body.type, body, result, duoState ? body.by : ''); } catch { /* 忽略 */ } }
      return { status: 200, data: result };
    }
    case '/api/garden/control': {
      const result = gardenControl(body);
      if (result.ok) { try { noteGarden(body.type === 'auto' ? 'auto' : body.type, body, result); } catch { /* 忽略 */ } }
      return { status: 200, data: result };
    }
    case '/api/room/chat': {
      // 四种通道与网页版同构：私聊 / 群聊 / 玩家互通。单机版没有模型，
      // 玩家互通只进环形日志（不产生 AI 回复），群聊仍走规则引擎但会区分两位住民。
      const ch = channelOf({
        target: body.target,
        channel: body.channel,
        pid: body.pid,
        // peer 通道必须带对方 pid：漏了它 ch.peer 为空，会被判成"还没连上对方"直接 400。
        peer: body.peer,
        who: body.who
      });
      if (ch.kind === 'peer') {
        const key = ch.peer ? ch.key : '';
        if (!key) return { status: 400, data: { ok: false, error: '还没连上对方，消息没发出去' } };
        const thread = peerLogFor(key);
        const message = thread.log.push({
          pid: ch.pid,
          name: String(body.name || '').slice(0, 24),
          who: 'player',
          kind: 'peer',
          text: String(body.text || '')
        });
        thread.save();
        return { status: 200, data: { ok: true, channel: 'peer', message, key } };
      }
      await new Promise((r) => setTimeout(r, 420 + Math.random() * 520));
      // 群聊：玩家这句先入现场，再让规则引擎回；回复也写回去，下一位才知道上一句是谁说的。
      if (ch.kind === 'group') {
        groupLog.push({
          pid: ch.pid,
          name: String(body.name || '').slice(0, 24),
          who: 'player',
          kind: 'group',
          text: String(body.text || '')
        });
        // 这一轮谁开口：@ 优先 → 显式 who → 与上一位住民交替。
        // 规则引擎只出一句，另一位不抢话，避免"两个声音同时答同一个问题"。
        const speaker = resolveGroupSpeaker({ text: body.text, who: body.who, log: groupLog.list() });
        const reply = localReply(body.text, { channel: 'group', pid: ch.pid, who: speaker }, homeSnapshot(), {
          log: groupLog.list()
        });
        if (reply) {
          groupLog.push({ pid: 'resident', name: residentName(speaker), who: speaker, kind: 'group', text: reply });
        }
        saveGroupLog();
        return { status: 200, data: { ok: true, reply, target: speaker, channel: 'group', who: speaker, pid: ch.pid } };
      }
      return { status: 200, data: { ok: true, reply: localReply(body.text, ch, homeSnapshot()), target: ch.kind, channel: ch.kind, who: ch.kind, pid: ch.pid } };
    }
    case '/api/room/chat/peer': {
      // 读历史：/api/room/chat 只负责写，这里只负责读（刷新后补上下文用）。
      const pid = normalizePid(body.pid);
      const peerId = normalizePeerId(body.peer);
      const key = peerThreadKey(pid, peerId);
      const thread = peerLogFor(key);
      const since = Number(body.since || 0) || 0;
      const messages = since > 0 ? thread.log.since(since) : thread.log.tail(PEER_LOG_MAX);
      return { status: 200, data: { ok: true, channel: 'peer', key, you: pid, peer: peerId, messages } };
    }
    case '/api/room/chat/group': {
      const pid = normalizePid(body.pid);
      const since = Number(body.since || 0) || 0;
      const raw = since > 0 ? groupLog.since(since) : groupLog.tail(GROUP_CONTEXT_LINES * 2);
      return {
        status: 200,
        data: {
          ok: true,
          channel: 'group',
          you: pid,
          nextSince: raw.length ? raw[raw.length - 1].seq : since,
          messages: raw.map((m) => ({ ...m, line: formatSpeakerLine(m, { viewPid: pid }) }))
        }
      };
    }
    case '/api/tv/opinion':
      await new Promise((r) => setTimeout(r, 500));
      return { status: 200, data: { ok: true, reply: '她凑近看了一眼：这画面挺有意思的，你从哪找来的？' } };
    case '/api/room/state':
      return { status: 200, data: { ok: true, room: roomViewFor() } };
    case '/api/room/act':
      return { status: 200, data: { ok: true, changed: false, room: roomViewFor() } };
    case '/api/room/inspect':
      return { status: 200, data: { ok: true, items: [] } };

    // ── 双人专用：在线名单 / 动态 / 两人聊天 / 进度统计 ──
    case '/api/net/state':
      return { status: 200, data: { ok: true, ...(duoState ? duoState.snapshot() : { players: [], feed: [], you: '' }) } };
    case '/api/net/presence':
      if (duoState) duoState.touch(body.pid, body.name);
      return { status: 200, data: { ok: true, ...(duoState ? duoState.snapshot() : { players: [], feed: [], you: '' }) } };
    case '/api/net/chat':
      return { status: 200, data: duoState ? duoState.chat(m, body) : { ok: true, messages: [] } };
    case '/api/net/stats': {
      const lv = profile.level();
      return {
        status: 200,
        data: {
          ok: true,
          level: { level: lv.level, into: lv.into, need: lv.need },
          stage: lv.stage,
          tasks: profile.tasks(),
          achievements: profile.achievements(),
          affection: profile.affection(),
          streak: profile.streak(),
          players: profile.players()
        }
      };
    }

    default:
      return { status: 404, data: { ok: false, error: `单机版没有这个接口：${path}` } };
  }
}

let installed = false;
let originalFetch = null;

export function installNetShim() {
  if (installed) return;
  installed = true;
  originalFetch = globalThis.fetch.bind(globalThis);
  bootEngine();

  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if (!path.startsWith('/api/')) return originalFetch(input, init);
    const method = String(init?.method || 'GET').toUpperCase();
    // GET 的查询参数摊进 body：/api/room/chat/peer?pid=…&since=… 这类端点要用。
    const body = { ...queryOf(input), ...(await bodyOf(init)) };
    const { status, data } = await handleApi(path, method, body);
    return json(data, status);
  };

  // 关掉页面时把状态落盘，离线结算靠这个时间戳。
  addEventListener('pagehide', () => { try { persist(); profile.markSeen(); } catch { /* 忽略 */ } });
  addEventListener('beforeunload', () => { try { persist(); profile.markSeen(); } catch { /* 忽略 */ } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { try { persist(); profile.markSeen(); } catch { /* 忽略 */ } }
  });
  setInterval(() => { try { profile.markSeen(); } catch { /* 忽略 */ } }, 30_000);

  globalThis.__gameStore = store;
  globalThis.__gameProfile = profile;
  globalThis.__gameApi = { homeSnapshot, act, gardenSnapshot, gardenAct, gardenControl, persist };
  return globalThis.fetch;
}

export { encoder, pathOf, queryOf, bodyOf, json };
