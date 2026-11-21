#!/usr/bin/env node
// 房间状态单测：不连桥接、不起服务，只测 src/room-state.js 的纯函数 + 落盘。
// 跑法：npm run test:room
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOM_ACTIONS,
  applyRoomAction,
  buildRoomPromptLine,
  describeRoomEvent,
  emptyRoomState,
  loadRoomState,
  markRoomEventsSeen,
  normalizeRoomState,
  roomStage,
  roomView,
  sanitizeText,
  saveRoomState,
  migrateScoreV1toV2,
  ROOM_STAGES
} from '../src/room-state.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message || error}`);
    process.exitCode = 1;
  }
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('emptyRoomState 是干净的初始房间', () => {
  const room = emptyRoomState(T0);
  assert.equal(room.affection, 0);
  assert.equal(room.visits, 0);
  assert.equal(room.lamp, true);
  assert.deepEqual(room.events, []);
  assert.deepEqual(room.notes, []);
});

test('visit 在 30 分钟内只算一次', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'visit', at: T0 });
  assert.equal(state.visits, 1);
  ({ state } = applyRoomAction(state, { action: 'visit', at: T0 + 5 * MIN }));
  assert.equal(state.visits, 1, '刷新页面不应刷访问次数');
  ({ state } = applyRoomAction(state, { action: 'visit', at: T0 + 31 * MIN }));
  assert.equal(state.visits, 2);
});

test('摸头/喂食/戳一下改变「和她」，小数不漂', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  // 增益来自 assets/data/progress.json 的 intimacyGain.actions：pet=2、feed=3、poke=0.5
  assert.equal(state.affection, 2);
  ({ state } = applyRoomAction(state, { action: 'feed', at: T0 + 1 }));
  assert.equal(state.affection, 5);
  ({ state } = applyRoomAction(state, { action: 'poke', at: T0 + 2 }));
  assert.equal(state.affection, 5.5, 'poke 是 0.5，不是 -1');
  // 戳十下不会掉分，也不该写出 4.999999999999999
  for (let i = 0; i < 10; i += 1) ({ state } = applyRoomAction(state, { action: 'poke', at: T0 + 10 + i }));
  assert.equal(state.affection, 10.5);
  assert.ok(Number.isFinite(state.affection));
  assert.equal(String(state.affection).replace(/[0-9]/g, ''), '.', '最多一位小数');
});

test('「和她」封顶 100，阶段走十段表', () => {
  let state = emptyRoomState(T0);
  for (let i = 0; i < 80; i += 1) ({ state } = applyRoomAction(state, { action: 'feed', at: T0 + i }));
  assert.equal(state.affection, 100);
  // 十段阈值 0/7/15/24/34/45/56/67/79/90，称呼来自 progress.json，测试只锁前几段与末段，
  // 免得以后调文案要连着改测试。
  assert.equal(roomStage(0).name, '点头之交');
  assert.equal(roomStage(7).name, '有点眼熟');
  assert.equal(roomStage(34).name, '亲近');
  assert.equal(roomStage(90).name, '交给你了');
  assert.equal(roomStage(120).name, '交给你了', '越界夹到末段');
  assert.equal(roomStage(-5).name, '点头之交', '负数夹到首段');
  assert.equal(ROOM_STAGES.length, 10, '全项目只剩一套十段');
});

test('v1 旧档（五段年代）迁移到十段，分数不降级、不清零', () => {
  // 五段起点的迁移锚点：0→0、10→7、25→34、50→56、75→79
  assert.equal(migrateScoreV1toV2(0), 0);
  assert.equal(migrateScoreV1toV2(10), 7);
  assert.equal(migrateScoreV1toV2(25), 34);
  assert.equal(migrateScoreV1toV2(50), 56);
  assert.equal(migrateScoreV1toV2(75), 79);
  assert.equal(migrateScoreV1toV2(100), 100);
  // 段位不降：旧 75 分原本是末段「粘人」，迁完仍是末段
  assert.equal(roomStage(migrateScoreV1toV2(75)).key, roomStage(90).key === 'entrusted' ? 'attached' : roomStage(migrateScoreV1toV2(75)).key);
  const old = normalizeRoomState({ version: 1, affection: 75, visits: 3, notes: [{ at: T0, text: '留着' }] }, T0);
  assert.equal(old.version, 2);
  assert.equal(old.affection, 79);
  assert.equal(old.visits, 3, '迁移不动来访次数');
  assert.equal(old.notes[0].text, '留着', '迁移不动留言');
  // 没有 version 字段的老文件也按 v1 处理
  assert.equal(normalizeRoomState({ affection: 50 }, T0).affection, 56);
  // 已经是 v2 的不再二次插值
  assert.equal(normalizeRoomState({ version: 2, affection: 50 }, T0).affection, 50);
  // 脏值仍在迁移后钳住
  assert.equal(normalizeRoomState({ version: 1, affection: 999 }, T0).affection, 100);
  assert.equal(normalizeRoomState({ version: 1, affection: -5 }, T0).affection, 0);
});

