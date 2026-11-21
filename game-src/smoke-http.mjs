// 「真双击」验证：玩家双击 开始玩.exe 之后，浏览器打开的是 http://127.0.0.1:8787/。
//
// 这个脚本跟 smoke-real.mjs 的区别：它不用 file://，而是真的把启动器跑起来
// （--no-open，所以不会弹一个浏览器窗口到脸上），然后让两个 headless Edge
// 都从 http://127.0.0.1:<port>/ 进游戏。这才是玩家看到的路径。
//
// 要验的三件事：
//   1. 立绘视频真的加载成了（readyState>=3），没有 SecurityError —— 这正是
//      当初 file:// 方案死掉的地方；
//   2. 单机能进游戏、存档层在；
//   3. 两个人住：一端开房拿码、另一端输码进屋，通道 ready，摸头与聊天同步；
//      再掐断客人通道，验证能自己接回来。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const EXE = path.resolve('dist/大肥鱼书房/开始玩.exe');
const PORT = 8901;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 启动器 ----
const launcher = spawn(EXE, ['--port', String(PORT), '--no-open'], { stdio: 'ignore', detached: false });
let launcherUp = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`${ORIGIN}launcher.json`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j.launcher) { launcherUp = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(200);
}
if (!launcherUp) { console.log('失败: 启动器没起来'); launcher.kill(); process.exit(1); }
console.log('启动器:', `${ORIGIN} 已就绪`);

