#!/usr/bin/env node
// 书房视觉验收探针：无头 Edge 打开 /room/?room=study，等 HOME_READY 后读取 __homeDebug()，
// 输出她的人物投影位置、相机参数、模型可见性等客观指标（用于判断构图是否合理）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8830;
const WIDTH = 1536, HEIGHT = 1024;
const CHROME_BIN = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9400 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-prof-'));
const logFd = fs.openSync(path.join(profile, 'edge.log'), 'w');
const child = spawn(CHROME_BIN, [
  '--headless=new', '--no-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
  `--window-size=${WIDTH},${HEIGHT}`, `--remote-debugging-port=${debugPort}`,
  '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', logFd, logFd], detached: true });
child.unref();

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: debugPort, path: p, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP timeout')));
    req.on('error', reject);
  });
}
function newTarget(url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: debugPort, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT', timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP new target timeout')));
    req.on('error', reject); req.end();
  });
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 20000);
    });
  }
}

(async () => {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('Edge 没有起来');
  const target = await newTarget('about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/room/?room=study` });
  const waitUntil = Date.now() + 60000; let info = null;
  while (Date.now() < waitUntil) {
    await sleep(400);
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: `window.__homeDebug ? JSON.stringify(window.__homeDebug()) : 'null'`, returnByValue: true });
      info = JSON.parse(r.result?.value || 'null');
      if (info && info.loading === 'done') break;
    } catch { /* 页面还在导航 */ }
  }
  if (!info) throw new Error('页面没有进入就绪状态');
  await sleep(2500);
  const r2 = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify(window.__homeDebug())`, returnByValue: true });
  const dbg = JSON.parse(r2.result?.value || '{}');
  console.log(JSON.stringify({
    herRoom: dbg.herRoom, spot: dbg.spot, modelVisible: dbg.modelVisible, actorVisible: dbg.actorVisible,
    modelPos: dbg.modelPos, statePos: dbg.statePos, displayPos: dbg.displayPos,
    charScreen: dbg.charScreen, camera: dbg.camera, target: dbg.target, camLook: dbg.camLook,
    shotView: dbg.shotView, shotLook: dbg.shotLook, view: dbg.view, follow: dbg.follow,
    bubbleOn: dbg.bubbleOn, loading: dbg.loading, modelReady: dbg.modelReady, chibiReady: dbg.chibiReady
  }, null, 2));
  try { cdp.ws.close(); } catch {}
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.error(`探针失败：${error?.message || error}`);
  process.exit(4);
});
