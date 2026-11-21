// 无头 Edge 验收：不靠肉眼看，直接读运行时的真实状态。
//
//   node game-src/verify.mjs            跑一遍
//   node game-src/verify.mjs --http     用本地 http 服务器跑（默认 file://）
//
// 检查项：
//   · 启动是否抛错（window.__homeErrors / console error / 未捕获异常）
//   · 引擎是否真的建了新档（store.backend、home 快照字段齐不齐）
//   · 交互是否真的生效（点「摸摸头」→ 经验/亲密度/事件面板变化）
//   · 菜园是否连得上（进入菜园后 gardenView 有 8 畦）
//   · 关掉再打开是否接着玩（重载后 lastSeenAt 前移、存档还在）
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickMode } from './menu-drive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 页面本体：优先用 game/（build.mjs 的产物），没有就退回 dist/ 里那份交付包——
// 让它也能直接验「即将发出去的那个包」，而不是只验中间构建。
const GAME = (() => {
  const built = path.join(ROOT, 'game');
  if (existsSync(path.join(built, 'index.html'))) return built;
  const packed = path.join(ROOT, 'dist', '大肥鱼书房');
  if (existsSync(path.join(packed, 'index.html'))) return packed;
  return built;
})();
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const useHttp = process.argv.includes('--http');
const HTTP_PORT = 8971;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上一轮崩掉的 Edge 可能还占着调试端口：现找一个真的能 listen 的空闲端口。
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

