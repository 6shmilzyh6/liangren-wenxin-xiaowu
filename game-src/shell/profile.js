// 养成层：把「她过她的日子」这件事变成看得见的进度。
//
// 这一层不改她的行为（行为全在 home-engine 里，和服务器版一致），
// 只做事后统计：动作 → 经验/亲密度/每日任务/成就/连续签到。
//
// 存档通过注入的 store 落地，于是同一份逻辑能跑在两种地方：
//   · 浏览器单机版：localStorage 虚拟文件表（engine/storage.js 的 store）
//   · 服务器联机版：state/ 目录下的真实文件（createDiskStore）
// 两个玩家连同一台服务器时，共享的就是同一份 profile —— 一起把等级推上去。
import { store as browserStore } from '../engine/storage.js';
// 成长数值的唯一来源：等级曲线、十段亲密度、礼物、互动、技能、片段门槛全在这份 JSON 里。
// 用 import attributes 而不是读文件 —— 打包时 esbuild 会把 JSON 内联进 game.js，
// file:// 单机版和服务器联机版拿到的是同一份数值，不会长出第二套常数表。
import progressConfig from '../../assets/data/progress.json' with { type: 'json' };

const FILE = 'state/profile.json';
const GROWTH = progressConfig;
const MAX_XP_LEVEL = Number(GROWTH.levelCurve.max) || 40;

// 十段亲密度：阈值与称呼都从 progress.json 取（0/7/15/24/34/45/56/67/79/90）。
const STAGES = (GROWTH.intimacy.stages || []).map((s) => [Number(s.min), s.title]);
/** 十段里某一档的完整信息（key/tone/下一档），面板要显示「离下一段还差多少」时用。 */
export function stageInfo(aff) {
  const stages = GROWTH.intimacy.stages || [];
  let hit = stages[0];
  const v = Number(aff) || 0;
  for (const s of stages) if (v >= Number(s.min)) hit = s;
  const next = stages.find((s) => Number(s.min) > v) || null;
  return {
    min: Number(hit.min),
    key: hit.key,
    title: hit.title,
    tone: hit.tone,
    next: next ? { min: Number(next.min), key: next.key, title: next.title } : null,
    toNext: next ? Math.max(0, Number(next.min) - v) : 0
  };
}

export const DAILY_TASKS = [
  { id: 'pet', label: '摸摸头 3 次', goal: 3, xp: 12 },
  { id: 'feed', label: '喂她一次小鱼干', goal: 1, xp: 15 },
  { id: 'water', label: '倒一杯水', goal: 1, xp: 10 },
  { id: 'talk', label: '跟她说句话', goal: 1, xp: 18 },
  { id: 'play', label: '陪她玩一次', goal: 1, xp: 16 },
  { id: 'garden', label: '去菜园做点事', goal: 2, xp: 20 },
  { id: 'meet', label: '让她们串一次门', goal: 1, xp: 22 }
];

