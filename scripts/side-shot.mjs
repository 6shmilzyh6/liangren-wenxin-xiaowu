#!/usr/bin/env node
// 一端一张图 + 像素统计：确认两边真的是两种画面（配色/角色/面板都不同）。
// 用法: node scripts/side-shot.mjs claude|her [输出路径]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ROOM_SHOT_PORT) || 8830;
const as = (process.argv[2] || 'claude').trim();
const out = process.argv[3] || path.join(ROOT, 'tmp-shots', `side-${as}.png`);
const WIDTH = 1536;
const HEIGHT = 1024;

const CANDIDATES = (process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []).concat([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]);
const edge = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!edge) { console.error('no Edge'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'side-shot-'));
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

// 只需要 PNG 的像素统计（不引第三方库）：解 IDAT → 反滤波 → 采样。
function decodePng(buf) {
  let pos = 8;
  let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const outBuf = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[rp]; rp += 1;
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = outBuf.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? outBuf.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: outBuf };
}

class CDP {
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && c.waiters.has(msg.id)) {
        const w = c.waiters.get(msg.id); c.waiters.delete(msg.id);
        if (msg.error) w.rej(new Error(msg.error.message)); else w.res(msg.result);
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
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  const started = Date.now();
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('Edge 没起来');
  const target = await newTarget('about:blank');
  const cdp = await CDP.open(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/room/?as=${as}` });

  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    const r = await cdp.eval('JSON.stringify({cr: !!(window.__homeDebug && window.__homeDebug().claudeReady), err:(window.__homeErrors||[]).length})');
    try { const o = JSON.parse(r); if (o.cr) { ready = true; break; } } catch {}
  }
  if (!ready) throw new Error('页面没就绪');
  await sleep(2600);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);

  const dbg = JSON.parse(await cdp.eval('JSON.stringify(window.__homeDebug())'));
  // UI 层的客观证据：两端如果只是「同一套界面」换个人，这些值会完全一样。
  const ui = JSON.parse(await cdp.eval(`(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p).trim();
      return o;
    };
    const root = getComputedStyle(document.documentElement);
    return JSON.stringify({
      vars: {
        accent: root.getPropertyValue('--accent').trim(),
        ink: root.getPropertyValue('--ink').trim(),
        card: root.getPropertyValue('--card').trim()
      },
      body: pick('body', ['background-color', 'font-family', 'font-size']),
      brand: pick('.brand h1', ['color', 'font-size', 'letter-spacing', 'font-family', 'font-weight']),
      herPanel: pick('.her-panel', ['background-color', 'border-radius', 'border-color', 'backdrop-filter']),
      eventsPanel: pick('.events-panel', ['background-color', 'border-radius', 'border-color']),
      header: pick('.panel-head .room', ['color', 'letter-spacing', 'text-transform']),
      actBtn: pick('.act', ['background-color', 'border-radius', 'color', 'font-family']),
      presence: {
        petActions: !!document.querySelector('#petActions') && getComputedStyle(document.querySelector('#petActions')).display !== 'none',
        followChip: !!document.querySelector('#followChip') && getComputedStyle(document.querySelector('#followChip')).display !== 'none',
        chatTabClaude: !!document.querySelector('#chatTabClaude') && getComputedStyle(document.querySelector('#chatTabClaude')).display !== 'none',
        chatTabHer: !!document.querySelector('#chatTabHer') && getComputedStyle(document.querySelector('#chatTabHer')).display !== 'none'
      }
    });
  })()`));
  const png = decodePng(buf);
  // 采样：把画面分成 12×8 格，统计每格的平均色，能看出「哪半边是暖色、哪半边冷色」
  const cols = 12; const rows = 8;
  const cells = [];
  let terracotta = 0; let creamWarm = 0; let blueGlass = 0; let total = 0;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let r = 0; let g = 0; let b = 0; let n = 0;
      const x0 = Math.floor((cx * png.w) / cols); const x1 = Math.floor(((cx + 1) * png.w) / cols);
      const y0 = Math.floor((cy * png.h) / rows); const y1 = Math.floor(((cy + 1) * png.h) / rows);
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0; x < x1; x += 4) {
          const i = (y * png.w + x) * png.channels;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n += 1;
          total += 1;
          // 赤陶系（R 明显大于 B）
          if (r > 110 && r - b > 45 && g > 55 && g < r) terracotta += 1;
          // 奶油暖白
          if (r > 215 && g > 195 && b > 165 && r - b > 22 && r - b < 90) creamWarm += 1;
          // 深蓝玻璃（B 明显大于 R，且偏暗）
          if (b > r + 25 && b > 55 && b < 190) blueGlass += 1;
        }
      }
      cells.push({ cx, cy, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) });
    }
  }
  const warmCells = cells.filter((c) => c.r - c.b > 18).length;
  console.log(JSON.stringify({
    ok: true,
    side: as,
    file: out,
    bytes: buf.length,
    size: [png.w, png.h],
    ms: Date.now() - started,
    followTarget: dbg.followTarget,
    her: { room: dbg.herRoom, screen: dbg.charScreen },
    claude: { visible: dbg.claudeVisible, room: dbg.claudeRoom, pos: dbg.claudePos, screen: dbg.claudeScreen },
    camera: dbg.camera,
    ui,
    pixels: {
      terracottaPct: +(100 * terracotta / total).toFixed(2),
      creamWarmPct: +(100 * creamWarm / total).toFixed(2),
      blueGlassPct: +(100 * blueGlass / total).toFixed(2),
      warmGridCells: `${warmCells}/${cells.length}`
    },
    grid: cells
  }, null, 2));

  cdp.close();
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.error(`失败：${error?.message || error}`);
  process.exit(4);
});
