// 单文件版（绿色版）验收：玩家拿到的就是一个 exe，双击就玩。
//
// 验证三件事：
//   1. 「两人温馨小屋.exe」单独放在一个空目录里（模拟"拖到桌面"），
//      双击之后能自己把游戏本体解出来、起服务、首页可访问；
//   2. 解出来的资源是完整的（index.html / game.js / 立绘视频），
//      浏览器进得去、立绘真的加载成；
//   3. 关掉再开一次不会重新解压（秒开），版本目录不会越堆越多。
//
// 这个脚本用 DAFIYU_HOME 把解压位置钉在工作区里的临时目录，不动玩家的
// %LOCALAPPDATA%，跑完自己清掉。
//
// 为什么不用系统 %TEMP%：这台机器的沙箱只让子进程写工作区，落到 %TEMP%
// 会假失败。目录里只有那一个 exe 这一点没变，"单独拖到桌面"的情形照样覆盖。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const SINGLE = path.resolve('dist/两人温馨小屋.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`✓ ${name}${note ? ' — ' + note : ''}`); }
  else { fail += 1; console.log(`✗ ${name}${note ? ' — ' + note : ''}`); }
}

if (!existsSync(SINGLE)) {
  console.log('失败: 没找到 dist/两人温馨小屋.exe，先跑 node game-src/pack.mjs');
  process.exit(1);
}
console.log(`单文件版 ${(statSync(SINGLE).size / 1048576).toFixed(1)} MB`);

// 模拟玩家把 exe 单独拖到桌面：一个空目录里只有这一个文件
const desk = path.resolve('.smoke-single/desk');
const home = path.resolve('.smoke-single/home');
rmSync(path.resolve('.smoke-single'), { recursive: true, force: true });
mkdirSync(desk, { recursive: true });
mkdirSync(home, { recursive: true });
const soloExe = path.join(desk, '两人温馨小屋.exe');
copyFileSync(SINGLE, soloExe);
const PORT = 8920;
const ORIGIN = `http://127.0.0.1:${PORT}/`;

function launch(extraEnv = {}) {
  return spawn(soloExe, ['--port', String(PORT), '--no-open'], {
    stdio: 'ignore',
    env: { ...process.env, DAFIYU_HOME: home, ...extraEnv }
  });
}

