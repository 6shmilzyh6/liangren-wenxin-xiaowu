// 探针：file:// 页面里，哪些来源能安全地当 WebGL 贴图？
//
// 背景：不带 --allow-file-access-from-files 时（玩家双击打开的真实情况），
// 从 file:// 载入的 <video> 被判定为跨源数据，texImage2D 抛 SecurityError，
// 立绘变成一片空白。这里在**真实的 game/index.html** 里测四种来源：
//   1. video + 相对路径（预期失败）
//   2. video + data: URL
//   3. video + blob: URL（页面内生成）
//   4. img  + 相对路径（贴图走 TextureLoader，要确认它是否也一样脏）
//   5. img  + data: URL
// 结论决定修法：是把素材内联成 data:/blob:，还是必须换启动方式。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p)) || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = path.resolve('game/assets/pet/sick.webm');      // 0.19MB，够小
const poster = path.resolve('game/assets/pet/sick.png');     // 0.13MB
if (!existsSync(clip)) throw new Error('找不到测试片段：' + clip);
const webmB64 = readFileSync(clip).toString('base64');
const pngB64 = readFileSync(poster).toString('base64');
console.log('webm base64 :', webmB64.length, ' png base64 :', pngB64.length);

const port = 9950;
const prof = mkdtempSync(path.join(tmpdir(), 'dfy-probe-taint-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  // 刻意不加 --allow-file-access-from-files
  'about:blank'
], { stdio: 'ignore' });

let page = null;
for (let i = 0; i < 80; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* 等 */ }
  await sleep(250);
}
if (!page) { proc.kill(); throw new Error('浏览器起不来'); }

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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

const pageUrl = 'file:///' + path.resolve('game/index.html').replace(/\\/g, '/');
await send('Page.navigate', { url: pageUrl });
await sleep(2500);   // 让主菜单出来（不影响后面的探测）

const script = `(async () => {
  const out = {};
  const gl = (() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    return c.getContext('webgl2') || c.getContext('webgl');
  })();
  const upload = (source) => {
    try {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return 'ok';
    } catch (err) {
      return String(err && err.name) + ': ' + String(err && err.message || '').slice(0, 48);
    }
  };

  const waitVideo = (v) => new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    v.addEventListener('loadeddata', fin, { once: true });
    v.addEventListener('canplay', fin, { once: true });
    v.addEventListener('error', fin, { once: true });
    setTimeout(fin, 4000);
  });

  const tryVideo = async (label, src) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.loop = true;
    document.body.appendChild(v);
    v.src = src;
    v.load();
    await waitVideo(v);
    try { await v.play(); } catch { /* 静音自动播放 */ }
    await new Promise((r) => setTimeout(r, 250));
    out[label] = { rs: v.readyState, w: v.videoWidth, h: v.videoHeight, tex: upload(v) };
    v.remove();
  };

  const tryImg = async (label, src) => {
    const img = new Image();
    img.src = src;
    await new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      img.onload = fin; img.onerror = fin;
      setTimeout(fin, 4000);
    });
    out[label] = { w: img.naturalWidth, h: img.naturalHeight, tex: upload(img) };
  };

  const b64ToBlob = (b64, type) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([buf], { type }));
  };

  await tryVideo('video-file', 'assets/pet/sick.webm');
  await tryVideo('video-data', 'data:video/webm;base64,${webmB64}');
  await tryVideo('video-blob', b64ToBlob('${webmB64}', 'video/webm'));
  await tryImg('img-file', 'assets/pet/sick.png');
  await tryImg('img-data', 'data:image/png;base64,${pngB64}');

  // 顺手确认 file:// 下 fetch 本地文件是否被拦（决定能不能运行时把素材转成 blob）
  try { const r = await fetch('assets/pet/sick.webm'); out.fetchFile = 'status ' + r.status; }
  catch (e) { out.fetchFile = String(e && e.message || e).slice(0, 60); }

  return JSON.stringify(out, null, 1);
})()`;

console.log(await evaluate(script));
ws.close();
proc.kill();
