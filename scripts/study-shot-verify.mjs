#!/usr/bin/env node
// 书房视觉验收：无头 Edge（CDP）打开 /room/?shot=1&room=study&q=balanced，
// 等待 HOME_READY，收集 __homeErrors，输出 overview 截图（书房视角）。
// 用法：node scripts/study-shot-verify.mjs <输出png路径>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// preview 环境没有 config.json 也能跑（home-preview 用默认端口 8830、无 token）。
let cfg = {};
for (const name of ['config.json', 'config.example.json']) {
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8')); break; } catch { /* 试下一个 */ }
}
const port = Number(process.env.ROOM_SHOT_PORT) || 8830;
const token = process.env.ROOM_SHOT_TOKEN !== undefined ? process.env.ROOM_SHOT_TOKEN : (cfg.consoleToken || '');
const out = process.argv[2] || path.join(ROOT, 'tmp-shots', 'study-verify.png');
const room = process.argv[3] || 'study';
const extraQs = process.argv[4] || ''; // 如 'pov=1'、'char=3d'、'shotLook=room'
const WIDTH = 1536;
const HEIGHT = 1024;
const CHROME_BIN = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!fs.existsSync(CHROME_BIN)) { console.error(`浏览器不存在：${CHROME_BIN}`); process.exit(3); }
try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* 忽略 */ }
try { fs.rmSync(out, { force: true }); } catch { /* 忽略 */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9400 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-prof-'));
const logPath = path.join(profile, 'edge.log');
const logFd = fs.openSync(logPath, 'w');

const child = spawn(CHROME_BIN, [
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
      host: '127.0.0.1', port: debugPort, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT', timeout: 5000
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
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
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

(async () => {
  const started = Date.now();
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(300); }
    if (Date.now() - started > 45000) break;
  }
  if (!version) throw new Error('Edge 没有起来');
  const target = await newTarget('about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
  });
  const qs = `?shot=1&q=balanced&room=${encodeURIComponent(room)}${extraQs ? `&${extraQs}` : ''}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const url = `http://127.0.0.1:${port}/room/${qs}`;
  await cdp.send('Page.navigate', { url });

  let ready = false;
  let errors = [];
  const waitUntil = Date.now() + 60000;
  while (Date.now() < waitUntil) {
    await sleep(400);
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({title:document.title, err:(window.__homeErrors||[]).slice(-8), her: (window.__debugHer||null)})`,
        returnByValue: true
      });
      const info = JSON.parse(r.result?.value || '{}');
      errors = info.err || [];
      if (info.title === 'HOME_READY') { ready = true; break; }
    } catch { /* 页面还在导航 */ }
  }
  if (!ready) throw new Error(`页面没有进入截图状态${errors.length ? `：${errors.join(' | ')}` : ''}`);
  await sleep(4000);
  // 截图模式下第 350ms 的二次渲染已经把 she 和家具画出来；这里再补一次渲染探针。
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({errors:(window.__homeErrors||[]).slice(-8), title:document.title})`,
    returnByValue: true
  });
  const probeInfo = JSON.parse(probe.result?.value || '{}');
  errors = probeInfo.errors || errors;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  if (buf.length < 1024) throw new Error('截图数据过小');
  fs.writeFileSync(out, buf);
  try { cdp.ws.close(); } catch { /* 忽略 */ }
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(JSON.stringify({ ok: true, file: out, bytes: buf.length, room, errors, ms: Date.now() - started }));
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  let logTail = '';
  try { logTail = fs.readFileSync(logPath, 'utf8').slice(-800); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error(`截图失败：${error?.message || error}${logTail ? `\n${logTail}` : ''}`);
  process.exit(4);
});
