// 精确遮挡图：每个像素用射线问"最前面是哪个网格（按名字/材质色）"。
// 不靠颜色近似——橙色头发和琥珀眼睛的 RGB 几乎一样，按颜色分类必然混淆。
//   node game-src/hitlab.mjs "yaw=0&pitch=0&dist=0.62&ty=1.10&fov=26" 44
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argQuery = process.argv[2] || 'yaw=0&pitch=0&dist=0.62&ty=1.10&fov=26';
const COLS = Number(process.argv[3] || 44);

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.pv-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=700,700', 'about:blank',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 700, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `file:///${PAGE.replace(/\\/g, '/')}?${argQuery}` });
  await sleep(3000);

  const expr = `(() => {
    const THREE = window.__THREE;
    const actor = window.__actorRef;
    const camera = window.__camera;
    const rc = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const W = innerWidth, H = innerHeight;
    const COLS = ${COLS};

    // 只扫角色在屏幕上的包围盒
    const box = new THREE.Box3().setFromObject(actor.group);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let ix = 0; ix <= 1; ix++) for (let iy = 0; iy <= 1; iy++) for (let iz = 0; iz <= 1; iz++) {
      const v = new THREE.Vector3(ix?box.max.x:box.min.x, iy?box.max.y:box.min.y, iz?box.max.z:box.min.z).project(camera);
      const sx = (v.x*0.5+0.5)*W, sy = (-v.y*0.5+0.5)*H;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W-1, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H-1, Math.ceil(y1));
    const stepX = Math.max(1, (x1-x0)/COLS);
    const stepY = stepX * 2.05;

    const ROOT_NAME = actor.group.name;
    const labelOf = (obj) => {
      let o = obj, d = 0;
      while (o && d < 8) { if (o.name && o.name !== ROOT_NAME) return o.name; o = o.parent; d++; }
      const hex = obj.material?.color?.getHexString?.() || '';
      return { e47c4f:'hair', af5235:'hairDark', e89b71:'hairLight', c4613d:'hairTip',
               fbe7db:'cream', dab5a2:'creamLining', d2714a:'orangeTextile',
               fff7ef:'petalWhite', '33110a':'ink', '4c281e':'bookBrown',
               e8b87c:'gold', fbe9dd:'skullSkin', f2d3c4:'skinWarm' }[hex] || hex || '?';
    };

    const rows = [];
    const tally = {};
    for (let y = y0; y <= y1; y += stepY) {
      const line = [];
      for (let x = x0; x <= x1; x += stepX) {
        ndc.x = (x / W) * 2 - 1;
        ndc.y = -(y / H) * 2 + 1;
        rc.setFromCamera(ndc, camera);
        const hits = rc.intersectObject(actor.group, true);
        const first = hits.find((h) => h.object.visible && !h.object.userData.isOutline
          && h.object.material?.opacity !== 0);
        if (!first) { line.push('..'); continue; }
        const lb = labelOf(first.object);
        tally[lb] = (tally[lb] || 0) + 1;
        line.push(lb.slice(0, 2).padEnd(2, ' '));
      }
      rows.push(line.join(''));
    }
    return JSON.stringify({ box: { x0, y0, x1, y1 }, rows, tally });
  })()`;

  const evalled = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (evalled.exceptionDetails) {
    console.error('出错：', evalled.exceptionDetails.exception?.description?.slice(0, 400));
    process.exit(1);
  }
  const data = JSON.parse(evalled.result.value);

  console.log(`\n视角 ${argQuery}`);
  console.log(`包围盒 ${JSON.stringify(data.box)}`);
  console.log('-'.repeat(COLS * 2));
  for (const r of data.rows) console.log(r);
  console.log('-'.repeat(COLS * 2));
  const sorted = Object.entries(data.tally).sort((a, b) => b[1] - a[1]);
  console.log('占屏：' + sorted.map(([k, v]) => `${k}:${v}`).join('  '));
  ws.close();
} finally {
  edge.kill();
}