test('talk 留言会进 notes，控制字符和长度被清洗', () => {
  const dirty = `  今天\u0007也想\u0000你了${'啊'.repeat(200)}  `;
  const { state, changed } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: dirty, at: T0 });
  assert.equal(changed, true);
  assert.equal(state.notes.length, 1);
  assert.ok(!/[\u0000-\u001f]/.test(state.notes[0].text));
  assert.ok(state.notes[0].text.length <= 120);
  assert.equal(state.events.at(-1).action, 'talk');
});

test('空留言不算一次动作', () => {
  const { changed } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: '   ', at: T0 });
  assert.equal(changed, false);
});

test('lamp 可以指定开关，并写进事件文本', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'lamp', on: false, at: T0 });
  assert.equal(state.lamp, false);
  assert.equal(state.events.at(-1).text, 'off');
  ({ state } = applyRoomAction(state, { action: 'lamp', on: true, at: T0 + 1 }));
  assert.equal(state.lamp, true);
  assert.equal(state.events.at(-1).text, 'on');
  const auto = applyRoomAction(state, { action: 'lamp', at: T0 + 2 }).state;
  assert.equal(auto.lamp, false, '不传 on 时应该切换');
});

test('事件最多留 60 条，notes 最多 20 条', () => {
  let state = emptyRoomState(T0);
  for (let i = 0; i < 80; i += 1) ({ state } = applyRoomAction(state, { action: 'pet', at: T0 + i }));
  assert.equal(state.events.length, 60);
  state = emptyRoomState(T0);
  for (let i = 0; i < 30; i += 1) ({ state } = applyRoomAction(state, { action: 'talk', text: `第 ${i} 句`, at: T0 + i }));
  assert.equal(state.notes.length, 20);
  assert.equal(state.notes.at(-1).text, '第 29 句');
});

test('roomView 只给页面需要的房间字段', () => {
  const { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  const view = roomView(state, T0 + 1);
  assert.equal(view.affection, 2);
  assert.equal(view.stage, '点头之交');
  // 十段补齐的三个字段：app.js 用 stageToNext 显示「还差 N」，用 stageKey 做样式钩子。
  assert.equal(view.stageKey, 'nod');
  assert.equal(view.stageMin, 0);
  assert.equal(view.stageToNext, 5);
  assert.ok(Array.isArray(view.events));
  assert.equal(view.events[0].by, '');
});

test('buildRoomPromptLine：没事件时不打扰，首次介绍带说明', () => {
  const room = emptyRoomState(T0);
  assert.equal(buildRoomPromptLine(room, { now: T0, includeIntro: false }), '');
  const intro = buildRoomPromptLine(room, { now: T0, includeIntro: true });
  assert.ok(intro.includes('【你的小屋】'));
  assert.ok(intro.includes('qq_send_room_photo'));
  assert.ok(intro.includes('灯亮着'));
});

test('buildRoomPromptLine：有人来过时播报，标已读后不再重复', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  ({ state } = applyRoomAction(state, { action: 'talk', text: '记得吃饭', at: T0 + 1 }));
  const line = buildRoomPromptLine(state, { now: T0 + 2, seenAt: 0 });
  assert.ok(line.includes('有人摸了摸你的头'));
  assert.ok(line.includes('记得吃饭'));
  const seen = markRoomEventsSeen(state, T0 + 3);
  assert.equal(buildRoomPromptLine(seen, { now: T0 + 4, seenAt: seen.seenAt, includeIntro: false }), '');
});

test('describeRoomEvent 会说人话', () => {
  assert.equal(describeRoomEvent({ action: 'pet' }), '有人摸了摸你的头');
  assert.equal(describeRoomEvent({ action: 'talk', text: '晚安' }), '有人留了句话：「晚安」');
  assert.equal(describeRoomEvent({ action: 'lamp', text: 'off' }), '有人帮你把灯关了');
});

test('normalizeRoomState 能从脏 JSON 里救回房间', () => {
  const room = normalizeRoomState({
    affection: '999',
    visits: -3,
    lamp: 'yes',
    events: [{ action: 'pet', at: T0 }, { action: 'hack', at: T0 }, null],
    notes: [{ at: T0, text: 'hi' }]
  }, T0 + 1);
  assert.equal(room.affection, 100);
  assert.equal(room.visits, 0);
  assert.equal(room.lamp, true);
  assert.equal(room.events.length, 1);
  assert.equal(room.notes.length, 1);
});

test('超过 7 天的事件会被清掉', () => {
  const room = normalizeRoomState({ events: [{ action: 'pet', at: T0 }] }, T0 + 8 * 24 * 60 * MIN);
  assert.equal(room.events.length, 0);
});

