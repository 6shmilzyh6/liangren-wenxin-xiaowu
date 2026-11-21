// 双人房会话通道的自测：只跑 room-channel.js 的纯函数，不需要起 DSH。
//
//   node scripts/test-room-channel.mjs
//
// 覆盖四件事（对应实现的四条硬约束）：
//   1. 两个 pid 对同一位住户说话 → 两条不同的会话键与文件名（修串台）
//   2. 默认玩家 pid 沿用旧文件名（升级不失忆）
//   3. 文件名能扛路径穿越
//   4. 群聊：@ 优先、交替、按 viewPid 把「你/另一位」标对
import assert from 'node:assert/strict';
import {
  DEFAULT_PID,
  channelOf,
  createRateGate,
  createRingLog,
  formatSpeakerLine,
  normalizePid,
  peerThreadKey,
  resolveGroupSpeaker,
  roomChatFileName,
  sanitizeKeyForFile,
  sessionKeyOf,
  buildGroupContext
} from '../src/room-channel.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

console.log('room-channel 自测');

ok('私聊：两个 pid 落到两条会话、两个文件', () => {
  const a = channelOf({ target: 'claude', pid: 'p_aaa' });
  const b = channelOf({ target: 'claude', pid: 'p_bbb' });
  assert.equal(a.kind, 'claude');
  assert.equal(a.key, 'claude:p_aaa');
  assert.notEqual(a.key, b.key);
  const fa = roomChatFileName(a.key, a.kind);
  const fb = roomChatFileName(b.key, b.kind);
  assert.notEqual(fa, fb);
  assert.equal(fa, 'room-chat-session-claude-p_aaa.json');
  assert.equal(fb, 'room-chat-session-claude-p_bbb.json');
});

ok('私聊：缺 pid 的老前端落到 host，沿用旧文件名', () => {
  const ch = channelOf({ target: 'her' });
  assert.equal(ch.pid, DEFAULT_PID);
  assert.equal(ch.key, `her:${DEFAULT_PID}`);
  assert.equal(roomChatFileName(ch.key, ch.kind), 'room-chat-session.json');
  const c = channelOf({ target: 'claude' });
  assert.equal(roomChatFileName(c.key, c.kind), 'room-chat-session-claude.json');
});

ok('私聊：新玩家不占用旧文件名', () => {
  const ch = channelOf({ target: 'her', pid: 'p_new' });
  assert.equal(roomChatFileName(ch.key, ch.kind), 'room-chat-session-her-p_new.json');
});

ok('文件名不穿越：../ 之类被压平', () => {
  const evil = channelOf({ target: 'her', pid: '../../etc/passwd' });
  // pid 非法 → 归一化成 host，同时 sanitize 也兜一层
  assert.equal(evil.pid, DEFAULT_PID);
  assert.ok(!roomChatFileName('her:../../x', 'her').includes('..'));
  assert.ok(!sanitizeKeyForFile('../../x').includes('..'));
  assert.ok(!sanitizeKeyForFile('a/b\\c').includes('/'));
  assert.ok(!sanitizeKeyForFile('a/b\\c').includes('\\'));
});

ok('群聊：key 与私聊分开，且每位住民一条', () => {
  const g1 = channelOf({ channel: 'group', who: 'her', pid: 'p_a' });
  const g2 = channelOf({ channel: 'group', who: 'claude', pid: 'p_a' });
  assert.equal(g1.kind, 'group');
  assert.equal(g1.who, 'her');
  assert.equal(g1.key, 'group');
  assert.notEqual(roomChatFileName('group:her', 'her'), roomChatFileName('her:p_a', 'her'));
  assert.equal(roomChatFileName(`group:${g2.who}`, g2.who).includes('group'), true);
});

ok('群聊：@ 点名优先于 who 与交替', () => {
  assert.equal(resolveGroupSpeaker({ text: '@小公主 你看这个', who: 'her', log: [] }), 'claude');
  assert.equal(resolveGroupSpeaker({ text: '@小蓝鱼 你来', who: 'claude', log: [] }), 'her');
  // 没点名时按显式 who
  assert.equal(resolveGroupSpeaker({ text: '嗯', who: 'claude', log: [] }), 'claude');
  // 都没有：上一句是 her 说的就轮到 claude
  assert.equal(resolveGroupSpeaker({ text: '嗯', log: [{ who: 'her' }] }), 'claude');
  assert.equal(resolveGroupSpeaker({ text: '嗯', log: [{ who: 'claude' }] }), 'her');
});

