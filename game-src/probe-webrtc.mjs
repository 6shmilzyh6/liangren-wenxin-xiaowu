// 一次性探针：确认 file:// 页面里 RTCPeerConnection / DataChannel 能不能用。
// 这决定了单机版能否「零安装双击就能和对面联机」。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'dfy-probe-'));
const html = path.join(dir, 'probe.html');
writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>probe</title><body>ok</body>', 'utf8');

const port = 9700 + Math.floor(Math.random() * 100);
const prof = mkdtempSync(path.join(tmpdir(), 'dfy-prof-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ok = false;
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); ok = true; break; } catch { await sleep(250); }
  }
  if (!ok) throw new Error('调试端口没起来');
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
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });
  await sleep(1200);

  const r = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const out = { origin: location.origin, proto: location.protocol };
      out.hasRTC = typeof RTCPeerConnection === 'function';
      out.hasDC = typeof RTCDataChannel === 'function';
      out.isSecure = window.isSecureContext;
      try {
        const a = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const b = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const dc = a.createDataChannel('t');
        const got = new Promise((res) => { b.ondatachannel = (e) => res(e.channel); });
        const ice = (pc) => new Promise((res) => {
          const buf = [];
          pc.onicecandidate = (e) => { if (!e.candidate) return res(buf); buf.push(e.candidate.candidate); };
          setTimeout(() => res(buf), 3000);
        });
        await a.setLocalDescription(await a.createOffer());
        const ca = await ice(a);
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        const cb = await ice(b);
        await a.setRemoteDescription(b.localDescription);
        out.candidatesA = ca.length;
        out.candidatesB = cb.length;
        out.sampleCandidate = ca[0] || '';
        const ch = await Promise.race([got, new Promise((res) => setTimeout(() => res(null), 4000))]);
        out.channel = !!ch;
        if (ch) {
          const msg = new Promise((res) => { ch.onmessage = (e) => res(e.data); });
          ch.send('ping');
          out.echo = await Promise.race([msg, new Promise((res) => setTimeout(() => res('timeout'), 3000))]);
        }
        out.connA = a.connectionState;
        a.close(); b.close();
      } catch (err) { out.error = String(err && err.message || err); }
      return JSON.stringify(out, null, 2);
    })()`
  });
  console.log(r.result?.result?.value || JSON.stringify(r.result, null, 2));
  if (r.result?.exceptionDetails) console.log('异常:', JSON.stringify(r.result.exceptionDetails, null, 2));
  ws.close();
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    for (const d of [dir, prof]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    process.exit(0);
  }, 400);
}
