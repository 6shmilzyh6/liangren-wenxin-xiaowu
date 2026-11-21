#!/usr/bin/env node
// 交互验收：在锁定端上走一遍「点地面让她过去 / 摆一个姿态 / 拖她一把」，
// 每一步都用服务端 state 与页面探针确认真的动了，而不是只看有没有报错。
// 用法: node scripts/side-interact.mjs claude|her
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.env.ROOM_SHOT_PORT) || 8830;
const as = (process.argv[2] || 'claude').trim();
const CANDIDATES = (process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []).concat([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]);
const edge = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!edge) { console.error('no Edge'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9900 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'side-interact-'));
const logFd = fs.openSync(path.join(profile, 'edge.log'), 'w');
const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1400,900',
  `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', logFd, logFd], detached: true });
child.unref();

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: debugPort, path: p, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
function newTarget(url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: debugPort, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT', timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
class CDP {
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.waiters.has(m.id)) {
        const w = c.waiters.get(m.id); c.waiters.delete(m.id);
        if (m.error) w.rej(new Error(m.error.message)); else w.res(m.result);
      }
    });
    return c;
  }
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const round = (n) => (typeof n === 'number' ? +n.toFixed(2) : n);

(async () => {
  const started = Date.now();
  let version = null;
  for (let i = 0; i < 60; i += 1) { try { version = await getJson('/json/version'); break; } catch { await sleep(300); } }
  if (!version) throw new Error('Edge 没起来');
  const target = await newTarget('about:blank');
  const cdp = await CDP.open(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/room/?as=${as}` });

  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    try { if (JSON.parse(await cdp.eval('JSON.stringify({cr: !!(window.__homeDebug && window.__homeDebug().claudeReady)})')).cr) break; } catch {}
  }
  await sleep(1200);

  const dbgOf = async () => JSON.parse(await cdp.eval('JSON.stringify(window.__homeDebug())'));
  // claudePos 是三维 [x,y,z]（y 是离地高度），displayPos 是二维 [x,z]；统一成 [x,z] 再比距离。
  const xz = (p) => (Array.isArray(p) ? (p.length > 2 ? [p[0], p[2]] : [p[0], p[1]]) : null);
  const before = await dbgOf();
  const who = as === 'claude' ? 'claude' : 'her';
  const posBefore = xz(who === 'claude' ? before.claudePos : before.displayPos);

  // 1) 点地面：走页面自己的 onClick 路径（不是直接 POST），确认前端把 target 带对了。
  const canvasBox = JSON.parse(await cdp.eval('JSON.stringify((()=>{const r=document.getElementById("scene").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})())'));
  // 先开点击移动（chip 是锁定的两端都有的功能）
  await cdp.eval(`(() => { const c = document.getElementById('clickMoveChip'); if (c && !c.classList.contains('active')) c.click(); return 'ok'; })()`);
  await sleep(300);
  // 落点要避开「点在人身上变成摸头」：挑一个离这一端那位够远的空地。
  const screenNow = (() => {
    return who === 'claude' ? before.claudeScreen : before.charScreen;
  })();
  const CANDIDATES_FRAC = [[0.5, 0.78], [0.3, 0.72], [0.68, 0.72], [0.22, 0.62], [0.78, 0.62], [0.5, 0.6]];
  let tapX = Math.round(canvasBox.x + canvasBox.w * 0.5);
  let tapY = Math.round(canvasBox.y + canvasBox.h * 0.78);
  for (const [fx, fy] of CANDIDATES_FRAC) {
    const x = Math.round(canvasBox.x + canvasBox.w * fx);
    const y = Math.round(canvasBox.y + canvasBox.h * fy);
    const d = screenNow && screenNow.z < 1 ? Math.hypot(x - screenNow.x, y - screenNow.y) : 9999;
    if (d > 220) { tapX = x; tapY = y; break; }
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: tapX, y: tapY, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
    });
    await sleep(120);
  }
  // 等她自己走过去（自由落点 walk 约 3-12 米）
  let walked = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(700);
    const d = await dbgOf();
    walked = xz(who === 'claude' ? d.claudePos : d.displayPos);
    const moved = Math.hypot(walked[0] - posBefore[0], walked[1] - posBefore[1]);
    if (moved > 0.8) break;
  }
  const movedBy = walked ? +Math.hypot(walked[0] - posBefore[0], walked[1] - posBefore[1]).toFixed(2) : null;

  // 2) 姿态：锁定大小姐的页面上，单击姿态按钮应该让模型演一段（gesture 生效期间有 _gesture 字段）。
  let gesture = null;
  if (as === 'claude' && before.claudeVisible) {
    gesture = await cdp.eval(`(() => {
      const b = document.querySelector('[data-claude-gesture="curtsy"]');
      if (!b) return { ok: false, why: 'no button' };
      b.click();
      return { ok: true, label: b.textContent.trim() };
    })()`);
    await sleep(300);
    // 手势是否真的挂到模型上：_gesture 有值且在计时中才算她在演。
    const g = JSON.parse(await cdp.eval('JSON.stringify({g: window.__homeDebug().claudeGesture})'));
    gesture.playing = g.g || null;
  }

  // 3) 长按拖动：按住她 500ms 再拖 120px，松手后位置应该变了，而且变的是这一端那位。
  const screenOf = async () => {
    const d = await dbgOf();
    const s = as === 'claude' ? d.claudeScreen : d.charScreen;
    return s;
  };
  let drag = null;
  const s0 = await screenOf();
  if (s0 && s0.z < 1) {
    const x0 = Math.round(s0.x); const y0 = Math.round(s0.y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(520);
    for (const step of [1, 2, 3, 4]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + step * 34, y: y0 + step * 8, button: 'left', buttons: 1 });
      await sleep(90);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 136, y: y0 + 32, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(1800);
    const d2 = await dbgOf();
    const p2 = xz(as === 'claude' ? d2.claudePos : d2.displayPos);
    drag = { moved: +Math.hypot(p2[0] - walked[0], p2[1] - walked[1]).toFixed(2), from: [round(walked[0]), round(walked[1])], to: [round(p2[0]), round(p2[1])] };
  }

  const after = await dbgOf();
  console.log(JSON.stringify({
    ok: true,
    side: as,
    ms: Date.now() - started,
    tap: { at: [tapX, tapY], posBefore: [round(posBefore[0]), round(posBefore[1])], movedBy },
    gesture,
    drag,
    followTarget: after.followTarget,
    her: { room: after.herRoom, spot: after.spot, walking: after.walking },
    claude: { room: after.claudeRoom, spot: after.claudeSpot, pos: after.claudePos },
    errors: (await cdp.eval('JSON.stringify(window.__homeErrors||[])')).slice(0, 2000)
  }, null, 2));

  cdp.close();
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.error(`失败：${e?.message || e}`);
  process.exit(4);
});
