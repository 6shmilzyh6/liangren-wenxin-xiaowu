// 成长系统端到端验证：growth 真的能随 /api/home/state 下发，且交互真的涨经验与亲密度。
//   node scripts/verify-growth.mjs
import {
  emptyHomeState, homeView, applyHomeAction, applyGrowthCheat, normalizeHomeState, progressRules,
} from '../src/home-state.js';

const now = Date.now();
const st = emptyHomeState(now);
// homeView 内部会自己 normalize + tick，不需要外部先 tick
const view = (state, t) => homeView(state, t, { lamp: false, emotion: null });

const results = [];
const ck = (name, ok, detail) => results.push({ name, ok, detail });

// ── 1. 初始快照 ──────────────────────────────────────────────
const v0 = view(st, now);
const g0 = v0.her.growth;
ck('① affection 不再是 null 占位', v0.her.affection !== null && v0.her.affection !== undefined,
  `affection = ${JSON.stringify(v0.her.affection)}`);
ck('② growth 随快照下发', !!g0, g0 ? `level=${g0.level} intimacy=${g0.intimacy}` : '缺失');
ck('③ 开局有一级称呼', typeof g0?.title === 'string' && g0.title.length > 0, `title = ${g0?.title}`);
ck('④ 开局有段位名', typeof g0?.stage?.title === 'string', `stage = ${g0?.stage?.title}`);
ck('⑤ 片段锁表已下发', g0?.clipLocks && Object.keys(g0.clipLocks).length > 0,
  `已锁 ${Object.keys(g0.clipLocks || {}).length} 个 / 共 ${g0?.clipTotal}`);
// 锁的值必须是个对象（带门槛与缺口），不能只是一句话。
// 以前下发字符串，前端读 .level 永远 undefined，于是每条都静默回退到本地表 ——
// 看着没坏，其实服务端那份权威数据一直没被用上。
const lockKey = Object.keys(g0?.clipLocks || {})[0];
const lockVal = g0?.clipLocks?.[lockKey];
ck('⑤b 锁的值带门槛与缺口（不是纯字符串）',
  !!lockVal && typeof lockVal === 'object'
  && Number.isFinite(Number(lockVal.level)) && Number.isFinite(Number(lockVal.intimacy))
  && Number.isFinite(Number(lockVal.gapLevel)) && Number.isFinite(Number(lockVal.gapIntimacy))
  && typeof lockVal.line === 'string',
  lockVal ? `${lockKey} = 需 Lv${lockVal.level} / 亲密度 ${lockVal.intimacy}，还差 ${lockVal.gapLevel} 级、${lockVal.gapIntimacy} 点` : '缺失');
// 缺口必须算得对：门槛减当前值，已经够了的那一项是 0。
ck('⑤c 缺口 = 门槛 − 当前值',
  !!lockVal && Number(lockVal.gapLevel) === Math.max(0, Number(lockVal.level) - Number(g0.level))
  && Math.abs(Number(lockVal.gapIntimacy) - Math.max(0, Number(lockVal.intimacy) - Number(g0.intimacy))) < 0.011,
  lockVal ? `当前 Lv${g0.level}/${g0.intimacy} → 缺口 ${lockVal.gapLevel} 级、${lockVal.gapIntimacy} 点` : '缺失');
ck('⑥ 开局就有可看的片段', Number(g0?.clipOpen) > 0, `可看 ${g0?.clipOpen}/${g0?.clipTotal}`);
// growth.gifts / interactions / skills 是「已解锁」列表，开局本就为空；
// 全量目录在 progressRules() 里。这里分别验。
const rules = typeof progressRules === 'function' ? progressRules() : null;
ck('⑦ 全量礼物目录 19 件（progressRules）', Array.isArray(rules?.gifts) && rules.gifts.length === 19,
  `${rules?.gifts?.length} 件`);
ck('⑧ 全量互动 22 条（progressRules）', Array.isArray(rules?.interactions) && rules.interactions.length === 22,
  `${rules?.interactions?.length} 条`);
ck('⑨ 全量技能 15 个（progressRules）', Array.isArray(rules?.skills) && rules.skills.length === 15,
  `${rules?.skills?.length} 个`);
ck('⑨b 已解锁清单开局为空（0 件礼物 / 0 互动 / 0 技能）',
  Array.isArray(g0?.gifts) && g0.gifts.length === 0
  && Array.isArray(g0?.interactions) && g0.interactions.length === 0
  && Array.isArray(g0?.skills) && g0.skills.length === 0,
  `gifts=${g0?.gifts?.length} interactions=${g0?.interactions?.length} skills=${g0?.skills?.length}`);

