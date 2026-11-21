// 源码契约测试：不需要起 DSH / SnowLuma，只确认「四项能力」在源码层面没有被改回去。
//
//   node scripts/test-room-channels-contract.mjs
//
// 为什么要有这一类测试：双人会话的接线是**跨文件**的（room-channel → bridge → 白名单两处
// → 单机包三个文件），任何一处漏改都表现为「本机正常、隧道模式 403」或「升级后又串台」，
// 而且很难在一次手工点测里发现。这里把「必须存在」的调用点钉死。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

const bridge = read('src/bridge.js');
const tunnel = read('src/room-tunnel-host.js');
const shim = read('game-src/shell/net-shim.js');
const chat = read('game-src/shell/chat.js');
const duo = read('game-src/shell/net-duo.js');
const channel = read('src/room-channel.js');

console.log('双人房会话通道 · 源码契约');

ok('room-channel 是纯 ESM（不 import node:*，单机包才能复用）', () => {
  assert.ok(!/from\s+'node:/.test(channel), '不能出现 node: 内置模块');
  assert.ok(!/require\(/.test(channel), '不能有 CommonJS require');
  assert.ok(/export function channelOf/.test(channel));
  assert.ok(/export function roomChatFileName/.test(channel));
  assert.ok(/export function createRateGate/.test(channel));
});

ok('bridge.js 的会话键来自 channelOf（不再只按 her/claude）', () => {
  const start = bridge.indexOf('function roomChatState');
  const fn = bridge.slice(start, start + 3400);
  assert.ok(/channelOf\(input\)/.test(fn), 'roomChatState 必须用 channelOf 归一键');
  assert.ok(!/const key = target === 'claude' \? 'claude' : 'her'/.test(fn), '旧的二元 key 必须消失');
  // 文件名派生在 roomChatFile 里（拿 key/kind 换 path），它必须走 roomChatFileName。
  const fileFn = bridge.slice(bridge.indexOf('function roomChatFile'), bridge.indexOf('function roomChatFile') + 400);
  assert.ok(/roomChatFileName\(key, kind\)/.test(fileFn), '文件名必须由 roomChatFileName 派生');
});

ok('bridge.js 限流按桶（pid+通道），不再挂在会话状态上', () => {
  assert.ok(/createRateGate\(/.test(bridge), '必须用 createRateGate');
  assert.ok(/roomChatGate\.check\(bucket/.test(bridge), '按 bucket 计数');
  assert.ok(!/st\.times = st\.times\.filter/.test(bridge), '旧的 st.times 共享计数必须消失');
  assert.ok(!/\bst\.times\b/.test(bridge), '会话状态上不该再有 times 字段');
});

ok('bridge.js 支持三种新通道并落盘', () => {
  assert.ok(/'peer'/.test(bridge) && /channel === 'peer'|rawChannel === 'peer'/.test(bridge), 'peer 通道分支');
  assert.ok(/groupLog\.push\(/.test(bridge), '群聊现场要入队');
  assert.ok(/buildGroupContext\(/.test(bridge), '群聊要拼最近 N 句');
  assert.ok(/buildGroupRules\(/.test(bridge), '群聊要带行为约束');
  assert.ok(/saveGroupLog\(\)/.test(bridge), '群聊日志要落盘');
  assert.ok(/savePeerLog\(/.test(bridge), '玩家互通日志要落盘');
});

ok('bridge.js 群聊不喂 QQ 记忆卡（避免把两个人混起来）', () => {
  assert.ok(/!isGroup && memoryBlock/.test(bridge), '群聊必须跳过记忆卡');
  assert.ok(/ch\.kind !== 'group'/.test(bridge), '群聊不写 QQ 记忆');
});

ok('两个新读取端点存在且返回视图标注', () => {
  assert.ok(/url\.pathname === '\/api\/room\/chat\/peer'/.test(bridge));
  assert.ok(/url\.pathname === '\/api\/room\/chat\/group'/.test(bridge));
  assert.ok(/formatSpeakerLine\(m, \{ viewPid: pid \}\)/.test(bridge));
});

ok('白名单两处都加了新路径（漏一处 = 隧道模式 403）', () => {
  // bridge.js 的 isRoomSurface
  const surface = bridge.slice(bridge.indexOf('const isRoomSurface'), bridge.indexOf('const isRoomSurface') + 900);
  assert.ok(surface.includes("'/api/room/chat/peer'"), 'isRoomSurface 要放行 peer 读');
  assert.ok(surface.includes("'/api/room/chat/group'"), 'isRoomSurface 要放行 group 读');
  // room-tunnel-host.js 的 TUNNEL_ALLOWED_PATHS
  assert.ok(tunnel.includes("'/api/room/chat/peer'"), 'TUNNEL_ALLOWED_PATHS 要放行 peer');
  assert.ok(tunnel.includes("'/api/room/chat/group'"), 'TUNNEL_ALLOWED_PATHS 要放行 group');
  assert.ok(tunnel.includes("'/api/room/chat'"), '原有的 chat 不能被删掉');
});

ok('单机包：三个端点 + 两份环形日志都接上了', () => {
  assert.ok(shim.includes("case '/api/room/chat/peer'"));
  assert.ok(shim.includes("case '/api/room/chat/group'"));
  assert.ok(shim.includes('room-peer-log-'));
  assert.ok(shim.includes('room-group-log.json'));
  assert.ok(/queryOf\(input\)/.test(shim), 'GET 的 query 要摊进 body');
  assert.ok(/channelOf\(\{/.test(shim), '单机包要用同一套通道归一化');
});

ok('单机包：规则引擎区分两位住民，且 peer 通道不假装有模型', () => {
  assert.ok(/ch\.kind === 'peer'\) return ''/.test(chat), 'peer 通道不产生 AI 回复');
  assert.ok(/namedResident\(/.test(chat), '要能认出被点名的是另一位');
  assert.ok(/resolveGroupSpeaker\(/.test(chat), '群聊发言人规则要与会话层一致');
  assert.ok(/ruleReply\(/.test(chat), '规则命中逻辑要抽成函数复用');
});

ok('双人模式：pid/name 随 DataChannel 请求一起送到房主', () => {
  assert.ok(/body\.pid = body\.pid \|\| self\.pid/.test(duo), 'pid 要带过去，否则两人又共用一条会话');
  assert.ok(/body\.name = self\.name/.test(duo), 'name 要带过去，群聊里才显示得出是谁');
  assert.ok(/queryOf\(input\)/.test(duo), 'query 要摊进 body');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
