#!/usr/bin/env node
// Shot-mode probe: open /room/?shot=1&room=study, wait for HOME_READY, dump __homeDebug().
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
  if (!version) throw new Error('Edge did not start');
  const target = await newTarget('about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/room/?shot=1&room=study` });
  const waitUntil = Date.now() + 60000; let ready = false;
  while (Date.now() < waitUntil) {
    await sleep(400);
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      if (r.result?.value === 'HOME_READY') { ready = true; break; }
    } catch { /* navigating */ }
  }
  if (!ready) throw new Error('page did not reach HOME_READY');
  await sleep(1200);
  const r2 = await cdp.send('Runtime.evaluate', { expression: `window.__homeDebug ? JSON.stringify(window.__homeDebug()) : 'null'`, returnByValue: true });
  const dbg = JSON.parse(r2.result?.value || '{}');
  console.log(JSON.stringify({
    herRoom: dbg.herRoom, spot: dbg.spot, modelVisible: dbg.modelVisible, actorVisible: dbg.actorVisible,
    modelPos: dbg.modelPos, statePos: dbg.statePos, displayPos: dbg.displayPos,
    charScreen: dbg.charScreen, camera: dbg.camera, target: dbg.target, camLook: dbg.camLook,
    shotView: dbg.shotView, shotLook: dbg.shotLook, view: dbg.view, follow: dbg.follow,
    bubbleOn: dbg.bubbleOn, loading: dbg.loading, modelReady: dbg.modelReady, chibiReady: dbg.chibiReady,
    // 小公主：模型是否加载、是否可见、在屏幕上的位置
    claudeReady: dbg.claudeReady, claudeVisible: dbg.claudeVisible,
    claudeRoom: dbg.claudeRoom, claudeSpot: dbg.claudeSpot,
    claudePos: dbg.claudePos, claudeStatePos: dbg.claudeStatePos, claudeScreen: dbg.claudeScreen,
    followTarget: dbg.followTarget
  }, null, 2));
  try { cdp.ws.close(); } catch {}
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.error(`probe failed: ${error?.message || error}`);
  process.exit(4);
});