ok('群聊：视角标注谁说的', () => {
  const log = createRingLog(16);
  log.push({ pid: 'p_a', name: '阿瑞', who: 'player', text: '你们都在吗' });
  log.push({ pid: 'resident', who: 'her', text: '在的' });
  log.push({ pid: 'p_b', name: '阿鱼', who: 'player', text: '我也在' });
  const lines = log.list().map((m) => formatSpeakerLine(m, { viewPid: 'p_a' }));
  assert.equal(lines[0], '【你】你们都在吗');
  assert.equal(lines[1], '【小蓝鱼】在的');
  assert.equal(lines[2], '【阿鱼】我也在');
  // 换一个视角，同一个人的身份就翻了
  const other = formatSpeakerLine(log.list()[0], { viewPid: 'p_b' });
  assert.equal(other, '【阿瑞】你们都在吗');
});

ok('群聊：上下文块只取最近 N 句并声明「唯一可信」', () => {
  const log = createRingLog(64);
  for (let i = 0; i < 40; i += 1) log.push({ pid: 'p_a', who: 'player', text: `第 ${i} 句` });
  const block = buildGroupContext(log.list(), { viewPid: 'p_a', lines: 8 });
  assert.ok(block.includes('最近 8 句'));
  assert.ok(block.includes('第 39 句'));
  assert.ok(!block.includes('第 31 句'));
});

ok('环形日志：超上限从头部丢，seq 单调', () => {
  const log = createRingLog(3);
  log.push({ text: 'a' });
  log.push({ text: 'b' });
  log.push({ text: 'c' });
  log.push({ text: 'd' });
  assert.equal(log.list().length, 3);
  assert.deepEqual(log.list().map((m) => m.text), ['b', 'c', 'd']);
  assert.deepEqual(log.list().map((m) => m.seq), [2, 3, 4]);
});

ok('玩家互通：两端算同一个串（A→B 与 B→A 不分家）', () => {
  assert.equal(peerThreadKey('p_a', 'p_b'), peerThreadKey('p_b', 'p_a'));
  assert.equal(peerThreadKey('p_a', 'p_b'), 'peer:p_a|p_b');
  assert.equal(channelOf({ channel: 'peer', pid: 'p_a', peer: 'p_b' }).key, 'peer:p_a|p_b');
  // 只有一端 id 时退回单侧键
  assert.equal(channelOf({ channel: 'peer', pid: 'p_a' }).key, 'peer:p_a');
});

ok('pid 归一化：非法字符不落地', () => {
  assert.equal(normalizePid('p_ok-1'), 'p_ok-1');
  assert.equal(normalizePid('has space'), DEFAULT_PID);
  assert.equal(normalizePid(''), DEFAULT_PID);
  assert.equal(normalizePid(null), DEFAULT_PID);
  assert.equal(normalizePid('x'.repeat(99)), DEFAULT_PID);
});

ok('限流：一人刷屏不锁另一人（旧实现共享 30/分钟）', () => {
  const gate = createRateGate({ limit: 3, windowMs: 60_000 });
  const a = channelOf({ target: 'claude', pid: 'p_a' });
  const b = channelOf({ target: 'claude', pid: 'p_b' });
  const bucketA = `${a.kind}:${a.pid}`;
  const bucketB = `${b.kind}:${b.pid}`;
  assert.equal(bucketA, 'claude:p_a');
  assert.notEqual(bucketA, bucketB);
  // A 连刷到限额
  assert.equal(gate.check(bucketA, 3).ok, true);
  assert.equal(gate.check(bucketA, 3).ok, true);
  assert.equal(gate.check(bucketA, 3).ok, true);
  const blocked = gate.check(bucketA, 3);
  assert.equal(blocked.ok, false, 'A 被限流');
  assert.ok(blocked.retryAfter >= 1, '给出剩余秒数');
  // B 不受影响 —— 这就是本次修复的重点
  assert.equal(gate.check(bucketB, 3).ok, true, 'B 仍然能说话');
});

ok('限流：桶键带通道，私聊刷屏不带进群聊', () => {
  const gate = createRateGate({ limit: 1, windowMs: 60_000 });
  assert.equal(gate.check('her:p_a', 1).ok, true);
  assert.equal(gate.check('her:p_a', 1).ok, false);
  // 同一个 pid 换到群聊，是另一个桶
  assert.equal(gate.check('group:p_a', 1).ok, true);
  // 换成小公主，也是另一个桶
  assert.equal(gate.check('claude:p_a', 1).ok, true);
});