// 解锁表。每条都是一个可判定的条件，不是文案摆设：
//   kind   —— 判定口径：first(首次) / count(计数) / level(等级) / intimacy(亲密度) /
//             streak(连续签到) / daily(每日全清) / skill(技能) / interaction(互动) / note(一次性标记)
//   target —— 'her' | 'claude' | 'any'：亲密度类看谁；计数类看 d.counts 的同名字段
//   need   —— 阈值（first 固定 1）
//   reward —— 达成时补发的 { xp, aff }，写 0 就是不补
// 判定统一走 resolveUnlocks()，noteAction / noteGarden / rollDay 尾部各调一次，
// 于是「什么时候该解锁什么」只有一处逻辑，加条件只改这张表。
export const ACHIEVEMENTS = [
  // ── 原有条目：id 与文案保持不变，老存档里已解锁的记录不会失效 ──
  { id: 'first-pet', label: '第一次摸头', hint: '摸摸她的头', kind: 'first', target: 'pet', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'first-feed', label: '投喂成功', hint: '喂一次小鱼干', kind: 'first', target: 'feed', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'first-talk', label: '有来有回', hint: '跟她说第一句话', kind: 'first', target: 'talk', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'first-garden', label: '菜园学徒', hint: '完成一次菜园操作', kind: 'first', target: 'garden', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'first-harvest', label: '第一茬收成', hint: '收一次菜', kind: 'first', target: 'harvest', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'meet-3', label: '串门常客', hint: '串门 3 次', kind: 'count', target: 'meet', need: 3, reward: { xp: 0, aff: 0 } },
  { id: 'lv-5', label: '小屋熟客', hint: '等级到 5', kind: 'level', target: 'any', need: 5, reward: { xp: 0, aff: 0 } },
  { id: 'lv-10', label: '半个主人', hint: '等级到 10', kind: 'level', target: 'any', need: 10, reward: { xp: 0, aff: 0 } },
  { id: 'lv-20', label: '半个家人', hint: '等级到 20', kind: 'level', target: 'any', need: 20, reward: { xp: 0, aff: 0 } },
  { id: 'lv-30', label: '会看脸色', hint: '等级到 30', kind: 'level', target: 'any', need: 30, reward: { xp: 0, aff: 0 } },
  { id: 'lv-40', label: '一辈子', hint: '等级到 40', kind: 'level', target: 'any', need: 40, reward: { xp: 0, aff: 0 } },
  // aff-60 / aff-90 已删除：60 不落在十段任何边界（45 是「会等你」、56 是「默契」），
  // 90 又与 stage-entrusted 同 label（「离不开」会在 79 和 90 各解锁一次）。
  // 段位成就统一由下面的 stage-* 表生成，这里不再另立一套亲密度门槛。
  { id: 'days-3', label: '连着三天', hint: '连续签到 3 天', kind: 'streak', target: 'any', need: 3, reward: { xp: 0, aff: 0 } },
  { id: 'days-7', label: '住了一周', hint: '连续签到 7 天', kind: 'streak', target: 'any', need: 7, reward: { xp: 0, aff: 0 } },
  { id: 'daily-all', label: '今日全清', hint: '一天内做完所有每日任务', kind: 'daily', target: 'any', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'night-owl', label: '深夜还醒着', hint: '凌晨 0-5 点还在屋里', kind: 'note', target: 'any', need: 1, reward: { xp: 0, aff: 0 } },
  // ── 礼物分级（方案 C）：三条，全部走 note + flags，在 noteAction 里当 action==='buy' 时写。
  //    不用 kind:'count' 是因为计数走 d.counts，而 buy 一天能买好几件、也不该进动作计数。
  { id: 'wallet-whale', label: '鲸元券攒够了', hint: '攒到一次「随手」那一档的价格', kind: 'note', target: 'any', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'wallet-token', label: 'tokens 攒够了', hint: '攒到一次「随手」那一档的价格', kind: 'note', target: 'any', need: 1, reward: { xp: 0, aff: 0 } },
  { id: 'gift-careful', label: '第一件用心的', hint: '递出第一件「攒了一阵子」的礼物', kind: 'note', target: 'any', need: 1, reward: { xp: 0, aff: 0 } },
  // ── 十段亲密度（第 2 段起）：阈值与称呼直接来自 progress.json，这里不抄数字 ──
  ...(GROWTH.intimacy.stages || []).slice(1).map((s, i) => ({
    id: `stage-${s.key}`,
    label: s.title,
    hint: `亲密度到 ${s.min}（第 ${i + 2} 段）`,
    kind: 'intimacy',
    target: 'any',
    need: Number(s.min),
    reward: { xp: 0, aff: 0 }
  })),
  // ── 十五个技能：等级到了就是学会了，label 是她会做的那件事 ──
  ...(GROWTH.skills || []).map((sk) => ({
    id: `skill-${sk.id}`,
    label: sk.name,
    hint: `等级到 ${sk.minLevel}`,
    kind: 'skill',
    target: 'any',
    need: Number(sk.minLevel),
    reward: { xp: 0, aff: 0 }
  })),
  // ── 十九件礼物：收到即解锁，亲密度门槛与 progress.json 的 gifts 一一对应 ──
  ...(GROWTH.gifts || []).map((gift) => ({
    id: `gift-${gift.id}`,
    label: gift.name,
    hint: `亲密度到 ${gift.minIntimacy}`,
    kind: 'intimacy',
    target: 'any',
    need: Number(gift.minIntimacy),
    reward: { xp: 0, aff: 0 }
  })),
  // ── 二十二条互动：等级与亲密度两把锁，need 记等级、minIntimacy 记亲密度 ──
  // duo 为 true 的是双人动作（俩人可以一起做），面板上标出来。
  ...(GROWTH.interactions || []).map((it) => ({
    id: `interaction-${it.id}`,
    label: it.name,
    hint: `等级 ${it.minLevel} · 亲密度 ${it.minIntimacy}${it.duo ? ' · 双人' : ''}`,
    kind: 'interaction',
    target: 'any',
    need: Number(it.minLevel),
    minIntimacy: Number(it.minIntimacy),
    duo: it.duo === true,
    reward: { xp: 0, aff: 0 }
  }))
];

