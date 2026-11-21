// 游戏壳：开局引导、等级条、每日任务、成就、签到、存档导出、离线结算报告。
//
// 设计约束（与既有 HUD 共存，不遮挡）：
//   · 左上 .her-panel、右上 .events-panel、右下 .pet-actions、底部中央 .cam-bar、
//     左下 .info（点场景物件时才出现）；
//   · 所以状态条只占「左下角最底」一条，面板是覆盖式卡片，关掉就消失；
//   · 开场引导是独立全屏层，z-index 高于 #loading(20)。
import { profile, DAILY_TASKS, ACHIEVEMENTS, levelOf, stageOf } from './profile.js';
import { store } from '../engine/storage.js';
import { runCheat, cheatHelp, CHEAT_NAMES } from './cheats.js';

// 'offline' = file:// 双击打开；'online' = 通过服务器地址打开，两人共享一份存档。
// shellMode 决定"存档归谁""帮助里怎么写""开场白说什么"。
//   solo  = 一个人玩，进度在这台设备上；
//   duo   = 两个人住（P2P），进度在开房那台电脑上；
//   online= 连联机服务器，进度在服务器上。
let shellMode = 'solo';
// 双人模式下的身份与房间信息，由 main.js 传进来；单机时是 null。
let duoInfo = null;

