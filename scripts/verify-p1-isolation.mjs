// P1 硬条件验证：两个不同 pid 对同一个角色说话，必须落到两个独立会话。
//   运行：node scripts/verify-p1-isolation.mjs
import { channelOf, sessionKeyOf } from '../src/room-channel.js';

const rows = [
  ['p_alice 对 claude', { target: 'claude', pid: 'p_alice' }],
  ['p_bob 对 claude', { target: 'claude', pid: 'p_bob' }],
  ['p_alice 对 her', { target: 'her', pid: 'p_alice' }],
  ['无 pid（旧前端）', { target: 'claude' }],
  ['群聊 who=her', { channel: 'group', who: 'her', pid: 'p_alice' }],
  ['群聊 who=claude', { channel: 'group', who: 'claude', pid: 'p_alice' }],
  ['玩家互通 a↔b', { channel: 'peer', pid: 'p_a', peer: 'p_b' }],
  ['玩家互通 b↔a（反向）', { channel: 'peer', pid: 'p_b', peer: 'p_a' }],
];

const out = rows.map(([label, input]) => {
  const ch = channelOf(input);
  const sk = sessionKeyOf(ch);
  return { label, sessionKey: sk.sessionKey, kind: sk.kind };
});

console.log('通道 → 会话键');
console.log('─'.repeat(66));
for (const r of out) console.log(`${r.label.padEnd(26)} ${r.sessionKey.padEnd(24)} ${r.kind}`);
console.log('─'.repeat(66));

const get = (label) => out.find((r) => r.label.startsWith(label))?.sessionKey;

const checks = [
  ['① 两个玩家对 claude 的会话不同（修串台）', get('p_alice 对 claude') !== get('p_bob 对 claude')],
  ['② 同一玩家对 her 与 claude 不同', get('p_alice 对 her') !== get('p_alice 对 claude')],
  ['③ 旧前端无 pid 落到 host（升级不失忆）', get('无 pid') === 'claude:host'],
  ['④ 群聊按住民分开（her）', get('群聊 who=her') === 'group:her'],
  ['⑤ 群聊按住民分开（claude）', get('群聊 who=claude') === 'group:claude'],
  ['⑥ 群聊与私聊不互相覆盖', get('群聊 who=her') !== get('p_alice 对 her')],
  ['⑦ 玩家互通双向算出同一个键', get('玩家互通 a↔b') === get('玩家互通 b↔a')],
  ['⑧ 玩家互通不占用住户会话', !String(get('玩家互通 a↔b')).startsWith('claude')],
];

console.log();
let pass = 0;
for (const [name, ok] of checks) {
  if (ok) pass += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}
console.log('─'.repeat(66));
console.log(`${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
