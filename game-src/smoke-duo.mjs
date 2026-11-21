// 双人模式的端到端验证：开两个独立的浏览器实例，
// 一个开房、一个用房间号进屋，然后检查：
//   1. 两边都进了同一间屋子（__duo.role 分别是 host / guest）；
//   2. 客人做的动作，房主那边能看到（动态流同步）；
//   3. 客人的聊天，房主能收到。
//
// 这是"跨网络也能双人"这条需求的唯一硬证据 —— 必须真跑一遍。
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
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-duo-${tag}-`));
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
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

async function waitFor(browser, expression, label, timeoutMs = 30000, interval = 400) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await browser.evaluate(expression);
    if (v && v !== 'no-menu') return v;
    await sleep(interval);
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms）`);
}

const A = await boot(9900, 'host');
const B = await boot(9910, 'guest');

try {
  for (const b of [A, B]) {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Page.navigate', { url: GAME });
  }
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 出菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 出菜单');
  console.log('两端菜单就绪');

  // A：两个人住 → 开一间房
  await A.evaluate(`(() => {
    const btns = [...document.querySelectorAll('#gxMenu .m-opt')];
    btns.find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt.duo')`, 'A 进双人页');
  await A.evaluate(`(() => {
    document.querySelectorAll('#gxMenu .m-opt.duo')[0].click();
    return 'ok';
  })()`);

  const code = await waitFor(A, `(() => {
    const v = document.querySelector('#gxMenu .m-val');
    return v && /^[0-9A-Z]{6}$/.test(v.textContent.trim()) ? v.textContent.trim() : null;
  })()`, 'A 拿到房间号', 40000);
  console.log('房间号  :', code);

  // 房主先自己进屋等（这也是玩家的正常操作），菜单才会退掉。
  await A.evaluate(`(() => {
    const go = [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /先进去等对方/.test(b.textContent));
    if (go) go.click();
    return go ? 'clicked' : 'no-go';
  })()`);

  // B：两个人住 → 输码进屋
  await B.evaluate(`(() => {
    const btns = [...document.querySelectorAll('#gxMenu .m-opt')];
    btns.find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-code')`, 'B 进双人页');
  await B.evaluate(`(() => {
    const input = document.querySelector('#gxMenu .m-code');
    input.value = ${JSON.stringify(code)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /进这间屋子/.test(b.textContent)).click();
    return document.querySelector('#gxMenu .m-code').value;
  })()`);

  // 两端都要进游戏（菜单消失、__duo 挂上）
  const aState = await waitFor(A, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    return globalThis.__duo ? JSON.stringify({ role: __duo.role, code: __duo.code }) : null;
  })()`, 'A 进游戏', 45000);
  console.log('房主    :', aState);

  const bState = await waitFor(B, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    return globalThis.__duo ? JSON.stringify({ role: __duo.role, code: __duo.code }) : null;
  })()`, 'B 进游戏', 45000);
  console.log('客人    :', bState);

  // 等通道就绪
  await waitFor(A, `globalThis.__duo && __duo.link.ready ? 'ready' : null`, 'A 通道 ready', 30000);
  console.log('通道就绪');

  // 客人在自己这边摸她的头 —— 请求会经 DataChannel 交给房主执行。
  const acted = await B.evaluate(`(async () => {
    const r = await fetch('/api/home/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pet', by: '客人小测', pid: 'p_guest_test' })
    });
    const d = await r.json();
    return JSON.stringify({ status: r.status, ok: d.ok, error: d.error || null });
  })()`);
  console.log('客人摸头:', acted);

  // 房主那边应该看到这条动态
  const seenByHost = await waitFor(A, `(() => {
    const n = globalThis.__duo && __duo.state && __duo.state();
    const feed = (n && n.feed) || [];
    const hit = feed.find(f => /客人小测/.test(f.text || ''));
    return hit ? hit.text : null;
  })()`, '房主看到客人的动作', 20000);
  console.log('房主看到:', seenByHost);

  // 客人发一句话，房主应该收到
  await B.evaluate(`fetch('/api/net/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '屋子真好看', name: '客人小测' })
  }).then(r => r.json())`, 'B 发消息');
  const chatted = await waitFor(A, `(() => {
    const el = document.querySelector('#ntMsgs');
    return el && /屋子真好看/.test(el.textContent) ? el.textContent.trim().slice(0, 40) : null;
  })()`, '房主收到聊天', 15000);
  console.log('房主收到:', chatted);

  // 屋子状态两边一致（同一个 spot）
  const snapA = await A.evaluate(`JSON.stringify({ spot: window.__homeDebug().spot, pos: window.__homeDebug().statePos })`);
  const snapB = await B.evaluate(`JSON.stringify({ spot: window.__homeDebug().spot, pos: window.__homeDebug().statePos })`);
  console.log('房主她  :', snapA);
  console.log('客人她  :', snapB);

  // ── 边界：网络断掉再自动重连 ────────────────────────────────────────────
  // 直接把客人的 data channel 掐掉，模拟"对方换网 / 路由器抖了一下"。
  console.log('--- 掐断客人的通道 ---');
  await B.evaluate(`(() => {
    const c = globalThis.__duo && __duo.link._conn;
    if (!c) return 'no-conn';
    c.close();
    return 'closed';
  })()`);

  const hostSawDrop = await waitFor(A, `(() => {
    const t = document.querySelector('#ntBar')?.textContent || '';
    return /断开|慢/.test(t) ? t.trim() : null;
  })()`, '房主发现对方断开', 20000);
  console.log('房主状态:', hostSawDrop);

  // 客人应该自己接回来（scheduleRetry：3/6/12/24 秒）
  const backAgain = await waitFor(B, `globalThis.__duo && __duo.link.ready ? 'ready' : null`, '客人自动重连', 60000);
  console.log('客人重连:', backAgain);

  await waitFor(A, `globalThis.__duo && __duo.link.ready ? 'ready' : null`, '房主重新就绪', 30000);

  // 重连后动作还能通吗（这才是重连的意义）
  const afterRetry = await B.evaluate(`(async () => {
    const r = await fetch('/api/home/act', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feed', by: '重连小测', pid: 'p_guest_test' })
    });
    const d = await r.json();
    return JSON.stringify({ status: r.status, ok: d.ok });
  })()`);
  console.log('重连后喂食:', afterRetry);
  const seen2 = await waitFor(A, `(() => {
    const n = globalThis.__duo && __duo.state && __duo.state();
    const hit = ((n && n.feed) || []).find(f => /重连小测/.test(f.text || ''));
    return hit ? hit.text : null;
  })()`, '房主看到重连后的动作', 20000);
  console.log('房主看到:', seen2);

  // 「离开这间屋子」入口存在且能点（真的点了会 reload，所以只看它在不在）
  const leaveBtn = await A.evaluate(`(() => {
    const p = document.querySelector('#ntOpen');
    if (p) p.click();
    const btn = document.querySelector('.nt-leave');
    return btn ? btn.textContent.trim() : 'no-leave';
  })()`);
  console.log('离开按钮:', leaveBtn);

  console.log('--- A 控制台 ---');
  for (const l of A.logs.slice(-10)) console.log(l);
  console.log('--- B 控制台 ---');
  for (const l of B.logs.slice(-10)) console.log(l);
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