// 这一层样式会被注入到游戏页里，那一页不一定加载 skin-desk.css，
// 所以每个色值都写成 var(--令牌, 兜底值)：有皮肤就跟皮肤走，没有就退回同一套纸/陶值。
// 原来这里是深蓝玻璃（17 处 rgba(180,210,240,·) + 3 处 backdrop-filter + 渐变进度条），
// 跟菜单页的纸面完全不是一套，属于"同一套样式重写第五遍"。
const CSS = `
#gxBar{position:fixed; left:20px; bottom:18px; z-index:19; display:flex; align-items:center; gap:10px;
  padding:9px 13px; border-radius:var(--r-2,10px); border:1px solid var(--line,#d9cbb5);
  background:var(--paper,#f6f0e4); color:var(--ink,#2f2119);
  box-shadow:var(--sh-2,0 4px 14px rgba(90,68,48,.14)); cursor:pointer; user-select:none;
  font:13px/1.4 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif); transition:border-color .12s}
#gxBar:hover{border-color:var(--line-2,#c0ad93)}
#gxBar .gx-lv{display:flex; flex-direction:column; line-height:1.15}
#gxBar .gx-lv b{font-size:var(--fs-4,15px); letter-spacing:.02em}
#gxBar .gx-lv span{font-size:var(--fs-1,11px); color:var(--ink-3,#97836d); letter-spacing:.12em}
#gxBar .gx-sep{width:1px; height:24px; background:var(--line,#d9cbb5)}
#gxBar .gx-aff{display:flex; align-items:center; gap:7px; font-size:var(--fs-1,11px); color:var(--ink-2,#6b5847)}
#gxBar .gx-track{width:78px; height:6px; border-radius:var(--r-1,4px); background:var(--hairline,rgba(90,68,48,.14)); overflow:hidden}
#gxBar .gx-track i{display:block; height:100%; width:0; border-radius:var(--r-1,4px);
  background:var(--clay,#d2714a); transition:width .4s}
#gxBar .gx-today{font-size:var(--fs-1,11px); color:var(--ink-3,#97836d)}
#gxBar .gx-today b{color:var(--sage,#6f8468); font-weight:600}
#gxBar .gx-badge{font-size:var(--fs-1,11px); padding:2px 7px; border-radius:var(--r-1,4px);
  background:var(--clay-soft,rgba(210,113,74,.14)); color:var(--clay-deep,#af5235)}

#gxPanel{position:fixed; inset:0; z-index:26; display:none; place-items:center;
  background:rgba(43,28,20,.42); font:14px/1.6 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif); color:var(--ink,#2f2119)}
#gxPanel.show{display:grid}
#gxPanel .gx-card{width:min(92vw,640px); max-height:82vh; overflow:auto; border-radius:var(--r-3,16px); padding:22px 24px;
  background:var(--paper,#f6f0e4); border:1px solid var(--line,#d9cbb5); box-shadow:var(--sh-3,0 18px 44px rgba(90,68,48,.20))}
#gxPanel h2{margin:0 0 4px; font-size:var(--fs-5,19px); letter-spacing:.02em}
#gxPanel .gx-sub{margin:0 0 16px; font-size:var(--fs-2,12px); color:var(--ink-2,#6b5847)}
#gxPanel .gx-tabs{display:flex; gap:6px; margin-bottom:16px; flex-wrap:wrap}
#gxPanel .gx-tab{border:1px solid var(--line,#d9cbb5); background:var(--paper-2,#ece3d3); color:var(--ink-2,#6b5847);
  border-radius:var(--r-1,4px); padding:6px 14px; font-size:var(--fs-2,12px); cursor:pointer}
#gxPanel .gx-tab.on{background:var(--clay-soft,rgba(210,113,74,.14)); border-color:var(--clay,#d2714a); color:var(--clay-deep,#af5235); font-weight:600}
#gxPanel .gx-row{display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid var(--hairline,rgba(90,68,48,.14)); font-size:var(--fs-3,13px)}
#gxPanel .gx-row:last-child{border-bottom:0}
#gxPanel .gx-row .gx-name{flex:1}
#gxPanel .gx-row .gx-goal{font-size:var(--fs-1,11px); color:var(--ink-3,#97836d)}
/* 「保留存档」那一行：说明文字会换，别让它把按钮挤出去 */
#gxPanel .gx-row .gx-goal.gx-keep{max-width:62%; text-align:right; line-height:1.5}
#gxPanel .gx-row .gx-btn{margin:0; flex:0 0 auto; white-space:nowrap}
#gxPanel .gx-row.done .gx-name{color:var(--sage,#6f8468)}
#gxPanel .gx-row.done .gx-goal{color:var(--sage,#6f8468)}
#gxPanel .gx-lock{opacity:.55}
#gxPanel .gx-btn{border:1px solid var(--line,#d9cbb5); background:var(--paper-2,#ece3d3); color:var(--ink,#2f2119);
  border-radius:var(--r-1,4px); padding:8px 14px; font-size:var(--fs-3,13px); cursor:pointer; margin:6px 8px 0 0}
#gxPanel .gx-btn:hover{border-color:var(--line-2,#c0ad93); background:var(--paper-3,#e0d5c1)}
#gxPanel .gx-close{position:absolute; top:0; right:0}
#gxPanel textarea{width:100%; height:120px; background:#fffdf7; color:var(--ink,#2f2119); border-radius:var(--r-1,4px);
  border:1px solid var(--line,#d9cbb5); padding:10px; font:12px/1.5 ui-monospace,Consolas,monospace; resize:vertical}
#gxPanel .gx-hint{font-size:var(--fs-2,12px); color:var(--ink-3,#97836d); margin:8px 0 0}

#gxIntro{position:fixed; inset:0; z-index:31; display:grid; place-items:center;
  background:var(--paper-3,#e0d5c1);
  font:14px/1.7 var(--font-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif); color:var(--ink,#2f2119);
  transition:opacity .22s cubic-bezier(.2,.7,.2,1)}
#gxIntro.hide{opacity:0; pointer-events:none}
#gxIntro .gx-in{width:min(92vw,600px); text-align:left; background:var(--paper,#f6f0e4);
  border:1px solid var(--line,#d9cbb5); border-radius:var(--r-3,16px); padding:26px 28px;
  box-shadow:var(--sh-3,0 18px 44px rgba(90,68,48,.20))}
#gxIntro h1{font-size:var(--fs-5,19px); margin:0 0 6px; letter-spacing:.03em}
#gxIntro .gx-lead{margin:0 0 20px; color:var(--ink-2,#6b5847); font-size:var(--fs-3,13px)}
#gxIntro .gx-item{display:flex; gap:10px; padding:7px 0; font-size:var(--fs-3,13px); color:var(--ink,#2f2119)}
#gxIntro .gx-item b{color:var(--clay-deep,#af5235); font-weight:600; min-width:74px}
#gxIntro input{width:100%; margin-top:6px; padding:10px 12px; border-radius:var(--r-1,4px);
  border:1px solid var(--line,#d9cbb5); background:#fffdf7; color:var(--ink,#2f2119); font-size:14px}
#gxIntro input:focus-visible{outline:2px solid var(--clay,#d2714a); outline-offset:1px}
#gxIntro .gx-start{margin-top:20px; width:100%; padding:12px; border-radius:var(--r-2,10px); cursor:pointer;
  border:1px solid var(--clay,#d2714a); background:var(--clay,#d2714a); color:#fffaf3; font-size:var(--fs-4,15px); letter-spacing:.06em; font-weight:600}
#gxIntro .gx-start:hover{background:var(--clay-deep,#af5235); border-color:var(--clay-deep,#af5235)}
#gxIntro .gx-fine{margin-top:14px; font-size:var(--fs-1,11px); color:var(--ink-3,#97836d); line-height:1.7}

#gxToast{position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:29;
  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none}
#gxToast .gx-t{padding:8px 16px; border-radius:var(--r-2,10px); font-size:var(--fs-2,12px); color:var(--ink,#2f2119);
  background:var(--paper,#f6f0e4); border:1px solid var(--line,#d9cbb5);
  box-shadow:var(--sh-2,0 4px 14px rgba(90,68,48,.14)); animation:gx-in .22s cubic-bezier(.2,.7,.2,1) both}
@keyframes gx-in{from{opacity:0; transform:translateY(-6px)} to{opacity:1; transform:none}}
#gxToast .gx-t.gold{border-color:var(--sun,#e0a44a); color:var(--clay-deep,#af5235)}

#gxPrompt{position:fixed; inset:0; z-index:32; display:none; place-items:center; background:rgba(43,28,20,.46)}
#gxPrompt.show{display:grid}
#gxPrompt .gx-card{width:min(90vw,420px); border-radius:var(--r-3,16px); padding:20px; background:var(--paper,#f6f0e4);
  border:1px solid var(--line,#d9cbb5); box-shadow:var(--sh-3,0 18px 44px rgba(90,68,48,.20));
  font:14px/1.6 var(--font-ui,"PingFang SC","Noto Sans SC",system-ui,sans-serif); color:var(--ink,#2f2119)}
#gxPrompt h3{margin:0 0 12px; font-size:var(--fs-4,15px); font-weight:600}
#gxPrompt input{width:100%; padding:11px 13px; border-radius:var(--r-1,4px); border:1px solid var(--line,#d9cbb5);
  background:#fffdf7; color:var(--ink,#2f2119); font-size:14px}
#gxPrompt input:focus-visible{outline:2px solid var(--clay,#d2714a); outline-offset:1px}
#gxPrompt .gx-act{display:flex; gap:8px; justify-content:flex-end; margin-top:14px}
#gxPrompt button{padding:8px 16px; border-radius:var(--r-1,4px); cursor:pointer; font-size:var(--fs-3,13px);
  border:1px solid var(--line,#d9cbb5); background:var(--paper-2,#ece3d3); color:var(--ink,#2f2119)}
#gxPrompt button:hover{background:var(--paper-3,#e0d5c1); border-color:var(--line-2,#c0ad93)}
#gxPrompt button.gx-primary{background:var(--clay,#d2714a); border-color:var(--clay,#d2714a); color:#fffaf3; font-weight:600}
#gxPrompt button.gx-primary:hover{background:var(--clay-deep,#af5235); border-color:var(--clay-deep,#af5235)}
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const fmtDur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分钟` : `${h} 小时`;
};