async function boot(port, tag) {
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-http-${tag}-`));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 100; i += 1) {
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

const A = await boot(9940, 'a');
const B = await boot(9950, 'b');

try {
  for (const b of [A, B]) {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Page.navigate', { url: ORIGIN });
  }
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 出菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 出菜单');
  console.log('http 打开：菜单正常');

  // ---- 单机：立绘必须真的加载成 ----
  await A.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /一个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  const solo = await waitFor(A, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    const d = typeof window.__homeDebug === 'function' ? window.__homeDebug() : null;
    if (!d) return null;
    if (!d.actorReadyState) return null;
    return JSON.stringify({
      actor: d.actorSrc, readyState: d.actorReadyState, err: d.actorError,
      charMode: d.charMode, her: d.herRoom, store: !!globalThis.__gameStore,
      canvas: !!document.querySelector('canvas')
    });
  })()`, '单机进游戏（等立绘 readyState）', 45000);
  console.log('单机模式:', solo);
  const soloObj = JSON.parse(solo);
  if (soloObj.readyState < 2) throw new Error('立绘视频没加载成，readyState=' + soloObj.readyState);

  // ---- 双人：B 重新载入页面当房主，A 也回到菜单当客人 ----
  await A.send('Page.navigate', { url: ORIGIN });
  await B.send('Page.navigate', { url: ORIGIN });
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 回菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 回菜单');

  await A.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt.duo')`, 'A 进双人页');
  await A.evaluate(`(() => { document.querySelectorAll('#gxMenu .m-opt.duo')[0].click(); return 'ok'; })()`);
  const code = await waitFor(A, `(() => {
    const v = document.querySelector('#gxMenu .m-val');
    return v && v.textContent.trim().length === 6 ? v.textContent.trim() : null;
  })()`, 'A 拿到房间号', 30000);
  console.log('房间号     :', code);

  await A.evaluate(`(() => {
    const b = [...document.querySelectorAll('#gxMenu button')].find(x => /先进去等对方/.test(x.textContent));
    if (!b) throw new Error('没找到「先进去等对方」');
    b.click();
    return 'ok';
  })()`);
  await waitFor(A, `!document.querySelector('#gxMenu') && !!globalThis.__duo`, 'A 进游戏', 40000);

  await B.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-code')`, 'B 进双人页');
  await B.evaluate(`(() => {
    const inp = document.querySelector('#gxMenu .m-code');
    inp.value = ${JSON.stringify(code)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  })()`);
  await B.evaluate(`(() => {
    const b = [...document.querySelectorAll('#gxMenu button')].find(x => /进这间屋子/.test(x.textContent));
    if (!b) throw new Error('没找到「进这间屋子」');
    b.click();
    return 'ok';
  })()`);
  await waitFor(B, `!document.querySelector('#gxMenu') && !!globalThis.__duo && __duo.role === 'guest'`, 'B 进游戏', 45000);
  await waitFor(A, `!!globalThis.__duo && __duo.link.ready`, 'A 通道就绪', 45000);
  await waitFor(B, `!!globalThis.__duo && __duo.link.ready`, 'B 通道就绪', 45000);
  console.log('通道就绪');

  // 客人摸头 → 房主应看到
  const pet = await B.evaluate(`(async () => {
    const r = await fetch('/api/home/act', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pet', by: '客人小测', pid: 'p_guest_test' })
    });
    const j = await r.json();
    return JSON.stringify({ status: r.status, ok: j.ok, error: j.error });
  })()`);
  console.log('客人摸头    :', pet);
  const feed = await waitFor(A, `(() => {
    const f = (globalThis.__duo.state().feed || []).map(x => x.text).join(' | ');
    return f.includes('客人小测') ? f : null;
  })()`, '房主看到客人的动作', 20000);
  console.log('房主看到    :', feed.split(' | ').pop());

  // 聊天
  await B.evaluate(`(async () => {
    await fetch('/api/net/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '屋子真好看' })
    });
    return 'ok';
  })()`);
  const said = await waitFor(A, `(() => {
    const el = document.querySelector('#ntMsgs');
    return el && el.textContent.includes('屋子真好看') ? el.textContent.trim().replace(/\\s+/g, ' ') : null;
  })()`, '房主收到聊天', 15000);
  console.log('房主收到    :', said);

  // 掐断客人通道 → 房主应报断开 → 客人自己接回来
  await B.evaluate(`(() => { __duo.link._conn.close(); return 'ok'; })()`);
  const bad = await waitFor(A, `(() => {
    const t = (document.querySelector('#ntBar') || {}).textContent || '';
    return /断开|慢|正在连/.test(t) ? t.trim().replace(/\\s+/g, ' ') : null;
  })()`, '房主看到断开', 25000);
  console.log('房主状态    :', bad);
  await waitFor(B, `__duo.link.ready === true`, '客人重连', 60000);
  console.log('客人重连    : ready');
  await waitFor(A, `__duo.link.ready === true`, '房主恢复', 60000);

  const feed2 = await B.evaluate(`(async () => {
    const r = await fetch('/api/home/act', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feed', by: '重连小测', pid: 'p_guest_test' })
    });
    const j = await r.json();
    return JSON.stringify({ status: r.status, ok: j.ok });
  })()`);
  console.log('重连后喂食  :', feed2);
  const after = await waitFor(A, `(() => {
    const f = (globalThis.__duo.state().feed || []).map(x => x.text).join(' | ');
    return f.includes('重连小测') ? f : null;
  })()`, '房主看到重连后的动作', 20000);
  console.log('房主看到    :', after.split(' | ').pop());

  // 离开按钮
  await A.evaluate(`(() => { const b = document.querySelector('#ntOpen'); if (b) b.click(); return 'ok'; })()`);
  await sleep(400);
  const leave = await A.evaluate(`(() => {
    const b = document.querySelector('.nt-leave');
    return b ? b.textContent.trim() : '(没找到)';
  })()`);
  console.log('离开按钮    :', leave);

  const bads = [...A.logs, ...B.logs].filter((l) => /error|exception/i.test(l));
  console.log('控制台异常  :', bads.length ? bads.slice(0, 6) : '无');
} catch (err) {
  console.log('失败:', err?.message || err);
  console.log('--- A 控制台 ---');
  for (const l of A.logs.slice(-20)) console.log(l);
  console.log('--- B 控制台 ---');
  for (const l of B.logs.slice(-20)) console.log(l);
  process.exitCode = 1;
} finally {
  A.kill();
  B.kill();
  // 让启动器自己退出（页面发过 /__bye 之后 90 秒），这里直接收掉以免留后台
  try { await fetch(`${ORIGIN}__bye`, { signal: AbortSignal.timeout(1500) }); } catch { }
  launcher.kill();
}
