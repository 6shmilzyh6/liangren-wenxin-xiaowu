// 联机接口验收：不开浏览器，直接照两个玩家的顺序打服务端。
//
// 覆盖的是"两个人共用一间屋子"这件事本身：
//   1. 两个 pid 都进得来，名单里互相看得见；
//   2. 一个人做的动作，另一个人下次 poll 就能看到（事件与等级共享）；
//   3. 菜园也是同一份；
//   4. 玩家之间的聊天是双向的、增量拉取不重复；
//   5. 中文不乱码。
//
// 用法：node game-src/verify-online.mjs [port]
// 它会自己在临时目录里起一个服务器（不碰正式的 data/），跑完即关。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.argv[2]) || 8799;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `　${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, init) {
  const res = await fetch(BASE + p, init);
  return res.json();
}

function post(p, body) {
  return api(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  });
}

// 临时数据目录：把 DATA_DIR 换掉，正式存档不受影响。
const tmp = mkdtempSync(path.join(tmpdir(), 'dafiyu-online-'));

const server = spawn(process.execPath, [path.join(HERE, 'server', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DAFIYU_DATA_DIR: tmp },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function shutdown(code) {
  try { server.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(code);
  }, 300);
}

try {
  // 等端口起来
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      const r = await fetch(`${BASE}/api/net/stats`);
      if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
  }
  if (!up) {
    console.log(serverLog);
    check('服务器启动', false, '端口 60 次轮询都不通');
    shutdown(1);
    throw new Error('server not up');
  }
  check('服务器启动', true, `127.0.0.1:${PORT}`);

  // ── 玩家 A 进来 ──
  const a = await api(`/api/home/state?pid=p_alice&name=${encodeURIComponent('小朱')}`);
  check('A 拿到屋子状态', a.ok === true && !!a.her && !!a.claude, `${a.her?.roomName} / ${a.claude?.roomName}`);
  check('A 看到在场玩家数=1', a.net?.players?.length === 1, `players=${a.net?.players?.length}`);
  check('存档位置非「—」', typeof a.room?.affection === 'number' && !!a.room?.stage, `aff=${a.room?.affection} stage=${a.room?.stage}`);

  // ── 玩家 B 进来 ──
  const b = await api(`/api/home/state?pid=p_bob&name=${encodeURIComponent('小张')}`);
  const names = (b.net?.players || []).map((p) => p.name).sort();
  check('B 进来后名单里有两个人', b.net?.players?.length === 2, names.join('、'));
  check('中文名字没乱码', names.includes('小朱') && names.includes('小张'), names.join('、'));

  // ── A 摸摸头，B 应该看得见 ──
  const xpBefore = (await api('/api/net/stats')).level?.into ?? 0;
  const act = await post('/api/home/act', { pid: 'p_alice', by: '小朱', action: 'pet', target: 'her' });
  check('A 的动作生效', act.ok === true && act.changed === true, `event=${act.event?.text || '(无)'}`);
  const statsAfter = await api('/api/net/stats');
  check('等级经验跟着涨', (statsAfter.level?.into ?? 0) > xpBefore || (statsAfter.level?.level ?? 1) > 1,
    `into ${xpBefore} → ${statsAfter.level?.into}（Lv.${statsAfter.level?.level}）`);
  check('动作记在 A 名下', !!statsAfter.players?.['小朱'], JSON.stringify(statsAfter.players?.['小朱'] || null));

  const bNext = await api(`/api/home/state?pid=p_bob&name=${encodeURIComponent('小张')}`);
  // 玩家动态是独立的一条流（home 的 eventLog 记的是"她做了什么"，不是"你做了什么"）。
  const feedText = (bNext.net?.feed || []).map((f) => f.text).join(' | ');
  check('B 看到 A 做了什么', /小朱/.test(feedText) && /摸/.test(feedText), feedText.slice(0, 80));
  check('动态里没有 B 的动作', !/小张.*摸/.test(feedText), feedText.slice(0, 80));
  check('B 看到的是同一份亲密', bNext.room?.affection === statsAfter.affection?.her, `aff=${bNext.room?.affection}`);

  // ── 菜园同一份 ──
  const g1 = await api('/api/garden/state');
  const g2 = await api('/api/garden/state');
  check('菜园可读且状态一致', g1.ok && g2.garden?.plots?.length === 8, `plots=${g1.garden?.plots?.length} coins=${g1.garden?.coins}`);
  check('菜园两人看到同一份', (g1.garden?.coins ?? -1) === (g2.garden?.coins ?? -2), `coins=${g1.garden?.coins}`);

  // ── 两个人之间说话 ──
  const m1 = await post('/api/net/chat', { pid: 'p_alice', name: '小朱', text: '我来喂鱼了' });
  check('A 发言成功', m1.ok === true && m1.message?.text === '我来喂鱼了', m1.message?.text || '');
  await post('/api/net/chat', { pid: 'p_bob', name: '小张', text: '那我浇水' });
  const pull = await api('/api/net/chat?since=0');
  check('B 能拉到 A 的消息', (pull.messages || []).some((m) => m.text === '我来喂鱼了'), `${pull.messages?.length} 条`);
  check('双向都进同一条流', (pull.messages || []).some((m) => m.text === '那我浇水'), `${pull.messages?.length} 条`);
  const since = pull.messages?.[pull.messages.length - 1]?.at ?? 0;
  const inc = await api(`/api/net/chat?since=${since}`);
  check('增量拉取不重复', (inc.messages || []).length === 0, `since 之后 ${inc.messages?.length} 条`);

  // ── 静态产物 ──
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('首页可访问', page.ok && /两人温馨小屋/.test(html), `${html.length} 字节`);
  check('index 指向 game.js', /src="\.\/game\.js"/.test(html));
  const js = await fetch(BASE + '/game.js');
  check('打包产物可下载', js.ok, `${Math.round(Number(js.headers.get('content-length') || 0) / 1024)} KB`);
  const asset = await fetch(BASE + '/assets/pet/idle.png');
  check('立绘素材可下载', asset.ok, `${asset.headers.get('content-type')}`);
  const css = await fetch(BASE + '/garden.css');
  check('garden.css 可下载', css.ok);
  const escape = await fetch(BASE + '/../src/bridge.js');
  check('路径穿越被挡住', escape.status === 404 || escape.status === 403, `status=${escape.status}`);
} catch (err) {
  if (!results.length || results.some((r) => !r.ok)) console.log(`\n异常：${err?.message || err}`);
} finally {
  const bad = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  联机验收 ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('  服务器日志尾部：');
    console.log(serverLog.split('\n').slice(-12).join('\n'));
  }
  shutdown(bad.length ? 1 : 0);
}
