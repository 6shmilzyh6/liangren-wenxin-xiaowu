// 菜园面板与「屋里的人」面板不再互相遮挡的几何验证。
//
// 用户报的问题是：开房之后，房间信息界面压在菜园内容上面。
// 原因是 .garden-panel（右侧 350–440px 一整列）与 .nt-bar / .nt-panel（right:20px）
// 抢同一块地方。修法是菜园打开时把联机条挪到左下。
//
// 这个脚本不看 CSS 文本，而是真的进一次双人房、点开菜园，然后量两块面板的
// getBoundingClientRect 有没有交叠。窗口宽度试三种，覆盖桌面与窄屏断点。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const GAME = 'file:///' + path.resolve('game/index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, tag, width, height) {
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-lay-${tag}-`));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--allow-file-access-from-files', '--use-fake-ui-for-media-stream', 'about:blank'
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
      if (!/useLegacyLights|WebGLRenderer/.test(text)) logs.push(`[${m.params.type}] ${text}`);
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

async function waitFor(browser, expression, label, timeoutMs = 40000, interval = 400) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const v = await browser.evaluate(expression);
    last = v;
    if (v && v !== 'no-menu') return v;
    await sleep(interval);
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms），最后拿到：${JSON.stringify(last)}`);
}

// 量两块面板有没有交叠；顺便把各自的矩形带出来，方便对不上时看数。
const OVERLAP_PROBE = `(() => {
  const gp = document.querySelector('#garden-panel');
  const nb = document.querySelector('#ntBar');
  const np = document.querySelector('#ntPanel');
  const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), hidden: n.hidden === true }; };
  const hit = (a, b) => {
    if (!a || !b || a.hidden || b.hidden) return false;
    if (!a.w || !a.h || !b.w || !b.h) return false;
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  };
  const garden = r(gp), bar = r(nb), panel = r(np);
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight,
    gardenOpen: document.body.classList.contains('garden-open'),
    garden, bar, panel,
    overlapBar: hit(garden, bar),
    overlapPanel: hit(garden, panel)
  });
})()`;

const A = await boot(9950, 'host', 1280, 800);
const B = await boot(9960, 'guest', 1280, 800);

try {
  for (const b of [A, B]) {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Page.navigate', { url: GAME });
  }
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 出菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 出菜单');

  await A.evaluate(`(() => { [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click(); return 'ok'; })()`);
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt.duo')`, 'A 进双人页');
  await A.evaluate(`(() => { document.querySelectorAll('#gxMenu .m-opt.duo')[0].click(); return 'ok'; })()`);
  const code = await waitFor(A, `(() => { const v = document.querySelector('#gxMenu .m-val');
    return v && /^[0-9A-Z]{6}$/.test(v.textContent.trim()) ? v.textContent.trim() : null; })()`, 'A 房间号');
  console.log('房间号  :', code);
  await A.evaluate(`(() => { const go = [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /先进去等对方/.test(b.textContent));
    if (go) go.click(); return 'ok'; })()`);

  await B.evaluate(`(() => { [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click(); return 'ok'; })()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-code')`, 'B 进双人页');
  await B.evaluate(`(() => { const i = document.querySelector('#gxMenu .m-code'); i.value = ${JSON.stringify(code)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /进这间屋子/.test(b.textContent)).click(); return i.value; })()`);

  await waitFor(A, `!document.querySelector('#gxMenu') && globalThis.__duo ? 'in' : null`, 'A 进游戏');
  await waitFor(B, `!document.querySelector('#gxMenu') && globalThis.__duo ? 'in' : null`, 'B 进游戏');
  await waitFor(A, `globalThis.__duo.link.ready ? 'ready' : null`, 'A 通道');
  await waitFor(B, `globalThis.__duo.link.ready ? 'ready' : null`, 'B 通道');
  console.log('双人房就绪');

  let allOk = true;
  for (const [w, h] of [[1280, 800], [1024, 760], [860, 720]]) {
    await A.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    // 先把联机面板也打开（用户看到的最坏情况：菜园 + 房间信息面板同时都在）
    await A.evaluate(`(() => { const b = document.querySelector('#ntOpen'); if (b) b.click(); return 'ok'; })()`);
    await sleep(400);
    await A.evaluate(`(() => { const c = document.querySelector('#gardenChip'); if (c && !document.body.classList.contains('garden-open')) c.click(); return 'ok'; })()`);
    await sleep(1500);
    const probe = await A.evaluate(OVERLAP_PROBE);
    const d = JSON.parse(probe || '{}');
    const ok = d.gardenOpen && !d.overlapBar && !d.overlapPanel;
    if (!ok) allOk = false;
    console.log(`\n[${w}x${h}] ${ok ? 'OK  不重叠' : 'FAIL 重叠'}`);
    console.log('  菜园  :', JSON.stringify(d.garden));
    console.log('  联机条:', JSON.stringify(d.bar));
    console.log('  信息面板:', JSON.stringify(d.panel));
    await A.evaluate(`(() => { const c = document.querySelector('#gardenChip'); if (c) c.click(); return 'ok'; })()`);
    await sleep(500);
  }

  console.log(allOk ? '\n=== 菜园与房间信息：三种宽度都不重叠 ===' : '\n=== 菜园与房间信息：仍有重叠 ===');

  // 留一张证据图：菜园 + 房间信息同屏
  await A.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await A.evaluate(`(() => { const b = document.querySelector('#ntOpen'); if (b) b.click();
    const c = document.querySelector('#gardenChip'); if (c && !document.body.classList.contains('garden-open')) c.click(); return 'ok'; })()`);
  await sleep(1800);
  const shot = await A.send('Page.captureScreenshot', { format: 'png' });
  if (shot?.result?.data) {
    const out = path.resolve('game-shots', '菜园与房间信息-不遮挡.png');
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('证据图:', out);
  }

  console.log('--- A 控制台 ---');
  for (const l of A.logs.slice(-8)) console.log(l);
} catch (err) {
  console.log('失败:', err?.message || err);
  for (const l of A.logs.slice(-15)) console.log(l);
} finally {
  A.kill();
  B.kill();
}