// ── 2. 摸头 5 次，经验与亲密度真的涨 ─────────────────────────
let s = st;
for (let i = 0; i < 5; i += 1) {
  const r = applyHomeAction(s, { action: 'pet', target: 'her', at: now + i * 1500 });
  s = r.state;
}
const v1 = view(s, now + 9000);
const g1 = v1.her.growth;
ck('⑩ 摸头后 xp 增加', Number(g1?.xp) > Number(g0?.xp), `${g0?.xp} → ${g1?.xp}`);
ck('⑪ 摸头后亲密度增加', Number(g1?.intimacy) > Number(g0?.intimacy),
  `${g0?.intimacy} → ${g1?.intimacy}`);
ck('⑫ affection 与 intimacy 一致', v1.her.affection === g1?.intimacy,
  `affection=${v1.her.affection} intimacy=${g1?.intimacy}`);

// ── 3. 同一动作重复递减（防刷）─────────────────────────────────
let s2 = st;
const gains = [];
for (let i = 0; i < 6; i += 1) {
  const before = view(s2, now + i * 1000).her.growth.intimacy;
  const r = applyHomeAction(s2, { action: 'pet', target: 'her', at: now + i * 1000 });
  s2 = r.state;
  const after = view(s2, now + i * 1000).her.growth.intimacy;
  gains.push(+(after - before).toFixed(3));
}
ck('⑬ 重复同一动作收益递减（第 6 次为 0）', gains[gains.length - 1] === 0,
  `各次增益 ${gains.join(' / ')}`);

// ── 3b. 「今天的账」：growBy 必须把系数一起交出来 ─────────────
// 玩家看到一个 +0.9 会以为卡了；界面要能说清这是第几次、按百分之几记的。
// 这里只验数据出口，界面那一侧靠 test-room 的静态断言。
const lastGrow = view(s2, now + 6000).her.growth.lastGrow;
ck('⑬b lastGrow 随快照下发且带系数', !!lastGrow
  && typeof lastGrow.action === 'string'
  && Number.isFinite(Number(lastGrow.factor))
  && Number.isFinite(Number(lastGrow.repeat))
  && Number.isFinite(Number(lastGrow.decay))
  && Number.isFinite(Number(lastGrow.dailyCap)),
  lastGrow ? `action=${lastGrow.action} 标称${lastGrow.base} ×${lastGrow.factor}（重复×${lastGrow.repeat} 边际×${lastGrow.decay}）剩${lastGrow.capLeft}/${lastGrow.dailyCap}` : '缺失');
// 第 6 次摸头的重复系数必须已经归零（progress.json 的 repeat 表末位是 0）。
ck('⑬c 第 6 次 lastGrow 的重复系数为 0', Number(lastGrow?.repeat) === 0,
  `repeat=${lastGrow?.repeat} intimgain=${lastGrow?.intimacy}`);
// 系数相乘必须真的等于「实得 / 标称」（容差放开到千分位，取整在 growBy 里做了两次）。
const expectGain = Math.round(Number(lastGrow?.base || 0) * Number(lastGrow?.factor || 0) * 100) / 100;
ck('⑬d 实得 = 标称 × 系数（取整后一致）',
  Math.abs(Number(lastGrow?.intimacy || 0) - expectGain) < 0.011,
  `实得 ${lastGrow?.intimacy} vs 标称×系数 ${expectGain}`);

// ── 3c. 撞每日上限时必须能说清「到顶了」 ─────────────────────
// 单个动作的重复系数很快归零（talk 第 6 次就 0），所以必须换着动作做才可能吃满 20 点。
let s3 = st;
let capped = null;
const MIX = ['talk', 'feed', 'play', 'water', 'pet', 'talk', 'feed', 'play', 'pet', 'sleep', 'wake', 'lamp'];
for (let i = 0; i < MIX.length * 4 && !capped; i += 1) {
  const action = MIX[i % MIX.length];
  // talk 每次换一句话，避开 30 分钟同文去重（那条走 deduped 分支，不算触顶）。
  const r = applyHomeAction(s3, { action, text: `第${i}句`, at: now + i * 1000 });
  s3 = r.state;
  const lg = view(s3, now + i * 1000).her.growth.lastGrow;
  if (lg && lg.capped) capped = lg;
}
ck('⑬e 吃满日上限时 lastGrow.capped 为真', !!capped,
  capped ? `本次 +${capped.intimacy}（剩余 ${capped.capLeft}）今日 ${capped.gainedToday}/${capped.dailyCap}` : '没触发，可能上限调大了');
ck('⑬f 触顶后今日已得不超过日上限',
  !capped || Number(capped.gainedToday) <= Number(capped.dailyCap) + 1e-9,
  capped ? `${capped.gainedToday} / ${capped.dailyCap}` : '未触发');

