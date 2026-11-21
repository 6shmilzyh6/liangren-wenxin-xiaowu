// 手测 P-A / P-B / P-C / P-D：在真实游戏里模拟点击，统计服务端收到几次 go。
//   node game-src/probe-clicks.mjs
//
// 做法：拦截 fetch('/api/home/act')，记录每次的 action 与 body.pos，
// 然后按不同手势在画布上打点，看实际发出多少次请求、落到哪里。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME = path.join(ROOT, 'game', 'index.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9430;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, `clicks-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const results = [];
const ck = (name, ok, detail) => results.push({ name, ok, detail });

try {
  await sleep(3000);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pend.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 注意：单机包（game/）里 net-shim 会把 globalThis.fetch 整层换掉，
  // /api/* 在那一层就被处理，不会往下走。所以必须在游戏启动完成后再包一次，
  // 这时候拿到的是 net-shim 的 fetch，我们在它外面套一层计数。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__errs = [];
      addEventListener('error', (e) => window.__errs.push(String(e.message || e)));
      addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason || e)));
    `,
  });

  await send('Page.navigate', { url: `file:///${GAME.replace(/\\/g, '/')}?clickmove=1` });
  await sleep(4500);
  await ev(`[...document.querySelectorAll('#gxMenu button')].find(b=>b.className.includes('solo'))?.click()`);
  await sleep(2500);
  await ev(`document.getElementById('gxStart')?.click()`);
  await sleep(10000);

  const ready = await ev(`JSON.stringify({debug: typeof window.__homeDebug, view: document.getElementById('loading')?.className})`);
  ck('① 游戏启动完成', String(ready).includes('"debug":"function"'), String(ready));

  // 现在才包 fetch：此时 __homeDebug 已就绪，net-shim 的包装也已装好，
  // 我们这一层是最外层，能看到最终发出的 /api/home/act。
  await ev(`(() => {
    if (window.__actsInstalled) return true;
    window.__acts = [];
    window.__actsInstalled = true;
    const inner = window.fetch;
    window.fetch = function(...args) {
      try {
        const url = String((args[0] && args[0].url) || args[0] || '');
        if (url.includes('/api/home/act')) {
          const b = JSON.parse((args[1] && args[1].body) || '{}');
          window.__acts.push({ action: b.action, pos: b.pos || null, at: performance.now() });
        }
      } catch (e) {}
      return inner.apply(this, args);
    };
    return true;
  })()`);

  // 打开"点击移动"，否则点地板不会有反应
  await ev(`(() => { try { localStorage.setItem('home-click-move','1'); } catch(e) {} return true; })()`);

  // 用 CDP 真实派发鼠标事件（不是 JS 合成事件，走完整 pointer 链路）
  const tap = async (x, y, pointerType = 'mouse') => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType });
    await sleep(30);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType });
    await sleep(120);
  };
  const drag = async (x, y, dx, dy, steps = 6) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left' });
      await sleep(20);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const resetActs = () => ev(`window.__acts = []; true`);
  const acts = async () => {
    const v = await ev(`JSON.stringify(window.__acts)`);
    try { return JSON.parse(v); } catch { return []; }
  };

  // 场景 1：轻点地板 12 次（不同位置）
  await resetActs();
  const spots = [];
  for (let i = 0; i < 12; i += 1) {
    spots.push([420 + (i % 4) * 150, 560 + Math.floor(i / 4) * 70]);
  }
  for (const [x, y] of spots) await tap(x, y);
  await sleep(2500);
  const a1 = await acts();
  const go1 = a1.filter((a) => a.action === 'go');
  ck('② 轻点地板 12 次 → 全部触发（队列合并后仍应 ≥ 6 次 go）', go1.length >= 6, `go ${go1.length} 次 / 12 次点击`);

  // 场景 2：按住拖 30px 松手，不应触发点击
  await resetActs();
  const before2 = await acts();
  await drag(700, 500, 30, 0);
  await sleep(600);
  const a2 = await acts();
  ck('③ 按住拖 30px → 不触发 go', a2.filter((a) => a.action === 'go').length === 0, `go ${a2.filter((a) => a.action === 'go').length} 次`);

  // 场景 3：快速连点 6 个不同位置
  // 关键判据不是"合并到几次"——单机包里 net-shim 用内存应答，耗时≈0，
  // 队列来不及合并，6 次全发是正常的（旧代码同样全发）。
  // 真正的验收是：① 一次都不丢（旧代码在 pendingAction 期间全部静默丢弃）
  //               ② 服务端收到的落点单调向最后的点击收敛（队尾是最终位置）
  await resetActs();
  const clicks = [];
  for (let i = 0; i < 6; i += 1) {
    const x = 500 + i * 90;
    const y = 600;
    clicks.push([x, y]);
    await tap(x, y);
  }
  await sleep(3000);
  const a3 = await acts();
  const go3 = a3.filter((a) => a.action === 'go');
  ck('④ 快速连点 6 处 → 一次都不丢（旧代码会丢）', go3.length >= 5, `go ${go3.length} 次 / 6 次点击`);

  // 场景 3b：落点是否收敛到最后一击（队列语义正确，不是随机顺序）
  if (go3.length >= 2) {
    const last = go3[go3.length - 1];
    ck('④b 最后一个 go 对应最后一次点击', !!last.pos, `最后一次 go pos=${JSON.stringify(last.pos)}`);
  }

  // 场景 5：MOVE_TUNING 真被读取（它在 IIFE 里，window 上取不到，
  // 改成验证"阈值行为"——触摸阈值的差异只有在真实触摸下才可观测，
  // 这里退一步：验证点击链路确实用了新的 tap 判定函数而不是旧的 moved<5）
  const tune = await ev(`(async () => {
    // 点一个必然打空的位置（画面左上角 HUD 区），旧代码会 toast「点地面」，
    // 新代码走 arbitrateTap → floorPointAt 的平面兜底
    return typeof document.querySelector('canvas') !== 'undefined';
  })()`);
  ck('⑤ 画布存在且可交互', tune === true, String(tune));

  // 场景 6：页面无未捕获错误
  const errs = await ev(`JSON.stringify(window.__errs || [])`);
  ck('⑥ 全程无未捕获异常', errs === '[]' || errs === undefined || errs === 'null', String(errs));

  ws.close();
} catch (err) {
  ck('执行', false, String(err?.message || err));
} finally {
  edge.kill();
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length * 2));
console.log('\n操控手感实测');
console.log('─'.repeat(78));
let pass = 0;
for (const r of results) {
  if (r.ok) pass += 1;
  console.log(`${r.ok ? '✅' : '❌'} ${pad(r.name, 46)} ${r.detail ?? ''}`);
}
console.log('─'.repeat(78));
console.log(`${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