/** 单条解锁条件是否已达成。所有口径都只读存档，不看外部状态。 */
function isUnlocked(entry, d) {
  const need = Number(entry.need) || 0;
  const affOf = () => (entry.target === 'her' || entry.target === 'claude'
    ? Number(d.aff?.[entry.target] || 0)
    : Math.max(Number(d.aff?.her || 0), Number(d.aff?.claude || 0)));
  switch (entry.kind) {
    case 'first':
    case 'count':
      return Number(d.counts?.[entry.target] || 0) >= need;
    case 'level':
    case 'skill':
      return levelOf(d.xp).level >= need;
    case 'intimacy':
      return affOf() >= need;
    case 'interaction':
      // 两把锁：等级够了、亲密度也得够，缺一样都不算解锁。
      return levelOf(d.xp).level >= need && affOf() >= Number(entry.minIntimacy || 0);
    case 'streak':
      return Number(d.streak || 0) >= need;
    case 'daily':
      return DAILY_TASKS.every((t) => Number(d.today?.tasks?.[t.id]?.done || 0) >= t.goal);
    case 'note':
      return Boolean(d.flags?.[entry.id]);
    default:
      return false;
  }
}

const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 亲密度留两位小数：poke / lamp / command 这些动作的增益是 0.5，
// 用 Math.round 会把每一次都翻成 1，连戳十下能拿满 10 点（该给 5 点）。
// 上限读 progress.json 的 intimacy.max，别在这里写死 100。
const INTIMACY_MAX = Number(GROWTH.intimacy.max) || 100;
const clamp = (v) => {
  const n = Number(v) || 0;
  return Math.max(0, Math.min(INTIMACY_MAX, Math.round(n * 100) / 100));
};

// 升级曲线：120, 180, 240 … 前期快、后期稳，40 级封顶。
// base/step/max 都从 progress.json 取，改曲线只改那份 JSON。
const XP_BASE = Number(GROWTH.levelCurve.base) || 120;
const XP_STEP = Number(GROWTH.levelCurve.step) || 60;
function levelOf(xp) {
  let level = 1;
  let need = XP_BASE;
  let rest = Math.max(0, Number(xp) || 0);
  while (level < MAX_XP_LEVEL && rest >= need) {
    rest -= need;
    level += 1;
    need += XP_STEP;
  }
  return { level, into: level >= MAX_XP_LEVEL ? 0 : rest, need: level >= MAX_XP_LEVEL ? 0 : need };
}

function stageOf(aff) {
  let name = STAGES[0][1];
  for (const [min, label] of STAGES) if (aff >= min) name = label;
  return name;
}

/** 等级对应的称呼（"半个主人""会看脸色"…），HUD 只显示这句话，不显示经验条。 */
export function levelTitleOf(level) {
  const list = GROWTH.levels || [];
  const n = Math.max(1, Math.min(list.length, Math.round(Number(level) || 1)));
  return list[n - 1]?.title || '';
}

function emptyProfile(now = Date.now()) {
  return {
    v: 1,
    createdAt: now,
    lastSeenAt: now,
    lastDay: '',
    streak: 0,
    xp: 0,
    aff: { her: 0, claude: 0 },
    counts: { pet: 0, feed: 0, water: 0, talk: 0, play: 0, meet: 0, garden: 0, harvest: 0, dance: 0, lamp: 0 },
    // 联机版：每个玩家在这个家里各记一份贡献，面板上能看出谁在勤快。
    players: {},
    today: { day: '', acts: {}, tasks: {} },
    achievements: {},
    // 一次性标记位（night-owl 这种没有计数可言的成就），key 是成就 id。
    flags: {},
    notes: [],
    // 在线时长：累计住在屋里的毫秒数（跨会话保留），面板上显示成「陪了她 X 小时」。
    livedMs: 0,
    // 这一份存档有没有被玩家明确「保留」过。false = 只在自动存，玩家没答应过要留。
    kept: false
  };
}

