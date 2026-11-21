// 真窗口双开验收：不是 headless，是两个真的浏览器窗口，
// 走完"一个人住 → 两个人住"的完整流程，各截一张图留证。
//
// 图落在 game-shots/ 下：可见-单机.png / 可见-双人房主.png / 可见-双人客人.png
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.resolve('game-shots');
mkdirSync(SHOTS, { recursive: true });

async function boot(port, tag, left) {
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-vis-${tag}-`));
  const proc = spawn(EDGE, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,820', `--window-position=${left},40`,
    'about:blank'
  ], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 120; i += 1) {
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
  const logs = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) return { __error: ex.exception?.description || ex.text };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const data = r.result?.data;
    if (!data) { console.log(`截图失败 ${name}`); return; }
    const file = path.join(SHOTS, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`截图 ${name} ${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB`);
  };
  return { tag, send, evaluate, shot, logs, kill: () => { try { ws.close(); } catch { } proc.kill(); } };
}

async function waitFor(b, expression, label, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await b.evaluate(expression);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`${b.tag} 等「${label}」超时（${timeoutMs}ms）`);
}

const P = 8904;
const launcher = spawn(path.resolve('dist/大肥鱼书房/开始玩.exe'), ['--port', String(P), '--no-open'], { stdio: 'ignore' });
for (let i = 0; i < 80; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${P}/launcher.json`); if ((await r.json()).launcher) break; } catch { }
  await sleep(200);
}
const URL = `http://127.0.0.1:${P}/`;
console.log(`启动器: ${URL}`);

const A = await boot(9961, 'A', 20);
const B = await boot(9962, 'B', 660);
try {
  // ---- 一个人住 ----
  await A.send('Page.navigate', { url: URL });
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 菜单');
  await A.shot('可见-菜单.png');
  await A.evaluate(`document.querySelector('#gxMenu .m-opt.solo').click()`);
  await waitFor(A, `!!document.querySelector('#gxBar')`, 'A 进游戏');
  const solo = await waitFor(A,
    `(() => { const d = window.__homeDebug && window.__homeDebug(); return d && d.actorReadyState > 0 ? JSON.stringify({ readyState: d.actorReadyState, charMode: d.charMode, her: d.herRoom }) : ''; })()`,
    'A 立绘加载', 30000);
  console.log('单机:', solo);
  await sleep(3500);
  await A.shot('可见-单机.png');

  // ---- 两个人住：A 开房 ----
  await A.send('Page.navigate', { url: URL });
  await A.send('Page.reload');
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 菜单重载');
  await A.evaluate(`document.querySelector('#gxMenu .m-opt.duo').click()`);
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt.duo')`, 'A 双人页');
  await A.evaluate(`[...document.querySelectorAll('#gxMenu .m-opt')].find(x => /开一间房/.test(x.textContent)).click()`);
  const code = await waitFor(A, `(document.querySelector('#gxMenu .m-val')||{}).textContent || ''`, '房间号');
  console.log('房间号:', code);
  await A.shot('可见-双人房间号.png');
  await A.evaluate(`[...document.querySelectorAll('#gxMenu .m-btn')].find(x => /先进去等对方/.test(x.textContent)).click()`);
  await waitFor(A, `!document.querySelector('#gxMenu') && !!globalThis.__duo`, 'A 进屋子');

  // ---- B 进房 ----
  await B.send('Page.navigate', { url: URL });
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 菜单');
  await B.evaluate(`document.querySelector('#gxMenu .m-opt.duo').click()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-code')`, 'B 双人页');
  await B.evaluate(`(() => { const i = document.querySelector('#gxMenu .m-code');
    i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await B.evaluate(`[...document.querySelectorAll('#gxMenu .m-btn')].find(x => /进这间屋子/.test(x.textContent)).click()`);
  await waitFor(B, `!document.querySelector('#gxMenu') && !!globalThis.__duo`, 'B 进屋子');

  await waitFor(A, `globalThis.__duo && __duo.link.ready`, 'A 通道');
  await waitFor(B, `globalThis.__duo && __duo.link.ready`, 'B 通道');
  console.log('通道就绪');

  // ---- 客人做一件事，房主看见 ----
  const act = await B.evaluate(`fetch('/api/home/act', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ action:'pet', by:'小蓝鱼', pid:'p_guest_vis' }) }).then(r => r.json())`);
  console.log('客人摸头:', JSON.stringify({ status: act?.status, ok: act?.ok ?? act?.data?.ok }));
  const seen = await waitFor(A,
    `(() => { const f = (__duo.state().feed || []).map(x => x.text).join(' | '); return /小蓝鱼/.test(f) ? f : ''; })()`,
    '房主看到客人动作', 20000);
  console.log('房主看到:', seen);

  const chat = await B.evaluate(`fetch('/api/net/chat', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ text:'这屋子真好看', pid:'p_guest_vis', by:'小蓝鱼' }) }).then(r => r.json())`);
  console.log('客人说话:', JSON.stringify(chat?.ok ?? chat?.data?.ok));

  // 打开两端「屋里的人」面板再截图，让图里能看出双人
  await A.evaluate(`document.querySelector('#ntOpen').click()`);
  await sleep(1200);
  await B.evaluate(`document.querySelector('#ntOpen').click()`);
  await sleep(2200);
  await A.shot('可见-双人房主.png');
  await B.shot('可见-双人客人.png');

  console.log('A 控制台:', A.logs.filter((l) => /error|exception/.test(l)).slice(0, 3).join('  ') || '无');
  console.log('B 控制台:', B.logs.filter((l) => /error|exception/.test(l)).slice(0, 3).join('  ') || '无');
} finally {
  try { await fetch(`http://127.0.0.1:${P}/__bye`); } catch { }
  A.kill(); B.kill(); launcher.kill();
}