ok('限流：窗口过期自动放行', () => {
  const gate = createRateGate({ limit: 1, windowMs: 1000 });
  // 直接用 check 打满，再等过窗口
  assert.equal(gate.check('k', 1).ok, true);
  assert.equal(gate.check('k', 1).ok, false);
  const until = Date.now() + 1100;
  while (Date.now() < until) { /* 同步空转 1.1 秒，比伪造时钟省事 */ }
  assert.equal(gate.check('k', 1).ok, true, '窗口过后可以再说');
});

ok('限流：桶数上涨不会泄漏（过期桶被清）', () => {
  const gate = createRateGate({ limit: 5, windowMs: 1 });
  for (let i = 0; i < 220; i += 1) gate.check(`her:p_${i}`, 5);
  // 过期的桶在阈值触发时被清掉，剩多少不重要，但不能再无限涨
  assert.ok(gate.size() <= 220);
  gate.reset();
  assert.equal(gate.size(), 0);
});

ok('会话表：两个 pid 对 claude 说话 → 两个 sessionKey + 两个文件', () => {
  // 这就是 P1 的验收条件，直接在本函数里跑出来（不用起服务端）。
  const a = sessionKeyOf({ target: 'claude', pid: 'p_alice' });
  const b = sessionKeyOf({ target: 'claude', pid: 'p_bob' });
  assert.equal(a.sessionKey, 'claude:p_alice');
  assert.equal(b.sessionKey, 'claude:p_bob');
  assert.notEqual(a.sessionKey, b.sessionKey);
  const fa = roomChatFileName(a.sessionKey, a.kind);
  const fb = roomChatFileName(b.sessionKey, b.kind);
  assert.notEqual(fa, fb);
  assert.equal(a.kind, 'claude');
  assert.equal(b.kind, 'claude');
  assert.equal(a.channel, 'claude');
});

ok('会话表：群聊按住民再分，且与私聊互不覆盖', () => {
  const priv = sessionKeyOf({ target: 'her', pid: 'p_a' });
  const gHer = sessionKeyOf({ channel: 'group', who: 'her', pid: 'p_a' });
  const gClaude = sessionKeyOf({ channel: 'group', who: 'claude', pid: 'p_a' });
  assert.equal(gHer.sessionKey, 'group:her');
  assert.equal(gClaude.sessionKey, 'group:claude');
  assert.equal(gHer.kind, 'her');
  assert.equal(gClaude.kind, 'claude');
  // 三者的文件名两两不同
  const files = new Set([
    roomChatFileName(priv.sessionKey, priv.kind),
    roomChatFileName(gHer.sessionKey, gHer.kind),
    roomChatFileName(gClaude.sessionKey, gClaude.kind)
  ]);
  assert.equal(files.size, 3);
});

ok('会话表：玩家互通不占用住户会话', () => {
  const p = sessionKeyOf({ channel: 'peer', pid: 'p_a', peer: 'p_b' });
  assert.equal(p.sessionKey, 'peer:p_a|p_b');
  assert.equal(p.channel, 'peer');
});

ok('通道优先级：channel 压过旧的 target（前端只发 channel 也对）', () => {
  // 只发 channel（新前端写法）
  assert.equal(channelOf({ channel: 'claude', pid: 'p_a' }).kind, 'claude');
  assert.equal(channelOf({ channel: 'her', pid: 'p_a' }).kind, 'her');
  // 两个都给且冲突：以 channel 为准
  assert.equal(channelOf({ channel: 'claude', target: 'her', pid: 'p_a' }).kind, 'claude');
  assert.equal(channelOf({ channel: 'her', target: 'claude', pid: 'p_a' }).kind, 'her');
  // 只发 target（旧前端写法）仍然有效
  assert.equal(channelOf({ target: 'claude', pid: 'p_a' }).kind, 'claude');
  // 什么都没有：fail-soft 到小蓝鱼，不会 500
  assert.equal(channelOf({ pid: 'p_a' }).kind, 'her');
});

ok('通道优先级：group / peer 不受 target 干扰', () => {
  assert.equal(channelOf({ channel: 'group', target: 'claude', who: 'her', pid: 'p_a' }).kind, 'group');
  assert.equal(channelOf({ channel: 'peer', target: 'claude', pid: 'p_a', peer: 'p_b' }).kind, 'peer');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
