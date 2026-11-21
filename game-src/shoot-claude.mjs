// 造型预览截图：把 preview-claude.html 在无头 Edge 里渲染成 png。
//   node game-src/shoot-claude.mjs                默认四机位
//   node game-src/shoot-claude.mjs --one front    只出一张
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const OUT = path.join(ROOT, 'game-shots', 'claude');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9366;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = [
  { name: 'front', query: 'yaw=0&pitch=4&dist=2.5&ty=0.95' },
  { name: 'three-quarter', query: 'yaw=38&pitch=8&dist=2.6&ty=0.95' },
  { name: 'side', query: 'yaw=90&pitch=4&dist=2.5&ty=0.95' },
  { name: 'back', query: 'yaw=180&pitch=6&dist=2.5&ty=0.95' },
  { name: 'head', query: 'yaw=8&pitch=2&dist=1.05&ty=1.28&fov=30' },
  { name: 'dress', query: 'yaw=12&pitch=-4&dist=1.5&ty=0.62&fov=34' },
];

await mkdir(OUT, { recursive: true });

const wanted = (() => {
  const i = process.argv.indexOf('--one');
  return i > 0 ? SHOTS.filter((s) => s.name === process.argv[i + 1]) : SHOTS;
})();

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.shot-profile-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=900,1000', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let targets = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
    await sleep(220);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没拿到调试页面');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pend.has(msg.id)) {
      const { resolve, reject } = pend.get(msg.id);
      pend.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });

  for (const shot of wanted) {
    const url = `file:///${PAGE.replace(/\\/g, '/')}?${shot.query}`;
    await send('Page.navigate', { url });
    await sleep(2200);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(OUT, `${shot.name}.png`), Buffer.from(data, 'base64'));
    console.log('shot', shot.name);
  }
  ws.close();
} finally {
  edge.kill();
}
console.log('done →', OUT);