test('saveRoomState / loadRoomState 原子落盘并保持字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-state-'));
  const file = path.join(dir, 'room.json');
  const { state } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: '留在墙上', at: T0 });
  saveRoomState(file, state, T0);
  const loaded = loadRoomState(file, T0 + 1);
  assert.equal(loaded.notes[0].text, '留在墙上');
  assert.equal(loaded.updatedAt, T0);
  // Windows 没有 POSIX 权限位：chmod 0o600 之后 statSync 仍报 0o666
  // （NTFS 的 ACL 不映射到 mode 位，0o666 是 Node 给的占位值）。
  // 所以这里只在真正有 POSIX 语义的平台校验，Windows 上这条断言无法成立，
  // 硬要断言只会得到一个永远为红、与实现无关的噪声。
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, '房间状态是私有数据，0600');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeText 去控制符、折叠空白', () => {
  assert.equal(sanitizeText('  a\u0001 b\n c  '), 'a b c');
  assert.equal(sanitizeText('x'.repeat(200)).length, 120);
});

test('动作清单与页面约定一致', () => {
  assert.deepEqual([...ROOM_ACTIONS], ['visit', 'pet', 'poke', 'feed', 'play', 'talk', 'sleep', 'wake', 'lamp']);
});

test('桌宠动作栏引用的动画片段都存在于 actor.js', () => {
  const html = fs.readFileSync(new URL('../public/room/index.html', import.meta.url), 'utf8');
  const actorSource = fs.readFileSync(new URL('../public/room/actor.js', import.meta.url), 'utf8');
  const clips = [...html.matchAll(/data-pet-clip="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(clips).size, clips.length, '动作栏片段不能重复');
  assert.ok(clips.includes('dance'), '动作栏必须有跳舞');
  for (const clip of clips) {
    assert.ok(new RegExp(`\n  ${clip}:`).test(actorSource), `actor.js 缺少动画片段：${clip}`);
  }
});

test('「今天的账」容器与渲染函数都在页面上', () => {
  const html = fs.readFileSync(new URL('../public/room/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
  // HUD 那一栏既能显示也能点开，缺一样这功能就是死的。
  assert.ok(/id="affRow"/.test(html), 'index.html 缺少可点的 #affRow');
  assert.ok(/id="affAccount"/.test(html), 'index.html 缺少 #affAccount 容器');
  assert.ok(/id="affLabel">和她</.test(html), 'HUD 标签必须是「和她」');
  assert.ok(/function renderAffAccount/.test(app), 'app.js 缺少 renderAffAccount');
  assert.ok(/\$\('affRow'\)/.test(app) && /toggleAffAccount/.test(app), 'app.js 没把 #affRow 接上点击');
  assert.ok(/lastGrow/.test(app), 'app.js 没消费 lastGrow');
});

test('「今天的账」不说系统口吻，也不提亲密度打折', () => {
  const app = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
  // 这一段是给玩家看的话，不能出现「等级不足」「未解锁」「权限」这类系统词。
  const block = app.slice(app.indexOf('function growExplain'), app.indexOf('function toggleAffAccount'));
  assert.ok(block.length > 100, 'growExplain 段落没找到');
  for (const bad of ['等级不足', '未解锁', '权限不足', '无权限', 'ERROR']) {
    assert.ok(!block.includes(bad), `账本文案不能出现系统口吻：${bad}`);
  }
  // quietFactor 只乘 XP，亲密度不吃折扣：账本里任何一句都不许说亲密度打折。
  assert.ok(!/亲密度[^。]{0,8}(打折|折扣|减少|六成|五折)/.test(app),
    '亲密度不吃时段折扣，文案不能这么说');
});

test('账本解释函数：四种原因各自说对，且不误报', () => {
  const app = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
  // growExplain 只依赖 Number()，可以整段抠出来在 node 里跑，不用开浏览器。
  // eslint-disable-next-line no-new-func
  const src = app.slice(app.indexOf('function num2'), app.indexOf('function renderAffAccount'));
  assert.ok(src.length > 100, 'growExplain 段落没找到');
  // eslint-disable-next-line no-new-func
  const growExplain = new Function(`${src}; return growExplain;`)();

  // 一、同文去重：说清「说过了」，不能说「涨了 0」。
  assert.match(growExplain({ deduped: true, base: 4, intimacy: 0 }), /说过了/);
  // 二、撞日上限：说清「今天满了」。
  assert.match(growExplain({ base: 3, intimacy: 0.12, capped: true, capLeft: 0.12 }), /额度|满了/);
  assert.match(growExplain({ base: 3, intimacy: 0.12, capped: true, capLeft: 0.12 }), /0\.12/);
  // 三、打折：说出第几次、按百分之几记。
  const cut = growExplain({ base: 2, intimacy: 0.87, times: 2, factor: 0.437, repeat: 0.45, decay: 0.965 });
  assert.match(cut, /第 3 次/);
  assert.match(cut, /44%/);
  // 四、第一次做、系数接近 1：不该硬编个解释出来。
  assert.equal(growExplain({ base: 2, intimacy: 2, times: 0, factor: 1, repeat: 1, decay: 1 }), '');
  // 五、标称就是 0 的动作不能装作涨了。
  assert.match(growExplain({ base: 0, intimacy: 0, times: 3, factor: 0 }), /不记账/);
  // 六、没有任何数据时不崩、返回空串。
  assert.equal(growExplain(null), '');
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n房间状态测试全部通过（${passed} 项）`);
}
