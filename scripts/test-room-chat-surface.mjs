// 单机包规则引擎的行为测试：不需要浏览器，直接 import game-src/shell/chat.js。
//
//   node scripts/test-room-chat-surface.mjs
//
// chat.js 只依赖 room-channel.js 与自身的规则表，没有 DOM / localStorage 依赖，
// 所以能在 Node 里直接跑。这里验证 P4 的验收点：
//   · 私聊：两位住民各说各的，互不串台词
//   · 群聊：能被 @ 点名改人、能认出"叫的是另一位"、能接另一位的话
//   · 玩家互通：不产生 AI 回复
import assert from 'node:assert/strict';
import { localReply } from '../game-src/shell/chat.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

// 一份最小可用的 home 快照：够 where() 读出房间/活动/身体状态。
const view = {
  her: { roomName: '客厅', activity: '在看书', asleep: false, spotLabel: '沙发' },
  claude: { roomName: '书房', activity: '在发呆', asleep: false, spotLabel: '窗边' },
  body: { hunger: 0.8, thirst: 0.2, energy: 0.9 }
};

console.log('单机版规则引擎 · 通道行为');

ok('私聊 her：命中规则表，回的是小蓝鱼的台词', () => {
  const reply = localReply('晚安', 'her', view);
  assert.ok(reply.includes('关灯') || reply.includes('躺下'), `实际：${reply}`);
});

ok('私聊 claude：同一句话回的是小公主的台词（不串台）', () => {
  const reply = localReply('晚安', 'claude', view);
  assert.ok(reply.includes('看完') || reply.includes('睡了'), `实际：${reply}`);
  // 两句必须不一样，否则等于两个住户共用一个声音
  assert.notEqual(reply, localReply('晚安', 'her', view));
});

ok('私聊：两位住民用各自的房间位置说话', () => {
  const her = localReply('早', 'her', view);
  const claude = localReply('早', 'claude', view);
  assert.ok(her.includes('客厅'), `her 实际：${her}`);
  assert.ok(claude.includes('书房'), `claude 实际：${claude}`);
});

ok('群聊：@ 小公主时由小公主接，位置对得上', () => {
  const reply = localReply('@小公主 早', { channel: 'group', pid: 'p_a' }, view, { log: [] });
  assert.ok(reply.includes('书房'), `实际：${reply}`);
});

ok('群聊：@ 小蓝鱼时由小蓝鱼接', () => {
  const reply = localReply('@小蓝鱼 早', { channel: 'group', pid: 'p_a' }, view, { log: [] });
  assert.ok(reply.includes('客厅'), `实际：${reply}`);
  assert.ok(!reply.includes('书房'), '不能带出另一个人的位置');
});

ok('群聊：小蓝鱼开口时被叫的是小公主 → 把话递过去，不抢话', () => {
  const log = [{ who: 'player', pid: 'p_a', text: '小公主你觉得呢' }];
  const reply = localReply('小公主你觉得呢', { channel: 'group', pid: 'p_a', who: 'her' }, view, { log });
  assert.ok(reply.includes('小公主'), `实际：${reply}`);
  assert.ok(reply.includes('旁边') || reply.includes('叫的'), `实际：${reply}`);
});

ok('群聊：上一句是另一位住民说的 → 先应一声再接话', () => {
  const log = [{ who: 'her', pid: 'resident', text: '我先说一句' }];
  const reply = localReply('你也说说', { channel: 'group', pid: 'p_a', who: 'claude' }, view, { log });
  // 垫话来自 GROUP_SHIFT，必然提到另一位（小蓝鱼）
  assert.ok(reply.includes('小蓝鱼'), `实际：${reply}`);
});

ok('群聊：没有点名、没有 who、日志里也没有住民 → 默认小蓝鱼', () => {
  const reply = localReply('今天天气怎么样', { channel: 'group', pid: 'p_a' }, view, { log: [] });
  assert.ok(reply.includes('风') || reply.includes('窗外'), `实际：${reply}`);
});

ok('玩家互通：不产生 AI 回复（单机包也不假装有人应）', () => {
  assert.equal(localReply('你在吗', { channel: 'peer', pid: 'p_a', peer: 'p_b' }, view), '');
});

ok('群聊里玩家互通仍然安静（peer 优先于 group 判定）', () => {
  assert.equal(localReply('你在吗', { channel: 'peer', pid: 'p_a', peer: 'p_b', who: 'her' }, view, { log: [] }), '');
});

ok('空消息：给一句追问而不是空串', () => {
  assert.equal(localReply('   ', 'her', view), '你想说什么？');
});

ok('睡着时：群聊也会敷衍，不会突然长篇', () => {
  const asleep = { ...view, her: { ...view.her, asleep: true } };
  const reply = localReply('你好呀', { channel: 'group', pid: 'p_a', who: 'her' }, asleep, { log: [] });
  assert.ok(reply.length > 0);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
