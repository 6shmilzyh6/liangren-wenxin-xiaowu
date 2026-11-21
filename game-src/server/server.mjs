// 双人联机服务器：一间屋子，两个玩家，一个唯一的状态源。
//
// 和单机版的关系：
//   · 行为层完全相同 —— 复用 src/home-state.js、src/garden-autonomy.js、
//     src/garden-store.js，只是把存档根目录指到 data/ 下；
//   · 养成层复用 game-src/shell/profile.js 的 createProfile，两个玩家共享同一份；
//   · 前端复用同一份 game/（打包产物），页面本身分不清单机还是联机。
//
// 联机额外提供的东西：
//   · GET  /api/net/presence  谁在线、谁在做什么（另一位玩家有独立的立绘）
//   · POST /api/net/act       玩家的动作（摸头/投喂…），带 by 名字，两人事件流合流
//   · POST /api/net/chat      玩家之间说话（不入 game 引擎，纯 relay + 落地）
//
// 启动：
//   node game-src/server/server.mjs            默认 8788
//   PORT=9000 node game-src/server/server.mjs
//
// 别人怎么进来：
//   本机 http://localhost:8788/
//   同局域网 http://<本机内网IP>:8788/
//   公网需要自己把端口映射出去（或用内网穿透），服务器只认 HTTP，不处理 TLS。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { createDiskStore } from './disk-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 这套逻辑要同时吃得下三种布局：
//   · 源码布局   <项目>/game-src/server/server.mjs   → 页面在 <项目>/game/，存档在 <项目>/game-src/server/data/
//   · 分享包布局 <分享包>/server.mjs                 → 页面就在 <分享包>/，存档在 <分享包>/data/
//   · 只有交付包 <项目>/game-src/server/server.mjs   → 页面在 <项目>/dist/大肥鱼书房/（game/ 被清掉时）
// 写死相对路径只对第一种成立，所以这里改成"找路标文件"。
function findGameDir(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;          // 分享包：server.mjs 和 index.html 同级
    if (existsSync(path.join(dir, 'game', 'index.html'))) return path.join(dir, 'game'); // 源码布局
    const packed = path.join(dir, 'dist', '大肥鱼书房', 'index.html');  // 只留了交付包
    if (existsSync(packed)) return path.join(dir, 'dist', '大肥鱼书房');
    const up = path.resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return path.join(path.resolve(start, '..', '..'), 'game');
}

const GAME_DIR = process.env.DAFIYU_ROOT
  ? path.resolve(process.env.DAFIYU_ROOT)
  : findGameDir(HERE);

// 存档目录：分享包默认 <包>/data，源码布局默认 game-src/server/data。
// DAFIYU_DATA_DIR 让验收脚本能指到临时目录，不碰正式存档。
//
// 关键：只在「这个文件自己就躺在 game-src/server/ 里」时才认源码布局。
// 原来是从 HERE 一路往上找 <dir>/game-src/server/server.mjs，于是分享包只要
// 恰好解在源码树里（dist/大肥鱼书房/ 就是这种），就会一路找到项目根，
// 把存档写进 game-src/server/data —— 交付包里永远没有 data/，玩家那边也分不清
// 进度到底存在哪。改成盯 HERE 自己的路径后缀，两件事一起解决。
function findSourceRoot(start) {
  const norm = path.resolve(start).replace(/\\/g, '/');
  if (!norm.endsWith('game-src/server')) return null;
  const up = path.resolve(start, '..', '..');
  return existsSync(path.join(up, 'game-src', 'server', 'server.mjs')) ? up : null;
}
const SOURCE_ROOT = findSourceRoot(HERE);

const DATA_DIR = process.env.DAFIYU_DATA_DIR
  ? path.resolve(process.env.DAFIYU_DATA_DIR)
  : (SOURCE_ROOT
    ? path.join(SOURCE_ROOT, 'game-src', 'server', 'data')
    : path.join(GAME_DIR, 'data'));

const PORT = Number(process.env.PORT) || 8788;

// ── 状态源：服务器目录下的真实文件 ───────────────────────────────────────
const disk = createDiskStore(DATA_DIR);

