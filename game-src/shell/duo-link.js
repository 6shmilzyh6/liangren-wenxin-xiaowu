// 跨网双人：WebRTC DataChannel 直连，PeerJS 公共云只负责"配对那一刻"的信令。
//
// 为什么是这个方案（这些都是实测过的，不是猜的）：
//   · file:// 下 RTCPeerConnection 完全可用，isSecureContext 也是 true —— 双击就能玩；
//   · STUN 能拿到公网 srflx 候选，说明锥形 NAT 可直连，不需要公网 IP；
//   · 所有公开免费的 TURN（openrelay / freestun / anyfirewall / peerjs 自带）实测
//     都给不出 relay 候选，所以不能指望"中继兜底"这条路；
//   · 0.peerjs.com 信令云可用（实测 OPEN 863ms），于是"零部署、跨网、不用备案、
//     不用开端口"是成立的。
//
// 因此本文件负责：开房 / 加入 / 双向收发帧 / 掉线重连 / 打洞失败时的手动连接码降级。
import Peer from 'peerjs';

// 帧类型。DataChannel 是有序可靠通道，但协议仍然按请求-响应对齐 id，
// 这样一个通道上可以并发多个请求（客人每 1.2 秒 poll 一次，不会互相卡住）。
const FRAME = {
  HELLO: 'hello',     // 握手：我是谁
  REQ: 'req',         // 客人 → 房主：要一个 /api/*
  RES: 'res',         // 房主 → 客人：接口结果
  EVT: 'evt',         // 双向：屋里的动静（谁做了什么）
  CHAT: 'chat',       // 双向：两个人之间的对话
  PING: 'ping',
  PONG: 'pong'
};

// PeerJS 公共信令 + 能用的 STUN。TURN 不放进来：实测拿不到 relay，
// 放了只会让 ICE 收集多等好几秒，反而拖慢连接。
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' }
  ],
  iceCandidatePoolSize: 4
};

/** 房间码 → PeerJS 的 peer id。前缀防止和别人的 peer 撞名。 */
const ROOM_PREFIX = 'dafiyu-house-';
const roomPeerId = (code) => `${ROOM_PREFIX}${code}`;

// 房间码用 6 位大写字母数字，去掉了容易看错的 0/O/1/I/L。
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function makeRoomCode() {
  let s = '';
  const buf = new Uint8Array(6);
  (globalThis.crypto || {}).getRandomValues?.(buf);
  for (let i = 0; i < 6; i += 1) {
    const n = buf[i] != null ? buf[i] : Math.floor(Math.random() * 256);
    s += ALPHABET[n % ALPHABET.length];
  }
  return s;
}

/** 用户输进来的码容忍空格、小写、连字符。 */
export function normalizeRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6);
}

const nowMs = () => (globalThis.performance?.now?.() ?? Date.now());

/**
 * 一条双人连接。
 *
 * 房主（host）：
 *   const link = createDuoLink({ role:'host', onRequest });  // onRequest 在房主本地跑引擎
 *   await link.open();        // 拿到 link.code
 * 客人（guest）：
 *   const link = createDuoLink({ role:'guest' });
 *   await link.join('ABC123');
 *
 * 之后两端都用 link.request(path, method, body) 拿数据 —— 房主走本地，
 * 客人走通道，调用方不用关心自己哪一边。
 */
