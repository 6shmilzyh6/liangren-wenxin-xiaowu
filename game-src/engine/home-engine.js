// 浏览器内引擎：把原来跑在 bridge 里的「事实层 + 行为层 + 菜园」原封不动搬进来。
//
// 复用的就是项目自己那份源码（src/home-state.js、src/garden-autonomy.js、src/garden-store.js），
// 只把 node:fs / node:path 换掉，所以行为和服务器版完全一致：
//   · 需求按“经过的时间”衰减，不是按心跳次数；
//   · 到站点只算到了，dwell 结束才结算并写事件；
//   · 菜园任务先走人、再干活、最后一次性结算；
//   · 同一类事件有冷却，消费端只读 15 分钟内的。
//
// 这里额外多做两件“游戏”需要的事：
//   1. 存档落在 localStorage（见 engine/storage.js），支持导出/导入；
//   2. 离线结算：关掉页面几小时回来，她真的过完了那段时间（最多 8 小时，
//      和 home-state.js 的 MAX_ELAPSED_HOURS 一致）。
import {
  HOME_ACTIONS, HOME_LAYOUT, ROOM_NAMES,
  loadHomeState, saveHomeState, advanceHomeState, applyHomeAction, homeView,
  emptyHomeState, applyGrowthCheat, applyTogetherCheat
} from '../../src/home-state.js';
import { createGardenCaretaker } from '../../src/garden-autonomy.js';
import { loadGarden, saveGarden, actGarden } from '../../src/garden-store.js';

let HOME_FILE = 'state/home.json';
let GARDEN_FILE = 'state/garden.json';

// garden-store / home-state 的读写都走这里；storage 层已经把 fs 换成虚拟文件表。
const storage = { loadHomeState, saveHomeState, loadGarden, saveGarden };

// 游戏环境：原版会打断她的事情里，只有 QQ 未读和 DSH 心情依赖外部服务。
// 断网的单机游戏不该因为“没人回消息”而心神不宁，所以固定成干净的环境。
// 联机版由服务器改写 mode，其余保持一致。
let env = { unread: 0, gateway: true, mode: 'offline-game' };
const getEnv = () => env;

/**
 * 联机服务器用：把存档路径指到服务器目录，并换掉运行环境。
 * 必须在 bootEngine() 之前调用。
 *
 * 浏览器单机版不需要调用，默认值就是 localStorage 里那两个键。
 */
export function configure(next = {}) {
  if (next.homeFile) HOME_FILE = next.homeFile;
  if (next.gardenFile) GARDEN_FILE = next.gardenFile;
  if (next.env) env = { ...env, ...next.env };
  caretaker = null;
}

let caretaker = null;

export function bootEngine(now = Date.now()) {
  if (caretaker) return caretaker;
  caretaker = createGardenCaretaker({
    homeFile: HOME_FILE,
    gardenFile: GARDEN_FILE,
    getEnv,
    storage
  });
  // 第一次 tick：新档会建出来，旧档会按离线时长补齐。
  caretaker.tick(now);
  return caretaker;
}/** 所有状态推进都走这里；页面只读结果，不改状态。 */
export function tick(now = Date.now()) {
  if (!caretaker) bootEngine(now);
  return caretaker.tick(now);
}

/** GET /api/home/state 的等价物。 */
export function homeSnapshot(now = Date.now()) {
  const { state, env: e } = tick(now);
  return homeView(state, now, e);
}

