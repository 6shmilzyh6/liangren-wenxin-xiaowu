// 双人模式的网络层：把 DataChannel 包成和单机版一模一样的 fetch。
//
// 关键设计：双人模式下"谁是权威"只有一个答案 —— 房主。
//   · 房主本地跑引擎（home-engine + profile），客人的每个 /api/* 都转给房主执行；
//   · 于是两端看到的屋子、等级、菜园、事件必然一致，不可能出现"各玩各的"。
//
// 为什么不让两人各跑一份引擎再合并：那样时钟、随机、自主行为都会分叉，
// 玩家会看到"她在我这儿在睡觉、在他那儿在种地"。养成游戏最忌这个。
//
// 连接期间的错误都在这里翻译成人话：玩家看到的是"没有这个房间号"，
// 而不是 "peer-unavailable"。
import { installNetShim, handleApi, setDuoState, pathOf, queryOf, bodyOf } from './net-shim.js';
import { createDuoLink } from './duo-link.js';
import { playerId, playerName, mySide, setMySide, otherSide, sideName } from './identity.js';
import {
  mountNetUI, absorbNet, setLinkState, pushMessage, renderNet,
  setSideInfo, onSwapRequest, showSwapAsk, clearSwapAsk
} from './net-ui.js';

// 房里另一个人的存在感：名单、动态流、两个人的聊天。
// 这份状态在房主内存里滚动，客人通过 request('/api/net/*') 拿到。
const FEED_MAX = 60;
const CHAT_MAX = 120;
const PRESENCE_TTL = 25_000;

// 动作 → 第三人称播报。和服务器版 server.mjs 的 ACTOR_VERB 保持一致的语气。
const VERB = {
  pet: '摸了摸她的头', poke: '戳了戳她', feed: '喂了一块小点心', water: '倒了一杯水',
  play: '陪她坐了一会儿', talk: '留了一句话', sleep: '劝她去睡', wake: '把她叫醒了',
  lamp: '调了一下灯', heal: '给她上了点药', visit: '去串了个门', meet: '让她们串了个门',
  command: '让她去别处', go: '带她走开', place: '把她放到别处', sick: '她有点不舒服'
};

function makeDuoState(link, self) {
  const players = new Map();
  const feed = [];
  const chat = [];

  const touch = (pid, name) => {
    if (!pid) return;
    const key = String(pid);
    const prev = players.get(key);
    players.set(key, {
      pid: key,
      name: String(name || prev?.name || '小屋访客').slice(0, 12),
      since: prev?.since || Date.now(),
      at: Date.now(),
      acts: prev?.acts || 0,
      lastAct: prev?.lastAct || ''
    });
  };

  const prune = () => {
    const cut = Date.now() - PRESENCE_TTL;
    for (const [k, p] of players) if (p.at < cut) players.delete(k);
  };

  const snapshot = () => {
    prune();
    const list = [...players.values()].map((p) => ({
      pid: p.pid,
      name: p.name,
      onlineFor: Date.now() - p.since,
      acts: p.acts,
      lastAct: p.lastAct
    }));
    return { players: list, you: self.pid, feed: feed.slice(-20) };
  };

  return {
    touch,
    snapshot,
    /** 有人做了什么：记进动态流，同时推给对方（免得对面要等下一次轮询）。 */
    noteAct(body, result) {
      const who = String(body?.by || '').slice(0, 24) || '有人';
      const verb = VERB[String(body?.action || '')] || '做了点什么';
      const target = body?.target === 'claude' ? '小公主' : '小蓝鱼';
      const text = `${who} ${verb}${body?.action === 'talk' ? `（${target}）` : ''}`;
      const item = { pid: String(body?.pid || self.pid), text, at: Date.now() };
      feed.push(item);
      if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
      const p = players.get(item.pid);
      if (p) { p.acts += 1; p.lastAct = verb; }
      link.broadcast('feed', item);
      return result;
    },
    chat(method, body) {
      if (String(method).toUpperCase() === 'POST') {
        const text = String(body?.text || '').trim().slice(0, 240);
        if (!text) return { ok: false, error: '空消息' };
        const msg = {
          pid: String(body?.pid || self.pid),
          name: String(body?.name || '小屋访客').slice(0, 12),
          text,
          at: Date.now()
        };
        chat.push(msg);
        if (chat.length > CHAT_MAX) chat.splice(0, chat.length - CHAT_MAX);
        link.say(msg);
        return { ok: true, message: msg };
      }
      const since = Number(body?.since || 0) || 0;
      return { ok: true, messages: chat.filter((m) => m.at > since) };
    }
  };
}

/**
 * 开双人局。
 *
 * @param {'host'|'guest'} role
 * @param {{code?:string, onStatus?:Function, onEvent?:Function, onLeave?:Function}} options
 */