function normalize(raw, now) {
  const base = emptyProfile(now);
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw };
  out.aff = { her: clamp(raw.aff?.her), claude: clamp(raw.aff?.claude) };
  out.counts = { ...base.counts, ...(raw.counts || {}) };
  out.players = { ...(raw.players || {}) };
  out.today = { day: String(raw.today?.day || ''), acts: { ...(raw.today?.acts || {}) }, tasks: { ...(raw.today?.tasks || {}) } };
  out.achievements = { ...(raw.achievements || {}) };
  // 老存档没有 flags：补一个空表，后面 resolveUnlocks 判定 note 类成就时有地方落标记。
  out.flags = { ...(raw.flags && typeof raw.flags === 'object' ? raw.flags : {}) };
  out.notes = Array.isArray(raw.notes) ? raw.notes.slice(-12) : [];
  out.xp = Math.max(0, Number(raw.xp) || 0);
  out.streak = Math.max(0, Number(raw.streak) || 0);
  // 在线时长与「保留存档」标记：老档没有这两项，补默认值。
  out.livedMs = Math.max(0, Number(raw.livedMs) || 0);
  out.kept = raw.kept === true;
  return out;
}

// 动作经验表：同样来自 progress.json 的 xp.actions，缺项按 1 兜底（未知动作也不至于 0 分）。
const XP_TABLE = { ...(GROWTH.xp.actions || {}) };

/**
 * 造一份养成层。
 *
 * @param storeImpl 需要 read(path)/write(path,text)，见 engine/storage.js
 * @param options.followTarget 可选 () => 'her'|'claude'，决定面板上看谁的亲密度
 */