// 引擎与养成层都要在 disk 就位之后再 import（它们建实例时会读存档）。
const { configure, homeSnapshot, act: homeAct, gardenSnapshot, gardenAct, gardenControl, persist, bootEngine } =
  await import('../engine/home-engine.js');
const { createProfile } = await import('../shell/profile.js');
const { localReply } = await import('../shell/chat.js');

configure({
  homeFile: path.join(DATA_DIR, 'home.json'),
  gardenFile: path.join(DATA_DIR, 'garden.json'),
  env: { unread: 0, gateway: true, mode: 'online-duo' }
});

// home-engine 内部用的是 src/home-state.js 的真实 fs；存档根目录要对齐到 DATA_DIR。
// 它读写的文件名是 state/home.json 这种，所以这里把 DATA_DIR 当作"工作目录"的替身：
// 直接让 home-engine 用 disk 提供的同一套文件 —— 改 configure 传绝对路径即可。
// （configure 已把 HOME_FILE/GARDEN_FILE 指到 DATA_DIR 下的文件。）

const profileApi = createProfile(disk, {
  followTarget: () => 'her'
});
const { profile, noteAction, noteGarden, roomViewFor } = profileApi;

bootEngine();

// ── 在线玩家 ──────────────────────────────────────────────────────────────
// 内存里维护，不落盘：谁在线是"此刻的事实"，重启服务器就该清空。
// pid 由浏览器生成后存在 localStorage，换标签页还是同一个人。
const players = new Map();
const PRESENCE_TTL = 22_000;

// 玩家动态流：谁做了什么。
//
// 为什么不复用 home 的 eventLog：原版里 pet/play/talk 这类动作的 event 是
// 直接放在 act 响应里返回给页面的，不进 eventLog（eventLog 记的是"她做了什么"，
// 不是"你做了什么"）。而且 eventLog 里 pet 的文案是"小朱摸了摸你的头"——
// 那是给她看的话。这里要的是给对方看的第三人称动态，所以单独一条流。
const feed = [];
const FEED_MAX = 120;

function pushFeed(entry) {
  feed.push(entry);
  if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
}

function touchPlayer(pid, patch = {}) {
  const now = Date.now();
  const prev = players.get(pid) || { pid, name: '小屋访客', at: 0, joinedAt: now, acts: 0, room: '', activity: '' };
  const next = { ...prev, ...patch, pid, at: now };
  players.set(pid, next);
  return next;
}

function livePlayers() {
  const now = Date.now();
  const out = [];
  for (const [pid, p] of players) {
    if (now - p.at > PRESENCE_TTL) { players.delete(pid); continue; }
    out.push({
      pid, name: p.name, acts: p.acts, room: p.room, activity: p.activity,
      onlineFor: now - p.joinedAt, lastAct: p.lastAct || null
    });
  }
  return out;
}

/** 最近 30 条玩家动态（"谁做了什么"，给对方看的）。 */
function recentFeed() {
  return feed.slice(-30);
}

// 动作 → 第三人称的一句话。刻意和 home-state 里的文案区分：
// 那边是"她视角"（小朱摸了摸你的头），这里是给对方读的（小朱摸了摸小蓝鱼的头）。
const ACTOR_VERB = {
  pet: ['摸了摸', '的头'],
  poke: ['戳了戳', ''],
  feed: ['喂了', '一块小点心'],
  water: ['给', '倒了杯水'],
  play: ['陪', '玩了一会儿'],
  talk: ['跟', '说了一句话'],
  sleep: ['哄', '睡了'],
  wake: ['叫醒了', ''],
  lamp: ['帮', '关了灯'],
  heal: ['照顾了', ''],
  visit: ['去看望了', ''],
  meet: ['让两位见了面', ''],
  command: ['指挥', '动了动'],
  go: ['让', '换了个地方'],
  place: ['把', '挪到了别处'],
  sick: ['注意到', '不太舒服']
};

