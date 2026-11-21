// 造型像素验收：不靠肉眼，直接数像素判颜色/位置/比例。
//   node game-src/verify-claude-pixels.mjs
// 输出：每个检查项的颜色统计与坐标，全部由 in-page 计算后回传到 node。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9369;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const cv = document.querySelector('canvas');
  const w = cv.width, h = cv.height;
  const gl = cv.getContext('webgl2') || cv.getContext('webgl');
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // readPixels 是左下原点，翻成左上原点方便和 projectY 对齐
  const at = (x, y) => {          // x,y 用左上原点、CSS 像素（devicePixelRatio=1）
    const gx = Math.round(x);
    const gy = Math.round(h - 1 - y);
    if (gx < 0 || gy < 0 || gx >= w || gy >= h) return null;
    const i = (gy * w + gx) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };
  const near = (c, t, tol) => c && Math.abs(c[0]-t[0]) + Math.abs(c[1]-t[1]) + Math.abs(c[2]-t[2]) <= tol;

  // 统计矩形区域内某类颜色的像素数
  const count = (x0, y0, x1, y1, test) => {
    let n = 0, tot = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y += 1) {
      for (let x = Math.round(x0); x <= Math.round(x1); x += 1) {
        const c = at(x, y);
        if (!c) continue;
        tot += 1;
        if (c[3] > 32 && test(c)) n += 1;
      }
    }
    return { n, tot };
  };

  const WHITE_PETAL = [255, 247, 239];
  const ORANGE = [210, 113, 74];
  const HAIR = [228, 124, 79];
  const CREAM = [251, 231, 219];

  const pjY = window.__projectY;
  const pjX = window.__projectX;
  const yTop = pjY(1.53), yHead = pjY(1.44), yNeck = pjY(1.30),
        yWaist = pjY(0.52), yKnee = pjY(0.33), yFoot = pjY(0.02);
  const xL = pjX(-0.7, 1.0), xR = pjX(0.7, 1.0);

  const crownBox = window.__crownBox;  // {min,max} 世界
  const geo = window.__dumpGeo ? JSON.parse(window.__dumpGeo()) : null;

  return JSON.stringify({
    canvas: { w, h, dpr: devicePixelRatio },
    screen: { yTop, yHead, yNeck, yWaist, yKnee, yFoot, xL, xR },
    geo,
    readback: {
      // 花饰：白瓣必须在其中，橙心必须存在
      petalWhiteInCrown: count(xL, yTop, xR, yNeck, (c) => near(c, WHITE_PETAL, 40)),
      orangeInCrown: count(xL, yTop, xR, yNeck, (c) => near(c, ORANGE, 60)),
      hairInCrown: count(xL, yTop, xR, yNeck, (c) => near(c, HAIR, 60)),
      // 裙摆：膝盖以上必须是奶油白；膝盖以下应基本没有奶油白
      creamAboveKnee: count(xL, yWaist, xR, yKnee, (c) => near(c, CREAM, 30)),
      creamBelowKnee: count(xL, yKnee + 4, xR, yFoot, (c) => near(c, CREAM, 30)),
    }
  });
})()`;

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.shot-profile-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=900,1000', 'about:blank',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `file:///${PAGE.replace(/\\/g, '/')}?yaw=0&pitch=4&dist=2.5&ty=0.95` });
  await sleep(2800);

  const { result } = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const data = JSON.parse(result.value);
  console.log(JSON.stringify(data, null, 2));
  ws.close();
} finally {
  edge.kill();
}
