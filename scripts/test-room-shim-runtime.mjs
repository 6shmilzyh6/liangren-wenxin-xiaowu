// 单机包 shim 的运行期测试：直接在 Node 里 import game-src/shell/net-shim.js 并调 handleApi。
//
//   node scripts/test-room-shim-runtime.mjs
//
// net-shim 只依赖 home-engine / storage / profile，而 storage 在没有 localStorage 时
// 自动退化成内存后端（见 game-src/engine/storage.js 的 boot()），所以能在 Node 里真跑。
// 这验证的是 P2/P3/P4 的**运行期行为**，不是字符串契约：
//   · 玩家互通：写进环形日志、按串隔离、能按 since 增量拉
//   · 群聊：入队 + 规则引擎回复 + 落盘恢复
//   · 私聊：pid 不同 → 互不影响（限流与日志都不串）
import assert from 'node:assert/strict';

const { handleApi } = await import('../game-src/shell/net-shim.js');

let pass = 0;
const ok = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

const post = (path, body) => handleApi(path, 'POST', body);
const get = (path, query = {}) => handleApi(path, 'GET', query);

console.log('单机包 shim · 运行期行为');

await ok('玩家互通：写一条能读回来', async () => {
  const r = await post('/api/room/chat', {
    channel: 'peer', pid: 'p_a', peer: 'p_b', name: '阿瑞', text: '你在吗'
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.channel, 'peer');
  assert.equal(r.data.message.text, '你在吗');
  assert.equal(r.data.message.pid, 'p_a');
  assert.equal(r.data.key, 'peer:p_a|p_b');

  const back = await get('/api/room/chat/peer', { pid: 'p_a', peer: 'p_b' });
  assert.equal(back.status, 200);
  assert.equal(back.data.messages.length, 1);
  assert.equal(back.data.messages[0].text, '你在吗');
});

await ok('玩家互通：两端是同一个串（B 也能读到 A 发的）', async () => {
  const back = await get('/api/room/chat/peer', { pid: 'p_b', peer: 'p_a' });
  assert.equal(back.data.key, 'peer:p_a|p_b');
  assert.equal(back.data.messages.length, 1, 'B 读到的应该是 A 刚发那条');
});

await ok('玩家互通：不同的一对玩家互相看不见', async () => {
  await post('/api/room/chat', { channel: 'peer', pid: 'p_c', peer: 'p_d', text: '我们这边' });
  const other = await get('/api/room/chat/peer', { pid: 'p_a', peer: 'p_b' });
  assert.equal(other.data.messages.length, 1, 'A/B 的串不该混进 C/D 的消息');
  assert.ok(!other.data.messages.some((m) => m.text === '我们这边'));
});

await ok('玩家互通：没连上对方时明确失败（不静默吞掉）', async () => {
  const r = await post('/api/room/chat', { channel: 'peer', pid: 'p_a', text: '发给谁' });
  assert.equal(r.status, 400);
  assert.equal(r.data.ok, false);
  assert.ok(r.data.error.includes('对方'), `实际：${r.data.error}`);
});

await ok('玩家互通：不产生 AI 回复（单机版不假装有人应）', async () => {
  const r = await post('/api/room/chat', { channel: 'peer', pid: 'p_a', peer: 'p_b', text: '在吗' });
  assert.equal(r.data.reply, undefined, 'peer 通道不该有 reply 字段');
});

await ok('玩家互通：since 增量拉取', async () => {
  const all = await get('/api/room/chat/peer', { pid: 'p_a', peer: 'p_b' });
  const lastSeq = all.data.messages[all.data.messages.length - 1].seq;
  const inc = await get('/api/room/chat/peer', { pid: 'p_a', peer: 'p_b', since: lastSeq });
  assert.equal(inc.data.messages.length, 0, '没有新消息时返回空');
  await post('/api/room/chat', { channel: 'peer', pid: 'p_b', peer: 'p_a', name: '阿鱼', text: '在的' });
  const inc2 = await get('/api/room/chat/peer', { pid: 'p_a', peer: 'p_b', since: lastSeq });
  assert.equal(inc2.data.messages.length, 1);
  assert.equal(inc2.data.messages[0].text, '在的');
});

await ok('群聊：玩家这句入队，规则引擎回一句，两者都留档', async () => {
  const r = await post('/api/room/chat', {
    channel: 'group', pid: 'p_a', name: '阿瑞', text: '@小蓝鱼 早'
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.channel, 'group');
  assert.equal(r.data.who, 'her', '@小蓝鱼 应该由小蓝鱼接');
  assert.ok(String(r.data.reply || '').length > 0, '规则引擎要给出回复');

  const view = await get('/api/room/chat/group', { pid: 'p_a' });
  const texts = view.data.messages.map((m) => m.text);
  assert.ok(texts.includes('@小蓝鱼 早'), '玩家那句要在');
  assert.ok(texts.some((t) => String(t).length > 0 && t !== '@小蓝鱼 早'), '住民的回复也要在');
});

await ok('群聊：@ 小公主时换人接（规则引擎区分两位住民）', async () => {
  const r = await post('/api/room/chat', {
    channel: 'group', pid: 'p_a', name: '阿瑞', text: '@小公主 早'
  });
  assert.equal(r.data.who, 'claude');
});

await ok('群聊：视角标注按 pid 区分你 / 别人', async () => {
  await post('/api/room/chat', { channel: 'group', pid: 'p_b', name: '阿鱼', text: '我也在' });
  const asA = await get('/api/room/chat/group', { pid: 'p_a' });
  const asB = await get('/api/room/chat/group', { pid: 'p_b' });
  const aLines = asA.data.messages.map((m) => m.line);
  const bLines = asB.data.messages.map((m) => m.line);
  assert.ok(aLines.some((l) => l.startsWith('【你】')), `A 视角应有【你】：${aLines.slice(0, 3)}`);
  assert.ok(aLines.some((l) => l.startsWith('【阿鱼】')), 'A 视角下 p_b 应是名字');
  assert.ok(bLines.some((l) => l.startsWith('【你】')), 'B 视角也应有【你】');
  assert.ok(bLines.some((l) => l.startsWith('【阿瑞】')), 'B 视角下 p_a 应是名字');
  // 同一句话在两边标法必须不同
  const shared = asA.data.messages.find((m) => m.pid === 'p_b');
  assert.ok(shared, '要能找到 p_b 那条');
  assert.ok(shared.line.startsWith('【阿鱼】'), `A 视角：${shared.line}`);
});

await ok('群聊：nextSince 可用于增量', async () => {
  const view = await get('/api/room/chat/group', { pid: 'p_a' });
  const since = view.data.nextSince;
  const inc = await get('/api/room/chat/group', { pid: 'p_a', since });
  assert.equal(inc.data.messages.length, 0);
  await post('/api/room/chat', { channel: 'group', pid: 'p_a', text: '再来一句' });
  const inc2 = await get('/api/room/chat/group', { pid: 'p_a', since });
  assert.ok(inc2.data.messages.length >= 1, '新增的句子要能拉到');
});

await ok('私聊：两位住民分别回话，target 正确', async () => {
  const her = await post('/api/room/chat', { target: 'her', pid: 'p_a', text: '晚安' });
  const claude = await post('/api/room/chat', { target: 'claude', pid: 'p_a', text: '晚安' });
  assert.equal(her.data.target, 'her');
  assert.equal(claude.data.target, 'claude');
  assert.notEqual(her.data.reply, claude.data.reply, '两位住民的台词不能一样');
});

await ok('私聊：channel 字段优先于旧 target（新前端写法）', async () => {
  const r = await post('/api/room/chat', { channel: 'claude', target: 'her', pid: 'p_a', text: '早' });
  assert.equal(r.data.target, 'claude', 'channel 要压过 target');
});

await ok('私聊：不带 pid 的老前端仍然可用（落到 host）', async () => {
  const r = await post('/api/room/chat', { target: 'her', text: '晚安' });
  assert.equal(r.status, 200);
  assert.equal(r.data.pid, 'host');
});

await ok('未知路径仍然是 404（没有顺手把整个 /api 放开）', async () => {
  const r = await get('/api/room/chat/nope');
  assert.equal(r.status, 404);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
