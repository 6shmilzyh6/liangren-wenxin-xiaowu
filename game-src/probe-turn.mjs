// 探针五：PeerJS 官方自带的两条 TURN 到底能不能给出 relay 候选。
// 这是"对称 NAT / 校园网能不能连上"的唯一决定因素。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'dfy-p5-'));
const html = path.join(dir, 'p.html');
writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>p</title><body>ok</body>', 'utf8');

const port = 10000 + Math.floor(Math.random() * 80);
const prof = mkdtempSync(path.join(tmpdir(), 'dfy-prof5-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETS = [
  { name: 'peerjs-eu', urls: ['turn:eu-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  { name: 'peerjs-us', urls: ['turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  { name: 'peerjs-both', urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  { name: 'peerjs-eu-tcp', urls: ['turn:eu-0.turn.peerjs.com:3478?transport=tcp'], username: 'peerjs', credential: 'peerjsp' }
];

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
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });
  await sleep(700);

  const out = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const SETS = ${JSON.stringify(SETS)};
      const rows = [];
      for (const s of SETS) {
        const row = { name: s.name, relay: 0, srflx: 0, host: 0, ms: 0, glue: [] };
        const t0 = Date.now();
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: s.urls, username: s.username, credential: s.credential }] });
          pc.createDataChannel('x');
          const cands = [];
          await new Promise((res) => {
            pc.onicecandidate = (e) => { if (!e.candidate) return res(); cands.push(e.candidate.candidate); };
            setTimeout(res, 8000);
            pc.setLocalDescription(pc.createOffer()).catch(() => res());
          });
          row.ms = Date.now() - t0;
          row.relay = cands.filter((c) => / typ relay /.test(c)).length;
          row.srflx = cands.filter((c) => / typ srflx /.test(c)).length;
          row.host = cands.filter((c) => / typ host /.test(c)).length;
          row.glue = cands.filter((c) => / typ relay /.test(c)).slice(0, 2).map((c) => c.replace(/^(candidate:\\S+ \\d+ \\S+ \\d+ )\\S+/, '$1<relay-addr>'));
          pc.close();
        } catch (e) { row.err = String(e && e.message || e).slice(0, 90); }
        rows.push(row);
      }
      return JSON.stringify(rows, null, 2);
    })()`
  });
  console.log(out.result?.result?.value || JSON.stringify(out.result, null, 2));
  ws.close();
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    for (const d of [dir, prof]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    process.exit(0);
  }, 400);
}
