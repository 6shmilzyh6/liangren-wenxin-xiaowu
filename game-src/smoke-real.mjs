// 「真双击」验证：不传 --allow-file-access-from-files。
//
// 玩家真实的启动方式是双击「开始玩.cmd」→ 默认浏览器直接开 file:///…/index.html，
// 没有任何命令行开关。之前所有测试都带着这个开关，等于替玩家开了后门 ——
// 万一某个资源是靠 XHR 读本地文件，只有这个开关能通，那玩家那边就白屏。
// 这个脚本就是去掉开关跑一遍，确认单机与双人都还能起来。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const GAME = 'file:///' + path.resolve('game/index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, tag) {
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-real-${tag}-`));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    // 故意不加 --allow-file-access-from-files
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!page) throw new Error(`${tag} 起不来`);

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
      if (!/useLegacyLights/.test(text)) logs.push(`[${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
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
  return { tag, send, evaluate, logs, kill: () => { try { ws.close(); } catch { } proc.kill(); } };
}

async function waitFor(browser, expression, label, timeoutMs = 30000, interval = 400) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await browser.evaluate(expression);
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms）`);
}

const A = await boot(9920, 'host');
const B = await boot(9930, 'guest');

try {
  for (const b of [A, B]) {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Page.navigate', { url: GAME });
  }
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 出菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 出菜单');
  console.log('无开关启动：菜单正常');

  // 单机模式：确认立绘（视频）、引擎、存档都能起来
  await A.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /一个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  const solo = await waitFor(A, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    const d = typeof window.__homeDebug === 'function' ? window.__homeDebug() : null;
    if (!d) return null;
    return JSON.stringify({
      canvas: !!document.querySelector('canvas'),
      actor: d.actorSrc, readyState: d.actorReadyState, err: d.actorError,
      charMode: d.charMode, her: d.herRoom, store: !!globalThis.__gameStore
    });
  })()`, '单机进游戏', 40000);
  console.log('单机模式:', solo);

  // 双人：B 重开一页当客人（A 已经进了单机，不能再当房主）
  await B.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt.duo')`, 'B 进双人页');
  const canDuo = await B.evaluate(`(() => {
    const b = document.querySelectorAll('#gxMenu .m-opt.duo')[0];
    return JSON.stringify({ disabled: b.disabled, text: b.textContent.trim().slice(0, 20) });
  })()`);
  console.log('双人按钮:', canDuo);

  console.log('--- A 控制台 ---');
  for (const l of A.logs.slice(-12)) console.log(l);
  console.log('--- B 控制台 ---');
  for (const l of B.logs.slice(-12)) console.log(l);
} catch (err) {
  console.log('失败:', err?.message || err);
  console.log('--- A 控制台 ---');
  for (const l of A.logs.slice(-20)) console.log(l);
  console.log('--- B 控制台 ---');
  for (const l of B.logs.slice(-20)) console.log(l);
} finally {
  A.kill();
  B.kill();
}
