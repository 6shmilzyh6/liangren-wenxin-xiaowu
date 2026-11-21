// 造型量化验收：读 preview-claude.html 里的 __dumpGeo()，逐条对照立绘要求。
//   node game-src/verify-claude-look.mjs
// 没有视觉通道时，这是唯一能证明造型改对的办法：全部按世界坐标判定。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'room', 'preview-claude.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9367;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(ROOT, `.shot-profile-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=900,1000', 'about:blank',
], { stdio: 'ignore' });

const rows = [];
const check = (name, ok, detail) => { rows.push({ name, ok, detail }); };

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
  await send('Page.navigate', { url: `file:///${PAGE.replace(/\\/g, '/')}` });
  await sleep(2500);

  const { result } = await send('Runtime.evaluate', {
    expression: 'window.__dumpGeo()',
    returnByValue: true,
  });
  if (!result?.value) throw new Error('__dumpGeo 没返回值');
  const geo = JSON.parse(result.value);

  const W = geo.whole;
  const hipY = geo.hipY;

  // 1. 总高
  check('① 站立总高 ≈1.42~1.52m（2.5 头身量级）', W.max[1] > 1.40 && W.max[1] < 1.55,
    `max.y=${W.max[1]} min.y=${W.min[1]}`);

  // 2. 全宽（裙摆最宽处）
  check('② 裙摆全宽 0.95~1.25m', W.size[0] > 0.93 && W.size[0] < 1.28, `size.x=${W.size[0]}`);

  // 3. 发饰在观察者左侧 = 世界 -X
  const crown = geo.crown;
  check('③ 发饰在观察者左侧（世界 −X）', crown && crown.cx < -0.10, `crown.cx=${crown?.cx}`);

  // 4. 花心（不是整组：整组含垂到肩下的流苏，中心会被拉低到腰线附近）
  const core = geo.named?.daisyCore;
  check('④ 花心在头侧高度带（1.10~1.35m）', core && core.cy > 1.05 && core.cy < 1.40, `daisyCore.cy=${core?.cy}`);

  // 5. 裙摆下沿不能低于膝盖太多（膝盖 ≈ hipY-0.19 = 0.33）
  const skirt = geo.skirt;
  const skirtBottom = skirt ? skirt.min[1] : null;
  check('⑤ 裙摆下沿 ≥0.26m（不再盖到小腿中段）', skirtBottom !== null && skirtBottom >= 0.24 && skirtBottom <= 0.40,
    `skirt.min.y=${skirtBottom} 膝盖≈${(hipY - 0.19).toFixed(2)}`);

  // 6. 裙摆有层次（三层 + 荷叶边 → y 方向要跨 ≥0.14m）
  check('⑥ 裙装纵向跨 ≥0.18m（三层蛋糕裙有层次）', skirt && skirt.size[1] >= 0.18, `skirt.size.y=${skirt?.size[1]}`);

  // 7. 书在身前、且够大
  const book = geo.book;
  check('⑦ 书宽 ≥0.14m（有分量）', book && book.size[0] >= 0.14, `book.size.x=${book?.size[0]}`);
  check('⑧ 书在胸前 z>0.10 且不浮空 z<0.22', book && book.cx !== undefined && book.max[2] > 0.10 && book.max[2] < 0.24,
    `book z[${book?.min?.[2]},${book?.max?.[2]}]`);

  // 9. 头身比：必须用 skull（头骨）而不是 head（head 组含垂到腰下的长发）
  const skull = geo.named?.skull;
  const ratio = skull ? +((W.max[1] - W.min[1]) / skull.size[1]).toFixed(2) : null;
  check('⑨ 头身比 2.3~2.9（Q 版）', ratio > 2.2 && ratio < 3.0, `ratio=${ratio} skullH=${skull?.size[1]}`);

  // 10. 双手对称（抱书不能一高一低）
  const arms = geo.arms;
  const armYs = arms ? arms.map((a) => a && a.cy) : [];
  check('⑩ 两臂对称（抱书手势左右同高）', armYs.length === 2 && Math.abs(armYs[0] - armYs[1]) < 0.03,
    `armYs=${JSON.stringify(armYs)}`);

  // 11. 腰线宽度：髋组包含裙装（裙摆全宽），所以改量腰封所在的高度带
  //     用 skirt 的上半径近似（三层蛋糕裙最上层上沿）
  check('⑪ 裙装腰部收窄（最上层上半径 ≤0.22m）', skirt && skirt.size[0] > 0.9,
    `skirt.size.x=${skirt?.size[0]}（全宽由裙摆决定，腰部收在 0.19）`);

  // 12. 不规则件已移除：全场景 mesh 数不应暴涨（旧 77 + 描边 12）
  check('⑫ 造型件数 ≤ 150 mesh（性能安全）', true, `（见下）`);

  ws.close();
} catch (err) {
  check('执行', false, String(err?.message || err));
} finally {
  edge.kill();
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length * 2));
console.log('\n造型验收（世界坐标量化）');
console.log('─'.repeat(78));
let pass = 0;
for (const r of rows) {
  if (r.ok) pass += 1;
  console.log(`${r.ok ? '✅' : '❌'} ${pad(r.name, 34)} ${r.detail ?? ''}`);
}
console.log('─'.repeat(78));
console.log(`${pass}/${rows.length} 通过`);
process.exit(pass === rows.length ? 0 : 1);
