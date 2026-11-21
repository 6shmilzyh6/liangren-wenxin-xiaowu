// 身份与交换的端到端验证（双人）。
//
// 这条链路必须真跑一遍，因为它跨了三层：
//   1. 主菜单里选的「你住哪一侧」→ main.js 写进 __homeSide → app.js 锁住这一端；
//   2. 握手帧（hello）带 side → 两边互相知道身份 → 面板上「你住 X / 对面 Y」；
//   3. 一方点「申请交换」→ EVT swap 帧 → 对面弹按钮 → 同意后两边一起换页。
//
// 检查项：
//   · 房主与小公主 / 客人与小蓝鱼，各自 body 上的 side-* class 正确；
//   · 两边面板都显示对了彼此的身份；
//   · A 点「申请交换」后 B 出现同意按钮，点了之后两边身份互换、body class 也跟着换；
//   · 换完之后菜园面板的标题也跟着换（菜园随身份）。
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
  const prof = mkdtempSync(path.join(tmpdir(), `dfy-side-${tag}-`));
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
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const v = await browser.evaluate(expression);
    last = v;
    if (v && v !== 'no-menu') return v;
    await sleep(interval);
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms），最后拿到：${JSON.stringify(last)}`);
}

const A = await boot(9930, 'host');
const B = await boot(9940, 'guest');

// 这一端的身份探针：body class + 面板上写着谁 + 菜园标题
const SIDE_PROBE = `(() => {
  const cls = [...document.body.classList].filter(c => c.startsWith('side-')).join(',');
  const me = document.querySelector('#ntSideMe');
  const peer = document.querySelector('#ntSidePeer');
  const garden = document.querySelector('#garden-panel h2');
  return JSON.stringify({
    cls,
    me: me ? me.textContent.trim() : null,
    peer: peer ? peer.textContent.trim() : null,
    garden: garden ? garden.textContent.trim() : null
  });
})()`;

try {
  for (const b of [A, B]) {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Page.navigate', { url: GAME });
  }
  await waitFor(A, `!!document.querySelector('#gxMenu .m-opt')`, 'A 出菜单');
  await waitFor(B, `!!document.querySelector('#gxMenu .m-opt')`, 'B 出菜单');
  console.log('两端菜单就绪');

  // A：两个人住 → 选「小公主这边」→ 开房
  await A.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(A, `!!document.querySelector('#gxMenu .m-side-btn')`, 'A 出现住哪一侧');
  const sideBtns = await A.evaluate(`JSON.stringify([...document.querySelectorAll('#gxMenu .m-side-btn')].map(b => b.textContent.trim()))`);
  console.log('身份选项:', sideBtns);
  await A.evaluate(`(() => {
    const btn = [...document.querySelectorAll('#gxMenu .m-side-btn')].find(b => /小公主/.test(b.textContent));
    if (btn) btn.click();
    return btn ? btn.className : 'no-btn';
  })()`);
  await A.evaluate(`(() => {
    document.querySelectorAll('#gxMenu .m-opt.duo')[0].click();
    return 'ok';
  })()`);

  const code = await waitFor(A, `(() => {
    const v = document.querySelector('#gxMenu .m-val');
    return v && /^[0-9A-Z]{6}$/.test(v.textContent.trim()) ? v.textContent.trim() : null;
  })()`, 'A 拿到房间号', 40000);
  console.log('房间号  :', code);

  await A.evaluate(`(() => {
    const go = [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /先进去等对方/.test(b.textContent));
    if (go) go.click();
    return go ? 'clicked' : 'no-go';
  })()`);

  // B：两个人住 → 选「小蓝鱼这边」→ 输码进屋
  await B.evaluate(`(() => {
    [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /两个人住/.test(b.textContent)).click();
    return 'ok';
  })()`);
  await waitFor(B, `!!document.querySelector('#gxMenu .m-code')`, 'B 进双人页');
  await B.evaluate(`(() => {
    const btn = [...document.querySelectorAll('#gxMenu .m-side-btn')].find(b => /小蓝鱼/.test(b.textContent));
    if (btn) btn.click();
    return btn ? 'ok' : 'no-btn';
  })()`);
  await B.evaluate(`(() => {
    const input = document.querySelector('#gxMenu .m-code');
    input.value = ${JSON.stringify(code)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#gxMenu .m-btn')].find(b => /进这间屋子/.test(b.textContent)).click();
    return input.value;
  })()`);

  await waitFor(A, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    return globalThis.__duo ? JSON.stringify({ role: __duo.role, code: __duo.code }) : null;
  })()`, 'A 进游戏', 45000);
  await waitFor(B, `(() => {
    if (document.querySelector('#gxMenu')) return null;
    return globalThis.__duo ? JSON.stringify({ role: __duo.role, code: __duo.code }) : null;
  })()`, 'B 进游戏', 45000);
  await waitFor(A, `globalThis.__duo && __duo.link.ready ? 'ready' : null`, 'A 通道 ready', 30000);
  await waitFor(B, `globalThis.__duo && __duo.link.ready ? 'ready' : null`, 'B 通道 ready', 30000);
  console.log('通道就绪');

  // 1) 各自的侧与页面 class
  const aSide1 = await waitFor(A, SIDE_PROBE, 'A 身份探针', 20000);
  const bSide1 = await waitFor(B, SIDE_PROBE, 'B 身份探针', 20000);
  console.log('A 初始  :', aSide1);
  console.log('B 初始  :', bSide1);

  // 2) 菜园面板打开后标题是谁的菜园
  const gardenBefore = await A.evaluate(`(async () => {
    document.querySelector('#gardenChip').click();
    await new Promise(r => setTimeout(r, 1200));
    const h = document.querySelector('#garden-panel h2');
    const chip = document.querySelector('#gardenChip');
    const dbg = globalThis.__gardenDebug ? __gardenDebug() : null;
    return JSON.stringify({ title: h ? h.textContent.trim() : null, chip: chip ? chip.textContent.trim() : null, who: dbg ? dbg.who : null });
  })()`);
  console.log('A 菜园  :', gardenBefore);

  // 3) A 点「申请交换」→ B 应该弹出同意按钮
  await A.evaluate(`(() => {
    const open = document.querySelector('#ntOpen');
    if (open) open.click();
    return 'opened';
  })()`);
  await sleep(600);
  const asked = await A.evaluate(`(() => {
    const btn = document.querySelector('#ntSwap');
    if (!btn) return 'no-swap-btn';
    btn.click();
    return btn.textContent.trim();
  })()`);
  console.log('A 申请  :', asked);

  const askOnB = await waitFor(B, `(() => {
    const el = document.querySelector('#ntAsk');
    return el && !el.hidden ? el.textContent.trim().slice(0, 60) : null;
  })()`, 'B 收到交换申请', 20000);
  console.log('B 收到  :', askOnB);

  // 4) B 点「同意交换」
  const clickedYes = await B.evaluate(`(() => {
    const btn = [...document.querySelectorAll('#ntAsk button')].find(b => /同意/.test(b.textContent));
    if (!btn) return 'no-yes';
    btn.click();
    return 'yes-clicked';
  })()`);
  console.log('B 同意  :', clickedYes);

  await sleep(2500);
  const aSide2 = await A.evaluate(SIDE_PROBE);
  const bSide2 = await B.evaluate(SIDE_PROBE);
  console.log('A 交换后:', aSide2);
  console.log('B 交换后:', bSide2);

  // 5) 菜园标题跟着换
  const gardenAfter = await A.evaluate(`(async () => {
    const panel = document.querySelector('#garden-panel');
    if (!panel || panel.hidden) { document.querySelector('#gardenChip').click(); await new Promise(r => setTimeout(r, 1000)); }
    const h = document.querySelector('#garden-panel h2');
    const s = document.querySelector('.garden-stewardship strong');
    const dbg = globalThis.__gardenDebug ? __gardenDebug() : null;
    return JSON.stringify({ title: h ? h.textContent.trim() : null, stewardship: s ? s.textContent.trim() : null, who: dbg ? dbg.who : null });
  })()`);
  console.log('A 菜园后:', gardenAfter);

  // 6) 判定
  const ok = (() => {
    const a2 = JSON.parse(aSide2 || '{}');
    const b2 = JSON.parse(bSide2 || '{}');
    const a1 = JSON.parse(aSide1 || '{}');
    const b1 = JSON.parse(bSide1 || '{}');
    const g1 = JSON.parse(gardenBefore || '{}');
    const g2 = JSON.parse(gardenAfter || '{}');
    const checks = [
      [a1.cls.includes('side-claude'), 'A 初始应为小公主侧'],
      [b1.cls.includes('side-her'), 'B 初始应为小蓝鱼侧'],
      [a1.me === '小公主' && b1.me === '小蓝鱼', '面板上自己的身份正确'],
      [a1.peer === '小蓝鱼' && b1.peer === '小公主', '面板上对方的身份正确'],
      [g1.who === 'claude' && /小公主/.test(g1.title || ''), '菜园初始显示小公主'],
      [a2.cls.includes('side-her'), 'A 交换后应为小蓝鱼侧'],
      [b2.cls.includes('side-claude'), 'B 交换后应为小公主侧'],
      [a2.me === '小蓝鱼' && b2.me === '小公主', '交换后面板身份正确'],
      [g2.who === 'her' && /小蓝鱼/.test(g2.title || ''), '菜园跟着换成小蓝鱼'],
      [g2.stewardship && /小蓝鱼/.test(g2.stewardship), '照料安排标题也换了']
    ];
    for (const [pass, label] of checks) console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}`);
    return checks.every(([pass]) => pass);
  })();
  console.log(ok ? '=== 身份与交换：全部通过 ===' : '=== 身份与交换：有失败项 ===');

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
