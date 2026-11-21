// 联机版截图：起一个服务器 + 两个独立 Edge（= 两台设备），
// 把「同一间屋子里有两个人」的画面存成 png。
//
//   node game-src/shots-duo.mjs
//
// 想给分享包里那份单文件 server.mjs 截（验证真的发出去能玩）：
//   set DAFIYU_SERVER=D:\Documents\大肥鱼书房\dist\大肥鱼书房\server.mjs
//   node game-src/shots-duo.mjs
// 此时产物多加 online-pack 前缀，方便和源码布局的图区分。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync as mkTmp, rmSync as rmTmp, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 默认跑源码里的服务器；给了 DAFIYU_SERVER 就跑那个文件（分享包自测用）。
const SERVER = process.env.DAFIYU_SERVER ? path.resolve(process.env.DAFIYU_SERVER) : path.join(HERE, 'server', 'server.mjs');
const SERVER_DIR = path.dirname(SERVER);
const TAG = process.env.DAFIYU_SERVER ? 'online-pack' : 'online';

const DATA = mkTmp(path.join(tmpdir(), 'dafiyu-shotduo-'));
const profiles = [mkTmp(path.join(tmpdir(), 'dafiyu-shota-')), mkTmp(path.join(tmpdir(), 'dafiyu-shotb-'))];
await mkdir(OUT, { recursive: true });

async function pickPort(preferred) {
  const net = await import('node:net');
  for (let p = preferred; p < preferred + 40; p += 1) {
    const free = await new Promise((res) => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return preferred;
}

const PORT = await pickPort(8830);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [SERVER], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DAFIYU_DATA_DIR: DATA },
  stdio: 'ignore'
});

/** 起一个 Edge 并连上 CDP，返回 {send, evaluate, shot}。 */
async function launch(debugPort, profileDir) {
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--mute-audio', '--window-size=1440,900', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); ready = true; break; } catch { await sleep(250); }
  }
  if (!ready) throw new Error(`Edge 调试端口 ${debugPort} 没起来`);

  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const open = async (name) => {
    await send('Page.navigate', { url: `${BASE}/index.html` });
    for (let i = 0; i < 70; i += 1) {
      if (await evaluate(`!!document.getElementById('loading')?.classList.contains('hide')`) === true) break;
      await sleep(500);
    }
    await sleep(2500);
    await evaluate(`(() => {
      const i = document.getElementById('gxName');
      if (i) i.value = ${JSON.stringify(name)};
      document.getElementById('gxStart')?.click();
      return true;
    })()`);
    await sleep(1500);
  };

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('  →', name);
  };

  return { proc, ws, send, evaluate, open, shot };
}

let A = null;
let B = null;
try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/api/net/stats`)).ok) break; } catch { /* 等 */ }
    await sleep(200);
  }

  A = await launch(await pickPort(9420), profiles[0]);
  B = await launch(await pickPort(9480), profiles[1]);

  await A.open('小朱');
  await B.open('小张');
  await sleep(1500);

  // 让小张做两件事，这样 A 的「屋里的人」里有内容可看。
  for (const [sel, times] of [['[data-act="pet"]', 1], ['[data-act="feed"]', 1]]) {
    for (let i = 0; i < times; i += 1) {
      await B.evaluate(`(() => { document.querySelector('${sel}')?.click(); return true; })()`);
      await sleep(1200);
    }
  }
  await B.evaluate(`(() => {
    const i = document.getElementById('ntOpen'); if (i) i.click();
    const t = document.getElementById('ntInput'); if (t) t.value = '我把鱼喂过了';
    document.getElementById('ntSend')?.click();
    document.getElementById('ntClose')?.click();
    return true;
  })()`);
  await sleep(4000);

  await A.shot(`11-${TAG}-house.png`);

  // 打开「屋里的人」面板：名单 + 动态 + 消息。
  await A.evaluate(`(() => {
    document.getElementById('ntOpen')?.click();
    const t = document.getElementById('ntInput'); if (t) t.value = '收到，我去看菜园';
    document.getElementById('ntSend')?.click();
    return true;
  })()`);
  await sleep(2500);
  await A.shot(`12-${TAG}-panel.png`);
} finally {
  try { A?.ws.close(); } catch { /* 忽略 */ }
  try { B?.ws.close(); } catch { /* 忽略 */ }
  try { A?.proc.kill(); } catch { /* 忽略 */ }
  try { B?.proc.kill(); } catch { /* 忽略 */ }
  try { server.kill(); } catch { /* 忽略 */ }
  await sleep(600);
  for (const d of [...profiles, DATA]) {
    try { rmTmp(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
console.log('done');
