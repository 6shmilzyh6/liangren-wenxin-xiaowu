// 主菜单：单机 / 双人，在游戏里选。
//
// 之前版本按 location.protocol 判断模式 —— 双击打开就是单机，从服务器打开就是联机。
// 那等于把"玩法"绑在"你怎么启动"上，玩家根本没有选择权，也谈不上成品。
// 现在所有入口都先进这张菜单，模式是玩家点的。
//
// 菜单同时负责把网络连起来：连不上就停在这儿报错、可以重试，
// 而不是进了屋子才发现对面没人。
//
// 视觉上这是一块"片头"：左边是活着的她，右边是这间屋子的门。
// 立绘用 assets/pet/idle.webm（静音循环），拿不到 webm 就退回 idle.png —— 两者在
// file:// 下都能正常显示（不能当 WebGL 贴图，但 <video>/<img> 本身没问题）。
import { playerName, setPlayerName, playerId, mySide, setMySide, nameSettled, DEFAULT_NAME } from './identity.js';
import { normalizeRoomCode } from './duo-link.js';

const CSS = `
/* ── 底色：一张纸，不是三团极光 + 网格 + 暗角 ─────────────────────
   原来这里有 7 层装饰（三团 blur 70px 的极光、细网格、径向暗角、158° 渐变、
   ::before 高光、渐变文字裁切、hover 扫光）。叠到第七层的时候，
   它已经不是"氛围"，而是"AI 生成图"的指纹。现在只留：纸底 + 一条细纹。 */
#gxMenu{position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
  padding:26px; overflow:auto; color:#2f2119;
  /* 字体栈不再各写一遍：有皮肤就跟着 --font-ui，没有就用同一套兜底 */
  font:13px/1.6 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif);
  background:#f6f0e4; isolation:isolate}

#gxMenu .m-scene{position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:repeating-linear-gradient(90deg, rgba(90,68,48,.05) 0 1px, transparent 1px 4px)}

/* ── 舞台：左立绘、右门 ─────────────────────────────────────────── */
#gxMenu .m-stage{position:relative; z-index:1; display:flex; align-items:center; gap:clamp(18px,4vw,58px);
  width:min(96vw,1120px); max-width:1120px}

#gxMenu .m-showcase{position:relative; flex:0 0 auto; width:clamp(220px,32vw,392px);
  display:flex; flex-direction:column; align-items:center; gap:12px}
/* 双人站位：俩立绘手牵手，左边小蓝鱼、右边 Claude 收 0.92 再下错 6px，
   脚踩同一条地平线（flex-end），谁都不抢戏。只有纸和陶，没有光晕。
   牵手靠两件事叠出来（不重画立绘）：
     1) 两侧各向中间压 3.5%，手臂区自然重叠，读作「挨着」；
     2) 中线上盖一枚 hand-hold.svg，无论立绘怎么动，读到的都是「牵着」。 */
#gxMenu .m-pair{position:relative; width:100%; display:flex; align-items:flex-end;
  justify-content:center; gap:0}
#gxMenu .m-pair .m-actor:first-child{margin-right:-3.5%}
/* 手：中线上的一枚线稿，符号代替解剖。单人时没有「牵」的对象，整枚不画。 */
#gxMenu .m-pair::after{content:""; position:absolute; left:50%; bottom:16%;
  width:9%; aspect-ratio:1.6/1; transform:translateX(-50%) rotate(-6deg);
  background:url("./assets/ui/hand-hold.svg") center/contain no-repeat;
  pointer-events:none; filter:drop-shadow(0 2px 3px rgba(90,68,48,.22))}
#gxMenu .m-pair.m-solo::after{display:none}
#gxMenu .m-actor{position:relative; flex:1 1 0; min-width:0;
  display:flex; flex-direction:column; align-items:center}
/* 0.92 的伸缩比 = Claude 那侧窄一点、矮一点；只剩一人时自动长满这行 */
#gxMenu .m-actor-b{flex:0.92 1 0; transform:translateY(6px); margin-left:-3.5%}
#gxMenu .m-actor[hidden]{display:none}
/* 只剩一个人时，别让他还缩在角落、也别还偏下：整条长满、回正 */
#gxMenu .m-pair.m-solo .m-actor{flex:1 1 0}
#gxMenu .m-pair.m-solo .m-actor-b{transform:none}
#gxMenu .m-np-row.m-solo .m-np-cell-b{flex:1 1 0}
/* 画面框：定死 16/9，孩子绝对定位铺满 —— 这样某侧 png 404 / video 没起来时，
   坏图不会把框撑变形，两张立绘永远同尺寸、对称。 */
#gxMenu .m-live-wrap{position:relative; width:100%; aspect-ratio:16/9; overflow:hidden}
#gxMenu .m-live,
#gxMenu .m-live-post{position:absolute; inset:0; width:100%; height:100%; object-fit:contain}
/* 名字牌：两张牌一行对齐立绘，房间描述只写一次、居中压在两张牌下面 */
#gxMenu .m-nameplate{width:100%; display:flex; flex-direction:column; align-items:center;
  gap:3px; text-align:center}
#gxMenu .m-np-row{width:100%; display:flex; align-items:flex-start; justify-content:center;
  gap:clamp(6px,1.2vw,14px)}
#gxMenu .m-np-cell{flex:1 1 0; min-width:0}
#gxMenu .m-np-cell-b{flex:0.92 1 0}
#gxMenu .m-np-cell[hidden]{display:none}
#gxMenu .m-np-t{font-size:13px; letter-spacing:.28em; color:#2f2119; text-indent:.28em;
  white-space:nowrap}
#gxMenu .m-np-d{font-size:11px; color:#97836d; letter-spacing:.08em}

/* ── 门：右侧面板 ──────────────────────────────────────────────── */
#gxMenu .m-panel{position:relative; flex:1 1 auto; min-width:0; width:min(94vw,558px);
  border-radius:16px; padding:28px 28px 22px;
  background:#fbf7ee;
  border:1px solid #d9cbb5;
  box-shadow:0 18px 44px rgba(90,68,48,.20)}

#gxMenu h1{margin:0; font-size:19px; letter-spacing:.06em; font-weight:700; color:#2f2119}
#gxMenu .m-sub{margin:9px 0 22px; color:#6b5847; font-size:12px; letter-spacing:.02em}
#gxMenu .m-sub em{font-style:normal; color:#af5235}

#gxMenu .m-name{display:flex; align-items:center; gap:10px; margin:0 0 18px}
#gxMenu .m-name label{font-size:12px; color:#6b5847; white-space:nowrap; letter-spacing:.06em}
#gxMenu .m-name input{flex:1; min-width:0}
#gxMenu .m-name.todo input{border-color:#d2714a}
#gxMenu .m-name .m-need{font-size:11px; color:#d2714a; white-space:nowrap}
#gxMenu .m-name .m-ok{font-size:11px; color:#6f8468; white-space:nowrap}
#gxMenu input{background:#fffdf7; border:1px solid #d9cbb5; border-radius:10px;
  padding:10px 12px; color:#2f2119; font-size:13px; font-family:inherit}
#gxMenu input::placeholder{color:#97836d}
#gxMenu input:focus-visible{border-color:#d2714a; outline:2px solid #d2714a; outline-offset:2px}

/* 焦点态：原来这一页 588 行里 0 条焦点样式，键盘用户完全看不出在哪。
   统一 2px 赤陶环，跟房间页同一条规则。 */
#gxMenu button:focus-visible,
#gxMenu summary:focus-visible,
#gxMenu a:focus-visible{outline:2px solid #d2714a; outline-offset:2px; border-radius:10px}

/* 两个玩法：图标块 + 标题/说明 + 箭头。没有扫光、没有 skew。 */
#gxMenu .m-opt{position:relative; display:flex; align-items:center; gap:14px; width:100%; text-align:left;
  padding:16px 17px; margin:0 0 10px; border-radius:10px; cursor:pointer;
  border:1px solid #d9cbb5; background:#f2ebdd; color:#2f2119;
  font:inherit; transition:border-color 120ms cubic-bezier(.2,.7,.2,1),
    background 120ms cubic-bezier(.2,.7,.2,1), box-shadow 120ms cubic-bezier(.2,.7,.2,1)}
#gxMenu .m-opt:hover:not(:disabled){border-color:#d2714a; background:#fbf7ee;
  box-shadow:0 6px 18px rgba(90,68,48,.14)}
#gxMenu .m-opt:active:not(:disabled){background:#ece3d3}
#gxMenu .m-opt:disabled{opacity:.45; cursor:default}
#gxMenu .m-opt .m-ico{width:42px; height:42px; flex:0 0 42px; border-radius:10px; display:grid;
  place-items:center; line-height:1; background:#e0d5c1; color:#af5235}
#gxMenu .m-opt .m-ico svg{width:20px; height:20px; stroke:currentColor; fill:none;
  stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; display:block}
#gxMenu .m-opt.duo .m-ico{background:rgba(224,164,74,.24); color:#8a5e1f}
#gxMenu .m-opt.solo .m-ico{background:rgba(111,132,104,.20); color:#4d5f47}
#gxMenu .m-opt .m-body{flex:1 1 auto; min-width:0}
#gxMenu .m-opt .m-t{display:block; font-size:15px; font-weight:600; letter-spacing:.02em}
#gxMenu .m-opt .m-d{display:block; margin-top:3px; font-size:12px; color:#6b5847}
#gxMenu .m-opt .m-go{flex:0 0 auto; color:#97836d; font-size:15px; transition:transform 120ms cubic-bezier(.2,.7,.2,1), color 120ms cubic-bezier(.2,.7,.2,1)}
#gxMenu .m-opt:hover:not(:disabled) .m-go{transform:translateX(3px); color:#d2714a}

/* 分页头、返回、侧边选择、房间号 */
#gxMenu .m-back{border:0; background:none; color:#6b5847; font:inherit; font-size:12px;
  cursor:pointer; padding:2px 0; margin-bottom:14px; transition:color 120ms}
#gxMenu .m-back:hover{color:#2f2119}
#gxMenu .m-row{display:flex; gap:10px}
#gxMenu .m-row > *{flex:1}
#gxMenu .m-code{letter-spacing:.3em; text-transform:uppercase; text-align:center;
  font-size:19px; font-weight:700; font-variant-numeric:tabular-nums}
#gxMenu .m-btn{border:1px solid #c0ad93; background:#f2ebdd; color:#2f2119;
  border-radius:10px; padding:11px 16px; font:inherit; font-size:13px; cursor:pointer;
  transition:background 120ms cubic-bezier(.2,.7,.2,1), border-color 120ms cubic-bezier(.2,.7,.2,1)}
#gxMenu .m-btn:hover{background:#ece3d3; border-color:#d2714a}
#gxMenu .m-btn.primary{background:#d2714a; border-color:#d2714a; color:#fffaf3; font-weight:600}
#gxMenu .m-btn.primary:hover{background:#af5235; border-color:#af5235}
#gxMenu .m-btn:disabled{opacity:.5; cursor:default}

#gxMenu .m-side{margin:2px 0 16px}
#gxMenu .m-side-lbl{display:block; font-size:12px; color:#6b5847; margin-bottom:9px; letter-spacing:.05em}
#gxMenu .m-side-btns{display:flex; gap:10px}
#gxMenu .m-side-btn{flex:1; cursor:pointer; padding:12px 14px; border-radius:10px; font:inherit; font-size:13px;
  display:inline-flex; align-items:center; justify-content:center; gap:7px;
  border:1px solid #d9cbb5; background:#f2ebdd; color:#2f2119;
  transition:background 120ms cubic-bezier(.2,.7,.2,1), border-color 120ms cubic-bezier(.2,.7,.2,1)}
#gxMenu .m-side-btn svg{width:15px; height:15px; stroke:currentColor; fill:none;
  stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; display:block; flex:none}
#gxMenu .m-side-btn:hover{border-color:#c0ad93; background:#ece3d3}
#gxMenu .m-side-btn.on{border-color:#d2714a; background:rgba(210,113,74,.14); color:#af5235; font-weight:600}

#gxMenu .m-status{margin:14px 0 0; padding:11px 13px; border-radius:10px; font-size:12px;
  background:#f2ebdd; border:1px solid #d9cbb5; color:#6b5847;
  display:none; align-items:center; gap:10px}
#gxMenu .m-status.on{display:flex}
#gxMenu .m-status.err{border-color:#a8432f; color:#a8432f}
#gxMenu .m-status.ok{border-color:#6f8468; color:#4d5f47}
#gxMenu .m-dot{width:7px; height:7px; border-radius:50%; background:#d2714a; flex:0 0 7px;
  animation:m-pulse 1.4s ease-in-out infinite}
#gxMenu .m-status.err .m-dot{background:#a8432f; animation:none}
#gxMenu .m-status.ok .m-dot{background:#6f8468; animation:none}
@keyframes m-pulse{0%,100%{opacity:.35}50%{opacity:1}}

#gxMenu .m-room{margin:16px 0 0; padding:17px; border-radius:10px; text-align:center;
  background:#f2ebdd; border:1px solid #c0ad93}
#gxMenu .m-room .m-lbl{font-size:11px; color:#97836d; letter-spacing:.16em}
#gxMenu .m-room .m-val{font-size:19px; font-weight:700; letter-spacing:.34em; text-indent:.34em;
  color:#2f2119; margin:7px 0 3px; font-variant-numeric:tabular-nums}
#gxMenu .m-fine{margin:16px 0 0; font-size:11px; color:#97836d; line-height:1.8}
#gxMenu .m-warn{margin:0 0 16px; padding:11px 13px; border-radius:10px; font-size:12px; line-height:1.7;
  background:rgba(224,164,74,.16); border:1px solid #e0a44a; color:#6b4a1c}
#gxMenu .m-warn b{display:block; margin-bottom:4px; font-size:13px; color:#5a3d13}
#gxMenu .m-hide{display:none !important}

/* 窄屏（笔记本竖屏 / 手机）：两张仍并排，总宽收到 min(78vw,300px)，
   名字牌字号降一档；两侧都别留空白块 */
@media (max-width:860px){
  #gxMenu .m-stage{flex-direction:column; gap:12px}
  #gxMenu .m-showcase{width:min(78vw,300px)}
  #gxMenu .m-pair{gap:0}
  /* 窄屏手要放大一点，否则 9% 只有 22px，看不清 */
  #gxMenu .m-pair::after{width:11%; bottom:15%}
  #gxMenu .m-np-row{gap:6px}
  #gxMenu .m-np-t{font-size:11px; letter-spacing:.2em; text-indent:.2em}
  #gxMenu .m-panel{width:min(94vw,558px); padding:22px 18px 18px}
  #gxMenu h1{font-size:19px}
}
@media (prefers-reduced-motion:reduce){
  #gxMenu .m-dot{animation:none}
  #gxMenu .m-opt:hover:not(:disabled) .m-go{transform:none}
}
`;

