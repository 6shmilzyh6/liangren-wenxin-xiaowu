// 探针三：跨网双人到底靠什么连上。
//
// 要回答三件事：
//   1. 哪些免费 TURN 真的能给出 relay 候选（决定"对称 NAT/校园网"能不能通）；
//   2. 连通后延迟大概多少（决定这游戏的手感）；
//   3. 手动交换的连接码能压到多短（决定"不依赖任何服务器"这条路好不好用）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'dfy-probe3-'));
const html = path.join(dir, 'p.html');
writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>p</title><body>ok</body>', 'utf8');

const port = 9900 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(path.join(tmpdir(), 'dfy-prof3-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 候选 TURN：全是公开免费的，逐个单独试，看谁能真的给出 relay。
const TURN_CANDIDATES = [
  { name: 'openrelay-udp80', urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { name: 'openrelay-tcp443', urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { name: 'freestun-3478', urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
  { name: 'anyfirewall-tcp443', urls: 'turn:turn.anyfirewall.com:443?transport=tcp', username: 'webrtc', credential: 'webrtc' },
  { name: 'cloudflare-stun', urls: 'stun:stun.cloudflare.com:3478' }
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400);
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'file:///' + html.replace(/\\/g, '/') });
  await sleep(800);

  const out = await ev(`(async () => {
    const TURN = ${JSON.stringify(TURN_CANDIDATES)};
    const report = { servers: [], sdp: {}, turn: {} };

    // ── ① 每个 TURN 单独试，看 relay 候选 ──
    for (const s of TURN) {
      const row = { name: s.name, urls: s.urls, relay: 0, srflx: 0, host: 0, ms: 0, err: '' };
      const t0 = Date.now();
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: s.urls, username: s.username, credential: s.credential }] });
        pc.createDataChannel('x');
        const cands = [];
        await new Promise((res) => {
          pc.onicecandidate = (e) => { if (!e.candidate) return res(); cands.push(e.candidate.candidate); };
          setTimeout(res, 7000);
          pc.setLocalDescription(pc.createOffer()).catch(() => res());
        });
        row.ms = Date.now() - t0;
        row.relay = cands.filter((c) => / typ relay /.test(c)).length;
        row.srflx = cands.filter((c) => / typ srflx /.test(c)).length;
        row.host = cands.filter((c) => / typ host /.test(c)).length;
        pc.close();
      } catch (e) { row.err = String(e && e.message || e).slice(0, 80); }
      report.servers.push(row);
    }

    // ── ② 完整 offer 的 SDP 体积 vs 压缩后的连接码体积 ──
    try {
      const pc = new RTCPeerConnection({ iceServers: TURN.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })) });
      pc.createDataChannel('dafiyu');
      const cands = [];
      await new Promise((res) => {
        pc.onicecandidate = (e) => { if (!e.candidate) return res(); cands.push(e.candidate.candidate); };
        setTimeout(res, 6000);
        pc.setLocalDescription(pc.createOffer()).catch(() => res());
      });
      const sdp = pc.localDescription.sdp;
      // 只留对我们有用的行（去掉 host 的 mDNS 名字候选之外的全留，但去掉注释性属性）
      const pruned = sdp.split('\\r\\n').filter((l) => {
        if (!l) return false;
        if (l.startsWith('a=extmap') || l.startsWith('a=rtcp-') || l.startsWith('a=ssrc')) return false;
        return true;
      }).join('\\r\\n');
      const zlib = async (text, fmt) => {
        const cs = new CompressionStream(fmt);
        const blob = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs);
        const buf = new Uint8Array(await new Response(blob).arrayBuffer());
        let bin = '';
        for (const b of buf) bin += String.fromCharCode(b);
        return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      };
      report.sdp.rawLen = sdp.length;
      report.sdp.prunedLen = pruned.length;
      report.sdp.candidates = cands.length;
      report.sdp.rawB64 = await zlib(sdp, 'deflate-raw');
      report.sdp.prunedB64 = await zlib(pruned, 'deflate-raw');
      report.sdp.rawB64Len = report.sdp.rawB64.length;
      report.sdp.prunedB64Len = report.sdp.prunedB64.length;
      report.sdp.bodyLen = sdp.length;
      delete report.sdp.rawB64; delete report.sdp.prunedB64;
      report.sdp.sampleCand = cands.slice(0, 4).map((c) => c.replace(/^(candidate:\\S+ \\d+ \\S+ \\d+ )\\S+/, '$1<addr>'));
      pc.close();
    } catch (e) { report.sdp.error = String(e && e.message || e).slice(0, 120); }

    // ── ③ 两个本地 PeerConnection 打通，测一个来回的延迟 ──
    try {
      const a = new RTCPeerConnection(); const b = new RTCPeerConnection();
      const ch = a.createDataChannel('t');
      const got = new Promise((res) => { b.ondatachannel = (e) => res(e.channel); });
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      const remote = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (remote) {
        const rtts = [];
        for (let i = 0; i < 7; i += 1) {
          const t = performance.now();
          await new Promise((res) => { remote.onmessage = res; ch.send('ping'); });
          rtts.push(+(performance.now() - t).toFixed(2));
        }
        report.rtt = { samples: rtts, avg: +(rtts.reduce((s, v) => s + v, 0) / rtts.length).toFixed(2) };
      }
      a.close(); b.close();
    } catch (e) { report.rtt = { error: String(e && e.message || e).slice(0, 100) }; }

    return JSON.stringify(report, null, 2);
  })()`);

  console.log(out);
  ws.close();
} finally {
  try { proc.kill(); } catch { /* 忽略 */ }
  setTimeout(() => {
    for (const d of [dir, prof]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    process.exit(0);
  }, 400);
}