function toast(text, gold = false) {
  const box = document.getElementById('gxToast');
  if (!box) return;
  const t = el('div', `gx-t${gold ? ' gold' : ''}`, text);
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2600);
  setTimeout(() => t.remove(), 3100);
}

/** 接管 window.prompt：原生弹窗在游戏里会打断沉浸感，也无头环境下会卡住。 */
function patchPrompt() {
  const host = el('div', '');
  host.id = 'gxPrompt';
  const card = el('div', 'gx-card');
  const title = el('h3', '', '');
  const input = el('input', '');
  const acts = el('div', 'gx-act');
  const cancel = el('button', '', '取消');
  const ok = el('button', 'gx-primary', '确定');
  acts.append(cancel, ok);
  card.append(title, input, acts);
  host.appendChild(card);
  document.body.appendChild(host);

  let resolve = null;
  const close = (value) => {
    host.classList.remove('show');
    const fn = resolve;
    resolve = null;
    fn?.(value);
  };
  cancel.addEventListener('click', () => close(null));
  ok.addEventListener('click', () => close(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
  });
  host.addEventListener('click', (e) => { if (e.target === host) close(null); });

  window.prompt = (message = '', fallback = '') => {
    if (resolve) close(null);
    title.textContent = String(message || '');
    input.value = String(fallback || '');
    host.classList.add('show');
    setTimeout(() => input.focus(), 30);
    return '';
  };
  // 上面返回空串会让 app.js 认为用户取消；真正的取值走这条异步通道。
  window.__gxPrompt = (message, fallback = '') => new Promise((res) => {
    if (resolve) close(null);
    title.textContent = String(message || '');
    input.value = String(fallback || '');
    host.classList.add('show');
    setTimeout(() => input.focus(), 30);
    resolve = res;
  });
}