/* 旧版深蓝夜幕（三团极光 / 网格 / 暗角 / 158° 渐变 / ::before 高光 /
   渐变标题裁切 / hover 扫光 / m-rise 入场）已经整段删除，
   对应的新规则写在上面的 CSS 块里。不要再往回加。 */

const el = (tag, cls = '', text = '') => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

// 图标：24×24 线稿 SVG，stroke=currentColor，尺寸跟着字号走。
// 原来这里塞的是 emoji（🐟 / 👑 / 🏠 / 🖧），字形和配色由系统字体决定，
// Windows 上是彩色塑料，和纸/陶这套皮肤压根不是一套东西。
const ICON = {
  solo: '<path d="M3 12c2.6-3.6 5.8-5.4 9.6-5.4 3.4 0 6.2 2.1 8.4 5.4-2.2 3.3-5 5.4-8.4 5.4C8.8 17.4 5.6 15.6 3 12Z"/><path d="M6.6 12h.01"/><path d="M3 12 1.5 8.8"/><path d="M3 12 1.5 15.2"/>',
  duo: '<path d="M4 11 12 4l8 7"/><path d="M6.5 9.6V20h11V9.6"/><path d="M10 20v-5h4v5"/>',
  her: '<path d="M3 12c2.6-3.6 5.8-5.4 9.6-5.4 3.4 0 6.2 2.1 8.4 5.4-2.2 3.3-5 5.4-8.4 5.4C8.8 17.4 5.6 15.6 3 12Z"/><path d="M6.6 12h.01"/>',
  claude: '<path d="M4 18h16"/><path d="M4 18 3 8l4.5 3.5L12 6l4.5 5.5L21 8l-1 10"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7.5 7h.01"/><path d="M7.5 17h.01"/>'
};