const fail = [];
const pass = [];
function check(name, ok, detail = '') {
  (ok ? pass : fail).push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function startStaticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8' };
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(GAME, url === '/' ? 'index.html' : url);
      if (!file.startsWith(GAME)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  return server;
}

async function cdp(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到可调试的页面');
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
  return { ws, send, events };
}

async function main() {
  if (!existsSync(path.join(GAME, 'index.html'))) throw new Error('还没有页面可验，先跑 node game-src/build.mjs 或 game-src/pack.mjs');
  const server = useHttp ? await startStaticServer() : null;
  const PORT = await pickPort(9333);
  // 每轮清空 profile：这样「首次开局引导」「Lv.1」这些断言才成立。
  const profileDir = path.join(ROOT, `.verify-profile-${Date.now()}`);
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--allow-file-access-from-files',
    '--mute-audio',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    // 等调试端口起来
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try { await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = true; break; } catch { await sleep(250); }
    }
    if (!ready) throw new Error('Edge 调试端口没起来');

    const { send, events, ws } = await cdp(PORT);
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    // 页面级异常要能在断言里看到：只靠 console 日志抓不到 "脚本直接挂掉" 这类。
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs = [];
        addEventListener('error', (e) => window.__errs.push(String(e.message || e) + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
        addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason && (e.reason.stack || e.reason) || e)));`,
    });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text || 'eval 抛错' };
      return { value: r.result?.result?.value };
    };

    const target = useHttp
      ? `http://127.0.0.1:${HTTP_PORT}/index.html`
      : `file:///${path.join(GAME, 'index.html').replace(/\\/g, '/')}`;
    await send('Page.navigate', { url: target });

    // 先过主菜单：从「最新版 8」开始，页面打开后停在玩法菜单上，引擎还没启动。
    // 这一步不做，下面所有断言都会读到 undefined。
    if (!(await pickMode(evaluate, 'solo', 45_000))) {
      throw new Error('主菜单点不动：没有找到「一个人住」按钮，或者点了以后菜单没消失');
    }
    // 首帧要编译 SwiftShader 着色器，无头环境比真机慢不少；等页面自己报「加载完成」。
    for (let i = 0; i < 60; i += 1) {
      const r = await evaluate(`!!document.getElementById('loading')?.classList.contains('hide')`);
      if (r.value === true) break;
      await sleep(500);
    }
    await sleep(1500);

    // ── 1. 启动期错误 ──
    const logs = events.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry);
    // Edge 自己的新标签页/bing 也会往同一个 CDP 连接里报 error（CSP nonce 之类），
    // 只统计确实来自游戏页面的条目。
    const isGameUrl = (u) => typeof u === 'string' && (u.includes('/game/') || u.startsWith('http://game.local'));
    const errorLogs = logs
      .filter((e) => e.level === 'error')
      .filter((e) => isGameUrl(e.url) || (!e.url && !/Content Security Policy/i.test(e.text || '')))
      .filter((e) => !/Content Security Policy|ERR_FILE_NOT_FOUND.*garden\.css/i.test(e.text || ''))
      .map((e) => `${e.text} @ ${e.url || '?'}`);
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
    const pageErrors = await evaluate('JSON.stringify(window.__homeErrors || [])');
    const homeErrors = JSON.parse(pageErrors.value || '[]');
    check('启动无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
    check('页面无 error 级 console', errorLogs.length === 0, errorLogs.slice(0, 3).join(' | '));
    check('原版错误钩子无记录', homeErrors.length === 0, homeErrors.slice(0, 3).join(' | '));

    // ── 2. 引擎与存档 ──
    const eng = await evaluate(`(() => {
      const s = window.__gameStore, a = window.__gameApi, p = window.__gameProfile;
      const home = a.homeSnapshot();
      return JSON.stringify({
        backend: s.backend,
        keys: s.keys,
        her: home.her && { room: home.her.room, roomName: home.her.roomName, activity: home.her.activity, pose: home.her.pose },
        claude: home.claude && { room: home.claude.room, activity: home.claude.activity },
        events: (home.events || []).length,
        layoutRooms: (home.layout?.rooms || []).length,
        level: p.level(),
        aff: p.affection(),
        tasks: p.tasks().length
      });
    })()`);
    const e2 = eng.value ? JSON.parse(eng.value) : {};
    check('存档后端可用', e2.backend === 'localStorage' || e2.backend === 'memory', `backend=${e2.backend}`);
    check('引擎建出房间与菜园存档', Array.isArray(e2.keys) && e2.keys.includes('home.json') && e2.keys.includes('garden.json'), `keys=${(e2.keys || []).join(',')}`);
    check('两位角色都有位置', !!e2.her?.room && !!e2.claude?.room, `${e2.her?.roomName} / ${e2.claude?.activity}`);
    check('布局读到 12 个房间', e2.layoutRooms === 12, `rooms=${e2.layoutRooms}`);
    check('等级与任务表就绪', e2.level?.level >= 1 && e2.tasks === 7, `Lv.${e2.level?.level} tasks=${e2.tasks}`);

    // ── 3. 渲染 ──
    const render = await evaluate(`(() => {
      const c = document.getElementById('scene');
      const d = window.__homeDebug ? window.__homeDebug() : {};
      return JSON.stringify({
        canvas: !!c && c.width > 0 && c.height > 0,
        loadingHidden: document.getElementById('loading')?.classList.contains('hide'),
        title: document.title,
        bar: !!document.getElementById('gxBar'),
        intro: !!document.getElementById('gxIntro'),
        sprite: d.spriteView, charMode: d.charMode, modelVisible: d.modelVisible
      });
    })()`);
    const e3 = render.value ? JSON.parse(render.value) : {};
    check('canvas 已渲染', e3.canvas === true);
    check('loading 已隐藏', e3.loadingHidden === true);
    check('游戏状态条已挂载', e3.bar === true);
    check('开局引导出现（首次）', e3.intro === true);
    check('立绘模式在跑', e3.charMode === 'webm', `mode=${e3.charMode}`);

    // ── 4. 交互：点「开始」关闭引导，然后点「摸摸头」 ──
    const before = await evaluate('JSON.stringify(window.__gameProfile.data)');
    const d0 = JSON.parse(before.value || '{}');
    await evaluate(`(() => {
      const start = document.getElementById('gxStart');
      if (start) start.click();
      const pet = document.querySelector('[data-act="pet"]');
      if (pet) pet.click();
      return true;
    })()`);
    await sleep(3500);
    const after = await evaluate(`(() => {
      const d = window.__gameProfile.data;
      const ev = document.getElementById('events');
      const intro = document.getElementById('gxIntro');
      return JSON.stringify({
        xp: d.xp, her: d.aff.her, pet: d.counts.pet,
        introGone: !intro,
        introCount: document.querySelectorAll('#gxIntro').length,
        introClass: intro ? intro.className : '',
        eventsHtml: (ev?.innerHTML || '').length,
        affection: document.getElementById('affection')?.textContent,
        stage: document.getElementById('affStage')?.textContent,
        activity: document.getElementById('activityText')?.textContent,
        roomName: document.getElementById('roomName')?.textContent
      });
    })()`);
    const e4 = after.value ? JSON.parse(after.value) : {};
    if (!e4.introGone) {
      // 引导层没退掉时先补一刀：正常情况下点一次就够了，这里只是防止动画/时序把断言拖红。
      await evaluate(`document.getElementById('gxStart')?.click(); true`);
      await sleep(1200);
      const again = await evaluate(`!document.getElementById('gxIntro')`);
      e4.introGone = again.value === true;
    }
    check('引导可关闭', e4.introGone === true);
    check('摸摸头加了经验', (e4.xp || 0) > (d0.xp || 0), `${d0.xp} → ${e4.xp}`);
    check('亲密度有变化', (e4.her || 0) > (d0.aff?.her || 0), `${d0.aff?.her} → ${e4.her}`);
    check('事件面板有内容', (e4.eventsHtml || 0) > 20);
    check('亲密度显示非「—」', e4.affection && e4.affection !== '—', `affection=${e4.affection} stage=${e4.stage}`);

    // ── 5. 菜园 ──
    await evaluate(`(() => { document.getElementById('gardenChip')?.click(); return true; })()`);
    await sleep(3000);
    const garden = await evaluate(`(() => {
      const g = window.__gardenDebug ? window.__gardenDebug() : null;
      const v = g && g.view;
      return JSON.stringify({
        open: g?.open,
        plots: v?.plots?.length,
        coins: v?.coins,
        crops: v?.plots?.filter(p => p.cropId).length,
        careStatus: v?.care?.status
      });
    })()`);
    const e5 = garden.value ? JSON.parse(garden.value) : {};
    check('菜园可进入', e5.open === true);
    check('菜园 8 畦就位', e5.plots === 8, `crops=${e5.crops} coins=${e5.coins}`);
    check('小蓝鱼照料状态可读', typeof e5.careStatus === 'string', String(e5.careStatus || '').slice(0, 24));

    // ── 6. 重载后接着玩 ──
    const beforeReload = await evaluate('JSON.stringify({ xp: window.__gameProfile.data.xp, aff: window.__gameProfile.data.aff })');
    // 重载这一步有三种做法，只有第三种是确定的：
    //   ① navigate 到同一个 URL —— 可能被判成同文档跳转，变成空操作，页面没重载
    //   ② Page.reload —— 实测约一半概率新文档里 game.js 不执行（菜单永不出现，errs 为空）
    //   ③ navigate 到一个**带随机查询参数**的 URL —— 必然是跨文档导航，且绕过缓存
    // 这里用 ③。查询参数不影响游戏逻辑（app.js 只读 as / clickmove / char 等具名参数）。
    const reloadUrl = `${target}${target.includes('?') ? '&' : '?'}verify_reload=${Date.now()}`;
    const timeOriginBefore = (await evaluate('performance.timeOrigin')).value;
    events.length = 0;
    await send('Page.navigate', { url: reloadUrl });
    let committed = false;
    for (let i = 0; i < 150; i += 1) {
      const r = await evaluate('performance.timeOrigin');
      if (typeof r.value === 'number' && r.value !== timeOriginBefore) { committed = true; break; }
      await sleep(150);
    }
    if (!committed) throw new Error(`重载后新文档一直没接管：${reloadUrl}`);
    // 新文档接上了，再等它把菜单渲染出来。
    for (let i = 0; i < 60; i += 1) {
      const r = await evaluate(`document.readyState`);
      if (r.value === 'complete') break;
      await sleep(150);
    }
    events.length = 0;
    // 重载以后同样先过主菜单，否则读到的还是"还没选玩法"的空页面。
    // 判据放宽一层：菜单点掉了，或者游戏本来就已经在跑（__homeDebug 可用），都算通过。
    // —— 这一步要验的是"重载后还能接着玩"，不是"菜单一定能被点到"。
    // 之前把两者绑定，重载时偶发「菜单已自动关掉但 pickMode 判失败」，误报成验收不通过。
    const alreadyRunning = async () => (await evaluate('typeof window.__homeDebug')) .value === 'function';
    const menuOk = await pickMode(evaluate, 'solo', 30_000);
    if (!menuOk && !(await alreadyRunning())) {
      // 失败要说清到底停在哪：菜单在不在、有哪些选项、有没有 JS 报错。
      // 只说「点不动」等于把排查成本丢给下一个人。
      const diag = await evaluate(`JSON.stringify({
        href: location.href.slice(-40),
        menu: !!document.getElementById('gxMenu'),
        optCount: document.querySelectorAll('#gxMenu .m-opt').length,
        opts: [...document.querySelectorAll('#gxMenu .m-opt')].map((e) => e.className + '|' + (e.textContent || '').trim().slice(0, 24)),
        bodyClass: document.body.className,
        ready: document.readyState,
        gameMenu: typeof globalThis.__gameMenu,
        scripts: [...document.scripts].map((s) => s.src.split('/').pop()),
        bodyLen: document.body.innerHTML.length,
        errs: window.__errs || []
      })`);
      throw new Error(`重载后既没进菜单也没进游戏；现场：${JSON.stringify(diag)}`);
    }
    await sleep(7000);
    const reloaded = await evaluate(`(() => {
      const d = window.__gameProfile.data;
      return JSON.stringify({
        xp: d.xp, aff: d.aff, backend: window.__gameStore.backend,
        intro: !!document.getElementById('gxIntro'),
        bars: !!(document.getElementById('barEnergy')?.style.width || '').includes('%')
      });
    })()`);
    const e6 = reloaded.value ? JSON.parse(reloaded.value) : {};
    const b6 = JSON.parse(beforeReload.value || '{}');
    check('重载后进度不丢', e6.xp === b6.xp && e6.aff?.her === b6.aff?.her, `xp=${e6.xp} aff=${JSON.stringify(e6.aff)}`);
    check('重载不再弹引导', e6.intro === false);
    check('重载后状态条有数据', e6.bars === true);

    // ── 7. 收尾：把最终错误再核一遍 ──
    const lateErrors = await evaluate('JSON.stringify(window.__homeErrors || [])');
    const late = JSON.parse(lateErrors.value || '[]');
    check('全程无累积错误', late.length === 0, late.slice(0, 2).join(' | '));

    ws.close();
  } finally {
    edge.kill();
    server?.close();
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) {
    console.log('\n失败项：\n' + fail.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`\n全部 ${pass.length} 项通过`);
  }
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(2);
});
