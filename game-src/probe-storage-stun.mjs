// 探针二：file:// 下 ① localStorage 能否持久化 ② 能否拿到公网 STUN 候选（srflx）
// 这两件事决定「双击启动 + 跨网 P2P」这条路成不成立。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'dfy-probe2-'));
const html = path.join(dir, 'p.html');
writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>p</title><body>ok</body>', 'utf8');
const fileUrl = 'file:///' + html.replace(/\\/g, '/');

const port = 9800 + Math.floor(Math.random() * 100);
const prof = mkdtempSync(path.join(tmpdir(), 'dfy-prof2-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); }
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300);
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // ── 1. localStorage 写入 ──
  await send('Page.navigate', { url: fileUrl });
  await sleep(900);
  const w = await ev(`(() => { try { localStorage.setItem('t','v123'); return 'wrote:' + localStorage.getItem('t'); } catch(e) { return 'ERR ' + e.message; } })()`);

  // ── 2. 重载后再读（同一 profile，模拟重开游戏） ──
  await send('Page.navigate', { url: fileUrl + '?x=1' });
  await sleep(900);
  const r2 = await ev(`(() => { try { return 'read:' + localStorage.getItem('t'); } catch(e) { return 'ERR ' + e.message; } })()`);

  // ── 3. 公网 STUN 候选 ──
  const stun = await ev(`(async () => {
    const out = { list: [] };
    try {
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.qq.com:3478' }
      ]});
      pc.createDataChannel('x');
      const done = new Promise((res) => {
        pc.onicecandidate = (e) => {
          if (!e.candidate) return res();
          out.list.push(e.candidate.candidate);
        };
        setTimeout(res, 9000);
      });
      await pc.setLocalDescription(await pc.createOffer());
      await done;
      pc.close();
    } catch (e) { out.error = String(e && e.message || e); }
    out.srflx = out.list.filter((c) => / typ srflx /.test(c)).length;
    out.host = out.list.filter((c) => / typ host /.test(c)).length;
    out.relay = out.list.filter((c) => / typ relay /.test(c)).length;
    return JSON.stringify(out);
  })()`);

  console.log('localStorage 写入 :', w);
  console.log('重载后读取        :', r2);
  console.log('ICE 结果          :', stun);
  ws.close();
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    for (const d of [dir, prof]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    process.exit(0);
  }, 400);
}
