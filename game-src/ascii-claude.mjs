// 造型字符图：把无头渲染结果降采样成色块图打印到终端。
// 没有视觉通道时，这是唯一能"看见"造型的办法 —— 依靠像素回读，不依赖看图能力。
//   node game-src/ascii-claude.mjs                     正面
//   node game-src/ascii-claude.mjs "yaw=38&pitch=8"    三分之四侧
//   node game-src/ascii-claude.mjs "yaw=90&w=40"       侧面，40 列
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9370;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argQuery = process.argv[2] && process.argv[2].includes('=') ? process.argv[2] : 'yaw=0&pitch=4&dist=2.45&ty=0.95';
const COLS = Number(new URLSearchParams(argQuery).get('w') || 46);

// 调色板：把颜色归类成可读符号。顺序即优先级（先命中先归类）。
const PALETTE = [
  { ch: 'O', name: '橙(花心/腰蝶)', hex: [210, 113, 74], tol: 40 },
  { ch: '#', name: '橙发', hex: [228, 124, 79], tol: 44 },
  { ch: '=', name: '深橙发梢', hex: [196, 97, 61], tol: 36 },
  { ch: 'o', name: '暗部发', hex: [175, 82, 53], tol: 32 },
  { ch: '.', name: '奶油裙', hex: [251, 231, 219], tol: 24 },
  { ch: ':', name: '裙暗部', hex: [218, 181, 162], tol: 24 },
  { ch: 'S', name: '肤色', hex: [242, 211, 196], tol: 26 },
  { ch: 'X', name: '墨黑描边', hex: [51, 17, 10], tol: 48 },
  { ch: 'b', name: '书棕', hex: [76, 40, 30], tol: 42 },
  { ch: 'g', name: '金', hex: [232, 184, 124], tol: 32 },
  { ch: 'w', name: '白花瓣', hex: [255, 247, 239], tol: 7 },
];

function buildProbe(cols) {
  const palJson = JSON.stringify(PALETTE.map(({ ch, hex, tol }) => ({ ch, hex, tol })));
  return `(() => {
  const COLS = ${cols};
  const PAL = ${palJson};
  const cv = document.querySelector('canvas');
  if (!cv) return JSON.stringify({ error: '没有 canvas' });
  const W = cv.width, H = cv.height;
  const gl = cv.getContext('webgl2') || cv.getContext('webgl');
  if (!gl) return JSON.stringify({ error: '没有 webgl 上下文' });
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);

  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (px[(y * W + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return JSON.stringify({ error: '画面全透明' });

  const className = (r, g, b) => {
    for (let i = 0; i < PAL.length; i += 1) {
      const p = PAL[i];
      if (Math.abs(r - p.hex[0]) + Math.abs(g - p.hex[1]) + Math.abs(b - p.hex[2]) <= p.tol) return p.ch;
    }
    return null;
  };

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const stepX = Math.max(1, Math.round(bw / COLS));
  const stepY = Math.max(1, Math.round(stepX * 2.05));
  const rows = [];
  const tally = {};
  for (let y = y0; y <= y1; y += stepY) {
    let line = '';
    for (let x = x0; x <= x1; x += stepX) {
      const votes = {};
      for (let yy = y; yy < Math.min(y + stepY, y1 + 1); yy += 1) {
        for (let xx = x; xx < Math.min(x + stepX, x1 + 1); xx += 1) {
          const i = (yy * W + xx) * 4;
          if (px[i + 3] <= 24) continue;
          const c = className(px[i], px[i + 1], px[i + 2]);
          if (c) votes[c] = (votes[c] || 0) + 1;
        }
      }
      let best = null;
      let bestN = 0;
      for (const k in votes) { if (votes[k] > bestN) { bestN = votes[k]; best = k; } }
      if (best) tally[best] = (tally[best] || 0) + 1;
      line += best || ' ';
    }
    rows.push(line.replace(/\\s+$/, ''));
  }
  return JSON.stringify({ box: { x0, y0, x1, y1, bw, bh }, stepX, stepY, rows, tally, canvas: [W, H] });
})()`;
}

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
  await send('Page.navigate', { url: `file:///${PAGE.replace(/\\/g, '/')}?${argQuery}` });
  await sleep(3000);

  const evalled = await send('Runtime.evaluate', { expression: buildProbe(COLS), returnByValue: true });
  if (evalled.exceptionDetails) {
    console.error('页面内执行出错：', evalled.exceptionDetails.exception?.description || evalled.exceptionDetails.text);
    process.exit(1);
  }
  const raw = evalled.result?.value;
  if (typeof raw !== 'string') {
    console.error('返回值不是字符串：', JSON.stringify(evalled.result).slice(0, 600));
    process.exit(1);
  }
  const data = JSON.parse(raw);
  if (data.error) { console.log(data.error); process.exit(1); }

  console.log(`\n视角 ${argQuery}`);
  console.log(`画布 ${data.canvas.join('x')}  包围盒 ${data.box.bw}x${data.box.bh}px  采样步长 ${data.stepX}/${data.stepY}`);
  console.log('-'.repeat(data.rows[0].length));
  for (const r of data.rows) console.log(r);
  console.log('-'.repeat(data.rows[0].length));
  console.log(PALETTE.map((p) => `${p.ch}=${p.name}`).join('  '));
  const tally = Object.entries(data.tally || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`分类统计 ${tally}`);
  ws.close();
} finally {
  edge.kill();
}