/** POST /api/home/act 的等价物：顺序与 bridge 一致（校验 → 动作 → 推进 → 保存 → 再 tick）。 */
export function act(input = {}) {
  const now = Number(input.at) || Date.now();
  const action = String(input.action || '').trim();
  if (!HOME_ACTIONS.includes(action)) {
    return { ok: false, error: `action 必须是 ${HOME_ACTIONS.join('/')}` };
  }
  // talk 的留言、claim 的便条内容都要留下来；别的动作不接受 free text。
  const keepsText = action === 'talk' || action === 'claim';
  const text = keepsText ? String(input.text || '').slice(0, 120) : '';
  if (action === 'talk' && !text.trim()) return { ok: false, error: '留言不能为空' };
  if (!caretaker) bootEngine(now);

  // 谁做的这件事：单机永远叫「你」，联机是玩家自己起的名字（事件面板里要能分清）。
  const by = String(input.by || '').trim().slice(0, 24) || '你';

  const before = caretaker.tick(now);
  const result = applyHomeAction(before.state, {
    action,
    text,
    // claim（小柜子兑换）要带这两样：换哪一样、便条上写什么。
    // 漏传的话 claimTogether 收到空 offer，find 不到就一路 changed:false，
    // 界面上表现为「点了没反应」。
    offer: input.offer,
    // buy（递礼物）/ return（收回礼）同理：漏传 gift 就是「点了没反应」，
    // 连错误都没有。
    gift: input.gift,
    room: input.room,
    spot: input.spot,
    pos: input.pos,
    free: input.free === true,
    on: input.on,
    at: now,
    by,
    emotion: env.emotion,
    target: input.target
  });
  if (!result.changed) {
    return { ok: true, changed: false, home: homeSnapshot(now) };
  }
  // 交互完立刻再推进一步：command/sleep 这类动作要在同一个响应里开始走路线，
  // 页面不用等下一轮轮询才看到她出发。
  const advanced = advanceHomeState(result.state, now, env).state;
  saveHomeState(HOME_FILE, advanced, now);
  const after = caretaker.tick(now);
  return {
    ok: true,
    changed: true,
    home: homeView(after.state, now, after.env),
    event: result.event || null,
    garden: after.garden
  };
}

export function gardenSnapshot(now = Date.now()) {
  const { garden } = tick(now);
  return { ok: true, garden };
}

/** POST /api/garden/act 的等价物：立刻结算的菜园操作（失败不扣钱、不产出）。 */
export function gardenAct(action = {}, now = Date.now()) {
  if (!caretaker) bootEngine(now);
  caretaker.tick(now);
  const result = actGarden(GARDEN_FILE, action, now);
  const after = caretaker.tick(now);
  return { ...result, garden: after.garden };
}

/** POST /api/garden/control 的等价物：自主照料开关、请她来菜园、立刻开工。 */
export function gardenControl(body = {}, now = Date.now()) {
  if (!caretaker) bootEngine(now);
  return caretaker.control(body, now);
}

/** 关页面/切后台时立刻落盘；离线结算靠的就是这份时间戳。 */
export function persist(now = Date.now()) {
  if (!caretaker) return;
  try {
    const { state } = caretaker.tick(now);
    saveHomeState(HOME_FILE, state, now);
  } catch { /* 忽略：下次 tick 还会写 */ }
}

/**
 * 作弊码用：直接把金币 / 种子 / 堆肥 / 仓库写成指定值。
 * 菜园的 normal 路径是 actGarden（要过校验、要扣钱），作弊不该走那条，
 * 但也不能绕过 saveGarden —— 否则下次 tick 会拿旧档覆盖回来。
 */
export function cheatGarden(patch = {}, now = Date.now()) {
  if (!caretaker) bootEngine(now);
  const { garden } = caretaker.tick(now);
  const next = JSON.parse(JSON.stringify(garden));
  if (Number.isFinite(Number(patch.coins))) next.coins = Math.max(0, Math.floor(Number(patch.coins)));
  if (Number.isFinite(Number(patch.compost))) next.compost = Math.max(0, Math.floor(Number(patch.compost)));
  if (patch.seeds && typeof patch.seeds === 'object') {
    for (const [id, n] of Object.entries(patch.seeds)) {
      if (id in next.seeds && Number.isFinite(Number(n))) next.seeds[id] = Math.max(0, Math.floor(Number(n)));
    }
  }
  saveGarden(GARDEN_FILE, next);
  const after = caretaker.tick(now);
  return after.garden;
}

/**
 * 作弊码用：把她俩的成长数值直接写死。
 * 和 cheatGarden 一样，必须落盘 —— 否则下次 tick 会拿旧档覆盖回来。
 */
export function cheatGrowth(patch = {}, now = Date.now()) {
  if (!caretaker) bootEngine(now);
  const { state } = caretaker.tick(now);
  const next = applyGrowthCheat(state, patch, now);
  saveHomeState(HOME_FILE, next, now);
  const after = caretaker.tick(now);
  return after.state;
}

/**
 * 作弊码用：把同行账本直接写成指定值。
 * 和 cheatGarden 一样必须落盘，否则下次 tick 会拿旧档覆盖回来。
 */
export function cheatTogether(patch = {}, now = Date.now()) {
  if (!caretaker) bootEngine(now);
  const { state } = caretaker.tick(now);
  const next = applyTogetherCheat(state, patch, now);
  saveHomeState(HOME_FILE, next, now);
  const after = caretaker.tick(now);
  return after.state;
}

export { HOME_ACTIONS, HOME_LAYOUT, ROOM_NAMES, emptyHomeState };
