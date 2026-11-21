// 造型射线图：每个格子打一条射线，报"最前面是哪个部件"。
// 不靠颜色近似，直接给遮挡关系 —— 用来判断"头发盖住裙子""花在不在脸上"这类问题。
//   node game-src/raymap-claude.mjs
//   node game-src/raymap-claude.mjs "yaw=38&pitch=8" 44
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argQuery = process.argv[2] && process.argv[2].includes('=') ? process.argv[2] : 'yaw=0&pitch=4&dist=2.45&ty=0.95';
const COLS = Number(process.argv[3] || 40);

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

  const evalled = await send('Runtime.evaluate', {
    expression: `window.__hitMap(${COLS})`,
    returnByValue: true,
  });
  if (evalled.exceptionDetails) {
    console.error('出错：', evalled.exceptionDetails.exception?.description || evalled.exceptionDetails.text);
    process.exit(1);
  }
  const data = JSON.parse(evalled.result.value);

  console.log(`\n视角 ${argQuery}  包围盒 ${JSON.stringify(data.box)}`);
  console.log('-'.repeat(data.rows[0].length / 2));
  for (const r of data.rows) console.log(r);
  console.log('-'.repeat(data.rows[0].length / 2));
  const tally = Object.entries(data.tally || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`占屏统计 ${tally}`);

  // 中轴剖面：她是"头发盖裙子"还是"裙子露出来"
  const prof = await send('Runtime.evaluate', {
    expression: 'window.__columnProfile()',
    returnByValue: true,
  });
  const rows = JSON.parse(prof.result.value);
  const hexTally = {};
  for (const r of rows) hexTally[r.hex] = (hexTally[r.hex] || 0) + 1;
  console.log(`\n中轴从下到上（每 6px 一个采样）`);
  for (const r of rows) {
    const mark = { '#fbe7db': '裙', '#dab5a2': '裾', '#e47c4f': '发', '#af5235': '暗', '#c4613d': '梢', '#d2714a': '橙', '#fff7ef': '瓣', '#4c281e': '书', '#f0d5c4': '肤', '#33110a': '墨' }[r.hex] || (r.hex || '');
    console.log(`  y=${String(r.y).padStart(4)}  世界 y=${r.worldY.toFixed(3)}  ${r.hex || '-'}  ${mark}`);
  }
  ws.close();
} finally {
  edge.kill();
}
