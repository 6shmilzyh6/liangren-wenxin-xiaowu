// 探针四：决定性验证 —— 不部署任何服务器，能不能跨网配对。
//
// 方案：用公开的 PeerJS 信令云（wss://0.peerjs.com）只在"配对那一刻"交换 SDP，
// 之后数据走 WebRTC DataChannel 点对点。
// 这里手写协议，不引 peerjs 依赖，验证的是这条链路本身是否可用。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'peerjs';
const HOSTS = [
  'wss://0.peerjs.com:443/peerjs',
  'wss://peerjs-js-binary.vercel.app/peerjs',
];

function token() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function probe(base) {
  const id = 'dfy-probe-' + Math.random().toString(36).slice(2, 8);
  const url = `${base}?key=${KEY}&id=${id}&token=${token()}`;
  const t0 = Date.now();
  return await new Promise((resolve) => {
    let ws;
    const done = (result) => {
      try { ws?.close(); } catch { /* 忽略 */ }
      resolve({ base, ...result, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done({ ok: false, stage: 'timeout' }), 12000);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      return done({ ok: false, stage: 'construct', err: String(e && e.message || e).slice(0, 120) });
    }
    let opened = false;
    let gotOpen = false;
    ws.onopen = () => { opened = true; };
    ws.onerror = (e) => {
      if (!gotOpen) { clearTimeout(timer); done({ ok: false, stage: opened ? 'error' : 'connect', err: String(e?.message || 'ws error').slice(0, 120) }); }
    };
    ws.onclose = (e) => {
      if (!gotOpen) { clearTimeout(timer); done({ ok: false, stage: 'closed', code: e.code, reason: String(e.reason || '').slice(0, 80) }); }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'OPEN') {
        gotOpen = true;
        clearTimeout(timer);
        done({ ok: true, stage: 'OPEN', assigned: msg.id || id });
      } else if (msg.type === 'ID-TAKEN') {
        gotOpen = true;
        clearTimeout(timer);
        done({ ok: false, stage: 'ID-TAKEN' });
      } else if (msg.type === 'ERROR') {
        gotOpen = true;
        clearTimeout(timer);
        done({ ok: false, stage: 'ERROR', err: String(msg.payload?.msg || msg.payload || '').slice(0, 120) });
      }
    };
  });
}

const results = [];
for (const host of HOSTS) {
  const r = await probe(host);
  results.push(r);
  console.log(`${r.ok ? '✓' : '✗'} ${r.base}　${r.stage}${r.err ? '　' + r.err : ''}　${r.ms}ms${r.assigned ? '　id=' + r.assigned : ''}`);
  await sleep(400);
}

// 两条都失败就没法零部署了，再确认一下基础网络到这些域名的可达性
if (!results.some((r) => r.ok)) {
  console.log('\n直接 HTTP 探测：');
  for (const url of ['https://0.peerjs.com/peerjs/id', 'https://peerjs.com/']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      console.log(`  ${url} → ${res.status}`);
    } catch (e) {
      console.log(`  ${url} → ${String(e?.message || e).slice(0, 80)}`);
    }
  }
}
console.log('\n结论：', results.some((r) => r.ok) ? '信令云可用，可零部署跨网' : '信令云不可用，需要自建信令');