function buildBar() {
  const bar = el('div', '');
  bar.id = 'gxBar';
  bar.innerHTML = `
    <div class="gx-lv"><b id="gxLevel">Lv.1</b><span id="gxXp">0 / 120</span></div>
    <span class="gx-sep"></span>
    <div class="gx-aff"><span>和她</span><span class="gx-track"><i id="gxAffBar"></i></span><b id="gxAff">0</b></div>
    <span class="gx-sep"></span>
    <div class="gx-today">今日任务 <b id="gxTaskDone">0/0</b></div>
    <span class="gx-badge" id="gxStreak">签到 1 天</span>`;
  bar.addEventListener('click', () => openPanel());
  document.body.appendChild(bar);
  return bar;
}

function refreshBar() {
  const lv = profile.level();
  const aff = profile.affection();
  const tasks = profile.tasks();
  const done = tasks.filter((t) => t.finished).length;
  const st = profile.streak();
  const $ = (id) => document.getElementById(id);
  if (!$('gxLevel')) return;
  // 亲密度只认一个来源：房间里那一栏（「和她」）显示的那个数。
  // profile.affection() 是平铺累加、无衰减无日上限，跟页面上的 growth.intimacy
  // 会各自漂移（实测摸三次头：这里 6、页面 4.3）。两边显示不同的数比不显示更糟，
  // 所以这里优先读页面已经拿到的快照，读不到才退回 profile。
  const live = readLiveIntimacy();
  const major = live ?? Math.max(aff.her, aff.claude);
  const maxAff = live === null ? 100 : Math.max(100, live);
  $('gxLevel').textContent = `Lv.${lv.level}`;
  $('gxXp').textContent = lv.level >= 40 ? '满级' : `${lv.into} / ${lv.need}`;
  $('gxAff').textContent = Number.isInteger(major) ? String(major) : Number(major).toFixed(1);
  $('gxAffBar').style.width = `${Math.min(100, (major / maxAff) * 100)}%`;
  $('gxTaskDone').textContent = `${done}/${tasks.length}`;
  $('gxStreak').textContent = `签到 ${st.streak} 天`;
  $('gxBar').title = `${stageOf(major)}　·　点开看今日任务与成就`;
}

/**
 * 页面（public/room/app.js）把当前指挥对象的成长快照挂在这里。
 * 读不到就返回 null，让调用方退回 profile —— 不能在这里自己算一遍。
 */