export async function startDuo(role, options = {}) {
  // 房主要先把引擎接起来：它既服务自己，也服务对面。
  // 客人也装同一个 shim —— 它负责 bootEngine()，客人要靠本地引擎渲染画面；
  // 之后客人的 /api/* 会被下面的包装接管，全部转给房主。
  installNetShim();

  const self = { pid: playerId(), name: playerName() };
  let duoState = null;
  let uiMounted = false;
  // 这一端住哪一侧。进房时由主菜单定下（options.side 优先，其次 localStorage）；
  // 房内不能随手切，只能发一个交换申请，对面点「同意交换」之后两边一起换。
  // 注意：开房这一步发生在玩家点「先进去等对方」之前，那时 options.side 已经定了，
  // 所以必须以 options.side 为准 —— 只读 localStorage 会读到上一次的身份。
  const wanted = options.side === 'claude' ? 'claude' : options.side === 'her' ? 'her' : mySide();
  let mySideNow = wanted === 'claude' || wanted === 'her' ? wanted : 'her';
  let peerSideNow = '';
  // 对方发来 ask 时报的侧：同意交换之后，我换到他那一边去。
  let askFromSide = '';
  // 传侧变化给 app.js：它负责整页文案、能指挥谁、菜园里写谁的名字。
  const emitSide = (side) => {
    try { globalThis.__sideChanged?.(side); } catch { /* app.js 还没起来就算了 */ }
  };
  setMySide(mySideNow);

  const mountDuoUI = () => {
    if (uiMounted) return;
    uiMounted = true;
    mountNetUI({
      roomCode: link.code,
      role,
      side: mySideNow,
      onLeave: () => {
        try { options.onLeave?.(); } catch { /* 忽略 */ }
        leaveRoom();
      }
    });
    setSideInfo(mySideNow, peerSideNow);
    onSwapRequest(sendSwap);
  };

  // 交换身份：谁都可以发起，双方都同意才落地。
  //   发起方 → ask(side=我现在的侧)
  //   接收方 → 点同意后记下"我要换过去的那一侧"，然后把"我原来那一侧"回给发起方 → yes(side=我原来的侧)
  //   发起方收到 yes → 换到对方原来那一侧
  // 两边各换一次，结果必然对称；任何一边掉线也不会半边换掉。
  const swapFrom = { side: '' };
  const sendSwap = (phase, side = mySideNow) => {
    try { link.broadcast('swap', { phase, side, name: self.name }); }
    catch { /* 掉线时静默 */ }
  };

  // 本地落地换侧：页面文案、面板、菜园一起换。
  const applySwap = (nextSide, nextPeerSide, quiet = false) => {
    const want = nextSide === 'claude' ? 'claude' : nextSide === 'her' ? 'her' : mySideNow;
    mySideNow = want;
    setMySide(mySideNow);
    if (nextPeerSide === 'her' || nextPeerSide === 'claude') peerSideNow = nextPeerSide;
    clearSwapAsk();
    setSideInfo(mySideNow, peerSideNow);
    emitSide(mySideNow);
    if (!quiet) {
      pushMessage({
        pid: 'sys', name: '身份',
        text: `身份换过来了：你现在住${sideName(mySideNow)}这一侧。`,
        at: Date.now()
      });
    }
  };

  // 接收方点「同意交换」时走这里：先把自己原来那一侧回给发起方，再换过去。
  const acceptSwap = () => {
    const myBefore = mySideNow;
    const target = swapFrom.side === 'her' || swapFrom.side === 'claude' ? swapFrom.side : otherSide(myBefore);
    swapFrom.side = '';
    sendSwap('yes', myBefore);
    applySwap(target, myBefore);
  };

  const link = createDuoLink({
    role,
    code: options.code,
    // side 随握手帧一起走：对面一连上就知道我是哪一侧，不用再单独问。
    identity: () => ({ pid: self.pid, name: self.name, side: mySideNow }),
    onRequest: role === 'host' ? (path, method, body) => handleApi(path, method, body) : null,
    onState: (state, detail) => {
      // 把传输层的状态翻译成 UI 语言。
      if (state === 'connected') setLinkState('connected');
      else if (state === 'waiting') setLinkState('waiting');
      else if (state === 'opening') setLinkState('connecting');
      else if (state === 'connecting') setLinkState('connecting');
      else if (state === 'disconnected') setLinkState('disconnected');
      else if (state === 'slow') setLinkState('slow');
      else if (state === 'signal-lost') setLinkState('slow', '信令服务器掉线，正在重连');
      else if (state === 'hello') {
        // 对面报上名字了：让他出现在名单里，同时记下他住哪一侧。
        if (duoState && detail?.pid) duoState.touch(detail.pid, detail.name);
        if (detail?.side === 'her' || detail?.side === 'claude') {
          peerSideNow = detail.side;
          setSideInfo(mySideNow, peerSideNow);
        }
        if (role === 'host' && detail?.pid) {
          // 房主也把客人拉进自己的面板。
          refreshNet();
        }
      }
      try { options.onStatus?.(state, detail, link?.stats); } catch { /* 忽略 */ }
    },
    onEvent: (kind, payload) => {
      if (kind === 'swap') {
        // 交换身份：ask → 弹按钮问我要不要；yes → 换到对方原来那一侧；no → 告知没同意。
        const phase = payload?.phase;
        const side = payload?.side === 'her' || payload?.side === 'claude' ? payload.side : '';
        if (phase === 'ask') {
          swapFrom.side = side;
          showSwapAsk(payload?.name, acceptSwap, () => {
            swapFrom.side = '';
            sendSwap('no');
          });
        } else if (phase === 'yes' && side) {
          // 对方同意了，并把他原来那一侧告诉我：我换过去，他换到我这侧。
          applySwap(side, otherSide(side));
        } else if (phase === 'no') {
          swapFrom.side = '';
          clearSwapAsk('对方这次不想换。');
        }
        return;
      }
      if (kind === 'feed') {
        // 对面刚做了什么：直接进动态流，面板立刻能看到。
        if (!netState.feed.some((f) => f.at === payload.at && f.text === payload.text)) {
          netState.feed.push({ pid: 'peer', text: payload.text, at: payload.at });
          if (netState.feed.length > 60) netState.feed.splice(0, netState.feed.length - 60);
          renderNet();
        }
      }
      try { options.onEvent?.(kind, payload); } catch { /* 忽略 */ }
    },
    onChat: (payload) => {
      // 对面发来的话：直接进聊天区，不用等轮询。
      if (payload?.text) pushMessage(payload);
      try { options.onChat?.(payload); } catch { /* 忽略 */ }
    }
  });

  if (role === 'host') {
    duoState = makeDuoState(link, self);
    setDuoState(duoState);
    duoState.touch(self.pid, self.name);
    await link.open();
    // 房主开完房就把面板挂上：他一个人先玩，面板显示"等对方进来"。
    mountDuoUI();
  } else {
    await link.join(options.code);
  }

  // 把 /api/* 全部转到房主那边。这一层装好之后，app.js 里那 3000 行
  // 表现层代码完全不知道自己在"远程"，它只是在 fetch。
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if (!path.startsWith('/api/')) return originalFetch(input, init);
    // GET 的查询参数摊进 body：/api/room/chat/peer?pid=…&since=… 这类端点靠它取参数，
    // 而通道只传 (path, method, body) 三元组，query 不摊进来就会丢会话/游标。
    const query = queryOf(input);
    // 房主自己（以及请求 /api/net/* 之类）仍然走本地分发器，
    // 客人则把一切交给通道 —— 包括 /api/net/*，因为权威在房主那边。
    if (role === 'host') {
      const method = String(init?.method || 'GET').toUpperCase();
      const body = { ...query, ...(await bodyOf(init)) };
      const { status, data } = await handleApi(path, method, body);
      if (path === '/api/home/state' || path === '/api/home/act') absorbNet(data);
      return jsonResponse(data, status);
    }
    const method = String(init?.method || 'GET').toUpperCase();
    const body = { ...query, ...(await bodyOf(init)) };
    // 身份随请求走：房主靠它分账"谁摸的头"。
    // 房间会话还要靠它分"谁在跟谁说话"，所以私聊/群聊的 pid 必须一路带到房主那边。
    body.pid = body.pid || self.pid;
    if (!body.by) body.by = self.name;
    if (!body.name) body.name = self.name;
    try {
      const out = await link.request(path, method, body);
      if (path === '/api/home/state' || path === '/api/home/act' || path === '/api/net/presence') {
        absorbNet(out.data);
      }
      return jsonResponse(out.data, out.status ?? 200);
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err?.message || err) }, 503);
    }
  };

  const refreshNet = () => {
    if (!duoState) return;
    absorbNet({ net: duoState.snapshot() });
  };

  // 心跳：让房主的在线名单里一直有客人。房主自己也定期刷新一次面板。
  const beat = () => {
    if (role === 'guest') {
      link.request('/api/net/presence', 'POST', { pid: self.pid, name: self.name })
        .then((out) => absorbNet(out.data))
        .catch(() => setLinkState('disconnected'));
    } else {
      duoState.touch(self.pid, self.name);
      refreshNet();
    }
  };
  beat();
  const beatTimer = setInterval(beat, 8000);

  // 客人连上之后才挂面板（连不上的话菜单会报错，不该留下一个空面板）。
  if (role === 'guest') mountDuoUI();
  setLinkState(role === 'host' ? 'waiting' : 'connected');

  const api = {
    role,
    get code() { return link.code; },
    self,
    get stats() { return link.stats; },
    link,
    state: () => duoState?.snapshot() || netState,
    close: () => { clearInterval(beatTimer); leaveRoom(); }
  };

  function leaveRoom() {
    clearInterval(beatTimer);
    try { setDuoState(null); } catch { /* 忽略 */ }
    try { link.close(); } catch { /* 忽略 */ }
    setLinkState('closed');
    // 双人局结束就回主菜单：玩家想再玩可以重新选模式。
    // 这里不 reload，避免把对端的连接状态也搅乱。
    location.hash = '';
    const again = confirm('离开这间屋子，回到主菜单？');
    if (again) location.reload();
  }

  globalThis.__duo = api;
  return { role, code: link.code, self, link, api };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
