// 成长数值自检：把 assets/data/progress.json 当成唯一事实源，逐条验它的自洽性。
//
// 跑法：node scripts/check-progress.mjs
// 全绿时退出码 0；任何一条不合规打印 [FAIL] 并以退出码 1 结束（可以直接挂进 CI）。
//
// 为什么单独有这份脚本：成长层（src/home-state.js）和养成层（game-src/shell/profile.js）
// 都只读这份 JSON，一旦里面的阈值写歪了，两边会一起歪，单看代码看不出来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(ROOT, 'assets', 'data', 'progress.json');

const problems = [];
const notes = [];
function check(ok, label, detail = '') {
  if (ok) {
    notes.push(`[ OK ] ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    problems.push(`[FAIL] ${label}${detail ? `：${detail}` : ''}`);
  }
  return ok;
}

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// ── 1. 等级曲线：40 级封顶，xpNeed(n) = base + step*(n-1)，累计必须等于 totalXp ──
const curve = cfg.levelCurve;
const MAX = Number(curve.max);
const BASE = Number(curve.base);
const STEP = Number(curve.step);
check(MAX === 40, '等级封顶是 40', `max=${MAX}`);
check(BASE === 120 && STEP === 60, '曲线参数 base=120 step=60', `base=${BASE} step=${STEP}`);

const needOf = (n) => (n >= MAX ? 0 : BASE + STEP * (n - 1));
let total = 0;
for (let n = 1; n < MAX; n += 1) total += needOf(n);
check(total === 49140, '升到满级累计经验 = 49140', `实算 ${total}`);
check(Number(curve.totalXp) === total, 'levelCurve.totalXp 与实算一致', `配置 ${curve.totalXp} / 实算 ${total}`);
check(Number(curve.daysToMax) === Math.ceil(total / Number(curve.xpPerDay)),
  'daysToMax 与 xpPerDay 相符', `${curve.daysToMax} 天 · 每天 ${curve.xpPerDay}`);

// ── 2. levels 表：40 行、n 连号、need 与曲线逐项一致、称呼不为空 ──
const levels = cfg.levels || [];
check(levels.length === MAX, 'levels 有 40 行', `实有 ${levels.length}`);
let levelMismatch = [];
levels.forEach((row, i) => {
  const want = needOf(Number(row.n));
  if (Number(row.n) !== i + 1 || Number(row.need) !== want) {
    levelMismatch.push(`n=${row.n} need=${row.need} 应为 ${want}`);
  }
  if (!row.title || !String(row.title).trim()) levelMismatch.push(`n=${row.n} 称呼为空`);
});
check(levelMismatch.length === 0, 'levels 的 n 连号且 need 与公式逐项吻合', levelMismatch.slice(0, 4).join('；'));

// ── 3. 十段亲密度：阈值 0/7/15/24/34/45/56/67/79/90，严格单调递增 ──
const WANT_STAGES = [0, 7, 15, 24, 34, 45, 56, 67, 79, 90];
const stages = cfg.intimacy?.stages || [];
check(stages.length === 10, '亲密度是十段', `实有 ${stages.length} 段`);
const mins = stages.map((s) => Number(s.min));
check(JSON.stringify(mins) === JSON.stringify(WANT_STAGES), '十段阈值等于 0/7/15/24/34/45/56/67/79/90', mins.join('/'));
let monotonic = true;
for (let i = 1; i < mins.length; i += 1) if (!(mins[i] > mins[i - 1])) monotonic = false;
check(monotonic, '段位阈值严格单调递增', mins.join(' < '));
check(mins[0] === Number(cfg.intimacy.min), '首段阈值等于 intimacy.min', `min=${cfg.intimacy.min}`);
check(mins[mins.length - 1] <= Number(cfg.intimacy.max), '末段阈值不超过 intimacy.max', `末段 ${mins[mins.length - 1]} · max ${cfg.intimacy.max}`);
const stageKeys = stages.map((s) => s.key);
check(new Set(stageKeys).size === stageKeys.length, '段位 key 不重复', stageKeys.join('/'));
check(stages.every((s) => s.title && s.title.trim()), '每段都有称呼');

// ── 4. 反刷参数：重复系数递减到 0、每日上限、去重窗口、凌晨折扣 ──
const repeat = (cfg.intimacy?.repeat || []).map(Number);
check(repeat.length >= 6 && repeat[0] === 1 && repeat[repeat.length - 1] === 0,
  '当日重复系数从 1 递减到 0', repeat.join('/'));
let repeatDesc = true;
for (let i = 1; i < repeat.length; i += 1) if (!(repeat[i] <= repeat[i - 1])) repeatDesc = false;
check(repeatDesc, '当日重复系数单调不增', repeat.join(' ≥ '));
check(Number(cfg.intimacy.dailyCap) === 20, '单角色每日亲密度上限 20', `dailyCap=${cfg.intimacy.dailyCap}`);
check(Number(cfg.intimacy.talkDedupMs) === 1_800_000, '同一句话去重窗口 30 分钟', `${cfg.intimacy.talkDedupMs} ms`);
const decay = cfg.intimacy.decay || {};
check(Number(decay.divisor) === 120 && Number(decay.floor) === 0.2,
  '边际递减 gain × max(0.2, 1 - aff/120)', `divisor=${decay.divisor} floor=${decay.floor}`);
const quiet = cfg.intimacy.quiet || {};
check(Number(quiet.fromHour) === 2 && Number(quiet.toHour) === 6 && Number(quiet.factor) === 0.6,
  '凌晨 2~6 点经验 ×0.6', `${quiet.fromHour}~${quiet.toHour} ×${quiet.factor}`);

// ── 5. 礼物：19 件，门槛落在十段边界上，id 唯一 ──
const gifts = cfg.gifts || [];
check(gifts.length === 19, '礼物 19 件', `实有 ${gifts.length}`);
const giftIds = gifts.map((g) => g.id);
check(new Set(giftIds).size === giftIds.length, '礼物 id 不重复');
const badGiftNeed = gifts.filter((g) => !WANT_STAGES.includes(Number(g.minIntimacy)));
check(badGiftNeed.length === 0, '礼物门槛都落在十段边界上', badGiftNeed.map((g) => `${g.id}=${g.minIntimacy}`).join(' '));
check(gifts.every((g) => g.name && g.desc && g.back), '每件礼物都有名字/描述/回礼文案');
check(gifts.slice().sort((a, b) => a.minIntimacy - b.minIntimacy)[0].minIntimacy === 0,
  '最低门槛的礼物亲密度为 0（新档也能收）');
check(Math.max(...gifts.map((g) => Number(g.minIntimacy))) === 90, '最高门槛的礼物落在第 10 段(90)');
check(Number(cfg.giftReturn?.delayDays) === 1, '回礼固定次日出现', `delayDays=${cfg.giftReturn?.delayDays}`);
check(cfg.giftReturn?.room === 'foyer', '回礼落在玄关', `room=${cfg.giftReturn?.room}`);

// ── 5b. 礼物分级（方案 C）：cost / currency / tier + 两种货币都拿得到 ──
const wallet = cfg.wallet || {};
const coinKeys = Object.keys(wallet.currencies || {});
const noPrice = gifts.filter((g) => !Number.isFinite(Number(g.cost)) || Number(g.cost) <= 0
  || !String(g.currency || '') || !String(g.tier || ''));
check(noPrice.length === 0, '每件礼物都有 cost / currency / tier',
  noPrice.map((g) => g.id).join(' ') || '全部齐');
const badCoin = gifts.filter((g) => !coinKeys.includes(String(g.currency)));
check(badCoin.length === 0, `礼物的币种都在 wallet.currencies 里（${coinKeys.join('/')}）`,
  badCoin.map((g) => `${g.id}=${g.currency}`).join(' ') || '全部对上');
// 两种货币都要「有人拿得到」：每种币至少有一条来源、且至少三件礼物用它定价。
const deadCoin = coinKeys.filter((k) => {
  const srcs = wallet.currencies?.[k]?.sources || [];
  const used = gifts.filter((g) => g.currency === k).length;
  return srcs.length === 0 || used < 3;
});
check(deadCoin.length === 0, '两种货币都有来源、都至少给 3 件礼物定价',
  deadCoin.length ? `缺来源或定价太少：${deadCoin.join('/')}` : coinKeys.map((k) => `${k}=${gifts.filter((g) => g.currency === k).length}件`).join(' · '));
// 三档各至少 3 件，且价位落在各自的区间里。
const tierKeys = Object.keys(wallet.tiers || {});
const thinTier = tierKeys.filter((k) => gifts.filter((g) => g.tier === k).length < 3);
check(thinTier.length === 0, '三档各至少 3 件',
  thinTier.length ? `${thinTier.join('/')} 不足 3 件` : tierKeys.map((k) => `${k}=${gifts.filter((g) => g.tier === k).length}`).join(' · '));
const outOfBand = gifts.filter((g) => {
  const t = wallet.tiers?.[g.tier];
  return t && (Number(g.cost) < Number(t.min) || Number(g.cost) > Number(t.max));
});
check(outOfBand.length === 0, '每件礼物的价格落在自己那一档的区间里',
  outOfBand.map((g) => `${g.id}=${g.cost}(${g.tier} ${wallet.tiers?.[g.tier]?.min}-${wallet.tiers?.[g.tier]?.max})`).join(' ') || '全部在区间内');
// 两种货币的每日上限都必须存在，否则 walletAdd 的 room 会变成 Infinity。
const noCap = coinKeys.filter((k) => !(Number(wallet.currencies?.[k]?.dailyCap) > 0));
check(noCap.length === 0, '每种货币都有每日上限', noCap.join('/') || coinKeys.map((k) => `${k}=${wallet.currencies[k].dailyCap}`).join(' · '));

// ── 6. 互动：22 条，等级 1..40、亲密度在十段内，duo 计数 11 ──
const its = cfg.interactions || [];
check(its.length === 22, '互动 22 条', `实有 ${its.length}`);
check(new Set(its.map((i) => i.id)).size === its.length, '互动 id 不重复');
const badInter = its.filter((i) => Number(i.minLevel) < 1 || Number(i.minLevel) > MAX
  || Number(i.minIntimacy) < 0 || Number(i.minIntimacy) > Number(cfg.intimacy.max)
  || !WANT_STAGES.includes(Number(i.minIntimacy)));
check(badInter.length === 0, '互动门槛都在范围内且亲密度落在十段边界上',
  badInter.map((i) => `${i.id}=${i.minLevel}/${i.minIntimacy}`).join(' '));
const duo = its.filter((i) => i.duo === true);
check(duo.length === 11, '双人互动 11 条', `实有 ${duo.length}`);
check(its.every((i) => i.name && i.line), '每条互动都有名字与台词');

// ── 7. 技能：15 个，等级 6..30，id 唯一 ──
const skills = cfg.skills || [];
check(skills.length === 15, '技能 15 个', `实有 ${skills.length}`);
check(new Set(skills.map((s) => s.id)).size === skills.length, '技能 id 不重复');
const skillLv = skills.map((s) => Number(s.minLevel));
check(Math.min(...skillLv) === 6, '最早的技能 6 级（泡茶）', `最早 ${Math.min(...skillLv)}`);
check(Math.max(...skillLv) === 30, '最晚的技能 30 级（看你脸色）', `最晚 ${Math.max(...skillLv)}`);
check(skillLv.every((n) => n >= 1 && n <= MAX), '技能等级都在 1..40');

// ── 8. 片段：114 个 p001..p114，门槛都在范围内 ──
const clips = cfg.clips || {};
const clipKeys = Object.keys(clips);
check(clipKeys.length === 114, '片段 114 个', `实有 ${clipKeys.length}`);
const wantKeys = Array.from({ length: 114 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`);
const missing = wantKeys.filter((k) => !clips[k]);
const extra = clipKeys.filter((k) => !wantKeys.includes(k));
check(missing.length === 0 && extra.length === 0, '片段键名正好是 p001..p114',
  `缺 ${missing.slice(0, 5).join(',') || '无'} · 多 ${extra.slice(0, 5).join(',') || '无'}`);
const badClip = clipKeys.filter((k) => {
  const row = clips[k] || {};
  const lv = Number(row.level);
  const ia = Number(row.intimacy);
  return !(lv >= 1 && lv <= MAX && ia >= 0 && ia <= Number(cfg.intimacy.max) && WANT_STAGES.includes(ia));
});
check(badClip.length === 0, '每个片段的等级 1..40、亲密度落在十段边界上',
  badClip.slice(0, 8).map((k) => `${k}=${clips[k].level}/${clips[k].intimacy}`).join(' '));
const clipLv = clipKeys.map((k) => Number(clips[k].level));
const clipIa = clipKeys.map((k) => Number(clips[k].intimacy));
check(Math.min(...clipLv) === 1 && Math.max(...clipLv) === MAX, '片段等级铺满 1..40',
  `${Math.min(...clipLv)}..${Math.max(...clipLv)}`);
check(Math.min(...clipIa) === 0 && Math.max(...clipIa) === 90, '片段亲密度铺满 0..90',
  `${Math.min(...clipIa)}..${Math.max(...clipIa)}`);
// 起步就能看的片段：1 级 + 0 亲密，没有的话新档打开抽屉是一片全锁。
const starters = clipKeys.filter((k) => Number(clips[k].level) === 1 && Number(clips[k].intimacy) === 0);
check(starters.length >= 1, '至少有一个开局就能看的片段', starters.join(',') || '无');

// ── 9. 锁定文案：三条都非空，且不是系统口吻 ──
const lines = cfg.lockedLines || {};
check(Boolean(lines.level && lines.intimacy && lines.both), '锁定文案 level/intimacy/both 齐全');
check(!/等级不足|亲密度不足|未解锁|权限/.test(JSON.stringify(lines)), '锁定文案不用系统口吻');

// ── 10. 经验表：动作 16 项、生活事件 14 项，值非负整数 ──
const xpActions = cfg.xp?.actions || {};
const xpEffects = cfg.xp?.effects || {};
check(Object.keys(xpActions).length === 16, '动作经验 16 项', `实有 ${Object.keys(xpActions).length}`);
check(Object.keys(xpEffects).length === 14, '生活事件经验 14 项', `实有 ${Object.keys(xpEffects).length}`);
const badXp = [...Object.entries(xpActions), ...Object.entries(xpEffects)]
  .filter(([, v]) => !Number.isInteger(Number(v)) || Number(v) < 0);
check(badXp.length === 0, '经验值都是非负整数', badXp.map(([k, v]) => `${k}=${v}`).join(' '));
const iaActions = cfg.intimacyGain?.actions || {};
check(Object.keys(iaActions).length >= 16, '亲密度增益覆盖全部动作', `实有 ${Object.keys(iaActions).length} 项`);
const badIa = Object.entries(iaActions).filter(([, v]) => Number(v) < 0 || Number(v) > 10);
check(badIa.length === 0, '单次动作亲密度增益在 0..10', badIa.map(([k, v]) => `${k}=${v}`).join(' '));

// ── 输出 ──
console.log(`成长数值自检：${path.relative(ROOT, CONFIG_PATH)}`);
for (const line of notes) console.log(line);
if (problems.length) {
  console.error('');
  for (const line of problems) console.error(line);
  console.error(`\n${problems.length} 项不合规，退出码 1。`);
  process.exit(1);
}
console.log(`\n全部 ${notes.length} 项通过。`);
