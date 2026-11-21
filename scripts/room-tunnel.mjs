#!/usr/bin/env node
// 异地共同经营：把本机房间页通过 Cloudflare 快速隧道暴露成一个 https 公网地址。
// 用法：node scripts/room-tunnel.mjs [--port 8830] [--bin <cloudflared 路径>]
// 说明：
//   · 快速隧道（trycloudflare quick tunnel）不需要注册账号，每次启动域名都会变；
//   · 隧道只转发到 127.0.0.1:<port>，房间页仍是本机这份存档，两个人操作的是同一个家；
//   · 首次运行会把 cloudflared 下载到 state/bin（约 55MB），之后复用；
//   · 想把地址固定下来，就申请 Cloudflare 账号做 named tunnel（见 README「异地共同经营」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeTunnelHost, clearTunnelHost } from '../src/room-tunnel-record.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'state', 'bin');
const TUNNEL_FILE = path.join(ROOT, 'state', 'room-tunnel.json');
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const BIN = path.join(BIN_DIR, EXE);
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(argValue('port', process.env.ROOM_TUNNEL_PORT || 8830));
const explicitBin = argValue('bin', process.env.CLOUDFLARED_BIN || '');

function log(line) { console.log(`[tunnel] ${line}`); }

async function findOrDownload() {
  const candidates = [explicitBin, BIN, path.join(os.tmpdir(), EXE), 'cloudflared'].filter(Boolean);
  for (const c of candidates) {
    if (c === 'cloudflared') continue;
    if (fs.existsSync(c)) return c;
  }
  // 系统 PATH 里能直接跑也行
  const onPath = await new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null));
    p.on('error', () => resolve(null));
  });
  if (onPath) return onPath;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = process.platform === 'win32'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  log('本机没有 cloudflared，正在下载（约 55MB，只需一次）…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 cloudflared 失败：HTTP ${res.status}（可手动下载后放 ${BIN}，或用 --bin 指定）`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(BIN, buf);
  if (process.platform !== 'win32') fs.chmodSync(BIN, 0o755);
  log(`已保存：${BIN}（${(buf.length / 1048576).toFixed(1)}MB）`);
  return BIN;
}

async function probe(base, timeoutMs = 8000) {
  try {
    const res = await fetch(`${base}/api/home/state`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return `HTTP ${res.status}`;
    const data = await res.json();
    const her = data?.her;
    const claude = data?.claude;
    return `房间快照可用：小蓝鱼在 ${her?.room || '?'}${claude ? `，小公主在 ${claude.room || '?'}` : ''}`;
  } catch (error) {
    return `探活失败：${error?.message || error}`;
  }
}

const bin = await findOrDownload();
log(`本地服务：http://127.0.0.1:${port}/room/`);
log('建立隧道中…');

const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let publicUrl = '';
let done = false;
const lines = [];

function handle(line) {
  lines.push(line);
  if (!publicUrl) {
    const m = URL_RE.exec(line);
    if (m) {
      publicUrl = m[0];
      const host = new URL(publicUrl).host;
      // 记下当次域名：bridge.js 用它把 Host 校验开一个「只通房间面」的口子。
      try {
        writeTunnelHost(TUNNEL_FILE, { host, url: `${publicUrl}/room/` });
      } catch (error) {
        log(`域名没写进 state/room-tunnel.json（${error?.message || error}）：如果房间跑的是 bridge.js，需要手动把 ${host} 写进 config.json 的 room.tunnelHosts`);
      }
      log('─'.repeat(64));
      log(`公网地址：${publicUrl}/room/`);
      log('把这条地址发给另一个人，他打开的就是同一个家（同一个存档）。');
      log('隧道期间本机关掉或 Ctrl+C，地址立即失效；重启后域名会变。');
      log('─'.repeat(64));
      probe(publicUrl).then((r) => log(r));
    }
  }
}

child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && handle(l)));
child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && handle(l)));

child.on('exit', (code) => {
  if (!done) log(`cloudflared 退出（code=${code}）；最后几行：\n${lines.slice(-6).join('\n')}`);
});
child.on('error', (error) => log(`启动失败：${error?.message || error}`));

setTimeout(() => {
  if (!publicUrl) log('20 秒内还没拿到公网地址，检查网络或本机 443/QUIC 出网；用 --bin 指定已有 cloudflared 再试。');
}, 20000);

const stop = () => { done = true; try { child.kill(); } catch { /* 忽略 */ } clearTunnelHost(TUNNEL_FILE); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