async function waitUp(limit = 200) {
  for (let i = 0; i < limit; i += 1) {
    try {
      const r = await fetch(`${ORIGIN}launcher.json`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j.launcher) return j;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return null;
}

async function shotDown(exe, limit = 60) {
  try { await fetch(`${ORIGIN}__bye`, { signal: AbortSignal.timeout(1200) }); } catch { }
  exe.kill();
  await sleep(600);
}

let launcher = launch();
try {
  const started = Date.now();
  const info = await waitUp();
  const firstMs = Date.now() - started;
  check('放在空目录里也能启动', !!info, info ? `${ORIGIN} ${(firstMs / 1000).toFixed(1)}s` : '');
  if (!info) throw new Error('单文件版没起来');

  // 首启要自己解压（首启会比二次启动慢，这里只要求 60 秒内）
  check('首启在 60 秒内完成', firstMs < 60_000, `${(firstMs / 1000).toFixed(1)}s`);

  // 解压目录结构：<home>/app/<version>/{index.html,game.js,assets,.ok}
  const appRoot = path.join(home, 'app');
  check('解到 DAFIYU_HOME 下', existsSync(appRoot));
  const versions = existsSync(appRoot) ? readdirSync(appRoot).filter((n) => !n.endsWith('.part')) : [];
  check('只有一个版本目录', versions.length === 1, versions.join(','));
  const ver = versions[0] || '';
  const appDir = path.join(appRoot, ver);
  check('index.html 就位', existsSync(path.join(appDir, 'index.html')));
  check('game.js 就位', existsSync(path.join(appDir, 'game.js')));
  check('.ok 标记写对', existsSync(path.join(appDir, '.ok')));

  const head = await fetch(ORIGIN, { signal: AbortSignal.timeout(5000) });
  const html = await head.text();
  check('首页可访问', head.ok && html.includes('两人温馨小屋'), `${html.length} 字节`);
  const js = await fetch(`${ORIGIN}game.js`, { signal: AbortSignal.timeout(15000) });
  const jsText = await js.text();
  check('game.js 可下载', js.ok && jsText.length > 500_000, `${jsText.length} 字节`);
  const webm = await fetch(`${ORIGIN}assets/pet/idle.webm`, { signal: AbortSignal.timeout(15000) });
  check('立绘视频可下载', webm.ok && (webm.headers.get('content-type') || '').includes('webm'),
    `${webm.headers.get('content-type')} ${webm.headers.get('content-length') || ''}`);

  // 真浏览器进去看一眼：菜单出来、点单机能进游戏、立绘 readyState 够
  let browser = null;
  if (EDGE) {
    const prof = path.resolve('.smoke-single/prof');
    mkdirSync(prof, { recursive: true });
    const proc = spawn(EDGE, [
      '--headless=new', '--remote-debugging-port=9960', `--user-data-dir=${prof}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', 'about:blank'
    ], { stdio: 'ignore' });
    let page = null;
    for (let i = 0; i < 100; i += 1) {
      try {
        const list = await (await fetch('http://127.0.0.1:9960/json/list')).json();
        page = list.find((t) => t.type === 'page');
        if (page) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    if (page) {
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
        if (r.result?.exceptionDetails) return null;
        return r.result?.result?.value;
      };
      const waitJs = async (expression, timeoutMs = 45_000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const v = await evaluate(expression);
          if (v) return v;
          await sleep(400);
        }
        return null;
      };
      browser = { ws, logs, kill: () => { try { ws.close(); } catch { } proc.kill(); } };

      await send('Runtime.enable');
      await send('Page.enable');
      await send('Page.navigate', { url: ORIGIN });

      const menu = await waitJs(`(() => {
        const n = document.querySelectorAll('#gxMenu .m-opt').length;
        return n ? n : null;
      })()`, 30_000);
      check('菜单出来', !!menu, menu ? `${menu} 个选项` : '');

      const warn = await evaluate(`(() => {
        const w = document.querySelector('#gxMenu .m-warn');
        return w ? w.textContent.trim().slice(0, 40) : '';
      })()`);
      check('没有「立绘会空白」的警告', !warn, warn || '');

      // 进门前必须先填名字（mode-menu.js 的 requireName 会拦住空名字的点击），
      // 不填的话「一个人住」这一下是被忽略掉的，后面等 __homeDebug 永远等不到。
      const named = await evaluate(`(() => {
        const i = document.querySelector('#gxMenu .m-name input');
        if (!i) return '';
        i.value = '验收';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return i.value;
      })()`);
      check('菜单能填名字', named === '验收', named || '没找到名字输入框');

      await evaluate(`(() => {
        [...document.querySelectorAll('#gxMenu .m-opt')].find(b => /一个人住/.test(b.textContent)).click();
        return 'ok';
      })()`);
      const solo = await waitJs(`(() => {
        if (document.querySelector('#gxMenu')) return null;
        const d = typeof window.__homeDebug === 'function' ? window.__homeDebug() : null;
        if (!d || !d.actorReadyState) return null;
        return JSON.stringify({
          actor: d.actorSrc, readyState: d.actorReadyState,
          charMode: d.charMode, her: d.herRoom, store: !!globalThis.__gameStore
        });
      })()`, 45_000);
      check('单机能进游戏、立绘加载成', !!solo && JSON.parse(solo).readyState >= 2, solo || '');

      const bads = logs.filter((l) => /error|exception/i.test(l));
      check('控制台无异常', bads.length === 0, bads.slice(0, 3).join(' / '));
    }
  }

  // 二次启动：不该重新解压
  browser?.kill();
  await shotDown(launcher);
  const versionsBefore = existsSync(appRoot) ? readdirSync(appRoot).length : 0;
  const t2 = Date.now();
  launcher = launch();
  const again = await waitUp();
  const secondMs = Date.now() - t2;
  check('关掉再开还能起来', !!again, `${(secondMs / 1000).toFixed(1)}s`);
  check('二次启动不重新解压', secondMs < 15_000, `${(secondMs / 1000).toFixed(1)}s`);
  const versionsAfter = existsSync(appRoot) ? readdirSync(appRoot).length : 0;
  check('版本目录没变多', versionsAfter === versionsBefore, `${versionsBefore} → ${versionsAfter}`);
} catch (err) {
  fail += 1;
  console.log('异常:', err?.message || err);
} finally {
  try { await fetch(`${ORIGIN}__bye`, { signal: AbortSignal.timeout(1200) }); } catch { }
  launcher.kill();
  await sleep(500);
  try { rmSync(desk, { recursive: true, force: true }); } catch { }
  try { rmSync(home, { recursive: true, force: true }); } catch { }
}

console.log(fail === 0 ? `单文件版验收 ${pass}/${pass} 全部通过` : `单文件版验收 ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
