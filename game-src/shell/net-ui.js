// 「屋里的人」面板：在线名单 + 刚刚发生 + 两个人之间的对话。
//
// 联机服务器（net-online）和点对点双人（net-duo）用的是同一块 UI：
// 它们都通过 fetch 拿 /api/home/state（里面带 net 字段）和 /api/net/chat，
// 所以这里只关心"数据从哪来"，完全不知道底层是服务器还是 DataChannel。
import { el, CSS_EXTRA } from './ui-kit.js';
import { playerId, playerName, sideName, otherSide } from './identity.js';

export const netState = {
  players: [],
  messages: [],
  feed: [],
  since: 0,
  me: '',
  // 连接状态：'connected' | 'waiting' | 'connecting' | 'disconnected' | 'slow' | 'closed'
  link: 'disconnected',
  note: '',
  // 这一端住哪一侧，以及对方那一侧（进房时定，之后只能双方同意互换）
  side: '',
  peerSide: '',
  // 正在等对方答复的交换申请；'ask' 表示对方正在问我
  swap: ''
};

let barEl = null;
let panelEl = null;
let backdropEl = null;
let listEl = null;
let feedEl = null;
let msgsEl = null;
let dotEl = null;
let sideEl = null;
let askEl = null;
let onLeaveRoom = null;
let swapSend = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const agoText = (ms) => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '刚进来';
  if (m < 60) return `来了 ${m} 分钟`;
  return `来了 ${Math.floor(m / 60)} 小时`;
};

export function renderNet() {
  if (!barEl) return;
  const others = netState.players.filter((p) => p.pid !== netState.me);

  // 状态条上的字就是"这间屋子现在是什么情况"：等对方 / 有人在 / 断了。
  let label;
  let cls = '';
  if (netState.link === 'waiting') { label = '等对方进来'; cls = 'nt-wait'; }
  else if (netState.link === 'connecting') { label = '正在连…'; cls = 'nt-wait'; }
  else if (netState.link === 'disconnected' || netState.link === 'closed') { label = '对方断开了'; cls = 'nt-bad'; }
  else if (netState.link === 'slow') { label = '网络有点慢'; cls = 'nt-bad'; }
  else label = others.length ? `${netState.players.length} 人在屋里` : '你在屋里';

  barEl.querySelector('.nt-count').textContent = label;
  barEl.className = `nt-bar ${cls}`.trim();
  barEl.classList.toggle('nt-solo', others.length === 0 && netState.link === 'connected');

  if (listEl) {
    listEl.innerHTML = netState.players.length
      ? netState.players.map((p) => {
        const me = p.pid === netState.me;
        const doing = p.lastAct ? ` · ${escapeHtml(p.lastAct)}` : '';
        return `<li class="${me ? 'nt-me' : ''}">
          <b>${escapeHtml(p.name)}</b>${me ? '<i>你</i>' : ''}
          <span>${agoText(p.onlineFor)}${p.acts ? ` · 做了 ${p.acts} 件事` : ''}${doing}</span>
        </li>`;
      }).join('')
      : '<li class="nt-empty">还没有人，把这间屋子的房间号发给对方。</li>';
  }

  renderFeed();
}

/** 对方刚做了什么：只在面板打开时才画，避免白白刷新 DOM。 */
function renderFeed() {
  if (!feedEl || panelEl?.hidden) return;
  const items = (netState.feed || []).slice(-8).reverse();
  feedEl.innerHTML = items.length
    ? items.map((f) => {
      const mine = f.pid === netState.me;
      const ago = Math.max(0, Math.round((Date.now() - f.at) / 1000));
      return `<div class="nt-feed-item${mine ? ' nt-feed-mine' : ''}">
        <span>${escapeHtml(f.text)}</span>
        <i>${ago < 60 ? `${Math.max(1, ago)} 秒前` : `${Math.round(ago / 60)} 分钟前`}</i>
      </div>`;
    }).join('')
    : '<p class="nt-hint">屋里还没有新动静。</p>';
}

