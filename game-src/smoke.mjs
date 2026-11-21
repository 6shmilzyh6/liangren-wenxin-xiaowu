// 冒烟测试：把构建好的 game/index.html 用 file:// 打开，
// 看主菜单能不能出来、点「一个人住」能不能进游戏。
//
// 用 CDP 直接控制 headless Edge，不装 puppeteer。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const GAME = path.resolve('game/index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port) {
  const prof = mkdtempSync(path.join(tmpdir(), 'dfy-smoke-'));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--allow-file-access-from-files', 'about:blank'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return proc; } catch { await sleep(250); }
  }
  throw new Error('调试端口没起来');
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const logs = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
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
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
    return r.result?.result?.value;
  };
  return { send, evaluate, logs, close: () => ws.close() };
}

const port = 9800 + Math.floor(Math.random() * 60);
const proc = await launch(port);
const cdp = await connect(port);

try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'file:///' + GAME });
  await sleep(2500);

  const menu = await cdp.evaluate(`(() => {
    const m = document.querySelector('#gxMenu');
    if (!m) return { menu: false };
    const opts = [...m.querySelectorAll('.m-opt')].map(b => ({ text: b.textContent.trim().slice(0,20), disabled: b.disabled }));
    const nameInput = m.querySelector('.m-name');
    return { menu: true, opts, hasName: !!nameInput, title: (m.querySelector('.m-title')||{}).textContent };
  })()`);
  console.log('主菜单 :', JSON.stringify(menu));

  // 点「一个人住」。进门要先有名字，空着点会被 requireName() 拦下来、菜单不动。
  const clicked = await cdp.evaluate(`(() => {
    const m = document.querySelector('#gxMenu');
    if (!m) return 'no-menu';
    const inp = m.querySelector('.m-name input');
    if (inp && !(inp.value || '').trim()) {
      inp.value = '冒烟';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const btns = [...m.querySelectorAll('.m-opt')];
    const solo = btns.find(b => /一个人/.test(b.textContent));
    if (!solo) return 'no-solo';
    solo.click();
    return 'clicked';
  })()`);
  console.log('点单机 :', clicked);
  await sleep(4000);

  const state = await cdp.evaluate(`(() => ({
    menuGone: !document.querySelector('#gxMenu'),
    bar: !!document.querySelector('#gxBar'),
    canvas: !!document.querySelector('canvas'),
    mode: globalThis.__gameShell ? 'shell-ok' : 'no-shell',
    duo: globalThis.__duo ? 'duo' : 'no-duo',
    api: typeof globalThis.__gameApi,
    store: !!globalThis.__gameStore,
    homeDebug: typeof window.__homeDebug === 'function' ? JSON.stringify(window.__homeDebug()) : 'none'
  }))()`);
  console.log('进游戏 :', JSON.stringify(state));

  console.log('--- 控制台 ---');
  for (const l of cdp.logs.slice(-25)) console.log(l);
} finally {
  cdp.close();
  proc.kill();
}