function readLiveIntimacy() {
  try {
    const snap = globalThis.__gameLiveAffection;
    const v = typeof snap === 'function' ? snap() : snap;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

let panel = null;
let panelTab = 'task';

function openPanel(tab = 'task') {
  panelTab = tab;
  if (!panel) {
    panel = el('div', '');
    panel.id = 'gxPanel';
    panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
    document.body.appendChild(panel);
  }
  panel.classList.add('show');
  renderPanel();
}

function closePanel() { panel?.classList.remove('show'); }

function renderPanel() {
  if (!panel) return;
  const lv = profile.level();
  const aff = profile.affection();
  const st = profile.streak();
  const tasks = profile.tasks();
  const achs = profile.achievements();
  const unlocked = achs.filter((a) => a.at).length;
  panel.innerHTML = '';

  const card = el('div', 'gx-card');
  const h = el('h2', '', `Lv.${lv.level}　${lv.stage}`);
  const sub = el('p', 'gx-sub', `经验 ${lv.level >= 40 ? '已满' : `${lv.into}/${lv.need}`}　·　和她 小蓝鱼 ${aff.her} · 小公主 ${aff.claude}　·　连续签到 ${st.streak} 天　·　成就 ${unlocked}/${achs.length}`);
  const tabs = el('div', 'gx-tabs');
  const body = el('div', '');

  const TABS = [['task', `今日任务 ${tasks.filter((t) => t.finished).length}/${tasks.length}`], ['ach', `成就 ${unlocked}/${achs.length}`], ['save', '存档'], ['help', '怎么玩']];
  for (const [id, label] of TABS) {
    const b = el('button', `gx-tab${panelTab === id ? ' on' : ''}`, label);
    b.addEventListener('click', () => { panelTab = id; renderPanel(); });
    tabs.appendChild(b);
  }

  if (panelTab === 'task') {
    for (const t of tasks) {
      const row = el('div', `gx-row${t.finished ? ' done' : ''}`);
      row.append(
        el('span', 'gx-name', `${t.finished ? '✓ ' : '· '}${t.label}`),
        el('span', 'gx-goal', t.finished ? `+${t.xp} 经验` : `${t.done}/${t.goal}`)
      );
      body.appendChild(row);
    }
    const tip = el('p', 'gx-hint', '这些事每天换一批，睡一觉就刷新了。今天全做完，多给你 40 点。');
    body.appendChild(tip);
  }

  if (panelTab === 'ach') {
    for (const a of achs) {
      const row = el('div', `gx-row${a.at ? ' done' : ' gx-lock'}`);
      row.append(
        el('span', 'gx-name', `${a.at ? '★ ' : '· '}${a.label}`),
        el('span', 'gx-goal', a.at ? new Date(a.at).toLocaleDateString('zh-CN') : a.hint)
      );
      body.appendChild(row);
    }
  }

  if (panelTab === 'save') {
    // 联机 / 双人时的存档都在"托管方"手里，两个人共用一份：
    // 导出/导入/重开都必须挡掉，否则一个人重开就把另一个人也清空了。
    if (shellMode === 'online' || shellMode === 'duo') {
      const hosted = shellMode === 'online' ? '服务器' : '开房那台电脑';
      body.append(
        el('p', 'gx-hint', `这是两个人的屋子。东西都放在${hosted}上，你俩用的是同一份。`),
        el('p', 'gx-hint', '所以这儿没有导出、导入、重开 —— 一个人重开，另一个人也白玩了。想看她俩谁做得多，点右下角「屋里的人」。')
      );
      if (shellMode === 'duo' && duoInfo?.code) {
        const row = el('div', 'gx-row');
        row.append(el('span', 'gx-name', '房间号'), el('span', 'gx-goal', duoInfo.code));
        body.appendChild(row);
        const roleRow = el('div', 'gx-row');
        roleRow.append(
          el('span', 'gx-name', '你的身份'),
          el('span', 'gx-goal', duoInfo.role === 'host' ? '房主（屋子在你这台电脑上）' : '访客（屋子在对方那边）')
        );
        body.appendChild(roleRow);
      }
      const closeOnline = el('button', 'gx-btn', '知道了');
      closeOnline.addEventListener('click', closePanel);
      body.appendChild(closeOnline);
      card.append(h, sub, tabs, body);
      panel.appendChild(card);
      refreshBar();
      return;
    }

    const live = el('div', 'gx-row');
    live.append(el('span', 'gx-name', '存档位置'), el('span', 'gx-goal', store.backend === 'localStorage' ? '浏览器本地（localStorage）' : '仅本次运行（内存）'));
    body.appendChild(live);

    // ── 「保留存档」：玩家自己决定这份进度要不要留着 ──────────────────
    // 以前只有自动写盘，玩家看不到自己玩到哪、也不知道下次还在不在。
    // 这里把「上次玩到哪」摊开，再给一个明确的保留开关。
    const info = profile.saveInfo();
    const when = info.lastSeenAt ? new Date(info.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '还没开始';
    const lived = info.livedMs >= 3600_000
      ? `${(info.livedMs / 3600_000).toFixed(1)} 小时`
      : `${Math.max(0, Math.round(info.livedMs / 60000))} 分钟`;
    for (const [k, v] of [
      ['上次玩到', when],
      ['陪了她', lived],
      ['现在', `Lv.${info.level}　和她 小蓝鱼 ${info.aff.her} · 小公主 ${info.aff.claude}`],
      ['已经收下', `${info.unlocked} 条成就 · ${info.notes} 张便签`]
    ]) {
      const row = el('div', 'gx-row');
      row.append(el('span', 'gx-name', k), el('span', 'gx-goal', v));
      body.appendChild(row);
    }

    // ── 两个人一起待的时间 ────────────────────────────────────────────
    // 「陪了她」是玩家自己的在线时长；这里换成真正两个人共处的那本账：
    // 一起待了多久、攒了几点、下个里程碑还差多少。
    // 以前只有一个人的时长，读起来像单人存档，和「两人同行」这个主题不符。
    const tg = typeof globalThis.__gameTogether === 'function' ? globalThis.__gameTogether() : null;
    if (tg) {
      const dur = (ms) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} 小时` : `${Math.max(0, Math.round(ms / 60000))} 分钟`);
      const rows = [
        ['一起待过', `${dur(tg.totalMs)}（这次 ${dur(tg.sessionMs)}）`],
        ['同行点数', `${tg.points} / ${tg.cap} 点 —— 去菜园「两个人的小柜子」换东西`]
      ];
      if (tg.nextMilestone) {
        const left = Math.max(0, Number(tg.nextMilestone.ms || 0) - tg.totalMs);
        rows.push(['下一个纪念', `${tg.nextMilestone.title} · 还差 ${dur(left)}`]);
      }
      if (tg.fatigueText) rows.push(['她有点累', tg.fatigueText]);
      for (const [k, v] of rows) {
        const row = el('div', 'gx-row');
        row.append(el('span', 'gx-name', k), el('span', 'gx-goal', v));
        body.appendChild(row);
      }
    }

    const keepRow = el('div', 'gx-row');
    const keepText = el('span', 'gx-goal gx-keep', info.kept
      ? '已保留 —— 下次打开还是这个家'
      : '还没保留 —— 现在关掉也会存，但你可能以为它丢了');
    const keepBtn = el('button', 'gx-btn', info.kept ? '取消保留' : '保留存档');
    keepBtn.addEventListener('click', () => {
      const now = profile.keepSave(!profile.saveInfo().kept);
      store.flushNow();
      keepText.textContent = now ? '已保留 —— 下次打开还是这个家' : '还没保留 —— 现在关掉也会存，但你可能以为它丢了';
      keepBtn.textContent = now ? '取消保留' : '保留存档';
      toast(now ? '记住了：这份进度会留着' : '取消了保留标记（进度还在，只是不再强调）', true);
      refreshBar();
    });
    keepRow.append(el('span', 'gx-name', '保留'), keepText, keepBtn);
    body.appendChild(keepRow);

    const box = el('textarea', '');
    box.placeholder = '点「导出存档」把这段文本存下来；粘贴别人的存档后点「导入存档」就能接着玩。';
    const row = el('div', '');
    const exp = el('button', 'gx-btn', '导出存档');
    exp.addEventListener('click', () => {
      box.value = store.exportText();
      box.select();
      try { navigator.clipboard?.writeText(box.value); } catch { /* 忽略 */ }
      toast('存档已导出（已尝试复制到剪贴板）');
    });
    const imp = el('button', 'gx-btn', '导入存档');
    imp.addEventListener('click', () => {
      if (!box.value.trim()) { toast('先把存档文本粘进来'); return; }
      try {
        const keys = store.importText(box.value.trim());
        toast(`导入成功，共 ${keys.length} 份数据；正在重载…`, true);
        setTimeout(() => location.reload(), 900);
      } catch (err) { toast(`导入失败：${err.message}`); }
    });
    const reset = el('button', 'gx-btn', '重开一局');
    reset.addEventListener('click', async () => {
      const yes = await window.__gxPrompt('确定要清空所有进度、从头开始吗？输入「重开」确认。');
      if (String(yes || '').trim() !== '重开') { toast('已取消'); return; }
      store.reset();
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('dafiyu-game') || k.startsWith('home-')) localStorage.removeItem(k);
        }
      } catch { /* 忽略 */ }
      location.reload();
    });
    row.append(exp, imp, reset);
    body.append(box, row);
    if (store.backend !== 'localStorage') {
      body.appendChild(el('p', 'gx-hint', '这台电脑不让游戏存东西（隐私模式开着？）。关掉窗口，这次的就没了，先点「导出存档」抄一份吧。'));
    }
  }

  if (panelTab === 'help') {
    const lines = [
      ['看屋子', '按住左键拖，视角就转；滚轮拉近拉远。最底下那排是三种顺手程度，挑一个用得惯的。'],
      ['让她走', '打开「点击移动」，点哪儿她就去哪儿。也可以直接点底下的房间名。'],
      ['照顾她', '左边那排：摸摸头、喂小鱼干、倒杯水、陪她玩、哄她睡。做一件，亲近一分。'],
      ['说话', '点「留句话」跟她说。她回你的话，看的是她那会儿在干嘛、心里想什么，不是随便挑一句。'],
      ['菜园', '右上角「进入菜园」进后院。菜自己会长，她也会去浇水收菜 —— 你要是想动手也行。'],
      ['两个人', '右上「指挥」切一下，让谁动谁就动。「去串门」是让她走到另一位身边待会儿。'],
      ['联机', shellMode === 'online'
        ? '这是联机屋子：服务器托管共用存档，你和对方进的是同一个家。右下角「屋里的人」看谁在线、也能直接跟对方说话。'
        : shellMode === 'duo'
          ? `这是两个人的屋子（房间号 ${duoInfo?.code || '——'}）：不管对方在哪个网下都能连。右下的「屋里的人」看谁在、也可以直接对话。`
          : '一个人玩：不需要联网。想两个人玩就关掉页面重新打开，在主菜单里选「两个人住」。'],
      ['你不在的时候', '关掉窗口她也照过（最多算 8 小时）。回来会跟你说这段时间出了什么事。']
    ];
    for (const [k, v] of lines) {
      const row = el('div', 'gx-row');
      row.append(el('span', 'gx-name', k), el('span', 'gx-goal', v));
      body.appendChild(row);
    }
  }

  const close = el('button', 'gx-btn', '关闭');
  close.addEventListener('click', closePanel);
  card.append(h, sub, tabs, body, close);
  panel.appendChild(card);
  refreshBar();
}

function offlineReport() {
  // profile 的 lastSeenAt 是两个时间点之间唯一的记录；home-state 自己按 8 小时封顶结算。
  const d = profile.data;
  const away = Date.now() - (Number(d.lastSeenAt) || Date.now());
  if (away < 5 * 60_000) return;
  setTimeout(() => {
    toast(`你离开了 ${fmtDur(away)}，她照常过完了这段时间。`, true);
    setTimeout(() => toast('点左下角的状态条可以看今日任务和成就。'), 1400);
  }, 1600);
}

function buildIntro(onStart) {
  const host = el('div', '');
  host.id = 'gxIntro';
  const box = el('div', 'gx-in');

  // 三种玩法的差别只讲一件事：进度归谁。
  const online = shellMode === 'online';
  const duo = shellMode === 'duo';
  const lead = online
    ? '同一间屋子，两个人一起住。这间房子由服务器托管，你和对方看到的是同一个家、同一份进度 —— 谁喂了鱼、谁收了菜，另一个人马上就能看见。'
    : duo
      ? '同一间屋子，两个人一起住。这间房子由开房那台电脑托管，房间号对上就是同一个家 —— 谁喂了鱼、谁收了菜，另一个人马上就能看见。'
      : '小蓝鱼和 Claude 小公主住在这儿。你进来，陪她们把日子往下过。';
  const progress = online
    ? '存在服务器上，你俩共用一份。谁喂了鱼、谁收了菜，都算在这个家上。'
    : duo
      ? `存在开房那台电脑上，你俩共用一份。房间号 ${duoInfo?.code || '——'}，他能看见你、你也能看见他。`
      : '就存在这台电脑上。关掉再来，还在这儿。';
  const fine = online
    ? '两个人各自打开同一个地址，进的就是同一个家。她会回你话，回的是她那点心事，不是客服话术。'
    : duo
      ? '他在哪个网下都能进来，你这边什么都不用设置。她会回你话，回的是她那点心事，不是客服话术。'
      : '一个人玩，断网也能进。她会回你话，回的是她那点心事，不是客服话术。';

  box.innerHTML = `
    <h1>两人温馨小屋</h1>
    <p class="gx-lead">${lead}</p>
    <div class="gx-item"><b>她们会过日子</b><span>会饿会困，会自己去菜园浇水收菜，会串门，睡前会关灯。你不在的时候也照过。</span></div>
    <div class="gx-item"><b>你能做的</b><span>摸摸头、喂条小鱼干、陪她玩、说两句话、让她俩串个门。每天有点小事做，做完会往上长。</span></div>
    <div class="gx-item"><b>东西存哪</b><span>${progress}</span></div>
    <label style="display:block;margin-top:18px;font-size:var(--fs-2,12px);color:var(--ink-3,#97836d)">你在这间屋子里的名字（会记进「刚刚发生」）</label>
    <input id="gxName" maxlength="12" />
    <button class="gx-start" id="gxStart">${online ? '进屋' : '开始过日子'}</button>
    <p class="gx-fine">${fine}</p>`;
  host.appendChild(box);
  document.body.appendChild(host);

  let name = '小屋访客';
  try { name = localStorage.getItem('home-actor-name') || '小屋访客'; } catch { /* 忽略 */ }
  const input = host.querySelector('#gxName');
  input.value = name === '小屋访客' ? '' : name;
  input.placeholder = '小屋访客';
  const start = () => {
    const value = (input.value || '').trim().slice(0, 12) || '小屋访客';
    try { localStorage.setItem('home-actor-name', value); } catch { /* 忽略 */ }
    host.classList.add('hide');
    setTimeout(() => host.remove(), 620);
    onStart?.(value);
  };
  host.querySelector('#gxStart').addEventListener('click', start);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  setTimeout(() => input.focus(), 200);
  return host;
}

export function mountGameShell(options = {}) {
  if (document.getElementById('gxBar')) return;
  const mode = options.mode === 'online' ? 'online' : (options.mode === 'duo' ? 'duo' : 'solo');
  shellMode = mode;
  duoInfo = options.duo
    ? { role: options.duo === 'host' ? 'host' : 'guest', code: globalThis.__duo?.code || '' }
    : null;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const toastBox = el('div', '');
  toastBox.id = 'gxToast';
  document.body.appendChild(toastBox);

  patchPrompt();
  buildBar();
  refreshBar();
  offlineReport();

  profile.onEvent((kind, payload) => {
    if (kind === 'achievement') toast(`成就解锁：${payload.label}`, true);
    else if (kind === 'task') toast(`任务完成：${payload.label}　+${payload.xp} 经验`);
    refreshBar();
  });

  setInterval(refreshBar, 2000);

  // 在线时长：每 30 秒把「这半分钟人真的在」记进存档。
  // 页面在后台时 document.hidden 为真，那段时间不算陪她 —— 挂机刷时长没意义，
  // 而且玩家回来会看到一个虚高的数字，反而假。
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const delta = now - lastTick;
    lastTick = now;
    if (document.hidden) return;
    // 超过 5 分钟的间隔当成「人走了」，不计入（关盖子、切走、休眠）。
    if (delta <= 0 || delta > 5 * 60 * 1000) return;
    try { profile.addLivedMs(delta); } catch { /* 统计失败不影响游玩 */ }
  }, 30_000);
  addEventListener('visibilitychange', () => { lastTick = Date.now(); });

  // 开局引导：同一台设备只走一次（存一个标记，重开一局时会被一起清掉）。
  let seen = false;
  try { seen = localStorage.getItem('dafiyu-game-intro') === '1'; } catch { /* 忽略 */ }
  if (!seen) {
    buildIntro(() => {
      try { localStorage.setItem('dafiyu-game-intro', '1'); } catch { /* 忽略 */ }
      toast('开始吧。左边是她的状态，右边是刚刚发生的事。', true);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if (e.key === 'g' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPanel(); }
  });

  globalThis.__gameShell = { openPanel, closePanel, toast, refreshBar };

  // ── 作弊码 ─────────────────────────────────────────────────────────
  // 只在控制台暴露，界面上不放按钮：这是给评委和演示用的后门，不是功能。
  //   __cheat()            看有哪些码
  //   __cheat('yu-all')    全都要
  //   __cheat('yu-level 30')
  // 做完立刻刷一次状态条，否则要等下一个 2 秒心跳才看到变化。
  globalThis.__cheat = (code) => {
    if (code === undefined) {
      const text = cheatHelp();
      console.log(text);
      return CHEAT_NAMES;
    }
    const out = runCheat(code);
    if (out === null) {
      const text = `没有这个码：${code}\n\n${cheatHelp()}`;
      console.log(text);
      return null;
    }
    console.log(`[cheat] ${code}\n${out}`);
    toast(`作弊码生效：${code}`, true);
    refreshBar();
    return out;
  };
  // 顺手把码表也挂上，方便在控制台里 tab 补全。
  globalThis.__cheat.list = CHEAT_NAMES;
}
