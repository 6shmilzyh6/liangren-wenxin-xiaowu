import { CROPS, GARDEN_RULES } from './garden-state.js';
// 作物图标是线稿 SVG，不再用 emoji：emoji 的配色和字形跟着系统字体走，
// 在纸/陶这套皮肤里会跳出来。这里只取图标 id，颜色由 CSS 的 currentColor 决定。
import { iconSvg } from './icons.js';

const byId = new Map(CROPS.map((crop) => [crop.id, crop]));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
const duration = (ms) => {
  if (!Number.isFinite(ms)) return '等待浇水';
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.ceil(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, text, handler, label) {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  if (handler) node.addEventListener('click', handler);
  return node;
}

// 这间屋子住着两个人：小蓝鱼（默认）和小公主。菜园是同一片地，
// 但"谁在照料"要跟着这一端陪的人走，所以所有写死人名的文案都从这里取。
const GARDEN_WHO = {
  her: {
    name: '小蓝鱼',
    // 地是两个人的：标题不再写「谁的」，只写「我们俩的」。
    // 「谁在照料」另有一行（stewardshipTitle），那才需要分人。
    title: '我们俩的菜园',
    stewardshipTitle: '小蓝鱼的照料安排',
    stewardshipOn: '小蓝鱼 · 自主照料中',
    stewardshipOff: '小蓝鱼 · 自主照料已暂停',
    autoLabel: '小蓝鱼自主照料菜园',
    autoOnTitle: '暂停小蓝鱼自主照料；手动操作仍然可用',
    autoOffTitle: '让小蓝鱼自行安排种植、采收和补给',
    callTitle: '请小蓝鱼来菜园',
    careNowTitle: '让小蓝鱼现在放下手头的事去照料菜园',
    grabHint: '按住小蓝鱼可以把她抱起来，松手放到菜园里的田边；开启开放或组合视角后可用 W/A/S/D 和方向键看她。',
    careCopy: '开启自主照料后，小蓝鱼会走到菜园安排翻土、播种、浇水、施肥和采收，也会出售收成、补充种子与堆肥。累了、饿了或睡觉时，她会先照顾自己；你仍然可以随时帮忙。',
    feedLabel: '喂小鱼干',
    busyTell: '通知小蓝鱼…',
    backTitle: '返回小屋',
    conflictForce: '直接派她去菜园',
    startCareTell: '通知她先去菜园…'
  },
  claude: {
    name: '小公主',
    title: '我们俩的菜园',
    stewardshipTitle: '小公主的照料安排',
    stewardshipOn: '小公主 · 自主照料中',
    stewardshipOff: '小公主 · 自主照料已暂停',
    autoLabel: '小公主自主照料菜园',
    autoOnTitle: '暂停小公主自主照料；手动操作仍然可用',
    autoOffTitle: '让小公主自行安排种植、采收和补给',
    callTitle: '请小公主来菜园',
    careNowTitle: '让小公主现在放下手头的事去照料菜园',
    grabHint: '按住小公主可以把她抱起来，松手放到菜园里的田边；开启开放或组合视角后可用 W/A/S/D 和方向键看她。',
    careCopy: '开启自主照料后，小公主会走到菜园安排翻土、播种、浇水、施肥和采收，也会出售收成、补充种子与堆肥。累了、饿了或睡觉时，她会先照顾自己；你仍然可以随时帮忙。',
    feedLabel: '递块点心',
    busyTell: '通知小公主…',
    backTitle: '返回小公主的客厅',
    conflictForce: '直接派她去菜园',
    startCareTell: '通知她先去菜园…'
  }
};

const normWho = (value) => (value === 'claude' ? 'claude' : 'her');

/** Garden presentation only. Actions and saved progression belong to the server. */
export function mountGardenUI({ onAction, onControl, onSelectPlot, onClose, onHomeAction, getTogether, getGrowth, who } = {}) {
  // 这一端陪的是谁：'her' 小蓝鱼 / 'claude' 小公主。房内交换身份后会运行期改。
  let side = normWho(who);
  let copy = GARDEN_WHO[side];
  let view = null;
  let open = false;
  let collapsed = false;
  let activeTab = 'grow';
  let selected = 0;
  let chosenCrop = CROPS[0]?.id || 'radish';
  let busy = false;
  let disposed = false;
  let feedbackMessage = '';
  let feedbackTone = '';

  const panel = el('section', 'garden-panel');
  panel.id = 'garden-panel';
  panel.hidden = true;
  const header = el('header', 'garden-header');
  const heading = el('div', 'garden-heading');
  heading.append(el('p', 'garden-eyebrow', '后院 · 八畦地 · 两个人一起种'));
  const headingTitle = el('h2', '', copy.title);
  heading.append(headingTitle);
  const headerTools = el('div', 'garden-header-tools');
  const collapse = button('garden-icon-button', '−', () => {
    collapsed = !collapsed;
    renderVisibility();
  }, '收起菜园面板');
  collapse.setAttribute('aria-expanded', 'true');
  const close = button('garden-icon-button', '×', () => {
    setOpen(false);
    onClose?.();
  }, '返回小屋');
  headerTools.append(collapse, close);
  header.append(heading, headerTools);
  const statusStrip = el('div', 'garden-status-strip');
  const coins = el('strong', '', '—');
  const compost = el('strong', '', '—');
  const harvests = el('strong', '', '—');
  for (const [title, value] of [['金币', coins], ['堆肥', compost], ['已收获', harvests]]) {
    const item = el('div', 'garden-stat');
    item.append(el('span', '', title), value);
    statusStrip.append(item);
  }
  const body = el('div', 'garden-body');
  const stewardship = el('div', 'garden-stewardship');
  const stewardshipCopy = el('div', 'garden-stewardship-copy');
  const stewardshipTitle = el('strong', '', copy.stewardshipTitle);
  const stewardshipStatus = el('span', 'garden-stewardship-status', '读取照料安排…');
  stewardshipStatus.setAttribute('role', 'status');
  stewardshipStatus.setAttribute('aria-live', 'polite');
  stewardshipCopy.append(stewardshipTitle, stewardshipStatus);
  const stewardshipControls = el('div', 'garden-stewardship-controls');
  const autoToggle = button('garden-auto-toggle', '自主照料', () => invoke({ type: 'auto', enabled: !view?.care?.autoEnabled }, true));
  autoToggle.setAttribute('role', 'switch');
  autoToggle.setAttribute('aria-checked', 'false');
  const callHer = button('garden-call-her', '请她来', () => invoke({ type: 'visit' }, true), copy.callTitle);
  const startCare = button('garden-start-care', '开始照料', () => startCareNow(), copy.careNowTitle);
  stewardshipControls.append(autoToggle, startCare, callHer);
  stewardship.append(stewardshipCopy, stewardshipControls);
  // 菜园里的通用相处功能。床、电视、房间导航等和屋子强绑定的入口不搬过来。
  const companionship = el('section', 'garden-companionship');
  const companionshipTitle = el('h3', 'garden-companionship-title', '和她相处');
  companionshipTitle.append(el('small', '', '走到田边也能陪她'));
  const socialGrid = el('div', 'garden-social-grid');
  const socialButtons = new Map();
  for (const [action, label] of [
    ['pet', '摸摸头'], ['feed', copy.feedLabel], ['water', '倒杯水'],
    ['play', '陪她玩'], ['talk', '留句话'], ['wake', '叫醒'],
    ['lamp', '灯']
  ]) {
    const node = button('garden-social-button', label, () => onHomeAction?.(action), label);
    socialButtons.set(action, node);
    socialGrid.append(node);
  }
  companionship.append(companionshipTitle, socialGrid);
  const grabHint = el('p', 'garden-grab-hint', copy.grabHint);
  companionship.append(grabHint);
  const conflict = el('section', 'garden-conflict');
  conflict.hidden = true;
  conflict.setAttribute('role', 'alertdialog');
  conflict.setAttribute('aria-label', '菜园照料任务冲突');
  const conflictQuestion = el('p', 'garden-conflict-question');
  const conflictCountdown = el('span', 'garden-conflict-countdown');
  const conflictActions = el('div', 'garden-conflict-actions');
  const deferButton = button('garden-conflict-defer', '先做前面的事', () => resolveConflict('defer'));
  const forceButton = button('garden-conflict-force', '直接去照料', () => resolveConflict('force'));
  conflictActions.append(deferButton, forceButton);
  conflict.append(el('strong', 'garden-conflict-title', '先做哪件事？'), conflictQuestion, conflictCountdown, conflictActions);
  let conflictData = null;
  let conflictDeadline = 0;
  let conflictTimer = 0;
  const tabs = el('nav', 'garden-tabs');
  tabs.setAttribute('aria-label', '菜园功能');
  tabs.setAttribute('role', 'tablist');
  const tabButtons = new Map();
  const contents = new Map();
  for (const [id, label] of [['grow', '种植'], ['store', '仓库'], ['shop', '种子铺'], ['together', '小柜子'], ['gift', '礼物']]) {
    const tab = button('garden-tab', label, () => { activeTab = id; renderVisibility(); scroll.scrollTop = 0; });
    tab.id = `garden-tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `garden-content-${id}`);
    tabButtons.set(id, tab);
    tabs.append(tab);
    const content = el('div', 'garden-tab-content');
    content.id = `garden-content-${id}`;
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', tab.id);
    contents.set(id, content);
  }
  const scroll = el('div', 'garden-scroll');
  scroll.append(...contents.values());
  const feedback = el('p', 'garden-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.textContent = '菜园数据读取中…';
  body.append(tabs, scroll, feedback);
  panel.append(header, statusStrip, stewardship, companionship, conflict, body);
  document.body.append(panel);

  // Eight persistent plot controls remain focusable while the view is refreshed.
  const grow = contents.get('grow');
  const sectionTitle = el('div', 'garden-section-heading');
  const readySummary = el('span', 'garden-ready-summary');
  sectionTitle.append(el('h3', '', '我的八畦菜地'), readySummary);
  grow.append(sectionTitle);
  const plotGrid = el('div', 'garden-plot-grid');
  const plotControls = [];
  for (let id = 0; id < 8; id++) {
    const tile = button('garden-plot-tile', undefined, () => {
      selectPlot(id);
      onSelectPlot?.(id);
    });
    tile.id = `garden-select-plot-${id}`;
    const number = el('span', 'garden-plot-number', String(id + 1).padStart(2, '0'));
    // 留空，等 render() 按当前作物注入图标；初始占位也不再写「·」。
    const icon = el('span', 'garden-plot-icon');
    icon.setAttribute('aria-hidden', 'true');
    const state = el('span', 'garden-plot-state', '待翻土');
    tile.append(number, icon, state);
    plotGrid.append(tile);
    plotControls.push({ tile, icon, state });
  }
  grow.append(plotGrid);

  const detail = el('section', 'garden-bed-detail');
  const detailHead = el('div', 'garden-detail-heading');
  const detailTitle = el('h3', '', '第 1 畦');
  const detailBadge = el('span', 'garden-stage-badge', '待翻土');
  detailHead.append(detailTitle, detailBadge);
  const detailDescription = el('p', 'garden-detail-description');
  const meters = el('div', 'garden-meters');
  function makeMeter(name, type) {
    const row = el('div', `garden-meter garden-meter-${type}`);
    const label = el('div', 'garden-meter-label');
    const value = el('span', 'garden-meter-value');
    label.append(el('span', '', name), value);
    const track = el('div', 'garden-meter-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', name);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = el('i');
    track.append(fill);
    row.append(label, track);
    meters.append(row);
    return { row, value, track, fill };
  }
  const progress = makeMeter('生长进度', 'growth');
  const moisture = makeMeter('土壤水分', 'water');
  const eta = el('p', 'garden-eta');
  const actionRow = el('div', 'garden-action-row');
  const actionButtons = new Map();
  for (const [type, label] of [['till', '翻松土壤'], ['plant', '播下种子'], ['water', '浇水'], ['fertilize', '施一份堆肥'], ['harvest', '采收这一畦']]) {
    const action = button(`garden-action ${['till', 'plant', 'harvest'].includes(type) ? 'garden-action-primary' : ''}`, label, () => {
      invoke({ type, plotId: selected, ...(type === 'plant' ? { cropId: chosenCrop } : {}) });
    });
    action.dataset.gardenAction = type;
    actionRow.append(action);
    actionButtons.set(type, action);
  }
  detail.append(detailHead, detailDescription, meters, eta, actionRow);
  grow.append(detail);

  const seedPicker = el('section', 'garden-seed-picker');
  const seedTitle = el('div', 'garden-section-heading');
  seedTitle.append(el('h3', '', '这一畦想种什么？'));
  const goShop = button('garden-text-button', '补充种子 →', () => { activeTab = 'shop'; renderVisibility(); scroll.scrollTop = 0; });
  seedTitle.append(goShop);
  seedPicker.append(seedTitle);
  const cropGrid = el('div', 'garden-crop-grid');
  const cropControls = new Map();
  for (const crop of CROPS) {
    const tile = button('garden-crop-tile', undefined, () => { chosenCrop = crop.id; render(); });
    tile.id = `garden-crop-${crop.id}`;
    const icon = el('span', 'garden-crop-icon');
    icon.innerHTML = iconSvg(crop.iconId || 'sprout');
    icon.setAttribute('aria-hidden', 'true');
    const name = el('span', 'garden-crop-name', crop.name);
    const info = el('span', 'garden-crop-info');
    tile.append(icon, name, info);
    cropGrid.append(tile);
    cropControls.set(crop.id, { tile, info });
  }
  seedPicker.append(cropGrid);
  grow.append(seedPicker);

  const care = el('details', 'garden-care');
  care.append(el('summary', '', '种菜小手册'));
  const careCopy = el('div', 'garden-care-copy');
  careCopy.append(
    el('p', 'garden-care-steps', '翻土 → 播种 → 浇水 → 成长 → 收获'),
    el('p', '', '缺水时生长暂停，浇水后继续；离开页面也按土壤水分计算成长，不会枯死。'),
    el('p', '', '每一茬可施肥一次，帮助作物生长并增加收成。成熟后采收，果蔬会存进仓库。'),
    el('p', '', '把收成出售换金币，再去种子铺补充种子和堆肥。采收后的菜地可以接着播种。')
  );
  const careWhoCopy = el('p', '', copy.careCopy);
  careCopy.append(careWhoCopy);
  care.append(careCopy);
  grow.append(care);

  const store = contents.get('store');
  const storageLead = el('div', 'garden-tab-intro');
  const storageCount = el('strong', '', '0');
  storageLead.append(el('span', 'garden-kicker', '仓库'), storageCount, el('span', 'garden-storage-unit', '份果蔬在仓库'));
  store.append(storageLead);
  const storageRows = new Map();
  const emptyStorage = el('p', 'garden-empty', '仓库还没有收成。第 1 畦的萝卜已成熟，可以采收。');
  store.append(emptyStorage);
  const inventoryList = el('div', 'garden-inventory-list');
  for (const crop of CROPS) {
    const row = el('div', 'garden-inventory-row');
    const icon = el('span', 'garden-list-icon');
    icon.innerHTML = iconSvg(crop.iconId || 'sprout');
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'garden-list-copy');
    const stock = el('span', 'garden-list-meta');
    copy.append(el('strong', '', crop.name), stock);
    const sell = button('garden-small-button', '出售全部', () => {
      invoke({ type: 'sell', cropId: crop.id, quantity: Math.min(99, count(view?.inventory?.[crop.id])) });
    }, `出售全部${crop.name}`);
    row.append(icon, copy, sell);
    inventoryList.append(row);
    storageRows.set(crop.id, { row, stock, sell });
  }
  store.append(inventoryList);
  const logHeading = el('div', 'garden-section-heading garden-log-heading');
  logHeading.append(el('h3', '', '菜园日记'));
  const logList = el('ol', 'garden-log');
  store.append(logHeading, logList);
  let lastLogKey = '';

  const shop = contents.get('shop');
  const shopLead = el('div', 'garden-shop-intro');
  shopLead.append(el('h3', '', '种子铺'), el('p', '', '12 种作物，种子买下后可随时播种。'));
  shop.append(shopLead);
  const shopList = el('div', 'garden-shop-list');
  const shopRows = new Map();
  for (const crop of CROPS) {
    const row = el('div', 'garden-shop-row');
    const icon = el('span', 'garden-list-icon');
    icon.innerHTML = iconSvg(crop.iconId || 'sprout');
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'garden-list-copy');
    const name = el('strong', '', crop.name);
    const meta = el('span', 'garden-list-meta');
    const yieldText = Array.isArray(crop.yield) ? crop.yield.join('–') : crop.yield;
    meta.textContent = `约 ${duration(crop.growMs)} · 收获 ${yieldText || '多'} 份`;
    const held = el('span', 'garden-shop-held');
    copy.append(name, meta, held);
    const buy = button('garden-small-button', `${crop.seedCost} 金币`, () => invoke({ type: 'buySeed', cropId: crop.id, quantity: 1 }), `购买一份${crop.name}种子，${crop.seedCost}金币`);
    row.append(icon, copy, buy);
    shopList.append(row);
    shopRows.set(crop.id, { held, buy });
  }
  const compostRow = el('div', 'garden-compost-card');
  const compostCopy = el('div', 'garden-list-copy');
  compostCopy.append(el('strong', '', '天然堆肥'), el('span', 'garden-list-meta', '每茬可施一次，提高生长速度与产量'));
  const buyCompost = button('garden-small-button', '购买一份', () => invoke({ type: 'buyCompost', quantity: 1 }), '购买一份堆肥');
  const compostIcon = el('span', 'garden-list-icon');
  compostIcon.innerHTML = iconSvg('leaf');
  compostRow.append(compostIcon, compostCopy, buyCompost);
  shop.append(shopList, compostRow);

  // ── 两个人的小柜子 ──────────────────────────────────────────────────
  // 同行点数不是菜园的钱，它是「两个人一起待着」攒下来的（每半小时 1 点）。
  // 数据在 home 账本里，菜园快照拿不到，所以由外面通过 getTogether 递进来，
  // 免得菜园面板自己再开一条 /api/home/state 的轮询。
  const together = contents.get('together');
  const tgLead = el('div', 'garden-tab-intro');
  const tgPoints = el('strong', '', '0');
  const tgCap = el('span', 'garden-storage-unit', '/ 0 点');
  tgLead.append(el('span', 'garden-kicker', '两个人的小柜子'), tgPoints, tgCap);
  const tgMeta = el('p', 'garden-empty', '一起待着就有积分：每半小时 1 点，一天最多 8 点。');
  const tgList = el('div', 'garden-shop-list');
  together.append(tgLead, tgMeta, tgList);
  let tgSignature = '';
  function renderTogether() {
    const tg = typeof getTogether === 'function' ? getTogether() : null;
    const pts = Math.max(0, Math.floor(Number(tg?.points) || 0));
    const cap = Math.max(0, Math.floor(Number(tg?.pointsCap ?? tg?.cap) || 0));
    tgPoints.textContent = String(pts);
    // 正常攒点不会超过上限（增量在结算时就封顶了）；超过了只可能是作弊码，
    // 这时候再把「/ 8 点」摆出来会让人以为数据坏了，所以只报实际持有量。
    tgCap.textContent = cap > 0 && pts <= cap ? ` / ${cap} 点` : ' 点';
    if (!tg) {
      tgMeta.textContent = '还没连上屋子的账本，等一会儿再打开这一栏。';
      if (tgSignature !== 'none') { tgList.replaceChildren(); tgSignature = 'none'; }
      return;
    }
    const offers = Array.isArray(tg.offers) ? tg.offers : [];
    const sig = offers.map((o) => `${o.id}:${o.affordable ? 1 : 0}${o.claimed ? 1 : 0}`).join('|') + `#${tg.points}`;
    tgMeta.textContent = tg.totalMs > 0
      ? `你们已经一起待了 ${duration(tg.totalMs)}${tg.sessionMs > 0 ? `（这次 ${duration(tg.sessionMs)}）` : ''}。`
      : '还没一起待过。开着这一页陪她，时间就会算进去。';
    if (sig === tgSignature) return;
    tgSignature = sig;
    tgList.replaceChildren();
    for (const offer of offers) {
      const row = el('div', 'garden-shop-row');
      const icon = el('span', 'garden-list-icon');
      icon.innerHTML = iconSvg(offer.id === 'snack' ? 'radish' : offer.id === 'note' ? 'leaf' : 'sprout');
      icon.setAttribute('aria-hidden', 'true');
      const body = el('div', 'garden-list-copy');
      body.append(el('strong', '', offer.label || '换点什么'), el('span', 'garden-list-meta', offer.desc || ''));
      const cost = Number(offer.points) || 0;
      const label = offer.claimed ? '已经换过' : `${cost} 点`;
      const btn = button('garden-small-button', label, () => claimOffer(offer), offer.claimed ? `${offer.label}这次已经换过了` : `花 ${cost} 点同行积分换${offer.label}`);
      btn.disabled = busy || offer.claimed === true || offer.affordable === false;
      row.append(icon, body, btn);
      tgList.append(row);
    }
    if (!offers.length) tgList.append(el('p', 'garden-empty', '小柜子还是空的。'));
  }

  // ── 礼物 · 递给她 ────────────────────────────────────────────────────
  // 19 件礼物按三档排：随手给她的 / 攒了一阵子的 / 一直没敢拿出来的。
  // 上面两个数字是钱包（鲸元券偏她、tokens 偏小公主），数据同样由 getWallet 递进来，
  // 不在这一层再开一条 /api/home/state 轮询。
  const gift = contents.get('gift');
  const wLead = el('div', 'garden-tab-intro');
  const wCoins = el('div', 'garden-wallet');
  wLead.append(el('span', 'garden-kicker', '攒着的东西'), wCoins);
  const wMeta = el('p', 'garden-empty', '攒够了，就把它递过去。');
  const wList = el('div', 'garden-shop-list');
  // 回礼提醒：玄关有东西就一直挂在礼物栏顶上，点一下就拿回来。
  // 不领也会一直在（数据侧 giftReturnsOf 会一直算出来），这是刻意的。
  const wReturn = el('button', 'garden-return-hint', '');
  wReturn.type = 'button';
  wReturn.hidden = true;
  wReturn.addEventListener('click', () => claimReturn());
  gift.append(wLead, wMeta, wReturn, wList);
  let wSignature = '';
  function renderGifts() {
    const growth = typeof getGrowth === 'function' ? getGrowth() : null;
    const offers = Array.isArray(growth?.offers) ? growth.offers : [];
    const wallet = growth?.wallet || null;
    const coins = Array.isArray(wallet?.currencies) ? wallet.currencies : [];
    // 回礼提醒：有就显示，点了就去拿。签名里带上 count，领完要能收起来。
    const hint = growth?.returnHint || null;
    wReturn.hidden = !hint;
    if (hint) {
      wReturn.textContent = `${hint.line} → 拿回来`;
      wReturn.title = `玄关有：${(hint.names || []).join(' / ')}`;
      wReturn.disabled = busy;
    }
    const sig = offers.map((o) => `${o.id}:${o.owned ? 1 : 0}${o.unlocked ? 1 : 0}${o.affordable ? 1 : 0}`).join('|')
      + '#' + coins.map((c) => `${c.key}=${c.amount}`).join(',')
      + `#ret=${hint ? hint.count : 0}`;
    // 钱包数字：两个都显示，攒满的那一个额外标一句「今天攒满了」。
    wCoins.replaceChildren();
    if (!coins.length) {
      wCoins.append(el('span', 'garden-empty', '还没连上账本。'));
    } else {
      for (const c of coins) {
        const box = el('span', 'garden-wallet-coin');
        box.append(el('strong', '', String(c.amount)));
        box.append(el('span', 'garden-storage-unit', ` ${c.label}`));
        if (c.leftToday === 0 && c.dailyCap > 0) box.append(el('em', 'garden-wallet-note', '今天攒满了'));
        wCoins.append(box);
      }
    }
    if (sig === wSignature) return;
    wSignature = sig;
    wList.replaceChildren();
    if (!offers.length) { wList.append(el('p', 'garden-empty', '货架还没摆上。')); return; }
    // 三档分开摆，档位顺序与 progress.json 的 tiers 一致。
    const order = (wallet?.tiers || []).map((t) => t.key);
    const labelOf = (key) => (wallet?.tiers || []).find((t) => t.key === key)?.label || key;
    const keys = order.length ? order : [...new Set(offers.map((o) => o.tier))];
    for (const key of keys) {
      const rows = offers.filter((o) => o.tier === key);
      if (!rows.length) continue;
      wList.append(el('h4', 'garden-gift-tier', labelOf(key)));
      for (const offer of rows) {
        const row = el('div', 'garden-shop-row');
        const icon = el('span', 'garden-list-icon');
        icon.innerHTML = iconSvg(offer.tier === 'solemn' ? 'leaf' : offer.tier === 'careful' ? 'sprout' : 'radish');
        icon.setAttribute('aria-hidden', 'true');
        const copy = el('div', 'garden-list-copy');
        copy.append(el('strong', '', offer.name), el('span', 'garden-list-meta', offer.desc || ''));
        // 差多少说清楚：钱不够写「还差 N 鲸元券」，门槛没到写「还不到日子」。
        // 不写「花 30 点买到」那种交易口吻 —— 这是把攒了很久的东西递出去。
        const label = offer.owned ? '在你这儿了' : offer.reason || `${offer.cost} ${offer.currencyLabel}`;
        const btn = button('garden-small-button', label, () => giveGift(offer), offer.owned ? `${offer.name}已经在你这儿了` : `把${offer.name}递给她（${offer.cost} ${offer.currencyLabel}）`);
        btn.disabled = busy || offer.owned === true || offer.unlocked === false || offer.affordable === false;
        row.append(icon, copy, btn);
        wList.append(row);
      }
    }
  }

  function updateConflictCountdown() {
    if (!conflictData) return;
    const left = Math.max(0, Math.ceil((conflictDeadline - Date.now()) / 1000));
    conflictCountdown.textContent = left > 0 ? `${left} 秒内不回答，她会自己决定` : '30 秒到了，让她自己决定';
    if (left <= 0) {
      conflictCountdown.textContent = '30 秒到了，让她自己决定';
      if (conflictTimer) clearInterval(conflictTimer);
      conflictTimer = 0;
    }
  }
  function hideConflict() {
    conflict.hidden = true;
    conflictData = null;
    conflictDeadline = 0;
    if (conflictTimer) clearInterval(conflictTimer);
    conflictTimer = 0;
  }
  function showConflict(pending) {
    if (!pending || !pending.id) { hideConflict(); return; }
    if (conflictData?.id === pending.id) {
      conflict.hidden = false;
      if (!conflictTimer && conflictDeadline > Date.now()) {
        conflictTimer = setInterval(updateConflictCountdown, 1000);
        updateConflictCountdown();
      }
      return;
    }
    conflict.hidden = false;
    conflictData = pending;
    conflictDeadline = Number(pending.deadline) || Date.now() + 30_000;
    conflictQuestion.textContent = pending.question || '她现在手头有事，要先做还是直接去照料？';
    conflict.hidden = false;
    if (conflictTimer) clearInterval(conflictTimer);
    updateConflictCountdown();
    conflictTimer = setInterval(updateConflictCountdown, 1000);
  }
  async function resolveConflict(decision) {
    if (busy || !conflictData) return;
    const pending = conflictData;
    hideConflict();
    busy = true;
    feedbackMessage = decision === 'force' ? copy.conflictForce : '先让她做完手头的事…';
    feedbackTone = '';
    render();
    try {
      const result = await onControl?.({ type: 'careNow', decision, conflictId: pending.id });
      if (disposed) return;
      feedbackMessage = result?.message || '已经记下了。';
      feedbackTone = result?.ok === false ? 'warning' : 'success';
    } catch {
      feedbackMessage = '这次没能记下，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  async function startCareNow() {
    if (busy || !view || disposed) return;
    busy = true;
    feedbackMessage = copy.startCareTell;
    feedbackTone = '';
    render();
    try {
      const result = await onControl?.({ type: 'careNow' });
      if (disposed) return;
      if (result?.conflict && result.pending) {
        showConflict(result.pending);
        feedbackMessage = '她手头还有事，先问问你。';
        feedbackTone = 'warning';
      } else {
        feedbackMessage = result?.message || '她已经在照料菜园了。';
        feedbackTone = result?.ok === false ? 'warning' : 'success';
      }
    } catch {
      feedbackMessage = '这次没能安排，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  function status(plot) {
    if (!plot?.cropId) return plot?.tilled ? '待播种' : '待翻土';
    if (plot.mature) return '可收获';
    if (plot.moisture <= 0) return '需要浇水';
    return ['种子入土', '出苗', '生长中', '即将成熟'][Math.min(3, count(plot.stage))];
  }
  function updateMeter(control, value) {
    const percent = Math.round(clamp01(value) * 100);
    control.value.textContent = `${percent}%`;
    control.fill.style.width = `${percent}%`;
    control.track.setAttribute('aria-valuenow', String(percent));
  }
  async function invoke(action, isControl = false) {
    if (busy || !view || disposed) return;
    busy = true;
    feedbackTone = '';
    feedbackMessage = isControl ? copy.busyTell : '提交中…';
    render();
    try {
      const result = await (isControl ? onControl?.(action) : onAction?.(action));
      if (disposed) return;
      feedbackMessage = result?.message || (result?.ok === false ? '这一步还没有完成，请再试一次。' : '照料完成。');
      feedbackTone = result?.ok === false ? 'warning' : 'success';
    } catch {
      feedbackMessage = '这次没能保存，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  // 换东西走的是屋子的账本（/api/home/act），不是菜园的 /api/garden/act，
  // 所以不能复用 invoke()。但忙碌态、反馈条、重绘要和别处一致。
  async function claimOffer(offer) {
    if (busy || !offer || offer.claimed) return;
    // 便条要先问写什么：不然花 3 点换到的是一张只有名字的空白纸。
    let noteText = '';
    if (offer.id === 'note') {
      const typed = window.prompt('便条上写点什么？', '');
      if (typed === null) return;
      noteText = String(typed).trim().slice(0, 120);
      if (!noteText) {
        feedbackMessage = '没写字就没换，点数还留着。';
        feedbackTone = 'warning';
        render();
        return;
      }
    }
    busy = true;
    feedbackTone = '';
    feedbackMessage = `正在换${offer.label}…`;
    render();
    try {
      const result = await onHomeAction?.({ action: 'claim', offer: offer.id, text: noteText });
      if (disposed) return;
      feedbackMessage = result?.message || (result?.ok === false ? `${offer.label}没换成，点数可能不够了。` : `${offer.label}换到了。`);
      feedbackTone = result?.ok === false ? 'warning' : 'success';
      tgSignature = '';
    } catch {
      feedbackMessage = '这次没能换，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  /**
   * 递礼物：走屋子的账本（/api/home/act，action=buy），不是菜园接口。
   * 和 claimOffer 同一套忙碌态与反馈，但文案偏「交出去」而不是「买到」。
   */
  async function giveGift(offer) {
    if (busy || !offer) return;
    if (offer.owned || offer.unlocked === false || offer.affordable === false) {
      feedbackMessage = offer.reason || '这一下还没到时候。';
      feedbackTone = 'warning';
      render();
      return;
    }
    busy = true;
    feedbackTone = '';
    feedbackMessage = `把${offer.name}递过去…`;
    render();
    try {
      const result = await onHomeAction?.({ action: 'buy', gift: offer.id });
      if (disposed) return;
      if (result?.ok === false) {
        feedbackMessage = result?.message || result?.error || '这次没递成，再看看还差多少。';
        feedbackTone = 'warning';
      } else {
        feedbackMessage = result?.message || `${offer.name}放在她手边了。`;
        feedbackTone = 'success';
      }
      wSignature = '';
    } catch {
      feedbackMessage = '这一步没确认，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  /**
   * 收下回礼：走屋子的账本（/api/home/act，action=return）。
   * 不指定具体哪一件 —— 服务端拿「最早到点的那一件」，界面点一下就走。
   */
  async function claimReturn() {
    if (busy) return;
    busy = true;
    feedbackTone = '';
    feedbackMessage = '去玄关看看…';
    render();
    try {
      const result = await onHomeAction?.({ action: 'return' });
      if (disposed) return;
      feedbackMessage = result?.message || (result?.ok === false ? '玄关这会儿什么都没有。' : '拿回来了。');
      feedbackTone = result?.ok === false ? 'warning' : 'success';
      wSignature = '';
    } catch {
      feedbackMessage = '这一步没确认，检查连接后再试一次。';
      feedbackTone = 'warning';
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  function renderVisibility() {
    panel.hidden = !open;
    // .is-open 负责进场动画（skin-desk.css：自下 6px 浮入 220ms）。
    // hidden 是硬切，动画必须挂在另一个类上，否则每次都从头播一遍。
    panel.classList.toggle('is-open', open);
    panel.classList.toggle('is-collapsed', collapsed);
    document.body.classList.toggle('garden-open', open);
    body.hidden = collapsed;
    statusStrip.hidden = collapsed;
    stewardship.hidden = collapsed;
    companionship.hidden = collapsed;
    if (collapsed && conflictTimer) { clearInterval(conflictTimer); conflictTimer = 0; }
    conflict.hidden = collapsed || !conflictData;
    collapse.textContent = collapsed ? '+' : '−';
    collapse.setAttribute('aria-label', collapsed ? '展开菜园面板' : '收起菜园面板');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    for (const [id, tab] of tabButtons) {
      tab.classList.toggle('active', id === activeTab);
      tab.setAttribute('aria-selected', String(id === activeTab));
      contents.get(id).hidden = id !== activeTab;
    }
  }
  function render() {
    renderVisibility();
    panel.setAttribute('aria-busy', String(busy || !view));
    if (!view) return;
    const care = view.care;
    const careEnabled = care?.autoEnabled === true;
    autoToggle.classList.toggle('is-on', careEnabled);
    autoToggle.setAttribute('aria-checked', String(careEnabled));
    autoToggle.title = careEnabled ? copy.autoOnTitle : copy.autoOffTitle;
    autoToggle.disabled = busy || !care;
    startCare.disabled = busy || !care;
    startCare.classList.toggle('is-caring', care?.task?.source === 'auto' || care?.queue > 0);
    if (view?.care?.pendingConflict) showConflict(view.care.pendingConflict); else if (!conflictTimer) hideConflict();
    callHer.disabled = busy || !care || care.task?.type === 'visit';
    stewardshipTitle.textContent = careEnabled ? copy.stewardshipOn : copy.stewardshipOff;
    const task = care?.task;
    const workNames = { till: '翻松土壤', plant: '播种', water: '浇水', fertilize: '施肥', harvest: '采收', sell: '出售收成', buySeed: '补充种子', buyCompost: '补充堆肥', visit: '来菜园散步' };
    const taskPlace = Number.isInteger(task?.plotId) ? `第 ${task.plotId + 1} 畦 · ` : '';
    // 状态行只报事实：走路中/干活中 + 地点 + 动作，不写「正在…着…」的拟人句。
    const taskText = task ? `${task.phase === 'walking' ? '前往' : ''}${taskPlace}${workNames[task.type] || '照料菜园'}${task.phase === 'walking' ? ' · 路上' : ' · 进行中'}` : '';
    const careStatus = typeof care?.status === 'string' ? care.status : '';
    const statusText = taskText || careStatus || (careEnabled ? '空闲时自动照料' : '点「请她来」开始');
    const queueSize = Array.isArray(care?.queued) ? care.queued.length : count(care?.queued);
    stewardshipStatus.textContent = statusText + (queueSize ? ` · 另有 ${queueSize} 项安排` : '');
    stewardshipStatus.title = stewardshipStatus.textContent;
    callHer.textContent = care?.character?.room === 'garden' && !care.character.walking ? '她在菜园' : '请她来';
    coins.textContent = count(view.coins).toLocaleString();
    compost.textContent = count(view.compost).toLocaleString();
    harvests.textContent = `${count(view.stats?.totalYield)} 份`;
    const plots = Array.isArray(view.plots) ? view.plots : [];
    const ripeCount = plots.filter((plot) => plot.mature).length;
    readySummary.textContent = ripeCount ? `${ripeCount} 畦可采收` : '点菜地，也可点场景';
    for (let id = 0; id < 8; id++) {
      const plot = plots.find((item) => item.id === id);
      const crop = byId.get(plot?.cropId);
      const control = plotControls[id];
      const state = status(plot);
      control.tile.classList.toggle('selected', id === selected);
      control.tile.classList.toggle('is-ripe', !!plot?.mature);
      control.tile.classList.toggle('is-dry', !!plot?.cropId && !plot.mature && plot.moisture <= 0);
      control.tile.setAttribute('aria-pressed', String(id === selected));
      control.tile.setAttribute('aria-label', `第 ${id + 1} 畦，${crop?.name || '空菜地'}，${state}`);
      // 图标：有作物用作物图标，翻过土用犁沟，没翻土用加号。全部是内联 SVG。
      control.icon.innerHTML = iconSvg(crop ? (crop.iconId || 'sprout') : (plot?.tilled ? 'furrow' : 'plus'));
      control.state.textContent = plot?.mature ? '可收获' : crop?.name || state;
      control.tile.disabled = busy;
    }
    const plot = plots.find((item) => item.id === selected);
    const crop = byId.get(plot?.cropId);
    const seed = byId.get(chosenCrop) || CROPS[0];
    const state = status(plot);
    detailTitle.textContent = `第 ${selected + 1} 畦${crop ? ` · ${crop.name}` : ''}`;
    detailBadge.textContent = state;
    detailBadge.classList.toggle('is-ripe', !!plot?.mature);
    detailBadge.classList.toggle('is-dry', !!plot?.cropId && !plot.mature && plot.moisture <= 0);
    if (plot?.mature) detailDescription.textContent = `${crop.name}已成熟，可以采收。`;
    else if (crop) detailDescription.textContent = plot.moisture <= 0 ? '土壤已干，生长暂停；浇水后继续。' : (plot.fertilized ? '已施堆肥，水分充足时继续生长。' : '水分充足时会持续生长。');
    else if (plot?.tilled) detailDescription.textContent = `土已翻好，可以播种${seed?.name || '作物'}。`;
    else detailDescription.textContent = '这块地还没翻土。';
    meters.hidden = !crop;
    if (crop) {
      updateMeter(progress, plot.progress);
      updateMeter(moisture, plot.moisture);
      moisture.row.classList.toggle('is-dry', plot.moisture <= 0.2);
    }
    eta.textContent = !crop ? '翻土 → 播种 → 浇水 → 收获' : plot.mature ? '成熟后留在地里，随时可采。' : plot.moisture <= 0 ? '生长暂停 · 浇水后继续' : `水分充足时，约 ${duration(plot.remainingMs)} 后可收获`;
    seedPicker.hidden = !!crop;
    const actionVisibility = { till: !crop && !plot?.tilled, plant: !crop && !!plot?.tilled, water: !!crop && !plot?.mature, fertilize: !!crop && !plot?.mature, harvest: !!plot?.mature };
    for (const [type, node] of actionButtons) {
      node.hidden = !actionVisibility[type];
      node.disabled = busy || !plot;
      if (type === 'plant') {
        node.textContent = count(view.seeds?.[chosenCrop]) ? `播种${seed?.name || ''} · 1 份种子` : '种子不足，请去种子铺';
        node.disabled ||= !count(view.seeds?.[chosenCrop]);
      }
      if (type === 'water') {
        node.textContent = plot?.moisture >= 0.98 ? '水分充足' : '给这畦浇水';
        node.disabled ||= plot?.moisture >= 0.98;
      }
      if (type === 'fertilize') {
        node.textContent = plot?.fertilized ? '本茬已施肥' : count(view.compost) ? '施肥 · 1 份堆肥' : '堆肥用完了';
        node.disabled ||= !!plot?.fertilized || !count(view.compost);
      }
    }
    for (const crop of CROPS) {
      const control = cropControls.get(crop.id);
      const quantity = count(view.seeds?.[crop.id]);
      control.tile.classList.toggle('selected', crop.id === chosenCrop);
      control.tile.setAttribute('aria-pressed', String(crop.id === chosenCrop));
      control.tile.setAttribute('aria-label', `选择${crop.name}，现有 ${quantity} 份种子，约 ${duration(crop.growMs)}成熟`);
      control.tile.disabled = busy;
      control.info.textContent = `${quantity} 份 · ${duration(crop.growMs)}`;
      const stock = count(view.inventory?.[crop.id]);
      const row = storageRows.get(crop.id);
      row.row.hidden = !stock;
      row.stock.textContent = `${stock} 份 · 共值 ${stock * crop.sellPrice} 金币`;
      row.sell.textContent = stock > 99 ? '出售 99 份' : '出售全部';
      row.sell.setAttribute('aria-label', stock > 99 ? `出售 99 份${crop.name}` : `出售全部${crop.name}`);
      row.sell.disabled = busy || !stock;
      const shopRow = shopRows.get(crop.id);
      shopRow.held.textContent = `已有 ${quantity} 份种子`;
      shopRow.buy.disabled = busy || count(view.coins) < crop.seedCost;
    }
    const compostCost = GARDEN_RULES.compostCost;
    buyCompost.disabled = busy || count(view.coins) < compostCost;
    buyCompost.textContent = `${compostCost} 金币`;
    buyCompost.setAttribute('aria-label', `购买一份堆肥，${compostCost}金币`);
    const stockTotal = CROPS.reduce((sum, crop) => sum + count(view.inventory?.[crop.id]), 0);
    storageCount.textContent = stockTotal.toLocaleString();
    emptyStorage.hidden = stockTotal > 0;
    if (!stockTotal && count(view.stats?.harvests) > 0) emptyStorage.textContent = '仓库空空的。收获后的果蔬会存放在这里。';
    const logs = Array.isArray(view.log) ? view.log.slice(-8).reverse() : [];
    const logKey = JSON.stringify(logs);
    if (lastLogKey !== logKey) {
      lastLogKey = logKey;
      logList.replaceChildren();
      for (const entry of logs) {
        const row = el('li');
        const stamp = new Date(entry.at);
        const time = Number.isFinite(stamp.getTime()) ? stamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        row.append(el('time', '', time), el('span', '', String(entry.text || '')));
        logList.append(row);
      }
      if (!logs.length) logList.append(el('li', 'garden-log-empty', '还没有记录。翻土、播种、浇水都会写在这里。'));
    }
    renderTogether();
    renderGifts();
    feedback.className = `garden-feedback ${feedbackTone ? `is-${feedbackTone}` : ''}`;
    feedback.textContent = feedbackMessage || (ripeCount ? '有作物成熟了，选中金色菜地就可以采收。' : '水分耗尽前不用管，生长会自动推进。');
  }
  function setView(nextView) {
    if (disposed || !nextView || !Array.isArray(nextView.plots)) return;
    view = nextView;
    render();
  }
  function setOpen(value) {
    if (disposed) return;
    open = !!value;
    if (open) collapsed = false;
    renderVisibility();
  }
  function selectPlot(id) {
    const next = Number(id);
    if (!Number.isInteger(next) || next < 0 || next > 7 || disposed) return;
    if (next !== selected || activeTab !== 'grow') scroll.scrollTop = 0;
    selected = next;
    activeTab = 'grow';
    collapsed = false;
    feedbackMessage = '';
    feedbackTone = '';
    render();
  }
  // 运行期换人：房内申请交换身份通过后，这一整块文案要跟着换掉，
  // 不用重挂面板（重挂会丢掉选中的菜畦和滚动位置）。
  function setWho(next) {
    if (disposed) return;
    const want = normWho(next);
    if (want === side) return;
    side = want;
    copy = GARDEN_WHO[side];
    if (headingTitle) headingTitle.textContent = copy.title;
    if (stewardshipTitle) stewardshipTitle.textContent = copy.stewardshipTitle;
    if (autoToggle) {
      autoToggle.setAttribute('aria-label', copy.autoLabel);
      autoToggle.title = view?.care?.autoEnabled === true ? copy.autoOnTitle : copy.autoOffTitle;
    }
    if (callHer) callHer.title = copy.callTitle;
    if (startCare) startCare.title = copy.careNowTitle;
    if (grabHint) grabHint.textContent = copy.grabHint;
    if (careWhoCopy) careWhoCopy.textContent = copy.careCopy;
    if (socialButtons.get('feed')) socialButtons.get('feed').textContent = copy.feedLabel;
    if (panel) panel.setAttribute('aria-label', copy.title);
    if (!disposed) render();
  }

  const onKey = (event) => {
    if (event.key === 'Escape') { setOpen(false); onClose?.(); }
    event.stopPropagation();
  };
  panel.addEventListener('keydown', onKey);
  panel.setAttribute('aria-label', copy.title);
  autoToggle.setAttribute('aria-label', copy.autoLabel);
  renderVisibility();
  return {
    setView,
    setOpen,
    selectPlot,
    setWho,
    get who() { return side; },
    destroy() {
      disposed = true;
      panel.removeEventListener('keydown', onKey);
      panel.remove();
      document.body.classList.remove('garden-open');
    }
  };
}