function actorLine(name, action, target, result) {
  const who = String(name || '有人').slice(0, 24);
  const pet = String(target || 'her') === 'claude' ? '小公主' : '小蓝鱼';
  const pair = ACTOR_VERB[String(action || '')];
  if (!pair) return `${who}在屋里转了一圈`;
  // 有的动作不需要宾语（哄睡了 / 叫醒了），这里按词表拼。
  const [verb, tail] = pair;
  if (tail === '一块小点心') return `${who}喂了${pet}${tail}`;
  if (!tail) return `${who}${verb}${pet}`;
  return `${who}${verb}${pet}${tail}`;
}

// ── 共享聊天 ──────────────────────────────────────────────────────────────
// 两个人之间的对话，和小蓝鱼/小公主的对话是两条线。
// 只保留最近 200 条，落一份到 data/chat.json，重启不丢。
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const chatLog = (() => {
  try { return JSON.parse(disk.read(CHAT_FILE) || '[]').slice(-200); } catch { return []; }
})();
let chatSaveTimer = 0;
function pushChat(entry) {
  chatLog.push(entry);
  if (chatLog.length > 200) chatLog.splice(0, chatLog.length - 200);
  if (!chatSaveTimer) {
    chatSaveTimer = setTimeout(() => {
      chatSaveTimer = 0;
      try { disk.write(CHAT_FILE, JSON.stringify(chatLog)); } catch { /* 忽略 */ }
    }, 500);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm',
  '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8'
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(GAME_DIR, rel);
  // 路径穿越：解析后必须仍在 GAME_DIR 里。
  if (!file.startsWith(GAME_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      // 立绘和模型是死资源，可以强缓存；html/js 每次都验一下，免得改了看不到。
      'cache-control': /\.(webm|png|glb|wav)$/i.test(file) ? 'public, max-age=604800' : 'no-cache'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/^\/proxy\/\d+/, '');
  const method = req.method || 'GET';

  try {
    // ── 页面与素材 ──
    if (!p.startsWith('/api/')) { await serveStatic(req, res, p); return; }

    // ── 房间事实层（和单机版同构，只是状态源在服务器） ──
    if (p === '/api/home/state' && method === 'GET') {
      const pid = url.searchParams.get('pid') || '';
      const name = url.searchParams.get('name') || '';
      if (pid) {
        const snap = homeSnapshot();
        touchPlayer(pid, { name: name || '小屋访客', room: snap.her?.roomName || '', activity: snap.her?.activity || '' });
      }
      const view = homeSnapshot();
      return json(res, {
        ...view,
        room: roomViewFor(),
        memory: { topics: [] },
        // 联机专属：谁在线、谁刚刚做了什么
        net: { players: livePlayers(), you: pid, feed: recentFeed() }
      });
    }

    if (p === '/api/home/act' && method === 'POST') {
      const body = await readBody(req);
      const pid = String(body.pid || '');
      const name = String(body.by || '小屋访客').slice(0, 24);
      if (pid) touchPlayer(pid, { name, activity: body.action || '' });
      const result = homeAct(body);
      if (result.ok && result.changed && String(body.action || '') !== 'claim') {
        try { noteAction(body.action, body, result, name); } catch { /* 统计失败不影响游玩 */ }
        if (pid) {
          const cur = players.get(pid);
          if (cur) {
            cur.acts = (cur.acts || 0) + 1;
            cur.lastAct = result.event?.text || String(body.action || '');
          }
        }
        // 给对方看的第三人称动态（和 home 的 eventLog 是两条流，见 pushFeed 注释）。
        pushFeed({
          at: Date.now(),
          pid,
          name,
          action: String(body.action || ''),
          target: String(body.target || 'her'),
          text: actorLine(name, body.action, body.target)
        });
      }
      return json(res, { ...result, room: roomViewFor(), net: { players: livePlayers(), you: pid, feed: recentFeed() } });
    }

    // ── 菜园 ──
    if (p === '/api/garden/state' && method === 'GET') {
      return json(res, gardenSnapshot());
    }
    if (p === '/api/garden/act' && method === 'POST') {
      const body = await readBody(req);
      const result = gardenAct(body);
      const name = String(body.by || '').slice(0, 24);
      if (result.ok) { try { noteGarden(body.type, body, result, name); } catch { /* 忽略 */ } }
      return json(res, result);
    }
    if (p === '/api/garden/control' && method === 'POST') {
      const body = await readBody(req);
      const result = gardenControl(body);
      const name = String(body.by || '').slice(0, 24);
      if (result.ok) { try { noteGarden(body.type === 'auto' ? 'auto' : body.type, body, result, name); } catch { /* 忽略 */ } }
      return json(res, result);
    }

    // ── 和屋里两位角色说话（本地规则，和单机版一致） ──
    if (p === '/api/room/chat' && method === 'POST') {
      const body = await readBody(req);
      await new Promise((r) => setTimeout(r, 420 + Math.random() * 520));
      return json(res, { ok: true, reply: localReply(body.text, body.target, homeSnapshot()), target: body.target });
    }

    if (p === '/api/tv/opinion' && method === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      return json(res, { ok: true, reply: '她凑近看了一眼：这画面挺有意思的，你从哪找来的？' });
    }

    if (p === '/api/room/state' && method === 'GET') {
      return json(res, { ok: true, room: roomViewFor() });
    }
    if (p === '/api/room/act' && method === 'POST') {
      return json(res, { ok: true, changed: false, room: roomViewFor() });
    }
    if (p === '/api/room/inspect' && method === 'GET') {
      return json(res, { ok: true, items: [] });
    }

    // ── 联机专属接口 ──
    if (p === '/api/net/presence' && method === 'POST') {
      const body = await readBody(req);
      const pid = String(body.pid || '');
      if (!pid) return json(res, { ok: false, error: '缺 pid' }, 400);
      touchPlayer(pid, { name: String(body.name || '小屋访客').slice(0, 24) });
      return json(res, { ok: true, players: livePlayers(), you: pid });
    }

    // 玩家之间的对话：一条广播流，前端各自渲染。
    if (p === '/api/net/chat' && method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, { ok: true, messages: chatLog.filter((m) => m.at > since), now: Date.now() });
    }
    if (p === '/api/net/chat' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 240);
      if (!text) return json(res, { ok: false, error: '空消息' }, 400);
      const entry = {
        at: Date.now(),
        pid: String(body.pid || '').slice(0, 64),
        name: String(body.name || '小屋访客').slice(0, 24),
        text
      };
      pushChat(entry);
      if (entry.pid) touchPlayer(entry.pid, { name: entry.name });
      return json(res, { ok: true, message: entry });
    }

    // 联机进度面板：两个人各自贡献了多少，加上共享的等级/亲密度。
    if (p === '/api/net/stats' && method === 'GET') {
      return json(res, {
        ok: true,
        level: profile.level(),
        tasks: profile.tasks(),
        achievements: profile.achievements(),
        affection: profile.affection(),
        streak: profile.streak(),
        players: { ...profile.players(), ...Object.fromEntries(livePlayers().map((x) => [x.name, { online: true, acts: x.acts }])) }
      });
    }

    json(res, { ok: false, error: `没有这个接口：${p}` }, 404);
  } catch (err) {
    json(res, { ok: false, error: String(err?.message || err) }, 500);
  }
});

// ── 定时推进：没人操作时她也继续过日子 ────────────────────────────────────
// 单机版靠页面轮询带动；服务器版必须自己走，否则两个人都关着页面她就冻住了。
setInterval(() => {
  try { homeSnapshot(); } catch { /* 下一轮再说 */ }
}, 15_000);

// 退出前把存档落盘。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { persist(); disk.flushNow(); } catch { /* 忽略 */ }
    process.exit(0);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('');
  console.log('  两人温馨小屋 · 双人联机');
  console.log('  ─────────────────────────────');
  console.log(`  本机：      http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  局域网：    http://${ip}:${PORT}/`);
  console.log('');
  console.log(`  存档目录：  ${DATA_DIR}`);
  console.log('  把上面任意一个地址发给对方，两边打开就是同一间屋子。');
  console.log('  公网访问需要自己把端口映射出去。');
  console.log('');
});