/** 造一个图标节点。id 找不到时返回空 span，不抛错。 */
function icon(id) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${ICON[id] || ICON.solo}</svg>`;
  return span;
}

const webRTCReady = () =>
  typeof globalThis.RTCPeerConnection === 'function' && typeof globalThis.RTCSessionDescription === 'function';

/** 按本地时间说一句当下的事实。原来那七句是拟人旁白（「她刚伸了个懒腰」），
 *  读起来像文案生成器；现在只报时间与场景状态。 */
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '凌晨 · 屋里只开着走廊的灯';
  if (h < 9) return '早上 · 客厅朝东，光线低';
  if (h < 12) return '上午 · 阳台上有太阳';
  if (h < 14) return '中午 · 厨房那边有动静';
  if (h < 18) return '下午 · 适合去后院';
  if (h < 22) return '晚上 · 灯已经开了';
  return '深夜 · 屋里安静';
}

/**
 * 弹出主菜单并等到玩家做出选择、且需要联网的模式已经连上为止。
 *
 * @param {{onStatus?:Function}} options
 * @returns {Promise<{mode:'solo'|'host'|'guest'|'online', code?:string, name:string}>}
 */
export function showModeMenu(options = {}) {
  if (document.getElementById('gxMenu')) return Promise.resolve(null);

  if (!document.getElementById('gxMenuCss')) {
    const style = document.createElement('style');
    style.id = 'gxMenuCss';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const overlay = el('div', '');
  overlay.id = 'gxMenu';

  // ── 背景：一层纸纹就够了（原来这里是 5 个装饰 div） ──
  overlay.appendChild(el('div', 'm-scene'));

  // ── 左：两位，并排站着（左小蓝鱼、右 Claude） ──
  // 每侧各自一条 poster→live 降级链：webm 出了 loadeddata 才露 video；
  // video 报错就撤掉它、露出 png；png 也 404（img 的 error）就把这一侧整块撤掉，
  // 剩下那侧靠 .m-pair 的 justify-content:center 自然居中，不留空白块。
  const showcase = el('div', 'm-showcase');
  const pair = el('div', 'm-pair');
  const npRow = el('div', 'm-np-row');
  // 某一侧塌了之后补一下标记：剩一个人时整条长满、回正，不留半格空白
  let syncSolo = () => {};

  const buildActor = (key, name, webm, png) => {
    const root = el('div', key === 'b' ? 'm-actor m-actor-b' : 'm-actor');
    const wrap = el('div', 'm-live-wrap');

    const poster = document.createElement('img');
    poster.className = 'm-live-post';
    poster.src = png;
    poster.alt = name;
    poster.draggable = false;

    const live = document.createElement('video');
    live.className = 'm-live';
    live.src = webm;
    live.muted = true;
    live.loop = true;
    live.autoplay = true;
    live.playsInline = true;
    live.setAttribute('muted', '');
    live.setAttribute('playsinline', '');
    live.preload = 'auto';
    live.style.opacity = '0';

    const cell = el('div', key === 'b' ? 'm-np-cell m-np-cell-b' : 'm-np-cell');
    cell.append(el('div', 'm-np-t', name));

    // 立绘和名字牌一起撤，别让牌悬在空气里；但 video 已经出画面时不能撤。
    let videoShown = false;
    let posterDead = false;
    const drop = () => {
      if (videoShown) return;
      root.hidden = true;
      cell.hidden = true;
      syncSolo();
    };
    const keep = () => {
      root.hidden = false;
      cell.hidden = false;
      syncSolo();
    };

    live.addEventListener('loadeddata', () => {
      videoShown = true;
      keep();
      live.style.opacity = '1';
      poster.style.opacity = '0';
    });
    live.addEventListener('error', () => {
      live.remove();
      if (posterDead) drop(); else poster.style.opacity = '1';
    });
    poster.addEventListener('error', () => { posterDead = true; drop(); });
    const kick = live.play?.();
    if (kick && typeof kick.catch === 'function') kick.catch(() => { live.style.opacity = '0'; });

    wrap.append(poster, live);
    root.append(wrap);
    return { root, cell };
  };

  const actorA = buildActor('a', '小 蓝 鱼', './assets/pet/idle.webm', './assets/pet/idle.png');
  const actorB = buildActor('b', '克劳德',
    './assets/pet/claude/claude_idle.webm', './assets/pet/claude/claude_idle.png');

  pair.append(actorA.root, actorB.root);

  // 名字牌：两张牌按立绘的宽度对齐，房间描述只写一次，居中压在两张牌下面
  npRow.append(actorA.cell, actorB.cell);
  const plate = el('div', 'm-nameplate');
  plate.append(npRow, el('div', 'm-np-d', '大平层 · 客厅 · 灯亮着'));
  showcase.append(pair, plate);
  overlay.appendChild(showcase);

  // 剩一个人时给个 m-solo 标记：那一侧长满整条、Claude 的回正不偏下
  syncSolo = () => {
    const solo = actorA.root.hidden !== actorB.root.hidden;
    pair.classList.toggle('m-solo', solo);
    npRow.classList.toggle('m-solo', solo);
  };

  // ── 右：门 ──
  // 同时挂 m-card：仓库里的自检脚本（smoke-menu / smoke-duo / menu-drive）都按
  // '#gxMenu .m-card' 找这块面板，留着这个类名就不用改一整套脚本。
  const panel = el('div', 'm-panel m-card');
  overlay.appendChild(panel);
  const card = panel;
  document.body.appendChild(overlay);

  // 鼠标轻微视差：整个舞台跟着偏一点点，画面就"活"了。
  const stage = el('div', 'm-stage');
  overlay.insertBefore(stage, showcase);
  stage.append(showcase, panel);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    overlay.addEventListener('pointermove', (e) => {
      const dx = (e.clientX / innerWidth - 0.5) * 14;
      const dy = (e.clientY / innerHeight - 0.5) * 10;
      showcase.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    });
    overlay.addEventListener('pointerleave', () => { showcase.style.transform = ''; });
  }

  // 名字：进门之前必须定一次。
  // 以前空着会静默回落成「小屋访客」，两个人都不改名时就都叫这个 ——
  // 事件面板分不清谁做的，按名字记的账也会合并成一条。
  // 所以这里不给「跳过」，只有填了才能往下走；进去以后还能改（面板里的名字格）。
  const nameRow = el('div', 'm-name');
  nameRow.append(el('label', '', '你的名字'));
  const nameInput = document.createElement('input');
  nameInput.maxLength = 12;
  const saved = playerName();
  nameInput.value = saved === DEFAULT_NAME ? '' : saved;
  nameInput.placeholder = '比如：阿岚';
  nameInput.autocomplete = 'off';
  nameRow.appendChild(nameInput);
  const nameHint = el('span', 'm-need', nameSettled() ? '' : '得先有个名字');
  nameRow.appendChild(nameHint);
  nameRow.classList.toggle('todo', !nameSettled());

  function refreshNameHint() {
    const v = (nameInput.value || '').trim();
    const ok = v.length > 0;
    nameRow.classList.toggle('todo', !ok);
    nameHint.className = ok ? 'm-ok' : 'm-need';
    nameHint.textContent = ok ? '好' : '得先有个名字';
    return ok;
  }
  nameInput.addEventListener('input', refreshNameHint);
  refreshNameHint();

  // 这一端住哪一侧：记在 localStorage，进房前定一次；房内只能双方同意才互换。
  let pickedSide = mySide() || 'her';

  const status = el('div', 'm-status');
  status.append(el('span', 'm-dot'), el('span', 'm-text', ''));

  function setStatus(text, kind = '') {
    status.className = `m-status on ${kind}`.trim();
    status.querySelector('.m-text').textContent = text;
  }
  function clearStatus() { status.className = 'm-status'; }

  // 判断能不能上双人：WebRTC 不可用（极老的浏览器）就别给这个选项，
  // 免得玩家点了之后卡在"连接中"。
  const canDuo = webRTCReady();
  // 「连联机服务器」只有在**真的有人开了服务器**时才该出现。
  // 不能只看协议：正式包是用 开始玩.exe 起一个本机静态服务再打开页面的，
  // 那也是一个 http:// 地址，但背后没有任何 /api 实现，选它必炸。
  // 所以这里真的去问一句 /api/home/state。
  let serverAvailable = false;

  async function probeServer() {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      const r = await fetch('/api/home/state', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return false;
      const ct = r.headers.get('content-type') || '';
      if (!/json/.test(ct)) return false;
      const j = await r.json();
      return !!(j && (j.room !== undefined || j.affection !== undefined || j.state !== undefined));
    } catch {
      return false;
    }
  }

  function fileWarning() {
    if (location.protocol !== 'file:') return null;
    const box = el('div', 'm-warn');
    box.append(
      el('b', '', '人物立绘和 3D 模型会是空白的'),
      el('span', '', '你是直接双击 index.html 打开的。浏览器不允许 file:// 页面把本地视频/图片当贴图用。'
        + '请关掉这一页，改双击同一个文件夹里的「开始玩.exe」。')
    );
    return box;
  }

  /** 一个玩法按钮：图标块 + 标题/说明 + 右侧箭头。
   *  第二参数收的是图标 id（见上面 ICON 表），不再是 emoji 字符。 */
  function modeButton(cls, iconId, title, desc) {
    const b = el('button', `m-opt ${cls}`);
    b.type = 'button';
    const ico = el('span', 'm-ico');
    ico.appendChild(icon(iconId));
    b.append(ico);
    const body = el('span', 'm-body');
    body.append(el('span', 'm-t', title), el('span', 'm-d', desc));
    b.append(body, el('span', 'm-go', '→'));
    return b;
  }

  function renderHome() {
    card.textContent = '';
    card.append(
      el('h1', '', '两人温馨小屋'),
      el('p', 'm-sub', greeting()),
      nameRow
    );

    const solo = modeButton('solo', 'solo', '一个人住',
      '不用联网，进度存在这台设备上。想玩多久玩多久。');
    solo.addEventListener('click', () => {
      if (!requireName()) return;
      const name = commitName();
      finish({ mode: 'solo', name });
    });
    card.appendChild(solo);

    const duo = modeButton('duo', 'duo', '两个人住',
      '不管对方在哪、用的是什么网，给个房间号就能进同一间屋子。');
    if (!canDuo) {
      duo.disabled = true;
      duo.querySelector('.m-d').textContent = '这个浏览器连不了别人。换 Edge 或者 Chrome 开。';
    }
    duo.addEventListener('click', renderDuo);
    card.appendChild(duo);

    // 直接从 index.html 双击打开时给一句明白的提示，别让玩家以为游戏坏了。
    const warn = fileWarning();
    if (warn) card.appendChild(warn);

    // 从服务器打开时，多给一个"连服务器"的选项：老玩法还在，但它不再是唯一出路。
    if (serverAvailable) {
      const srv = modeButton('m-srv', 'server', '连联机服务器',
        `这屋子挂在 ${location.host} 上。谁打开都进同一个家。`);
      srv.addEventListener('click', () => {
        if (!requireName()) return;
        finish({ mode: 'online', name: commitName() });
      });
      card.appendChild(srv);
    }

    card.appendChild(status);
    card.appendChild(el('p', 'm-fine',
      '屋子在开房那台电脑上长着：等级、亲密度、菜园、她俩今天的脾气，都在那边。'
      + '进去的人看到的是一模一样的家。'));
  }

  function renderDuo() {
    card.textContent = '';
    const back = el('button', 'm-back', '← 换个玩法');
    back.addEventListener('click', () => { clearStatus(); renderHome(); });

    card.append(
      back,
      el('h1', '', '两个人住'),
      el('p', 'm-sub', '你先开一间，把号发给他；他选「进别人的屋」，输进去就成。')
    );

    // 住哪一侧：进房前定一次。进去之后不能随手切，只能向对方发交换申请。
    const sideRow = el('div', 'm-side');
    sideRow.append(el('span', 'm-side-lbl', '你住哪一侧'));
    const sideBtns = el('div', 'm-side-btns');
    // 侧边按钮也是「图标 + 文字」：图标用 icon() 注入，文字单独放一段，
    // 不能再往 textContent 里塞 emoji（那会连图标一起替换掉）。
    for (const [key, iconId, label, hint] of [
      ['her', 'her', '小蓝鱼这边', '指挥小蓝鱼，页面上是她那一侧'],
      ['claude', 'claude', '小公主这边', '指挥小公主，页面换成暖陶纸那一套']
    ]) {
      const b = el('button', `m-side-btn${pickedSide === key ? ' on' : ''}`);
      b.type = 'button';
      b.title = hint;
      b.dataset.side = key;
      b.append(icon(iconId), el('span', '', label));
      b.addEventListener('click', () => {
        pickedSide = key;
        sideBtns.querySelectorAll('.m-side-btn').forEach((n) => n.classList.toggle('on', n.dataset.side === key));
      });
      sideBtns.appendChild(b);
    }
    sideRow.appendChild(sideBtns);
    card.appendChild(sideRow);
    card.appendChild(el('p', 'm-fine', '进去就定了，不能随手换。真要换，按「指挥」发个申请，等他点头。'));

    // 开房
    const host = modeButton('duo', 'duo', '开一间房',
      '屋子长在这台电脑上。把号发给他，他进来住。');
    host.addEventListener('click', () => doHost(host));
    card.appendChild(host);

    // 加入
    const joinBox = el('div', '');
    const codeInput = document.createElement('input');
    codeInput.className = 'm-code';
    codeInput.maxLength = 6;
    codeInput.placeholder = '房间号';
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    codeInput.addEventListener('input', () => {
      const at = codeInput.selectionStart;
      codeInput.value = normalizeRoomCode(codeInput.value);
      codeInput.setSelectionRange(at, at);
    });
    const joinRow = el('div', 'm-row');
    const joinBtn = el('button', 'm-btn primary', '进这间屋子');
    joinBtn.addEventListener('click', () => doJoin());
    joinRow.appendChild(joinBtn);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

    const joinLabel = el('label', '', '对方给你的 6 位房间号');
    joinLabel.style.cssText = 'display:block;font-size:12px;color:#6b5847;margin:16px 0 8px;letter-spacing:.05em';
    joinBox.append(joinLabel, codeInput, joinRow);
    card.appendChild(joinBox);
    card.appendChild(status);

    function lock(flag) {
      host.disabled = flag;
      joinBtn.disabled = flag;
      codeInput.disabled = flag;
      nameInput.disabled = flag;
    }

    async function doHost(buttonEl) {
      if (!requireName()) return;
      const name = commitName();
      lock(true);
      setStatus('正在开门…');
      buttonEl.querySelector('.m-t').textContent = '正在开门…';
      try {
        const { startDuo } = await import('./net-duo.js');
        // 房间号撞车（unavailable-id）会自动换一个再来，最多三次。
        let out = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            // 身份要点名传进去：网络层拿它当"我住哪一侧"，进房之后就只能靠对方同意才换。
            out = await startDuo('host', {
              side: pickedSide,
              onStatus: (state, detail) => options.onStatus?.(state, detail)
            });
            break;
          } catch (err) {
            if (err?.retryable && attempt < 2) continue;
            throw err;
          }
        }
        if (!out) throw new Error('开门失败');
        renderRoom(out.code, { name });
      } catch (err) {
        lock(false);
        buttonEl.querySelector('.m-t').textContent = '开一间房';
        setStatus(`开房失败：${err?.message || err}。`, 'err');
      }
    }

    async function doJoin() {
      const code = normalizeRoomCode(codeInput.value);
      if (code.length !== 6) { setStatus('房间号是 6 位。', 'err'); codeInput.focus(); return; }
      if (!requireName()) return;
      const name = commitName();
      lock(true);
      setStatus(`正在连 ${code}…`);
      joinBtn.textContent = '正在连…';
      try {
        // 慢一拍的重试在 duo-link 的 join 里做（同一个 peer 上再 connect 一次）。
        // 这里不能重开一次 startDuo：那会多挂一层 fetch 包装，前一层的 link 已经死了。
        const { startDuo } = await import('./net-duo.js');
        await startDuo('guest', { code, side: pickedSide, onStatus: (state, detail) => options.onStatus?.(state, detail) });
        setStatus('连上了，正在进屋…', 'ok');
        setTimeout(() => finish({ mode: 'guest', code, name }), 320);
      } catch (err) {
        lock(false);
        joinBtn.textContent = '进这间屋子';
        setStatus(`没连上：${err?.message || err}。号对不对？对方开着这间屋吗？`, 'err');
      }
    }

    function renderRoom(code, { name }) {
      card.textContent = '';
      card.append(
        el('h1', '', '屋子开好了'),
        el('p', 'm-sub', `把这 6 位号发给对方（你是 ${name}）。`)
      );
      const room = el('div', 'm-room');
      room.append(el('div', 'm-lbl', '房 间 号'), el('div', 'm-val', code));
      card.appendChild(room);

      const copyRow = el('div', 'm-row');
      copyRow.style.marginTop = '14px';
      const copy = el('button', 'm-btn', '复制房间号');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); copy.textContent = '已复制'; }
        catch { copy.textContent = '复制不了，手抄一下吧'; }
        setTimeout(() => { copy.textContent = '复制房间号'; }, 1600);
      });
      const go = el('button', 'm-btn primary', '先进去等对方');
      go.addEventListener('click', () => finish({ mode: 'host', code, name }));
      copyRow.append(copy, go);
      card.appendChild(copyRow);

      const wait = el('div', 'm-status on');
      wait.append(el('span', 'm-dot'), el('span', 'm-text', '等对方进来…（你现在就可以开始玩，对方一进来就是同一间屋子）'));
      card.appendChild(wait);
      card.appendChild(el('p', 'm-fine',
        '一间房只坐一个人。对方进来之前你可以先自己照顾她，进度不会因为对方加入而重来。'));
    }
  }

  function commitName() {
    const value = (nameInput.value || '').trim().slice(0, 12);
    const name = value || DEFAULT_NAME;
    setPlayerName(name);
    return name;
  }

  /** 没填名字就别放行：按钮先抖一下 + 把光标放回输入框，比弹窗打断轻。 */
  function requireName() {
    if ((nameInput.value || '').trim()) return true;
    nameRow.classList.add('todo');
    nameHint.className = 'm-need';
    nameHint.textContent = '得先有个名字';
    nameInput.focus();
    try {
      nameInput.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' },
          { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 220, easing: 'ease-out' }
      );
    } catch { /* 老浏览器没有 animate，忽略 */ }
    return false;
  }

  let settled = false;
  function finish(result) {
    if (settled) return;
    settled = true;
    // 定下的那一侧跟着结果一起走：进房之后 app.js 就锁在这一侧。
    if (result && (result.mode === 'host' || result.mode === 'guest')) {
      result.side = setMySide(pickedSide) || pickedSide;
    }
    overlay.style.transition = 'opacity .3s';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 320);
    resolve(result);
  }

  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  renderHome();
  setTimeout(() => nameInput.focus(), 260);
  // 「连联机服务器」是异步探测出来的：先渲染菜单别让玩家干等，
  // 探到了再补上那一行（菜单可能已经被点走了，那就什么都不用做）。
  probeServer().then((yes) => {
    if (!yes || settled || !overlay.isConnected) return;
    serverAvailable = true;
    if (!card.querySelector('.m-srv')) renderHome();
  });
  // 方便调试：直接在控制台里跳过菜单
  globalThis.__gameMenu = { finish, renderHome, renderDuo };
  return promise;
}

export { playerId };
