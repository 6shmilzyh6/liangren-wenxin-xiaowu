// 分享包自测：直接跑 dist/大肥鱼书房/server.mjs 那份单文件产物，
// 用它自己的目录布局和默认存档位置，确认发出去以后对方真的能打开。
//
//   node game-src/test-pack.mjs
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(path.resolve(HERE, '..'), 'dist', '大肥鱼书房');
const CHECK = [];
const ok = (name, extra = '') => { CHECK.push([true, name, extra]); console.log(`  ✓ ${name}${extra ? `　${extra}` : ''}`); };
const bad = (name, extra = '') => { CHECK.push([false, name, extra]); console.log(`  ✗ ${name}${extra ? `　${extra}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUp(base, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/home/state?pid=p_probe`, { cache: 'no-store' });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log('\n分享包自测\n');

  if (!existsSync(path.join(PKG, 'server.mjs'))) {
    console.error('没有 dist/大肥鱼书房/server.mjs，先跑 node game-src/pack.mjs');
    process.exit(1);
  }
  ok('分享包在', PKG);

  // 布局检查：发出去以后对方看到的东西。
  // 名字以 pack.mjs 实际写出的为准（快速启动.cmd / 启动联机服务器.cmd）——
  // 这里以前写的是「双击玩单机.cmd / 启动联机版.cmd」，两个早就不存在了，
  // 于是一条真断言变成了永久红灯。
  const must = ['index.html', 'game.js', 'garden.css', 'server.mjs', 'README.txt', '快速启动.cmd', '启动联机服务器.cmd', 'assets'];
  const missing = must.filter((f) => !existsSync(path.join(PKG, f)));
  missing.length === 0 ? ok('文件齐全', `${must.length} 项`) : bad('缺文件', missing.join(' '));

  // server.mjs 是单文件：不该再去 import 项目源码
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(path.join(PKG, 'server.mjs'), 'utf8');
  const relImports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  relImports.length === 0 ? ok('server.mjs 自包含', '无相对路径 import') : bad('server.mjs 还依赖外部文件', relImports.join(' '));

  // 干净起步：不许带上次的存档
  rmSync(path.join(PKG, 'data'), { recursive: true, force: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port) };
  delete env.DAFIYU_DATA_DIR;   // 用默认位置：<包>/data
  delete env.DAFIYU_ROOT;
  const proc = spawn(process.execPath, [path.join(PKG, 'server.mjs')], { cwd: PKG, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const done = (async () => {
    try {
      if (!(await waitUp(base))) { bad('服务器起来', log.slice(-400)); return; }
      ok('服务器起来', `端口 ${port}`);

      // 默认存档位置必须落在包自己的 data/ 里
      await sleep(600);
      existsSync(path.join(PKG, 'data', 'home.json'))
        ? ok('存档落在包内 data/', 'data/home.json')
        : bad('存档没落在包内', existsSync(path.join(PKG, 'data')) ? 'data/ 空' : '没有 data/');

      const st = await (await fetch(`${base}/api/home/state?pid=p_probe&name=测试`, { cache: 'no-store' })).json();
      st.ok && st.her && st.claude ? ok('首页接口正常', `${st.her.roomName} / ${st.claude.roomName}`) : bad('首页接口异常');
      st.room?.affection != null ? ok('亲密度有值', st.room.affection) : bad('亲密度是空的');

      const xpBefore = (await (await fetch(`${base}/api/net/stats`)).json()).level ?? {};
      const pet = await (await fetch(`${base}/api/home/act`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pet', target: 'her', pid: 'p_probe', by: '测试' })
      })).json();
      pet.ok ? ok('动作接口正常', pet.event?.text || '') : bad('动作接口异常');
      // 经验要去 /api/net/stats 拿：roomViewFor() 里的 level 只是等级数字。
      const xpAfter = (await (await fetch(`${base}/api/net/stats`)).json()).level ?? {};
      (xpAfter.into ?? 0) > (xpBefore.into ?? 0) || (xpAfter.level ?? 1) > (xpBefore.level ?? 1)
        ? ok('经验确实涨了', `into ${xpBefore.into} → ${xpAfter.into}（Lv.${xpAfter.level}）`)
        : bad('经验没涨', JSON.stringify(xpAfter));

      const html = await (await fetch(`${base}/`)).text();
      html.includes('两人温馨小屋') ? ok('首页能打开', `${html.length} 字节`) : bad('首页内容不对');
      html.includes('./game.js') ? ok('index 指向打包后的 game.js') : bad('index 没指向 game.js');

      for (const [label, p, want] of [['game.js', '/game.js', 200], ['立绘', '/assets/pet/idle.png', 200], ['garden.css', '/garden.css', 200]]) {
        const r = await fetch(base + p);
        r.status === want ? ok(`${label} 可下载`, `${(Number(r.headers.get('content-length')) / 1024).toFixed(0)} KB`) : bad(`${label} 打不开`, String(r.status));
      }

      const escape = await fetch(`${base}/../game-src/server/server.mjs`);
      [403, 404].includes(escape.status) ? ok('路径穿越被挡住', `status=${escape.status}`) : bad('路径穿越没挡住', String(escape.status));

      // 单机那份 zip 里没有的东西不能漏：GLB 被剥了，页面不能因为缺它崩
      existsSync(path.join(PKG, 'assets', 'models', 'da-feiyu.opt.glb'))
        ? ok('3D 模型在', 'opt.glb')
        : bad('3D 模型缺失');
    } finally {
      proc.kill();
    }
  })();

  await done;
  await sleep(400);

  // 清掉自测产生的存档，交付包保持干净
  await rm(path.join(PKG, 'data'), { recursive: true, force: true });

  const pass = CHECK.filter((c) => c[0]).length;
  console.log(`\n  分享包自测 ${pass}/${CHECK.length} 通过\n`);
  if (pass !== CHECK.length) {
    console.log(log.slice(-1200));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
