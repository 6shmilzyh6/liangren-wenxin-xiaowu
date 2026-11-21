// 临时探针：确认 room-channel / chat / net-shim 的改动真的进了单机包。
// esbuild 会把非 ASCII 转成 \uXXXX，所以直接搜中文必然搜不到，得先解码再搜。
import { readFileSync } from 'node:fs';

const s = readFileSync(new URL('../game/game.js', import.meta.url), 'utf8');
// 把 \uXXXX 还原成字符，再做一次包含判断。
const decoded = s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const probes = [
  // room-channel.js：被 net-shim / chat 用到的部分必须进包
  ['room-channel: 视角标注（外人）', '另一位'],
  ['room-channel: 视角标注（自己）', '【你】'],
  ['room-channel: 住户名表', '小公主'],
  ['room-channel: 玩家互通键前缀', 'peer:'],
  ['room-channel: 文件名清洗正则', '[^A-Za-z0-9_-]+'],
  // chat.js：群聊规则引擎
  ['chat.js: 点名转交', '你叫的是'],
  ['chat.js: 群聊应答垫话', '她刚抬了下眼'],
  ['chat.js: 群聊并坐', '三个人坐在这儿'],
  ['chat.js: @ 点名正则', '(小公主|claude|大小姐)'],
  // net-shim.js：三个端点与两份环形日志
  ['net-shim: 玩家互通日志文件', 'room-peer-log-'],
  ['net-shim: 群聊日志文件', 'room-group-log.json'],
  ['net-shim: 私聊接口', '/api/room/chat'],
  ['net-shim: 玩家互通接口', '/api/room/chat/peer'],
  ['net-shim: 群聊接口', '/api/room/chat/group'],
  ['net-shim: GET query 摊平', 'searchParams'],
  // 服务端专用（会话文件命名、prompt 拼装）不该被打进单机包
  ['[应为 false] 服务端会话文件名', 'room-chat-session-'],
  ['[应为 false] 服务端群聊上下文块', '群聊现场·最近']
];

const expectAbsent = new Set(['[应为 false] 服务端会话文件名', '[应为 false] 服务端群聊上下文块']);

let bad = 0;
for (const [label, needle] of probes) {
  const hit = decoded.includes(needle);
  const want = !expectAbsent.has(label);
  const ok = want ? hit : !hit;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(needle)}${hit ? '' : '（未命中）'}`);
  if (!ok) bad += 1;
}
console.log(`\n${probes.length - bad}/${probes.length} 符合预期`);
process.exitCode = bad ? 1 : 0;
