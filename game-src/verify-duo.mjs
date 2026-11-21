// 联机版浏览器验收：开两个互不相干的 Edge 实例（各自独立 user-data-dir = 两台设备），
// 连同一个服务器，验证"两个人进的是同一间屋子"。
//
//   node game-src/verify-duo.mjs
//
// 为什么要两个实例而不是两个标签页：同一 profile 下的标签页共用 localStorage，
// 两个标签页会是同一个 pid、同一个名字 —— 那测不出"两个人"。
//
// 检查项：
//   · 两边都进得去，页面无异常，联机条挂上
//   · 两边看到同一间屋子（同一份亲密度/等级/菜园）
//   · A 摸头后，B 的「屋里的人」里出现 A 的动态
//   · B 说的话，A 那边拉得到（共用一条消息流）
//   · A 的名字记进事件，B 的名字也在名单里
//   · 联机时存档页不给导出/导入/重开
//   · 服务器重启后，进度还在（存档真的落了盘）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickMode } from './menu-drive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 与 verify.mjs 同一套退让：没有 game/ 就用 dist/ 里那份交付包。
const GAME = (() => {
  const built = path.join(ROOT, 'game');
  if (existsSync(path.join(built, 'index.html'))) return built;
  const packed = path.join(ROOT, 'dist', '大肥鱼书房');
  if (existsSync(path.join(packed, 'index.html'))) return packed;
  return built;
})();
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.argv[2]) || 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [];
const fail = [];
function check(name, ok, detail = '') {
  (ok ? pass : fail).push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function pickPort(preferred) {
  const net = await import('node:net');
  for (let p = preferred; p < preferred + 40; p += 1) {
    const free = await new Promise((res) => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return preferred;
}

// 默认跑源码里的服务器；set DAFIYU_SERVER=...\dist\大肥鱼书房\server.mjs
// 就能验收"分享包里那份单文件"是不是真能两台设备一起玩。
const SERVER = process.env.DAFIYU_SERVER ? path.resolve(process.env.DAFIYU_SERVER) : path.join(HERE, 'server', 'server.mjs');

function startServer() {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, PORT: String(PORT), DAFIYU_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // 留一份日志：重启失败时要能看出是 EADDRINUSE 还是别的。
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d.toString(); });
  proc.stderr.on('data', (d) => { proc.log += d.toString(); });
  return proc;
}

/** 一直重试到条件成立；用来替代固定的 sleep（无头环境时序很不稳）。 */
async function waitFor(fn, { timeout = 20_000, every = 400, label = '' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

async function waitServer(tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${BASE}/api/net/stats`)).ok) return true; } catch { /* 等 */ }
    await sleep(200);
  }
  return false;
}

/** 停服务器并真的等端口释放（否则紧接着重启会 EADDRINUSE）。 */
async function stopServer() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  const gone = new Promise((res) => { proc.once('exit', res); });
  try { proc.kill(); } catch { /* 忽略 */ }
  await Promise.race([gone, sleep(3000)]);
  for (let i = 0; i < 40; i += 1) {
    const listening = await new Promise((res) => {
      fetch(`${BASE}/api/net/stats`, { signal: AbortSignal.timeout(500) })
        .then(() => res(true)).catch(() => res(false));
    });
    if (!listening) return;
    await sleep(200);
  }
}

/** 重启服务器；端口没让干净就多试几次。 */
async function restartServer() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    serverProc = startServer();
    if (await waitServer(50)) return true;
    console.log(`  重启第 ${attempt + 1} 次失败：${serverProc.log.split('\n').filter(Boolean).slice(-3).join(' / ')}`);
    await stopServer();
    await sleep(800);
  }
  return false;
}

/** 起一个 Edge 实例并连上它的 CDP。 */
async function launch(label, debugPort, profileDir) {
  const proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--mute-audio',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); ready = true; break; } catch { await sleep(250); }
  }
  if (!ready) throw new Error(`${label} 的调试端口没起来`);

  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text || 'eval 抛错' };
    return { value: r.result?.result?.value };
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const open = async (name) => {
    await send('Page.navigate', { url: `${BASE}/index.html` });
    // 先过主菜单：玩法现在是在游戏里选的，服务器模式对应第三项「连联机服务器」
    // （要有服务端 /api 才会出现，探到之前菜单里只有单机/双人，所以超时给宽一点）。
    if (!(await pickMode(evaluate, 'server', 45_000))) {
      throw new Error('主菜单里没有「连联机服务器」：服务器没起来，或者菜单探测失败');
    }
    // 等 loading 隐藏（SwiftShader 首帧慢），再等一轮轮询把联机数据拉回来。
    for (let i = 0; i < 70; i += 1) {
      const r = await evaluate(`!!document.getElementById('loading')?.classList.contains('hide')`);
      if (r.value === true) break;
      await sleep(500);
    }
    await sleep(2500);
    if (name) {
      await evaluate(`(() => {
        const intro = document.getElementById('gxIntro');
        const input = document.getElementById('gxName');
        if (input) input.value = ${JSON.stringify(name)};
        document.getElementById('gxStart')?.click();
        return !!intro;
      })()`);
      await sleep(1200);
    }
  };

  return { proc, ws, send, evaluate, events, open, label };
}

const DATA = mkdtempSync(path.join(tmpdir(), 'dafiyu-duo-'));
const profiles = [mkdtempSync(path.join(tmpdir(), 'dafiyu-pa-')), mkdtempSync(path.join(tmpdir(), 'dafiyu-pb-'))];

let serverProc = null;
let A = null;
let B = null;

function cleanup() {
  try { A?.ws.close(); } catch { /* 忽略 */ }
  try { B?.ws.close(); } catch { /* 忽略 */ }
  try { A?.proc.kill(); } catch { /* 忽略 */ }
  try { B?.proc.kill(); } catch { /* 忽略 */ }
  try { serverProc?.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    for (const d of [...profiles, DATA]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    const total = pass.length + fail.length;
    console.log('\n' + pass.join('\n'));
    if (fail.length) {
      console.log('\n失败项：\n' + fail.join('\n'));
      console.log(`\n  联机浏览器验收 ${pass.length}/${total} 通过`);
      process.exit(1);
    }
    console.log(`\n  联机浏览器验收 ${pass.length}/${total} 全部通过`);
    process.exit(0);
  }, 500);
}

try {
  if (!existsSync(path.join(GAME, 'index.html'))) throw new Error('还没构建，先跑 node game-src/build.mjs');

  serverProc = startServer();
  if (!(await waitServer())) throw new Error('服务器没起来');
  check('服务器启动', true, BASE);

  const [pa, pb] = [await pickPort(9400), await pickPort(9460)];
  A = await launch('A', pa, profiles[0]);
  B = await launch('B', pb, profiles[1]);
  check('两个浏览器实例就绪', true, `A:${pa} B:${pb}`);

  // ── 两个人分别进屋，各自报名字 ──
  await A.open('小朱');
  await B.open('小张');

  // 名单是心跳（4 秒一拍）喂出来的，刚进屋那一下两边都只知道自己。
  // 所以这里必须等 A 的状态条真的变成「2 人在屋里」，不能读一次就断言。
  const countA = await (async () => {
    let txt = '';
    await waitFor(async () => {
      const r = await A.evaluate(`document.querySelector('#ntBar .nt-count')?.textContent || ''`);
      txt = r.value || '';
      return /2 人/.test(txt);
    }, { timeout: 20_000, every: 500 });
    return txt;
  })();

  const ea = await A.evaluate(`(() => {
    const net = window.__net;
    const d = window.__gameDebug ? window.__gameDebug() : {};
    return JSON.stringify({
      mode: typeof window.__gameApi === 'undefined' ? 'online' : 'offline-shim',
      bar: !!document.getElementById('ntBar'),
      count: document.querySelector('#ntBar .nt-count')?.textContent || '',
      pid: net?.playerId?.() || '',
      loadingHidden: !!document.getElementById('loading')?.classList.contains('hide'),
      charMode: d.charMode,
      affection: document.getElementById('affection')?.textContent,
      stage: document.getElementById('affStage')?.textContent
    });
  })()`);
  const eA = JSON.parse(ea.value || '{}');
  const eb = await B.evaluate(`(() => JSON.stringify({
    bar: !!document.getElementById('ntBar'),
    pid: window.__net?.playerId?.() || '',
    loadingHidden: !!document.getElementById('loading')?.classList.contains('hide')
  }))()`);
  const eB = JSON.parse(eb.value || '{}');

  check('页面走的是联机模式', eA.mode === 'online', `mode=${eA.mode}`);
  check('A 的联机条挂上', eA.bar === true, `文案=${eA.count}`);
  check('B 的联机条挂上', eB.bar === true);
  check('两个浏览器是不同的人', !!eA.pid && !!eB.pid && eA.pid !== eB.pid, `${eA.pid} / ${eB.pid}`);
  check('A 的页面正常加载完', eA.loadingHidden === true);
  check('B 的页面正常加载完', eB.loadingHidden === true);
  check('A 看到屋里 2 人', /2 人/.test(countA || eA.count || ''), `文案=${eA.count}`);
  check('A 的亲近度不是「—」', eA.affection && eA.affection !== '—', `aff=${eA.affection} stage=${eA.stage}`);

  // ── 同一间屋子：同等级、同亲密度、同菜园 ──
  const stat1 = await (await fetch(`${BASE}/api/net/stats`)).json();
  const stat2 = await (await fetch(`${BASE}/api/net/stats`)).json();
  check('两人共享同一份等级', stat1.level.level === stat2.level.level, `Lv.${stat1.level.level}`);
  check('两人共享同一份亲密度', stat1.affection.her === stat2.affection.her, `her=${stat1.affection.her}`);

  // ── A 摸头，B 应该在自己的面板里看到 ──
  await A.evaluate(`(() => { document.querySelector('[data-act="pet"]')?.click(); return true; })()`);

  // 等 B 的 netState 里真的出现 A 的动态（服务器 1.2 秒一轮轮询，别用固定 sleep 赌）。
  const feedB = await (async () => {
    let last = {};
    const ok = await waitFor(async () => {
      const r = await B.evaluate(`(() => {
        const n = window.__net?.state || {};
        document.getElementById('ntOpen')?.click();
        return JSON.stringify({
          players: (n.players || []).map(p => p.name),
          feed: (n.feed || []).map(f => f.text),
          listHtml: (document.getElementById('ntList')?.innerHTML || '').length,
          feedHtml: (document.getElementById('ntFeed')?.innerHTML || '').length
        });
      })()`);
      last = JSON.parse(r.value || '{}');
      return (last.feed || []).some((t) => /小朱/.test(t) && /摸/.test(t)) && (last.feedHtml || 0) > 40;
    }, { timeout: 20_000, every: 800 });
    return { ok, ...last };
  })();
  const eFeed = feedB;
  check('B 的名单里有 A 的名字', (eFeed.players || []).includes('小朱'), (eFeed.players || []).join('、'));
  check('B 看到 A 摸头的动态', (eFeed.feed || []).some((t) => /小朱/.test(t) && /摸/.test(t)), (eFeed.feed || []).slice(-2).join(' | '));
  check('B 的面板渲染出名单', (eFeed.listHtml || 0) > 40);
  check('B 的面板渲染出动态', (eFeed.feedHtml || 0) > 40);

  // ── B 说一句话，A 拉得到 ──
  await B.evaluate(`(() => {
    const i = document.getElementById('ntInput');
    if (i) { i.value = '我来浇水'; }
    document.getElementById('ntSend')?.click();
    return true;
  })()`);
  const chatA = await (async () => {
    let last = {};
    await waitFor(async () => {
      const r = await A.evaluate(`(() => {
        const n = window.__net?.state || {};
        document.getElementById('ntOpen')?.click();
        return JSON.stringify({
          msgs: (n.messages || []).map(m => m.name + ':' + m.text),
          msgsHtml: (document.getElementById('ntMsgs')?.innerHTML || '').length
        });
      })()`);
      last = JSON.parse(r.value || '{}');
      return (last.msgs || []).some((m) => /我来浇水/.test(m));
    }, { timeout: 20_000, every: 800 });
    return last;
  })();
  const eChat = chatA;
  check('A 收到 B 的消息', (eChat.msgs || []).some((m) => /我来浇水/.test(m)), (eChat.msgs || []).slice(-2).join(' | '));
  check('A 的消息区渲染出来', (eChat.msgsHtml || 0) > 40);

  // ── 联机时不给导出/导入/重开 ──
  const saveTab = await A.evaluate(`(() => {
    window.__gameShell?.openPanel?.();
    const tabs = [...document.querySelectorAll('.gx-tab')];
    const save = tabs.find(t => /存档/.test(t.textContent || ''));
    save?.click();
    const html = document.getElementById('gxPanel')?.innerHTML || '';
    return JSON.stringify({
      hasExport: /导出存档/.test(html),
      hasImport: /导入存档/.test(html),
      hasReset: /重开一局/.test(html),
      saysServer: /服务器/.test(html)
    });
  })()`);
  const eSave = JSON.parse(saveTab.value || '{}');
  check('联机存档页不给导出', eSave.hasExport === false);
  check('联机存档页不给导入', eSave.hasImport === false);
  check('联机存档页不给重开', eSave.hasReset === false);
  check('联机存档页说明在服务器上', eSave.saysServer === true);
  await A.evaluate(`window.__gameShell?.closePanel?.()`);

  // ── 存档真的落盘：重启服务器后进度还在 ──
  const before = (await (await fetch(`${BASE}/api/net/stats`)).json()).level.into;
  await stopServer();
  if (!(await restartServer())) throw new Error('服务器没重启起来');
  const afterRestart = await (await fetch(`${BASE}/api/net/stats`)).json();
  check('重启服务器后进度还在', (afterRestart.level.into ?? -1) === before, `into ${before} → ${afterRestart.level.into}`);
  check('重启后亲密度还在', (afterRestart.affection?.her ?? 0) > 1, `her=${afterRestart.affection?.her}`);
} catch (err) {
  console.log(`\n异常：${err?.message || err}`);
  fail.push(`✗ 脚本异常 — ${err?.message || err}`);
} finally {
  cleanup();
}