// ── 3d. 同一句话去重时，明确标成 deduped 而不是「涨了 0」 ────
// applyHomeAction 是不可变的：返回值必须回写，否则第二次调用读不到第一次的 talk 记录。
let s4 = st;
s4 = applyHomeAction(s4, { action: 'talk', text: '我回来了', at: now }).state;
s4 = applyHomeAction(s4, { action: 'talk', text: '我回来了', at: now + 60_000 }).state;
const dup = view(s4, now + 60_000).her.growth.lastGrow;
ck('⑬g 同文重复被标成 deduped 且实得为 0',
  dup?.deduped === true && Number(dup?.intimacy) === 0,
  dup ? `deduped=${dup.deduped} 实得=${dup.intimacy} 标称=${dup.base}` : '缺失');
// 隔过 30 分钟窗口就该重新记账，否则玩家会觉得「这句话永远不算数」。
s4 = applyHomeAction(s4, { action: 'talk', text: '我回来了', at: now + 60_000 + 31 * 60_000 }).state;
const again = view(s4, now + 60_000 + 31 * 60_000).her.growth.lastGrow;
ck('⑬h 超过去重窗口后同文重新记账',
  again?.deduped === false && Number(again?.intimacy) > 0,
  again ? `deduped=${again.deduped} 实得=${again.intimacy}` : '缺失');

// ── 4. 存档往返：normalize 不丢 growth ────────────────────────
const round = normalizeHomeState(JSON.parse(JSON.stringify(s)), now + 20000);
const g2 = view(round, now + 20000).her.growth;
ck('⑭ 存档往返后 growth 不丢',
  Number(g2?.xp) === Number(g1?.xp) && Number(g2?.intimacy) === Number(g1?.intimacy),
  `xp ${g1?.xp}→${g2?.xp}  intimacy ${g1?.intimacy}→${g2?.intimacy}`);

// ── 5. 老存档（v1，无 growth）不崩 ───────────────────────────
// 注意：存档顶层就是「她」的字段（平铺），claude 才是子对象。
const old = JSON.parse(JSON.stringify(s));
old.v = 1;
delete old.growth;
if (old.claude) delete old.claude.growth;
let migrated = null;
let migrateErr = null;
try {
  migrated = normalizeHomeState(old, now + 30000);
} catch (err) {
  migrateErr = err;
}
if (migrateErr) {
  ck('⑮ 老存档(v1 无 growth)能迁移', false, String(migrateErr?.message || migrateErr));
} else {
  const g3 = view(migrated, now + 30000).her.growth;
  ck('⑮ 老存档(v1 无 growth)能迁移', !!g3 && Number(g3.level) >= 1,
    `v=${migrated.v} level=${g3?.level} intimacy=${g3?.intimacy}`);
  ck('⑯ 迁移后版本升到 2', Number(migrated.v) === 2, `v = ${migrated.v}`);
}

// ── 6. 规则表本身可用（progressRules 是新增导出）──────────────
ck('⑰ progressRules 等级曲线可读', Number(rules?.levelCurve?.max) === 40,
  `等级上限 ${rules?.levelCurve?.max}，总 XP ${rules?.levelCurve?.totalXp}`);
ck('⑱ 十段亲密度阈值正确', Array.isArray(rules?.stages) && rules.stages.length === 10
  && rules.stages.map((s) => s.min).join(',') === '0,7,15,24,34,45,56,67,79,90',
  `${rules?.stages?.length} 段：${(rules?.stages || []).map((s) => s.min).join('/')}`);

// ── 7. 礼物分级：两段解锁 + 双货币 + 三档（方案 C）─────────────
// 这四条验的是「买得成 / 买不成」，不是文案 —— 文案靠 test-room 的静态断言。
const gw = (state, patch = {}) => applyGrowthCheat(state, { wallet: patch, ...patch }, now + 1000);
const buyOf = (state, gift, at = now + 1200) =>
  applyHomeAction(state, { action: 'buy', gift, target: 'her', at });

// 门槛不到不给买：g19-key 要亲密度 90，这里只有 0。
{
  const s0 = gw(st, { intimacy: 0, whale: 999, token: 999 });
  const r = buyOf(s0, 'g19-key');
  const g = view(r.state, now + 1200).her.growth;
  ck('⑲ 门槛不到不给买（钥匙要 90）',
    r.changed === false && !g.inventory.includes('g19-key') && /不到日子|还差/.test(r.reason || ''),
    `changed=${r.changed} reason=${r.reason || '(空)'} 持有=${g.inventory.includes('g19-key')}`);
}

// 钱不够买不了：门槛够（g01 要 0），但鲸元券只有 1，价格 2。
{
  const s0 = gw(st, { intimacy: 0, whale: 1, token: 0 });
  const r = buyOf(s0, 'g01-flower');
  const g = view(r.state, now + 1200).her.growth;
  const w = g.wallet.currencies.find((c) => c.key === 'whale');
  ck('⑳ 钱不够买不了（鲸元券 1 / 价 2）',
    r.changed === false && w.amount === 1 && !g.inventory.includes('g01-flower'),
    `changed=${r.changed} 余额=${w.amount} reason=${r.reason || '(空)'}`);
}

