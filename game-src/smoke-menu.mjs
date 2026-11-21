// 三种打开方式下，主菜单该显示什么。
//
//   1. file://   → 必须出「立绘会是空白」的黄色提示（因为确实会）
//   2. 开始玩.exe → 不该出那个提示，也不该出「连联机服务器」（背后没有 /api）
//   3. 联机服务器   → 该出「连联机服务器」
//
// 这三条的判断都不能靠 location.protocol：第 2 种也是 http://。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, tag) {
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-menu-${tag}-`));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'
  ], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* 等 */ }
    await sleep(250);
  }
  if (!page) throw new Error(`${tag} 起不来`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description };
    return r.result?.result?.value;
  };
  return { tag, send, evaluate, kill: () => { try { ws.close(); } catch { } proc.kill(); } };
}

async function menuState(b, url, label) {
  await b.send('Runtime.enable');
  await b.send('Page.enable');
  await b.send('Page.navigate', { url });
  for (let i = 0; i < 100; i += 1) {
    const ok = await b.evaluate(`!!document.querySelector('#gxMenu .m-opt')`);
    if (ok) break;
    await sleep(300);
  }
  await sleep(2600);   // 等 probeServer 那次异步探测回来
  const v = await b.evaluate(`(() => {
    const card = document.querySelector('#gxMenu .m-card');
    if (!card) return JSON.stringify({ err: '没有菜单' });
    return JSON.stringify({
      opt: [...card.querySelectorAll('.m-opt')].map(x => x.querySelector('.m-t')?.textContent || x.textContent.trim().slice(0, 8)),
      warn: !!card.querySelector('.m-warn'),
      warnText: card.querySelector('.m-warn') ? card.querySelector('.m-warn b').textContent : ''
    });
  })()`);
  console.log(label, v);
  return JSON.parse(v);
}

// ---- 1. file:// ----
const FILE_URL = 'file:///' + path.resolve('game/index.html').replace(/\\/g, '/');
const a = await boot(9960, 'file');
try { await menuState(a, FILE_URL, 'file://      :'); } finally { a.kill(); }

// ---- 2. 开始玩.exe ----
const EXE = path.resolve('dist/大肥鱼书房/开始玩.exe');
const P2 = 8902;
const launcher = spawn(EXE, ['--port', String(P2), '--no-open'], { stdio: 'ignore' });
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${P2}/launcher.json`); if ((await r.json()).launcher) break; } catch { }
  await sleep(200);
}
const b = await boot(9970, 'exe');
try { await menuState(b, `http://127.0.0.1:${P2}/`, '开始玩.exe   :'); } finally { b.kill(); launcher.kill(); }

// ---- 3. 联机服务器 ----
const P3 = 8903;
const srv = spawn(process.execPath, ['dist/大肥鱼书房/server.mjs'], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(P3), DAFIYU_DATA_DIR: path.resolve('game-src/server/data-menucheck') }
});
for (let i = 0; i < 80; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${P3}/api/home/state`); if (r.ok) break; } catch { }
  await sleep(250);
}
const c = await boot(9980, 'srv');
try { await menuState(c, `http://127.0.0.1:${P3}/`, '联机服务器   :'); } finally { c.kill(); srv.kill(); }
