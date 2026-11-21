#!/usr/bin/env node
// 页面自检：开 /room/?as=claude，等渲染，读回身份/配色/抽屉/小公主模型是否就位。
// 用法: node scripts/side-probe.mjs [as]   as = her | claude | (省略=房主端)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ROOM_SHOT_PORT) || 8830;
const as = (process.argv[2] || '').trim();
const q = as ? `?as=${as}` : '';
const WIDTH = 1440;
const HEIGHT = 900;

const CANDIDATES = (process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []).concat([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]);
const edge = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!edge) { console.error('no Edge'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9500 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'side-probe-'));
const logFd = fs.openSync(path.join(profile, 'edge.log'), 'w');

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
    req.on('timeout', () => req.destroy(new Error('timeout')));
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && c.waiters.has(msg.id)) {
        const w = c.waiters.get(msg.id);
        c.waiters.delete(msg.id);
        if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result);
      } else if (msg.method) c.events.push(msg);
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error(`${method} timeout`)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const main = async () => {
  let cdp = null;
  try {
    let info = null;
    for (let i = 0; i < 40; i++) {
      try { info = await getJson('/json/version'); break; } catch { await sleep(250); }
    }
    if (!info) throw new Error('CDP 没起来');
    const target = await newTarget(`http://127.0.0.1:${port}/room/${q}`);
    cdp = await CDP.open(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // 等首帧 + 两个模型就位
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(400);
      try {
        const r = await cdp.eval('!!(window.__homeDebug && window.__homeDebug().claudeReady) || !!window.__homeErrors?.length');
        if (r) { ready = true; break; }
      } catch { /* 页面还没好 */ }
    }
    await sleep(1500);
    const out = await cdp.eval(`(() => {
      const d = window.__homeDebug ? window.__homeDebug() : null;
      const body = document.body;
      const groups = [...document.querySelectorAll('#petAllBody .pet-group')].map((g) => ({
        name: g.querySelector('h4')?.textContent, buttons: g.querySelectorAll('button').length
      }));
      const chips = [...document.querySelectorAll('.chips .chip')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => el.textContent.trim().replace(/\\s+/g, ' '));
      const cs = getComputedStyle(body);
      return {
        title: document.title,
        classes: body.className,
        h1: document.querySelector('.brand h1')?.textContent,
        sub: document.querySelector('.brand p')?.textContent,
        bg: cs.backgroundColor,
        font: cs.fontFamily,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        heroColor: getComputedStyle(document.querySelector('.brand h1')).color,
        chipVisible: chips,
        drawerGroups: groups.length,
        drawerButtons: groups.reduce((a, g) => a + g.buttons, 0),
        drawerSummary: document.querySelector('#petAll summary')?.textContent,
        actLabels: [...document.querySelectorAll('.actions .act')].map((b) => b.textContent.trim()),
        moodLabels: ['#lblEnergy', '#lblHunger', '#lblThirst', '#lblPain'].map((s) => document.querySelector(s)?.textContent),
        eventsTitle: document.querySelector('.events-panel h3')?.textContent,
        affLabel: document.querySelector('#affLabel')?.textContent,
        claudePanel: !!document.querySelector('#claudeActions')
          && getComputedStyle(document.querySelector('#claudeActions')).display !== 'none'
          && !document.querySelector('#claudeActions').hidden,
        claudeGestures: [...document.querySelectorAll('[data-claude-gesture]')].map((b) => b.textContent.trim()),
        petActionsShown: !!document.querySelector('#petActions') && !document.querySelector('#petActions').hidden,
        meets: !!document.querySelector('#meetBtn') && getComputedStyle(document.querySelector('#meetBtn')).display !== 'none',
        chatTabs: [...document.querySelectorAll('.chat-tab')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.textContent.trim()),
        claudeReady: d && d.claudeReady,
        claudeVisible: d && d.claudeVisible,
        claudeRoom: d && d.claudeRoom,
        followTarget: d && d.followTarget,
        errors: (window.__homeErrors || []).slice(-4)
      };
    })()`);
    console.log(JSON.stringify({ ok: true, as: as || 'host', ...out }, null, 2));
  } catch (e) {
    console.error('probe failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    cdp?.close();
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    try { fs.closeSync(logFd); } catch {}
  }
};
main();
