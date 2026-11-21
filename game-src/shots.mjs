// 人眼不可靠，截图交给机器：把 game/index.html 真实渲染出来的画面存成 png。
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 与 verify.mjs 同一套退让：没有 game/ 就用 dist/ 里那份交付包。
const GAME = (() => {
  const built = path.join(ROOT, 'game');
  if (existsSync(path.join(built, 'index.html'))) return built;
  const packed = path.join(ROOT, 'dist', '大肥鱼书房');
  if (existsSync(path.join(packed, 'index.html'))) return packed;
  return built;
})();
const OUT = path.join(ROOT, 'game-shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.shot-profile-${Date.now()}`)}`, '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--mute-audio', '--window-size=1440,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 40; i += 1) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let seq = 0;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300) : r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('  →', name);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `file:///${path.join(GAME, 'index.html').replace(/\\/g, '/')}` });

  // 1) 开局引导
  for (let i = 0; i < 60; i += 1) {
    if (await ev(`!!document.getElementById('gxIntro')`) === true) break;
    await sleep(400);
  }
  await sleep(1200);
  await shot('01-intro.png');

  // 2) 走进屋子（关掉引导）
  await ev(`(() => { const s = document.getElementById('gxStart'); if (s) s.click(); return true; })()`);
  await sleep(9000);
  await shot('02-house.png');

  // 3) 任务面板
  await ev(`(() => { window.__gameShell?.openPanel?.(); return true; })()`);
  await sleep(900);
  await shot('03-panel.png');
  await ev(`(() => { window.__gameShell?.closePanel?.(); return true; })()`);

  // 4) 菜园
  await sleep(600);
  await ev(`(() => { document.getElementById('gardenChip')?.click(); return true; })()`);
  await sleep(5000);
  await shot('04-garden.png');

  ws.close();
} finally { edge.kill(); }
console.log('done');