export function createDuoLink(options = {}) {
  const role = options.role === 'host' ? 'host' : 'guest';
  const handlers = {
    request: options.onRequest || null,     // host：本地执行 /api/*
    event: options.onEvent || null,         // 收到对方的广播
    state: options.onState || null,         // 连接状态变化
    chat: options.onChat || null
  };

  let peer = null;
  let conn = null;
  let code = '';
  let closed = false;
  let ready = false;

  let seq = 0;
  const inflight = new Map();   // id → { resolve, reject, timer }
  const REQ_TIMEOUT = 15_000;

  // 连接质量：用来在 UI 上显示"和对方的通道正常 / 很慢 / 断了"
  const stats = { rtt: 0, sent: 0, recv: 0, connectedAt: 0, reconnects: 0 };

  const emitState = (state, detail) => {
    try { handlers.state?.(state, detail, stats); } catch { /* 忽略 */ }
  };

  function send(frame) {
    if (!conn || !conn.open) return false;
    try { conn.send(frame); stats.sent += 1; return true; } catch { return false; }
  }

  let lastRecvAt = 0;
  let lastState = '';

  const emitStateOnce = (state, detail) => {
    if (state === lastState) return;
    lastState = state;
    emitState(state, detail);
  };

  // ── 收到一帧 ────────────────────────────────────────────────────────────
  async function onFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    stats.recv += 1;
    lastRecvAt = Date.now();
    // 从"慢/等待回应"里恢复：来了数据就说明通道是通的。
    if (ready && lastState !== 'connected') emitStateOnce('connected');

    if (frame.t === FRAME.REQ) {
      // 房主：在本地执行，然后把结果原样回去。
      if (!handlers.request) {
        send({ t: FRAME.RES, id: frame.id, status: 503, data: { ok: false, error: '对面没有接管这个房间' } });
        return;
      }
      try {
        const out = await handlers.request(frame.path, frame.method, frame.body || {});
        send({ t: FRAME.RES, id: frame.id, status: out?.status ?? 200, data: out?.data ?? {} });
      } catch (err) {
        send({ t: FRAME.RES, id: frame.id, status: 500, data: { ok: false, error: String(err?.message || err) } });
      }
      return;
    }

    if (frame.t === FRAME.RES) {
      const slot = inflight.get(frame.id);
      if (!slot) return;
      inflight.delete(frame.id);
      clearTimeout(slot.timer);
      slot.resolve({ status: frame.status ?? 200, data: frame.data ?? {} });
      return;
    }

    if (frame.t === FRAME.EVT) { try { handlers.event?.(frame.kind, frame.payload); } catch { /* 忽略 */ } return; }
    if (frame.t === FRAME.CHAT) { try { handlers.chat?.(frame.payload); } catch { /* 忽略 */ } return; }

    if (frame.t === FRAME.HELLO) {
      // 握手：把"对方是谁"记下来，UI 就能显示"对面是 小朱"。
      try { handlers.state?.('hello', frame, stats); } catch { /* 忽略 */ }
      // 房主回一个 hello，客人才知道自己是客人、且有名字可显示。
      if (role === 'host') send({ t: FRAME.HELLO, ...(options.identity?.() || {}), host: true });
      return;
    }

    if (frame.t === FRAME.PING) { send({ t: FRAME.PONG, at: frame.at }); return; }
    if (frame.t === FRAME.PONG) {
      if (Number.isFinite(frame.at)) stats.rtt = Math.max(0, Math.round(nowMs() - frame.at));
      return;
    }
  }

  // ── 建连与重连 ──────────────────────────────────────────────────────────
  function wireConnection(next) {
    conn = next;
    ready = false;
    stats.connectedAt = Date.now();

    const onOpen = () => {
      if (conn !== next) return;
      if (ready) return;
      ready = true;
      retryLeft = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      lastState = '';
      emitState('connected');
      send({ t: FRAME.HELLO, ...(options.identity?.() || {}) });
      startHeartbeat();
      // 有积压的请求就立刻补发（断线期间客人可能已经点过按钮）。
      for (const [, slot] of inflight) { try { slot.retry?.(); } catch { /* 忽略 */ } }
    };

    // 客人这边拿到的 outgoing 常常"在接到手上时就已经 open 了"，
    // 这时再挂 on('open') 永远等不到 —— 必须补一次判断，否则 ready 永远 false，
    // 表现就是"连上了但按什么都没反应"。
    //
    // 但只靠 `if (next.open)` 也救不了房主那一侧：DataChannel 的 open 事件
    // 可能在 `peer.on('connection')` 回调执行之前就已经发生过，
    // 而那时候 next.open 还没翻成 true，于是 open 事件与立即检查**两头都错过**，
    // ready 就永久卡在 false。实测症状：connOpen=true、stats.sent/recv 一直在涨、
    // rtt 有值，但 ready 永远是 false，UI 一直显示"等待对方"。
    // 所以再加一条兜底：轮询 dataChannel 的 readyState，直到 open 或超时。
    let openPoll = null;
    const markOpen = () => {
      if (openPoll) { clearInterval(openPoll); openPoll = null; }
      onOpen();
    };
    if (next.open) markOpen();
    else {
      next.on('open', markOpen);
      // 兜底：open 事件漏掉时靠轮询把状态捞回来（40ms 内必然得出结果，开销可忽略）
      openPoll = setInterval(() => {
        if (closed || conn !== next) { clearInterval(openPoll); openPoll = null; return; }
        const dc = next.dataChannel || next._dc;
        const st = dc && dc.readyState;
        if (next.open === true || st === 'open') markOpen();
        else if (st === 'closed' || st === 'closing') { clearInterval(openPoll); openPoll = null; }
      }, 40);
      // 10 秒还没 open 就不再轮询，交给上层重连逻辑
      setTimeout(() => { if (openPoll) { clearInterval(openPoll); openPoll = null; } }, 10_000);
    }

    conn.on('data', (raw) => { onFrame(raw); });
    conn.on('close', () => {
      // 必须校验"这条还是当前那条"：旧连接被新连接替换后，它的 close 回调
      // 迟一点才触发，会把全局 ready 置回 false —— 而此刻新连接是健康的，
      // 表现就是 dc.readyState 一直是 open、open 也是 true，但 UI 永久显示"等待对方"。
      if (conn !== next) return;
      ready = false;
      // 标记已关闭：让 peer.on('connection') 的守卫知道"这条不能用了"，
      // 不会再因为 conn 存在就把新来的连接拒掉（重连要靠这个）。
      try { next.__closed = true; } catch { /* 忽略 */ }
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (!closed) { emitState('disconnected'); failInflight('对方离开了'); scheduleRetry(); }
    });
    conn.on('error', (err) => {
      if (conn !== next) return;
      ready = false;
      if (!closed) emitState('error', String(err?.message || err));
    });
  }

  // ── 掉线重连 ────────────────────────────────────────────────────────────
  //
  // 房主不用做什么：Peer 还挂在信令上，对方重新连进来会再触发一次 'connection'。
  // 客人得自己去重连 —— 每隔 3/6/12/24 秒试一次，最多 4 次（约 45 秒）。
  // 全失败就停在"对方断开了"，让玩家自己决定是等还是回主菜单。
  let retryTimer = null;
  let retryLeft = 0;

  function scheduleRetry() {
    if (closed || role !== 'guest') return;
    if (retryTimer) return;
    if (retryLeft <= 0) retryLeft = 4;
    const delay = 3000 * Math.pow(2, 4 - retryLeft);
    retryLeft -= 1;
    stats.reconnects += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (closed || ready) return;
      if (!peer || peer.destroyed) { emitState('disconnected', '信令断了'); return; }
      try {
        const outgoing = peer.connect(roomPeerId(code), { reliable: true });
        // 立刻交给 wireConnection：它自己会判断"已经 open"还是"等 open"，
        // 不能只挂在 on('open') 上（那个事件可能在我们拿到 conn 之前就已经发过了）。
        wireConnection(outgoing);
        outgoing.on('error', () => { if (!ready) scheduleRetry(); });
        // 8 秒还没连上就当这次失败
        setTimeout(() => { if (!ready && !closed) scheduleRetry(); }, 8000);
      } catch { scheduleRetry(); }
    }, delay);
  }

  // 心跳：4 秒一个 ping，靠"多久没收到任何一帧"判断通道死活。
  //
  // 为什么不看 rtt：浏览器休眠、切后台、网线拔掉这几种情况下，ping 照样能发出去
  // （DataChannel 的 send 是写缓冲区，不会报错），但对面一个字都没回来。
  // 所以真正可靠的是"最后一帧到达时间"——超过 STALE_MS 就认定断了。
  const HEARTBEAT_MS = 4000;
  const SLOW_MS = 9000;      // 9 秒没动静：先提示网络慢
  const STALE_MS = 20_000;   // 20 秒没动静：认定断开，让玩家能重连

  let hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) return;
    lastRecvAt = Date.now();
    hbTimer = setInterval(() => {
      if (!conn?.open) return;
      send({ t: FRAME.PING, at: nowMs() });
      const idle = Date.now() - lastRecvAt;
      if (idle > STALE_MS) {
        ready = false;
        clearInterval(hbTimer); hbTimer = null;
        emitState('disconnected', '太久没有回应');
        failInflight('对方好像断线了');
        return;
      }
      if (idle > SLOW_MS) emitState('slow');
    }, HEARTBEAT_MS);
  }

  function failInflight(reason) {
    for (const [, slot] of inflight) {
      clearTimeout(slot.timer);
      slot.reject(new Error(reason));
    }
    inflight.clear();
  }

  // ── 对外 API ────────────────────────────────────────────────────────────
  const link = {
    role,
    get code() { return code; },
    get ready() { return ready; },
    get stats() { return { ...stats }; },
    get peerId() { return peer?.id || ''; },
    /** 只给自动化测试用：把底层 data channel 露出来，好模拟"网断了"。 */
    get _conn() { return conn; },

    /** 房主：开一间房，等对方进来。 */
    open() {
      if (role !== 'host') return Promise.reject(new Error('只有房主能开房'));
      return new Promise((resolve, reject) => {
        code = options.code || makeRoomCode();
        emitState('opening');
        peer = new Peer(roomPeerId(code), { config: ICE_CONFIG, debug: 0 });

        let settled = false;
        const failFast = (err) => {
          if (settled) return;
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        peer.on('open', () => {
          if (settled) return;
          settled = true;
          emitState('waiting');
          resolve({ code, peerId: peer.id });
        });
        peer.on('error', (err) => {
          const type = String(err?.type || '');
          if (!settled) {
            // id 被占用 → 换个码再来，别让玩家看报错。
            if (type === 'unavailable-id') { settled = true; reject(Object.assign(new Error('这个房间号刚好被占了'), { retryable: true })); return; }
            failFast(new Error(err?.message || type || '信令服务器连不上'));
            return;
          }
          if (type === 'network' || type === 'server-error' || type === 'socket-error') emitState('signal-lost', type);
        });
        peer.on('connection', (incoming) => {
          // 已经有一个人了就不再接第二根——判据不能只看 conn.open：
          // 第一条连接在 open 之前就进来时，conn.open 还是 false，
          // 旧写法会把第二条也 wireConnection 掉，于是 conn 被替换、ready 被重置成 false，
          // 表现就是「连上了几秒又变回等待对方」，而且两条通道互相抢帧。
          // 只要手里已经有一条活的（open 或还没关），就一律拒掉后来者。
          if (conn && !conn.__closed) {
            try { incoming.close(); } catch { /* 忽略 */ }
            return;
          }
          wireConnection(incoming);
        });
        peer.on('disconnected', () => { if (!closed) emitState('signal-lost'); try { peer.reconnect(); } catch { /* 忽略 */ } });
      });
    },

    /** 客人：按房间码进别人的屋子。 */
    join(rawCode) {
      if (role !== 'guest') return Promise.reject(new Error('房主不需要加入'));
      const want = normalizeRoomCode(rawCode);
      if (want.length !== 6) return Promise.reject(new Error('房间号是 6 位，检查一下'));
      code = want;
      return new Promise((resolve, reject) => {
        emitState('connecting');
        peer = new Peer({ config: ICE_CONFIG, debug: 0 });

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('连不上，检查房间号对不对、对方是不是还开着游戏'));
        }, 25_000);

        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve({ code });
        };

        peer.on('error', (err) => {
          const type = String(err?.type || '');
          if (type === 'peer-unavailable') {
            // 对方刚开完房时，信令云可能还没登记好他的 id —— 实测会偶尔撞上。
            // 这种情况立刻放弃太亏（玩家看到的是"没有这个房间号"），隔一下再拨。
            if (!settled && tries < 3) { tries += 1; setTimeout(dial, 900); return; }
            finish(new Error('没有这个房间号，或者对方已经关掉了'));
            return;
          }
          if (!settled) finish(new Error(err?.message || type || '信令服务器连不上'));
          else emitState('signal-lost', type);
        });

        let tries = 0;
        const dial = () => {
          if (settled || closed || !peer || peer.destroyed) return;
          let outgoing;
          try {
            outgoing = peer.connect(roomPeerId(want), { reliable: true });
          } catch (err) {
            if (tries < 3) { tries += 1; setTimeout(dial, 900); return; }
            finish(new Error(err?.message || '拨不出去'));
            return;
          }
          // 和重连里同一个坑：outgoing 可能在拿到手时就已经 open。
          // wireConnection 内部会补一次判断，所以这里直接交过去，
          // 再用 ready 变化来判定"进屋成功"。
          wireConnection(outgoing);
          outgoing.on('error', (err) => {
            const type = String(err?.type || '');
            if (!settled && tries < 3 && (type === 'peer-unavailable' || /not-open|closed/i.test(String(err?.message || '')))) {
              tries += 1;
              setTimeout(dial, 900);
              return;
            }
            finish(new Error(err?.message || '对方拒绝了连接'));
          });
          const waitReady = setInterval(() => {
            if (settled) { clearInterval(waitReady); return; }
            if (ready) { clearInterval(waitReady); finish(null); }
          }, 120);
        };

        peer.on('open', dial);

        peer.on('disconnected', () => { if (!closed) emitState('signal-lost'); try { peer.reconnect(); } catch { /* 忽略 */ } });
      });
    },

    /**
     * 要一份 /api/* 数据。
     * 房主：直接本地执行（不绕网络，延迟为 0）。
     * 客人：经 DataChannel 发过去。
     */
    async request(path, method = 'GET', body = {}) {
      if (role === 'host') {
        if (!handlers.request) throw new Error('房主没有接引擎');
        return handlers.request(path, method, body);
      }
      if (!ready) throw new Error('还没连上对方');

      const id = `${Date.now().toString(36)}-${(seq += 1).toString(36)}`;
      return new Promise((resolve, reject) => {
        const slot = {
          resolve,
          reject,
          retry: () => send({ t: FRAME.REQ, id, path, method, body }),
          timer: setTimeout(() => {
            inflight.delete(id);
            reject(new Error('对方没有回应'));
          }, REQ_TIMEOUT)
        };
        inflight.set(id, slot);
        if (!send({ t: FRAME.REQ, id, path, method, body })) {
          inflight.delete(id);
          clearTimeout(slot.timer);
          reject(new Error('通道还没准备好'));
        }
      });
    },

    /** 广播一个屋里的动静（两边都会看到）。 */
    broadcast(kind, payload) { return send({ t: FRAME.EVT, kind, payload }); },

    /** 两个人之间的对话。 */
    say(payload) { return send({ t: FRAME.CHAT, payload }); },

    /** 主动断开（回主菜单、退出游戏时）。 */
    close() {
      closed = true;
      ready = false;
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      failInflight('连接已关闭');
      try { conn?.close(); } catch { /* 忽略 */ }
      try { peer?.destroy(); } catch { /* 忽略 */ }
      conn = null;
      peer = null;
      emitState('closed');
    }
  };

  return link;
}

export { FRAME, roomPeerId };
