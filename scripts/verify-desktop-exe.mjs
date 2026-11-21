// 校验桌面上的 exe 是不是「已修复双人断线」的那一版。
//
// 两个踩过的坑，写在这里免得下次重犯：
//   ① exe 里的游戏本体是**压缩过的 zip**，直接搜 exe 字节只能找到 zip 的文件名清单
//      （claude-hq 这类路径能搜到，但 game.js 里的代码字符串必然 0 命中），
//      会误判成"没有修复"。必须启动 exe、从 8787 端口取文件核对。
//   ② 不要用内置 fetch 拉 game.js（1.1 MB）：undici 在读完大响应体时
//      会抛 `AssertionError: assert(!this.paused)`。改用 node:http。
//
//   node scripts/verify-desktop-exe.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const exe = path.join(os.homedir(), 'Desktop', '两人温馨小屋.exe');
const PORT = 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

if (!fs.existsSync(exe)) {
  console.error(`桌面上没有 exe：${exe}`);
  process.exit(1);
}
const st = fs.statSync(exe);
console.log(`\n桌面 exe  ${exe}`);
console.log(`  大小 ${(st.size / 1024 / 1024).toFixed(1)} MB   时间 ${st.mtime.toLocaleString('zh-CN')}`);

function get(relPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: relPath, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const probe = async (relPath) => {
  try { const r = await get(relPath); return r.status === 200; } catch { return false; }
};

let spawned = false;
if (!(await probe('/index.html'))) {
  console.log('  启动 exe（首次要解包，约 10~30 秒）…');
  const p = spawn(exe, [], { stdio: 'ignore', detached: true });
  p.unref();
  spawned = true;
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1500);
    if (await probe('/index.html')) { up = true; break; }
  }
  if (!up) { console.error('  ✗ exe 起不来（90 秒内 8787 未监听）'); process.exit(1); }
}

const game = (await get('/game.js')).buf.toString('utf8');
const index = (await get('/index.html')).buf.toString('utf8');
const clip = await get('/assets/pet/claude-hq/claude_idle.webm');
const count = (s, n) => s.split(n).length - 1;

const checks = [
  ['game.js 可读', game.length > 500000, `${(game.length / 1024).toFixed(0)} KB`],
  ['含高画质片段 claude-hq', count(game, 'claude-hq') > 0, `${count(game, 'claude-hq')} 处`],
  ['含四通道 tab chatTabGroup', count(game, 'chatTabGroup') + count(index, 'chatTabGroup') > 0,
    `game.js ${count(game, 'chatTabGroup')} / index.html ${count(index, 'chatTabGroup')}`],
  ['含成长系统 clipLocks', count(game, 'clipLocks') > 0, `${count(game, 'clipLocks')} 处`],
  ['含亲密度字段 maxIntimacy', count(game, 'maxIntimacy') > 0, `${count(game, 'maxIntimacy')} 处`],
  ['已去掉 serialization:"json"（16KB 断线修复）',
    count(game, `serialization:${DQ}json${DQ}`) === 0 && count(game, `serialization:${SQ}json${SQ}`) === 0,
    `json 残留 ${count(game, `serialization:${DQ}json${DQ}`) + count(game, `serialization:${SQ}json${SQ}`)} 处`],
  ['群聊通道存在',
    count(game, `${SQ}group${SQ}`) + count(game, `${DQ}group${DQ}`) > 0,
    `共 ${count(game, `${SQ}group${SQ}`) + count(game, `${DQ}group${DQ}`)} 处`],
  ['玩家互通通道存在',
    count(game, `${SQ}peer${SQ}`) + count(game, `${DQ}peer${DQ}`) > 0,
    `共 ${count(game, `${SQ}peer${SQ}`) + count(game, `${DQ}peer${DQ}`)} 处`],
  ['高画质片段可下载', clip.status === 200 && clip.buf.length > 1000000,
    `HTTP ${clip.status} ${(clip.buf.length / 1024).toFixed(0)} KB`],
  ['分段发送的探针：服务端能处理 1 MB 响应', game.length > 1000000, `${(game.length / 1024 / 1024).toFixed(2)} MB 完整收到`],
];

console.log('─'.repeat(78));
let pass = 0;
for (const [name, ok, detail] of checks) {
  if (ok) pass += 1;
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length * 2));
  console.log(`${ok ? '✅' : '❌'} ${pad(name, 42)} ${detail}`);
}
console.log('─'.repeat(78));
console.log(`${pass}/${checks.length} 通过`);
if (spawned) console.log('（exe 仍在后台运行，服务在 http://127.0.0.1:8787）');
process.exit(pass === checks.length ? 0 : 1);
