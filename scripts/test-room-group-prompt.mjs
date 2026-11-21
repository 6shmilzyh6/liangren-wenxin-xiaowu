// 群聊提示词拼装的逻辑测试：不需要 DSH，也不需要起桥接。
//
//   node scripts/test-room-group-prompt.mjs
//
// 这里只验证 **拼装规则**（谁是权威上下文、标注格式、每轮带人设）：把 room-channel
// 提供的块按 bridge.js 的顺序拼一遍，断言结构与顺序都对。真模型调用不在测试范围内。
import assert from 'node:assert/strict';
import {
  GROUP_CONTEXT_LINES,
  buildGroupContext,
  buildGroupRules,
  createRingLog,
  formatSpeakerLine,
  resolveGroupSpeaker,
  sessionKeyOf
} from '../src/room-channel.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

console.log('群聊提示词 · 拼装规则');

ok('规则块：只由本轮 speaker 开口，且点名另一位', () => {
  const her = buildGroupRules({ speaker: 'her' });
  assert.ok(her.includes('小蓝鱼'), '要写清"你这一轮是谁"');
  assert.ok(her.includes('小公主'), '要写清另一位是谁');
  assert.ok(her.includes('只由小蓝鱼开口'), `实际：${her}`);
  assert.ok(her.includes('不要替'), '不能替别人说话');

  const claude = buildGroupRules({ speaker: 'claude' });
  assert.ok(claude.includes('只由小公主开口'));
  assert.notEqual(her, claude);
});

ok('规则块：明确"现场优先于记忆"', () => {
  const rules = buildGroupRules({ speaker: 'her' });
  assert.ok(rules.includes('唯一可信') || rules.includes('以现场为准'), `实际：${rules}`);
});

ok('规则块：speaker 非法时 fail-soft 到小蓝鱼', () => {
  const rules = buildGroupRules({ speaker: 'nobody' });
  assert.ok(rules.includes('只由小蓝鱼开口'));
});

ok('上下文块：只取最近 N 句，并标出 who', () => {
  const log = createRingLog(64);
  log.push({ pid: 'p_a', name: '阿瑞', who: 'player', text: '第一句' });
  log.push({ pid: 'resident', who: 'her', text: '第二句' });
  log.push({ pid: 'p_b', name: '阿鱼', who: 'player', text: '第三句' });

  const block = buildGroupContext(log.list(), { viewPid: 'p_a', lines: 2 });
  assert.ok(block.includes('最近 2 句'), `实际：${block}`);
  assert.ok(block.includes('【小蓝鱼】第二句'));
  assert.ok(block.includes('【阿鱼】第三句'));
  assert.ok(!block.includes('第一句'), '超出 N 句的要丢掉');
});

ok('上下文块：同一条消息对不同玩家显示不同称呼', () => {
  const entry = { pid: 'p_a', name: '阿瑞', who: 'player', text: '你好' };
  const asA = buildGroupContext([entry], { viewPid: 'p_a', lines: 4 });
  const asB = buildGroupContext([entry], { viewPid: 'p_b', lines: 4 });
  assert.ok(asA.includes('【你】你好'), `A 视角：${asA}`);
  assert.ok(asB.includes('【阿瑞】你好'), `B 视角：${asB}`);
});

ok('上下文块：空日志返回空串（第一条消息不产生空标题）', () => {
  assert.equal(buildGroupContext([], { viewPid: 'p_a' }), '');
});

ok('拼装顺序：设定 → 规则 → 现场 → 本轮那句（模拟 bridge.js）', () => {
  const ch = { channel: 'group', pid: 'p_a', who: 'claude' };
  const sk = sessionKeyOf(ch);
  const log = createRingLog(64);
  log.push({ pid: 'p_a', name: '阿瑞', who: 'player', text: '你们在吗' });
  log.push({ pid: 'resident', who: 'her', text: '在' });
  log.push({ pid: 'p_a', name: '阿瑞', who: 'player', text: '@小公主 你呢' });

  const speaker = resolveGroupSpeaker({ text: '@小公主 你呢', who: sk.kind, log: log.list() });
  const parts = [
    '【房间群聊设定】…',                       // intro（每轮都带）
    buildGroupRules({ speaker }),
    buildGroupContext(log.list(), { viewPid: 'p_a', lines: GROUP_CONTEXT_LINES }),
    '【此刻】…',                                // roomChatContext
    `小公主这一轮要回的就是上面最后那句：${formatSpeakerLine({ pid: 'p_a', who: 'player', text: '@小公主 你呢' }, { viewPid: 'p_a' })}`
  ];
  const prompt = parts.filter(Boolean).join('\n\n');

  assert.equal(speaker, 'claude', '@ 点名要压过交替');
  // 顺序断言：规则在现场之前、现场在本轮那句之前
  const iRules = prompt.indexOf('【群聊规则】');
  const iScene = prompt.indexOf('【群聊现场');
  const iMine = prompt.indexOf('这一轮要回的就是');
  assert.ok(iRules > 0 && iScene > iRules && iMine > iScene, `顺序不对：${[iRules, iScene, iMine]}`);
  // 现场里必须已经包含本轮这句（入站先 push）
  assert.ok(prompt.includes('【你】@小公主 你呢'));
  // 另一位的发言也要在，且标的是【小蓝鱼】
  assert.ok(prompt.includes('【小蓝鱼】在'));
});

ok('群聊会话与私聊是两条（不共用记忆）', () => {
  const priv = sessionKeyOf({ target: 'claude', pid: 'p_a' });
  const grp = sessionKeyOf({ channel: 'group', who: 'claude', pid: 'p_a' });
  assert.notEqual(priv.sessionKey, grp.sessionKey);
  assert.equal(priv.channel, 'claude');
  assert.equal(grp.channel, 'group');
});

ok('群聊上下文长度受控（16 句上限内）', () => {
  const log = createRingLog(200);
  for (let i = 0; i < 60; i += 1) log.push({ pid: 'p_a', who: 'player', text: `第${i}句` });
  const block = buildGroupContext(log.list(), { viewPid: 'p_a', lines: GROUP_CONTEXT_LINES });
  // 12 句（默认）→ 只有 48..59 出现
  assert.ok(block.includes('第59句'));
  assert.ok(!block.includes('第47句'));
  // 标题行也是【】开头，所以统计时要减掉它
  const lines = block.split('\n').filter((l) => l.startsWith('【'));
  assert.equal(lines.length, GROUP_CONTEXT_LINES + 1, '12 句话 + 1 行标题');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