export function renderNetMessages() {
  if (!msgsEl) return;
  if (!netState.messages.length) {
    msgsEl.innerHTML = '<p class="nt-hint">这里是你和对方说话的地方，屋里那两位看不到。</p>';
    return;
  }
  msgsEl.innerHTML = netState.messages.map((m) => {
    const mine = m.pid === netState.me;
    return `<div class="nt-msg ${mine ? 'nt-mine' : ''}">
      <span class="nt-who">${escapeHtml(m.name)}</span>
      <span class="nt-text">${escapeHtml(m.text)}</span>
    </div>`;
  }).join('');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

/** 把 /api/home/state 响应里带的 net 字段吸收进来。 */
export function absorbNet(data) {
  if (!data?.net) return;
  // 心跳（/api/net/presence）只带名单，不带动态。这里必须按字段判断，
  // 否则每 4 秒一拍就会把刚收到的动态清空 —— 面板会一直显示"屋里还没有新动静"。
  if (Array.isArray(data.net.players)) netState.players = data.net.players;
  if (Array.isArray(data.net.feed)) netState.feed = data.net.feed;
  netState.me = data.net.you || netState.me || playerId();
  renderNet();
}

export function pushMessage(msg) {
  if (!msg) return;
  netState.messages.push(msg);
  if (netState.messages.length > 120) netState.messages.splice(0, netState.messages.length - 120);
  netState.since = Math.max(netState.since, Number(msg.at) || 0);
  renderNetMessages();
}

export async function sendNetMessage(text) {
  const body = { pid: playerId(), name: playerName(), text };
  try {
    const res = await fetch('/api/net/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.ok && data.message) pushMessage(data.message);
  } catch { /* 掉线时静默，面板上的状态已经提示过了 */ }
}

async function pollChat() {
  try {
    const res = await fetch(`/api/net/chat?since=${netState.since}`);
    const data = await res.json();
    if (!data.ok) return;
    const fresh = data.messages || [];
    for (const m of fresh) pushMessage(m);
  } catch { /* 等下一轮 */ }
}

export function setLinkState(state, note = '') {
  netState.link = state;
  netState.note = note;
  renderNet();
}

/** 这一端 / 对方住在哪一侧的显示与「申请交换」按钮。 */
function renderSide() {
  if (!sideEl) return;
  const meEl = sideEl.querySelector('#ntSideMe');
  const peerEl = sideEl.querySelector('#ntSidePeer');
  const btn = sideEl.querySelector('#ntSwap');
  if (meEl) meEl.textContent = netState.side ? sideName(netState.side) : '—';
  if (peerEl) peerEl.textContent = netState.peerSide ? sideName(netState.peerSide) : '还没定';
  if (btn) {
    const waiting = netState.swap === 'sent';
    btn.disabled = waiting || !netState.peerSide;
    btn.textContent = waiting ? '等对方回话…' : '申请交换';
    btn.title = !netState.peerSide
      ? '对方进来并定好身份之后才能申请交换'
      : '向对方申请互换身份：对方同意之后两边才会换过来';
  }
}

/** 身份变了（自己换侧、或对方报上来）：重画那一行。 */
export function setSideInfo(side, peerSide) {
  if (side === 'her' || side === 'claude') netState.side = side;
  if (peerSide === 'her' || peerSide === 'claude') netState.peerSide = peerSide;
  renderSide();
}

/** 发起交换：由 net-duo 注进来的 sendSwap 真正发帧。 */
export function onSwapRequest(handler) {
  swapSend = typeof handler === 'function' ? handler : null;
}

function requestSwap() {
  if (!swapSend) return;
  if (netState.swap) return;
  // 对方还没进来（或还没报身份）时不能申请：先把面板打开让他看到状态。
  if (!netState.peerSide) { togglePanel(true); return; }
  netState.swap = 'sent';
  renderSide();
  try { swapSend('ask'); } catch { /* 掉线时静默 */ }
}

/** 对方在问我：面板里出两条按钮，等他点。onYes / onNo 由 net-duo 传进来。 */
export function showSwapAsk(fromName, onYes, onNo) {
  netState.swap = 'asked';
  renderSide();
  if (!askEl) return;
  askEl.hidden = false;
  askEl.textContent = '';
  askEl.append(el('span', '', `${fromName || '对方'}想和你换个身份：换过去之后你住${sideName(otherSide(netState.side))}那边。`));
  const btns = el('div', 'nt-ask-btns');
  const yes = el('button', '', '同意交换');
  const no = el('button', 'nt-no', '还是算了');
  yes.addEventListener('click', () => { try { onYes?.(); } catch { /* 忽略 */ } });
  no.addEventListener('click', () => { try { onNo?.(); } catch { /* 忽略 */ } });
  btns.append(yes, no);
  askEl.appendChild(btns);
  // 面板没开也让人看得见：直接展开。
  if (panelEl?.hidden) togglePanel(true);
}

export function clearSwapAsk(message = '') {
  netState.swap = '';
  renderSide();
  if (!askEl) return;
  askEl.hidden = !message;
  askEl.textContent = message;
}

/**
 * 建面板。联机和双人共用。
 * @param {{onLeave?:Function, roomCode?:string, role?:string, side?:string}} options
 */
export function mountNetUI(options = {}) {
  if (barEl) return;
  onLeaveRoom = options.onLeave || null;

  const style = document.createElement('style');
  style.textContent = CSS_EXTRA;
  document.head.appendChild(style);

  // 右下角的联机条：和左边的养成状态条错开，不盖住 HUD 的 .pet-actions。
  barEl = el('div', 'nt-bar');
  barEl.id = 'ntBar';
  barEl.innerHTML = `
    <span class="nt-dot"></span>
    <span class="nt-count">屋里的人</span>
    <button class="nt-open" id="ntOpen">屋里的人 / 说话</button>`;
  document.body.appendChild(barEl);
  barEl.querySelector('#ntOpen').addEventListener('click', () => togglePanel(true));
  dotEl = barEl.querySelector('.nt-dot');

  const roomLine = options.roomCode
    ? `<div class="nt-room">房间号 <b>${escapeHtml(options.roomCode)}</b>${options.role === 'host' ? ' · 你是房主' : ''}</div>`
    : '';

  // 身份：进房时定一次，房内不能随手切 —— 只能发一个交换申请，对方同意才换。
  const sideLine = options.side
    ? `<div class="nt-side" id="ntSide">
         <span>你住 <b id="ntSideMe">—</b></span>
         <span class="nt-side-peer">对面 <b id="ntSidePeer">—</b></span>
         <button id="ntSwap" type="button">申请交换</button>
       </div>`
    : '';

  // 遮罩：点空白处也能关。之前面板贴在右下角、没有遮罩、又没有 ESC，
  // 玩家唯一的出口是那个小小的 ×，而 × 因为 CSS 优先级问题根本不生效。
  backdropEl = el('div', 'nt-backdrop');
  backdropEl.id = 'ntBackdrop';
  backdropEl.hidden = true;
  backdropEl.addEventListener('click', () => togglePanel(false));
  document.body.appendChild(backdropEl);

  panelEl = el('div', 'nt-panel');
  panelEl.id = 'ntPanel';
  panelEl.hidden = true;
  panelEl.innerHTML = `
    <div class="nt-head">
      <b>这间屋子</b>
      <button class="nt-close" id="ntClose">×</button>
    </div>
    ${roomLine}
    ${sideLine}
    <div class="nt-ask" id="ntAsk" hidden></div>
    <ul class="nt-list" id="ntList"></ul>
    <div class="nt-feed" id="ntFeed"></div>
    <div class="nt-talk">
      <div class="nt-msgs" id="ntMsgs"></div>
      <div class="nt-send">
        <input id="ntInput" maxlength="240" placeholder="跟对方说一句…" />
        <button id="ntSend">发送</button>
      </div>
    </div>`;
  document.body.appendChild(panelEl);
  listEl = panelEl.querySelector('#ntList');
  feedEl = panelEl.querySelector('#ntFeed');
  msgsEl = panelEl.querySelector('#ntMsgs');
  sideEl = panelEl.querySelector('#ntSide');
  askEl = panelEl.querySelector('#ntAsk');
  if (options.side) netState.side = options.side;
  panelEl.querySelector('#ntSwap')?.addEventListener('click', () => {
    requestSwap();
  });
  renderSide();

  panelEl.querySelector('#ntClose').addEventListener('click', () => togglePanel(false));

  // 双人时给一个"离开这间屋子"：回主菜单重新选玩法。
  // 单机/服务器模式下没有这个按钮（服务器模式离开等于关页面）。
  if (onLeaveRoom) {
    const foot = el('div', 'nt-foot');
    const leave = el('button', 'nt-leave', '离开这间屋子');
    leave.addEventListener('click', async () => {
      // 必须走 togglePanel：直接写 panelEl.hidden 会把遮罩留在屏幕上，
      // 玩家点「离开」之后整个页面蒙着一层灰，点哪儿都没反应。
      togglePanel(false);
      onLeaveRoom();
    });
    foot.appendChild(leave);
    panelEl.appendChild(foot);
  }

  const input = panelEl.querySelector('#ntInput');
  const send = () => {
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    sendNetMessage(text);
  };
  panelEl.querySelector('#ntSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });

  renderNet();
  renderNetMessages();
  setInterval(pollChat, 2500);

  netState.me = playerId();
  // 「指挥」那一栏点到的就是这个入口：开面板 + 发申请，避免玩家找不到按钮。
  globalThis.__netSwap = () => { togglePanel(true); requestSwap(); };
  // 验收探针：身份与交换是跨三层的状态，出问题时要能一眼看到网络层到底收到了什么。
  globalThis.__netDebug = () => ({
    side: netState.side,
    peerSide: netState.peerSide,
    swap: netState.swap,
    hasSideEl: !!sideEl,
    me: netState.me,
    players: netState.players.map((p) => ({ pid: p.pid, name: p.name }))
  });
  return { renderNet, togglePanel };
}

export function togglePanel(open) {
  if (!panelEl) return;
  panelEl.hidden = !open;
  if (backdropEl) backdropEl.hidden = !open;
  if (open) {
    renderNet();
    renderNetMessages();
    pollChat();
    panelEl.querySelector('#ntInput')?.focus();
  }
}

/** 面板现在开着吗 —— 给 ESC / 暂停菜单这类全局按键判断用。 */
export function isNetPanelOpen() {
  return !!panelEl && !panelEl.hidden;
}
