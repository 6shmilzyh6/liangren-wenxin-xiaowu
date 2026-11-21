#!/usr/bin/env node
// 双角色实景截图：用「正常模式」（渲染循环开着）打开 /room/?room=study&cam=first，
// 这样小公主的模型会被每帧 setPose 驱动；等 claudeReady 后截一张，并回读屏幕坐标。
// 用法：node scripts/duo-live-shot.mjs [输出路径]
// 依赖：本机 Edge；Node 24 全局 WebSocket（不要 import 'ws'）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ROOM_SHOT_PORT) || 8830;
const out = process.argv[2] || path.join(ROOT, 'tmp-shots', 'duo-live.png');
const WIDTH = 1536;
const HEIGHT = 1024;

const CANDIDATES = (process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []).concat([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]);
function findEdge() {
  for (const bin of CANDIDATES) {
    try { if (fs.existsSync(bin)) return bin; } catch { /* 下一个 */ }
  }
  return null;
}
const edge = findEdge();
if (!edge) { console.error('没有找到 Edge（msedge.exe）'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9400 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-live-'));
const logFd = fs.openSync(path.join(profile, 'edge.log'), 'w');
try { fs.rmSync(out, { force: true }); } catch { /* 忽略 */ }

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  '--force-device-scale-factor=1', `--window-size=${WIDTH},${HEIGHT}`,
  `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', logFd, logFd], detached: true });
child.unref();

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: debugPort, path: p, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP timeout')));
    req.on('error', reject);
  });
}
function newTarget(url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: debugPort,
      path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT', timeout: 5000
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP new target timeout')));
    req.on('error', reject);
    req.end();
  });
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 20000);
      timer.unref?.();
    });
  }
}

async function evalJson(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const v = r.result?.value;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
}

(async () => {
  const started = Date.now();
  let version = null;
  for (let i = 0; i < 80; i += 1) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('Edge 没有起来');
  const target = await newTarget('about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/room/?room=study&cam=first` });

  // 等页面起来 + 小公主模型加载完（ClaudeActor 是程序化的，很快）
  let ready = false;
  const waitUntil = Date.now() + 50000;
  while (Date.now() < waitUntil) {
    await sleep(500);
    const d = await evalJson(cdp, `window.__homeDebug ? JSON.stringify({r:window.__homeDebug().claudeReady,e:window.__homeDebug().claudeRoom}) : 'null'`);
    if (d?.r) { ready = true; break; }
  }
  if (!ready) throw new Error('claudeReady 没有变 true');

  // 把两人都叫到书房，然后等他们走到
  await evalJson(cdp, `(async()=>{await fetch('/api/home/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'command',room:'study',spot:'desk',target:'her'})});await fetch('/api/home/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'command',room:'study',spot:'claude_desk',target:'claude'})});return 'ok'})()`);

  const arriveUntil = Date.now() + 120000;
  let dbg = null;
  while (Date.now() < arriveUntil) {
    await sleep(1500);
    dbg = await evalJson(cdp, `JSON.stringify(window.__homeDebug())`);
    const hp = dbg?.displayPos;
    const herInStudy = dbg?.herRoom === 'study' && Array.isArray(hp) && hp[0] > 13.2 && hp[0] < 17.4 && hp[1] > 3.0 && hp[1] < 6.2 && !dbg?.walking;
    const claudeInStudy = dbg?.claudeRoom === 'study' && dbg?.claudeVisible !== false && dbg?.claudePos && dbg.claudePos[0] > 13.2;
    if (herInStudy && claudeInStudy) break;
  }
  await sleep(2500);
  dbg = await evalJson(cdp, `JSON.stringify(window.__homeDebug())`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(out, buf);

  console.log(JSON.stringify({
    ok: true,
    file: out,
    bytes: buf.length,
    ms: Date.now() - started,
    her: { room: dbg?.herRoom, spot: dbg?.spot, screen: dbg?.charScreen, pos: dbg?.displayPos },
    claude: {
      ready: dbg?.claudeReady, visible: dbg?.claudeVisible,
      room: dbg?.claudeRoom, spot: dbg?.claudeSpot,
      pos: dbg?.claudePos, screen: dbg?.claudeScreen
    },
    camera: dbg?.camera,
    followTarget: dbg?.followTarget
  }, null, 2));

  try { cdp.ws.close(); } catch { /* 忽略 */ }
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  let log = '';
  try { log = fs.readFileSync(path.join(profile, 'edge.log'), 'utf8').slice(-800); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error(`失败：${error?.message || error}${log ? `\n${log}` : ''}`);
  process.exit(4);
});
