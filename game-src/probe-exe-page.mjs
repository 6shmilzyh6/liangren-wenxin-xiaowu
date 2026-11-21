// 验证 exe 内置服务器（http://127.0.0.1:8787/）上的游戏能不能真的跑起来。
// 目的：区分"exe 起不来"和"exe 起来了但页面报错"。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';
const URL_ = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prof = mkdtempSync(path.join(tmpdir(), 'dfy-exe-'));
const proc = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=9970', `--user-data-dir=${prof}`,
  '--window-size=1280,800', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  'about:blank'
], { stdio: 'ignore' });

let page = null;
for (let i = 0; i < 80; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:9970/json/list')).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!page) { console.log('浏览器起不来'); proc.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (!/useLegacyLights|WebGLRenderer|sigmaRadians/.test(text)) logs.push(`[${m.params.type}] ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
  if (m.method === 'Network.loadingFailed') {
    logs.push('[net-fail] ' + m.params.errorText + ' ' + (m.params.type || ''));
  }
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

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);

  const state = await evaluate(`JSON.stringify({
    url: location.href,
    title: document.title,
    menu: !!document.querySelector('#gxMenu'),
    menuOpts: [...document.querySelectorAll('#gxMenu .m-opt')].map(e => e.textContent.trim().slice(0, 24)),
    loading: document.querySelector('#loading') ? document.querySelector('#loading').className : null,
    canvas: !!document.querySelector('#scene'),
    bodyCls: document.body.className,
    scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src'))
  })`);
  console.log('页面状态:', state);

  // 真的点一次「一个人住」，看能不能进游戏
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('#gxMenu .m-opt')].find(x => /一个人住/.test(x.textContent));
    if (b) b.click();
    return b ? 'clicked' : 'no-btn';
  })()`);
  await sleep(9000);

  const after = await evaluate(`JSON.stringify({
    menuGone: !document.querySelector('#gxMenu'),
    bar: !!document.querySelector('#gxBar'),
    api: typeof globalThis.__gameApi,
    debug: typeof globalThis.__homeDebug === 'function' ? globalThis.__homeDebug() : null,
    loading: document.querySelector('#loading') ? document.querySelector('#loading').className : null
  })`);
  console.log('进游戏后:', after);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot?.result?.data) {
    const out = path.resolve('game-shots', 'exe直跑-页面.png');
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('截图:', out);
  }

  console.log('--- 控制台 ---');
  for (const l of logs.slice(0, 25)) console.log(l);
} catch (err) {
  console.log('失败:', err?.message || err);
} finally {
  try { ws.close(); } catch { }
  proc.kill();
}