export function createProfile(storeImpl, options = {}) {
  let data = null;
  const listeners = new Set();
  const pending = [];

  function load(now = Date.now()) {
    if (data) return data;
    let raw = null;
    try {
      const text = storeImpl.read(FILE);
      if (text) raw = JSON.parse(text);
    } catch { /* 存档坏了当新档 */ }
    data = normalize(raw, now);
    rollDay(now);
    return data;
  }

  function save(now = Date.now()) {
    if (!data) return;
    data.lastSeenAt = now;
    try { storeImpl.write(FILE, JSON.stringify(data, null, 2)); } catch { /* 忽略 */ }
  }

  // 跨天：清掉今日计数、结算连续签到。
  function rollDay(now = Date.now()) {
    const day = todayKey(new Date(now));
    if (data.today.day === day && data.lastDay === day) return { newDay: false };
    const newDay = data.lastDay !== day;
    data.today = { day, acts: {}, tasks: {} };
    let gift = null;
    if (newDay) {
      const yesterday = new Date(now - 86_400_000);
      data.streak = data.lastDay === todayKey(yesterday) ? data.streak + 1 : 1;
      data.lastDay = day;
      gift = { streak: data.streak, xp: 10 + Math.min(40, data.streak * 5) };
      data.xp += gift.xp;
      data.aff.her = clamp(data.aff.her + 1);
      data.aff.claude = clamp(data.aff.claude + 1);
      // 签到同时涨亲密度 + 涨经验，跨天这一下最容易刚好过线，判定一次。
      resolveUnlocks(now);
    }
    save(now);
    return { newDay, gift };
  }

  function emit(kind, payload) {
    pending.push({ kind, at: Date.now(), ...payload });
    for (const fn of listeners) { try { fn(kind, payload); } catch { /* 忽略 */ } }
  }

  function unlock(id, now = Date.now()) {
    if (!data || data.achievements[id]) return false;
    const meta = ACHIEVEMENTS.find((a) => a.id === id);
    data.achievements[id] = now;
    emit('achievement', { id, label: meta?.label || id });
    return true;
  }

  function bumpAffection(target, delta) {
    if (!data) return;
    const key = target === 'claude' ? 'claude' : 'her';
    const before = data.aff[key];
    data.aff[key] = clamp(before + delta);
    // 门槛直接取十段表的边界，不再写 60 / 90 这种落在段与段之间的数：
    // 60 在十段里没有任何意义（45 是「会等你」、56 是「默契」），
    // 90 又和 stage-entrusted 重复，玩家会看到「离不开」解锁两次。
    const stages = GROWTH.intimacy.stages || [];
    for (const st of stages) {
      const min = Number(st.min) || 0;
      if (min > 0 && data.aff[key] >= min) unlock(`stage-${st.key}`);
    }
  }

  /**
   * 统一解锁判定：遍历整张解锁表，把「条件已达成但还没记档」的条目一次性落地。
   * 每加一条成就/技能/礼物，只需要往 ACHIEVEMENTS 里塞一行，不用再在别处写 if。
   * 返回这次新解锁的条目（面板可以弹一串提示）；条件全不满足时返回空数组。
   */
  function resolveUnlocks(now = Date.now()) {
    if (!data) return [];
    const fresh = [];
    for (const entry of ACHIEVEMENTS) {
      if (data.achievements[entry.id]) continue;
      if (!isUnlocked(entry, data)) continue;
      if (!unlock(entry.id, now)) continue;
      const reward = entry.reward || {};
      const xpAdd = Math.max(0, Number(reward.xp) || 0);
      const affAdd = Math.max(0, Number(reward.aff) || 0);
      if (xpAdd) data.xp += xpAdd;
      if (affAdd) data.aff.her = clamp(data.aff.her + affAdd);
      fresh.push({ id: entry.id, label: entry.label, kind: entry.kind, xp: xpAdd, aff: affAdd });
    }
    return fresh;
  }

  function touchTask(id, now = Date.now()) {
    const task = DAILY_TASKS.find((t) => t.id === id);
    if (!task || !data) return;
    const acts = Number(data.today.acts[id] || 0);
    data.today.acts[id] = acts + 1;
    const done = Math.min(task.goal, data.today.acts[id]);
    const wasDone = Number(data.today.tasks[id]?.done || 0) >= task.goal;
    data.today.tasks[id] = { done, goal: task.goal };
    if (!wasDone && done >= task.goal) {
      data.xp += task.xp;
      data.aff.her = clamp(data.aff.her + 2);
      emit('task', { id, label: task.label, xp: task.xp });
      if (DAILY_TASKS.every((t) => Number(data.today.tasks[t.id]?.done || 0) >= t.goal)) {
        if (unlock('daily-all', now)) { data.xp += 40; data.aff.her = clamp(data.aff.her + 4); }
      }
    }
    save(now);
  }

  const profile = {
    get data() { return load(); },
    level() { const l = levelOf(load().xp); return { ...l, stage: stageOf(Math.max(load().aff.her, load().aff.claude)) }; },
    tasks() {
      const d = load();
      return DAILY_TASKS.map((t) => ({
        ...t,
        done: Math.min(t.goal, Number(d.today.acts[t.id] || 0)),
        finished: Number(d.today.tasks[t.id]?.done || 0) >= t.goal
      }));
    },
    achievements() {
      const d = load();
      return ACHIEVEMENTS.map((a) => ({ ...a, at: d.achievements[a.id] || 0 }));
    },
    affection() { return { ...load().aff }; },
    streak() { return { streak: load().streak, lastDay: load().lastDay }; },
    /** 存档概况：面板上「上次玩到哪」那一栏读这个，不用把整份 profile 摊开。 */
    saveInfo() {
      const d = load();
      return {
        createdAt: Number(d.createdAt) || 0,
        lastSeenAt: Number(d.lastSeenAt) || 0,
        livedMs: Number(d.livedMs) || 0,
        kept: d.kept === true,
        level: levelOf(d.xp).level,
        xp: Number(d.xp) || 0,
        aff: { ...d.aff },
        streak: Number(d.streak) || 0,
        // 有多少条成就落了档 —— 一眼看出「这份档不是空的」。
        unlocked: Object.keys(d.achievements || {}).length,
        notes: (d.notes || []).length
      };
    },
    /** 玩家点了「保留存档」：从此这份档带着明确的「我要留着」标记。 */
    keepSave(on = true) {
      const now = Date.now();
      const d = load(now);
      d.kept = on === true;
      d.lastSeenAt = now;
      save(now);
      return d.kept;
    },
    /** 累加在线时长。只在有动作/心跳时调，不自己开定时器。 */
    addLivedMs(ms) {
      const delta = Math.max(0, Math.min(6 * 3600 * 1000, Number(ms) || 0));
      if (delta < 1000) return Number(load().livedMs) || 0;
      const now = Date.now();
      const d = load(now);
      d.livedMs = (Number(d.livedMs) || 0) + delta;
      d.lastSeenAt = now;
      save(now);
      return d.livedMs;
    },
    /**
     * 作弊码用：直接给经验 / 亲密度 / 金币之类的「一次性写值」。
     * 只在这里开口子，别的路径仍然走 noteAction 那一套正常结算，
     * 免得作弊码的副作用散到整个养成层。
     */
    cheat(patch = {}) {
      const now = Date.now();
      const d = load(now);
      if (Number.isFinite(Number(patch.xp))) d.xp = Math.max(0, Number(patch.xp));
      if (patch.aff && typeof patch.aff === 'object') {
        if (Number.isFinite(Number(patch.aff.her))) d.aff.her = clamp(patch.aff.her);
        if (Number.isFinite(Number(patch.aff.claude))) d.aff.claude = clamp(patch.aff.claude);
      }
      if (Number.isFinite(Number(patch.livedMs))) d.livedMs = Math.max(0, Number(patch.livedMs));
      if (Number.isFinite(Number(patch.streak))) d.streak = Math.max(0, Math.floor(Number(patch.streak)));
      // 作弊后等级可能跳了好几级，成就与技能要一次性补判定，否则面板上是空的。
      resolveUnlocks(now);
      save(now);
      return { level: levelOf(d.xp).level, xp: d.xp, aff: { ...d.aff }, livedMs: d.livedMs };
    },
    stats() { return { ...load().counts }; },
    /** 联机版：每位玩家在这个家里做了多少事。 */
    players() { return { ...load().players }; },
    rollDay,
    /** 页面还活着的时候定期打点，用于判断"离线了多久"。 */
    markSeen(now = Date.now()) {
      const d = load(now);
      const rolled = rollDay(now);
      d.lastSeenAt = now;
      save(now);
      return rolled;
    },
    /** 取走累积的提示（Toast 用），取完即清。 */
    drain() { return pending.splice(0, pending.length); },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 给 app.js 的 roomView 用：亲密度 + 阶段 + 记忆板。 */
    roomViewFor() {
      const d = load();
      const major = typeof options.followTarget === 'function'
        ? (options.followTarget() === 'claude' ? 'claude' : 'her')
        : 'her';
      const aff = d.aff[major];
      const lv = levelOf(d.xp);
      const stage = stageInfo(aff);
      return {
        affection: aff,
        stage: stage.title,
        // 十段的完整信息：面板想显示「离下一段还差多少」时直接用，不用再算一遍。
        stageKey: stage.key,
        stageMin: stage.min,
        stageNext: stage.next,
        stageToNext: stage.toNext,
        notes: d.notes.slice(-3).map((n) => ({ at: n.at, text: n.text })),
        streak: d.streak,
        level: lv.level,
        // HUD 只显示称呼，不显示经验条：等级对应的那句话就是 title。
        title: levelTitleOf(lv.level)
      };
    },
    /** 解锁表全貌：已解锁带 at 时间戳，未解锁 at 为 0。 */
    unlocks() {
      const d = load();
      return ACHIEVEMENTS.map((a) => ({
        id: a.id,
        label: a.label,
        hint: a.hint,
        kind: a.kind,
        target: a.target,
        need: a.need,
        reward: a.reward,
        at: Number(d.achievements[a.id] || 0)
      }));
    },
    /** 还没解锁的下一个目标（按门槛从低到高），面板拿来做「下一步」。 */
    nextUnlocks(limit = 3) {
      const d = load();
      return ACHIEVEMENTS
        .filter((a) => !d.achievements[a.id] && (a.kind === 'level' || a.kind === 'intimacy' || a.kind === 'skill' || a.kind === 'interaction'))
        .sort((a, b) => Number(a.need) - Number(b.need))
        .slice(0, Math.max(1, limit))
        .map((a) => ({ id: a.id, label: a.label, kind: a.kind, need: a.need }));
    },
    stageInfo,
    note(text, now = Date.now()) {
      const d = load(now);
      d.notes.push({ at: now, text: String(text).slice(0, 40) });
      d.notes = d.notes.slice(-12);
      save(now);
    },
    reset(now = Date.now()) {
      data = emptyProfile(now);
      data.today = { day: todayKey(), acts: {}, tasks: {} };
      data.lastDay = todayKey();
      data.streak = 1;
      save(now);
      emit('reset', {});
    },
    save
  };

  /** /api/home/act 成功后调用。by 是操作者名字，联机时用来分账。 */
  function noteAction(action, body, result, by = '') {
    const now = Date.now();
    const d = load(now);
    rollDay(now);
    const target = body?.target === 'claude' ? 'claude' : 'her';
    const gain = XP_TABLE[action] ?? 1;
    d.xp += gain;
    d.counts[action] = (d.counts[action] || 0) + 1;
    if (by) {
      const key = String(by).slice(0, 24);
      const p = d.players[key] || { xp: 0, acts: 0, at: 0 };
      p.xp += gain;
      p.acts += 1;
      p.at = now;
      d.players[key] = p;
    }
    // 亲密度增益与动作经验同源（progress.json 的 intimacyGain.actions），
    // 这样服务器版成长层与这份养成层不会一个给 2 一个给 3。
    const affGain = Number((GROWTH.intimacyGain?.actions || {})[action]) || 0;
    if (affGain) bumpAffection(target, affGain);
    if (['pet', 'feed', 'water', 'talk', 'play', 'meet'].includes(action)) touchTask(action, now);
    // 深夜还醒着没有计数可依，先记个标记位，交给下面的统一判定去落地。
    const hour = new Date(now).getHours();
    if (hour >= 0 && hour < 5) d.flags['night-owl'] = now;
    // 递礼物：三条成就都靠 flags 落点（ACHIEVEMENTS 里 kind:'note'）。
    // 买成之后 home 快照里已经有新钱包和货架，从 result 里读就够了，不重算。
    if (action === 'buy' && result?.event?.gift) {
      const g = result.home?.[target]?.growth || null;
      const wallets = Array.isArray(g?.wallet?.currencies) ? g.wallet.currencies : [];
      const casualMin = Math.min(...(GROWTH.wallet?.tiers
        ? Object.values(GROWTH.wallet.tiers).map((t) => Number(t.min) || 99)
        : [2]));
      for (const w of wallets) {
        if (Number(w.amount) >= casualMin) d.flags[`wallet-${w.key}`] = now;
      }
      const bought = Array.isArray(g?.offers)
        ? g.offers.find((o) => o.id === result.event.gift)
        : null;
      if (bought?.tier === 'careful') d.flags['gift-careful'] = now;
    }
    // 统一判定：首次类/计数类/等级类/亲密度类/连签类/技能类在这里一次性结算，
    // 原来散在上面的 unlock('first-pet') / unlock('lv-5') 之类全部走这张表，不再逐条 if。
    resolveUnlocks(now);
    const lv = levelOf(d.xp).level;
    save(now);
    return { xp: gain, level: lv };
  }

  /** 菜园操作成功后调用。 */
  function noteGarden(type, body, result, by = '') {
    const now = Date.now();
    const d = load(now);
    rollDay(now);
    if (type === 'auto' || type === 'careNow' || type === 'visit') {
      d.xp += 3;
      touchTask('garden', now);
      resolveUnlocks(now);
      save(now);
      return;
    }
    d.xp += 5;
    d.counts.garden = (d.counts.garden || 0) + 1;
    if (by) {
      const key = String(by).slice(0, 24);
      const p = d.players[key] || { xp: 0, acts: 0, at: 0 };
      p.xp += 5;
      p.acts += 1;
      p.at = now;
      d.players[key] = p;
    }
    if (type === 'harvest') {
      d.xp += 12;
      d.counts.harvest = (d.counts.harvest || 0) + 1;
      bumpAffection('her', 2);
    }
    touchTask('garden', now);
    // 菜园也会给经验，等级/亲密度可能刚好跨线，这里同样走一次统一判定。
    resolveUnlocks(now);
    save(now);
  }

  return {
    profile,
    noteAction,
    noteGarden,
    roomViewFor: () => profile.roomViewFor(),
    resolveUnlocks,
    levelOf,
    stageOf,
    stageInfo,
    levelTitleOf,
    todayKey
  };
}

// ── 浏览器默认实例 ───────────────────────────────────────────────────────
// 单机版就是这一份：存档在 localStorage 的虚拟文件表里。
const browser = createProfile(browserStore, {
  followTarget: () => {
    try { return localStorage.getItem('home-follow-target') || 'her'; } catch { return 'her'; }
  }
});

export const profile = browser.profile;
export const noteAction = browser.noteAction;
export const noteGarden = browser.noteGarden;
export function roomViewFor() { return browser.roomViewFor(); }
export { levelOf, stageOf, todayKey };