// 买过不能再买：第一次扣 2 点，第二次原样退回。
{
  const s0 = gw(st, { intimacy: 0, whale: 10, token: 0 });
  const r1 = buyOf(s0, 'g01-flower');
  const r2 = buyOf(r1.state, 'g01-flower', now + 1400);
  const g = view(r2.state, now + 1400).her.growth;
  const w = g.wallet.currencies.find((c) => c.key === 'whale');
  ck('㉑ 买过不能再买（第二次不扣钱）',
    r1.changed === true && r2.changed === false && w.amount === 8,
    `第一次=${r1.changed} 第二次=${r2.changed} 余额=${w.amount}（应 8）`);
}

// 买完真的进背包，且回礼链路认它（次日到点后玄关能看到）。
{
  const s0 = gw(st, { intimacy: 0, whale: 10, token: 0 });
  const r1 = buyOf(s0, 'g01-flower');
  const g = view(r1.state, now + 1200).her.growth;
  // 回礼按「收下 + delayDays 天」算，所以要在一天之后再看。
  const gLater = view(r1.state, now + 26 * 3600_000).her.growth;
  const back = (gLater.returns || []).find((x) => x.id === 'g01-flower');
  ck('㉒ 买完进背包、次日回礼到玄关',
    g.inventory.includes('g01-flower') && !!back,
    `inventory=${g.inventory.join('/') || '(空)'} 回礼=${back ? `${back.room}.${back.spot}` : '无'}`);
}

// ── 8. 老存档回填（14 迁移）────────────────────────────────
// 14 之前礼物是自动发的，那批人没有 wallet。不补的话他们进游戏看到「货架全满、
// 钱包 0」，等于新系统对他们不存在。补一次启动资金，且必须只补一次。
{
  const legacy = emptyHomeState(now);
  legacy.growth.inventory = [
    { id: 'g01-flower', at: now - 2 * 86400_000 },
    { id: 'g02-fish', at: now - 2 * 86400_000 },
    { id: 'g03-hairpin', at: now - 2 * 86400_000 }
  ];
  delete legacy.growth.wallet;
  const v1 = view(legacy, now).her.growth;
  const coins = (gg) => (gg.wallet.currencies || []).reduce((a, c) => a + c.amount, 0);
  const first = coins(v1);
  const second = coins(view(legacy, now + 2000).her.growth);
  ck('㉓ 老存档（有礼物无钱包）回填一次启动资金',
    first > 0 && first === second,
    `第一次 ${first} 点 / 第二次 ${second} 点（应相等）`);
  // 新档不该被补：它走正常攒钱路径，白给一笔等于让「攒」这件事失效。
  ck('㉔ 新档不回填（0 件礼物）', coins(view(emptyHomeState(now), now).her.growth) === 0,
    '新档钱包 0');
}

// ── 9. 回礼提醒与领取 ──────────────────────────────────────
{
  const s0 = gw(st, { intimacy: 0, whale: 10, token: 0 });
  const r1 = buyOf(s0, 'g01-flower');
  const T = now + 26 * 3600_000;
  const before = view(r1.state, T).her.growth;
  const taken = applyHomeAction(r1.state, { action: 'return', target: 'her', at: T });
  const after = view(taken.state, T + 1000).her.growth;
  ck('㉕ 回礼到点后 returnHint 有值，领完变 null',
    !!before.returnHint && before.returnHint.count >= 1 && after.returnHint === null && taken.changed === true,
    before.returnHint ? `领前 ${before.returnHint.count} 件 → 领后 ${after.returnHint ? after.returnHint.count : 'null'}` : '领前就没有');
  // 同一件礼物只回一次礼，再点一次应该拿不到。
  const again = applyHomeAction(taken.state, { action: 'return', target: 'her', at: T + 2000 });
  ck('㉖ 回礼领过就不能再领', again.changed === false,
    `第二次 changed=${again.changed} reason=${again.reason || '(空)'}`);
}

// ── 输出 ─────────────────────────────────────────────────────
console.log('\n成长系统端到端验证');
console.log('─'.repeat(78));
let pass = 0;
for (const r of results) {
  if (r.ok) pass += 1;
  const pad = (x, n) => String(x) + ' '.repeat(Math.max(0, n - [...String(x)].length * 2));
  console.log(`${r.ok ? '✅' : '❌'} ${pad(r.name, 46)} ${r.detail ?? ''}`);
}
console.log('─'.repeat(78));
console.log(`${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
