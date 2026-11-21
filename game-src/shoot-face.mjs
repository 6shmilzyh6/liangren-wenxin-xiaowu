// 把脸贴图原图导出成 png，用来单独检查五官绘制本身。
//   node game-src/shoot-face.mjs
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const OUT = path.join(ROOT, 'game-shots', 'claude');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9372;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.shot-profile-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=920,620', 'about:blank',
], { stdio: 'ignore' });

try {
  let targets = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* wait */ }
    await sleep(220);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没拿到调试页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 920, height: 620, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `file:///${PAGE.replace(/\\/g, '/')}?facets=1` });
  await sleep(2800);

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, 'faces.png'), Buffer.from(data, 'base64'));
  console.log('faces.png 已导出');

  // 逐张单导出原始 canvas（像素级，不经浏览器截图缩放）
  for (const name of ['idle', 'happy', 'shy', 'blink', 'sick', 'sleep']) {
    const { result } = await send('Runtime.evaluate', {
      expression: `(() => { const t = window.__actorRef?.faceMaps?.[${JSON.stringify(name)}];`
        + ` if (!t?.image) return null; return t.image.toDataURL('image/png'); })()`,
      returnByValue: true,
    });
    const dataUrl = result?.value;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
      await writeFile(path.join(OUT, `face-${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`face-${name}.png`);
    } else {
      console.log(`face-${name}.png 取不到（需要 window.__actorRef）`);
    }
  }
  ws.close();
} finally {
  edge.kill();
}
console.log('done');
