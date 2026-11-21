// 把「造型预览」做成真正双击就能看的单文件。
//
// 关键坑（本项目 game-src/probe-taint.mjs 早验证过）：
//   不带 --allow-file-access-from-files 时（玩家双击的真实情况），
//   file:// 载入的 <video> 会被判为跨源数据，texImage2D 直接抛 SecurityError，
//   画面一片空白 —— 路径怎么写都没用，clips/ 放同目录也不行。
//   可用来源只有两种：data: URL 与 blob: URL。
//   file:// 下 fetch 本地文件同样被拦（Failed to fetch），所以不能在运行时读文件，
//   必须把片段以 base64 内联进 HTML，再用 Blob 转成 blob: URL 交给 video。
//
//   node game-src/pack-desktop.mjs              输出到桌面「小公主造型」
//   node game-src/pack-desktop.mjs --out DIR    指定目录
import { build } from 'esbuild';
import { writeFile, mkdir, copyFile, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOM = path.join(ROOT, 'public', 'room');
const CLIPS_SRC = path.join(ROOM, 'assets', 'pet', 'claude');
const SHOTS = path.join(ROOT, 'game-shots');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? path.resolve(process.argv[outIdx + 1])
  : path.join(process.env.USERPROFILE || ROOT, 'Desktop', '小公主造型');

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(path.join(OUT, '参考图'), { recursive: true });
  await mkdir(path.join(OUT, '对比图'), { recursive: true });

  // ── 1. 读片段并转 base64 ───────────────────────────────────────
  const clipFiles = (await readdir(CLIPS_SRC)).filter((f) => f.endsWith('.webm')).sort();
  const clips = {};
  let totalBytes = 0;
  for (const f of clipFiles) {
    const buf = await readFile(path.join(CLIPS_SRC, f));
    const key = f.replace(/\.webm$/, '');
    clips[key] = buf.toString('base64');
    totalBytes += buf.length;
  }
  const b64Bytes = Object.values(clips).reduce((n, s) => n + s.length, 0);
  console.log(`内联 ${clipFiles.length} 个片段：原始 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，base64 ${(b64Bytes / 1024 / 1024).toFixed(1)} MB`);

  // ── 2. 打包 three.js + ClaudeActor ─────────────────────────────
  const ENTRY = `
import * as THREE from './vendor/three.module.js';
import { ClaudeActor, setClipBase, registerInlineClips } from './claude-actor.js';

// 片段以 base64 内联进来，运行时转 blob: URL。
// 直接写 file:// 相对路径会抛 SecurityError（texImage2D），见文件头说明。
registerInlineClips(window.__CLAUDE_CLIPS__);
setClipBase('');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearAlpha(0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 60);
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c8b2, 1.0));
const dl = new THREE.DirectionalLight(0xfff1dd, 0.8);
dl.position.set(2, 4, 3);
scene.add(dl);

const actor = new ClaudeActor(scene);
actor.setVisible(true);
actor.setPose({ pos: [0, 0], elev: 0, pose: 'stand', kind: 'idle', walking: false, facing: 0 });

const VIEW = { yaw: 0, pitch: 3, dist: 1.9, ty: 0.92, fov: 32 };
function applyCamera() {
  camera.fov = VIEW.fov;
  camera.updateProjectionMatrix();
  const yaw = VIEW.yaw * Math.PI / 180;
  const pitch = VIEW.pitch * Math.PI / 180;
  camera.position.set(Math.sin(yaw) * VIEW.dist, VIEW.ty + Math.sin(pitch) * VIEW.dist, Math.cos(yaw) * VIEW.dist);
  camera.lookAt(new THREE.Vector3(0, VIEW.ty, 0));
}
applyCamera();

let dragging = false, lastX = 0, lastY = 0;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY;
  try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointerup', (e) => { dragging = false;
  try { cv.releasePointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  VIEW.yaw += (e.clientX - lastX) * 0.45;
  VIEW.pitch = Math.max(-35, Math.min(55, VIEW.pitch - (e.clientY - lastY) * 0.3));
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  VIEW.dist = Math.max(0.55, Math.min(5, VIEW.dist * (1 + Math.sign(e.deltaY) * 0.09)));
  applyCamera();
}, { passive: false });
cv.addEventListener('dblclick', () => {
  Object.assign(VIEW, { yaw: 0, pitch: 3, dist: 1.9, ty: 0.92, fov: 32 });
  applyCamera();
});

const bar = document.getElementById('bar');
const stat = document.getElementById('stat');
function mkBtn(text, fn) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', fn);
  bar.appendChild(b);
  return b;
}
function sep() { const d = document.createElement('div'); d.className = 'sep'; bar.appendChild(d); }

const PRESETS = [
  ['全身', { yaw: 0, pitch: 3, dist: 1.9, ty: 0.92, fov: 32 }],
  ['侧面', { yaw: 78, pitch: 3, dist: 1.9, ty: 0.92, fov: 32 }],
  ['看脸', { yaw: 0, pitch: 0, dist: 0.85, ty: 1.15, fov: 26 }],
  ['看裙', { yaw: 8, pitch: -3, dist: 1.1, ty: 0.55, fov: 34 }],
];
const vb = PRESETS.map(([label, v], i) => mkBtn(label, () => {
  Object.assign(VIEW, v);
  applyCamera();
  vb.forEach((x) => x.classList.remove('on'));
  vb[i].classList.add('on');
}));
vb[0].classList.add('on');
sep();

const ACTIONS = [
  ['待机','claude_idle'],['思考','claude_think'],['写代码','claude_write'],['忙碌','claude_busy'],
  ['整理','claude_compact'],['看书','claude_read'],['东张西望','claude_look'],['走路','claude_walk'],
  ['睡觉','claude_sleep'],['开心','claude_happy'],['吃惊','claude_surprised'],['生气','claude_pout'],
  ['挥手','claude_pat_wave'],['害羞','claude_pat_shy'],['雀跃','claude_pat_joy'],['哼歌','claude_hum'],
  ['伸懒腰','claude_stretch'],['打哈欠','claude_yawn'],['裙摆舞','claude_curtsy'],
];
for (const [label, clip] of ACTIONS) {
  mkBtn(label, () => {
    actor.playClip(clip);
    stat.textContent = label + ' · ' + clip.replace('claude_', '');
  });
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// 自检：等首帧真正解码完再判，否则第一帧还没贴上就误报空白。
  const clock = new THREE.Clock();
  setTimeout(() => {
    try {
      const hasVideo = [...document.querySelectorAll('video')].some((v) => v.readyState >= 2 && v.videoWidth > 0);
      const gl = renderer.getContext();
      const w = renderer.domElement.width;
      const h = renderer.domElement.height;
      const px = new Uint8Array(4 * 96 * 96);
      gl.readPixels(Math.max(0, (w >> 1) - 48), Math.max(0, (h >> 1) - 48), 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let painted = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 12) painted += 1;
      const ok = hasVideo && painted > 30;
      document.getElementById('stat').textContent = ok
        ? '已加载 ' + Object.keys(window.__CLAUDE_CLIPS__).length + ' 个片段'
        : '⚠ 未加载（video=' + (hasVideo ? 'ok' : 'false') + ' paint=' + painted + '）';
    } catch (e) {
      document.getElementById('stat').textContent = '自检出错：' + e.message;
    }
  }, 1800);

  (function loop() {
    const dt = Math.min(clock.getDelta(), 0.05);
    actor.update(dt, camera, { mode: 'overview', lookAtCamera: false });
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();
`;

  const entryPath = path.join(ROOM, '__desk-entry.js');
  await writeFile(entryPath, ENTRY, 'utf8');
  let code;
  try {
    const res = await build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      minify: true,
      write: false,
      target: ['chrome110', 'edge110'],
    });
    code = res.outputFiles[0].text;
  } finally {
    await rm(entryPath, { force: true });
  }

  const SHELL = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude 小公主 · 造型预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #f6efe1; overflow: hidden;
    font-family: "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  canvas { display: block; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 9px 14px 11px;
    display: flex; gap: 7px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #5b4a3a;
    background: linear-gradient(to top, rgba(246,239,225,.97), rgba(246,239,225,0)); }
  #bar button { font: inherit; padding: 4px 11px; border-radius: 6px; cursor: pointer;
    border: 1px solid #d9cbb5; background: #fffdf8; color: #3a2f26; }
  #bar button:hover { background: #f2e9d8; }
  #bar button.on { background: #d2714a; border-color: #d2714a; color: #fff; }
  #bar .sep { width: 1px; height: 16px; background: #ddd0bd; margin: 0 3px; }
  #hint { position: fixed; left: 15px; top: 13px; font-size: 12px; line-height: 1.75; color: #8a7560; }
  #hint b { color: #3a2f26; font-weight: 600; }
  #stat { position: fixed; right: 15px; top: 13px; font-size: 12px; color: #8a7560; }
</style>
</head>
<body>
<div id="hint"><b>拖动</b> 旋转 · <b>滚轮</b> 缩放 · <b>双击</b> 复位<br>下方按钮切动作</div>
<div id="stat">载入中…</div>
<div id="bar"></div>
<script>window.__CLAUDE_CLIPS__ = ${JSON.stringify(clips)};</script>
<script>${code}</script>
</body>
</html>`;

  const htmlPath = path.join(OUT, '造型预览.html');
  await writeFile(htmlPath, SHELL, 'utf8');
  console.log(`造型预览.html  ${(statSync(htmlPath).size / 1024 / 1024).toFixed(1)} MB（单文件，双击即开）`);

  // ── 3. 参考图与对比图 ──────────────────────────────────────────
  const refs = [['ref-2.png', '主立绘.png'], ['ref-1.png', '立绘-2.png'], ['ref-actions.png', '103个小动作.png']];
  for (const [from, to] of refs) {
    const src = path.join(SHOTS, from);
    if (existsSync(src)) await copyFile(src, path.join(OUT, '参考图', to));
  }
  const cmps = [['cmp-sprite.png', '对比-实际渲染.png'], ['ingame-claude.png', '游戏内实拍.png']];
  for (const [from, to] of cmps) {
    const src = path.join(SHOTS, from);
    if (existsSync(src)) await copyFile(src, path.join(OUT, '对比图', to));
  }

  const README = `Claude 小公主 · 造型预览
=======================

【怎么打开】
双击「造型预览.html」。文件约 ${(statSync(htmlPath).size / 1024 / 1024).toFixed(0)} MB，
20 个动作片段全部内联在里面，不联网、不需要服务器、不需要任何外部文件。

【怎么操作】
· 拖动 = 旋转   · 滚轮 = 缩放   · 双击 = 复位
· 上方 4 个按钮 = 机位
· 下方 19 个按钮 = 真实播放的动作

右上角会显示「已加载 20 个片段」。若显示「⚠ 画面空白（贴图被拦）」就是没加载成功。

【为什么文件这么大 / 为什么不用 clips 文件夹】
浏览器有一条安全规则：双击打开的本地网页（file://）里，
从同一目录读到的 <video> 会被当成"跨源数据"，贴到 WebGL 上直接抛 SecurityError，
画面就是空白 —— 路径怎么写都没用。本项目 game-src/probe-taint.mjs 专门验过：
  video + 相对路径 → SecurityError
  video + data:    → ok
  video + blob:    → ok
  fetch 本地文件    → Failed to fetch（所以运行时读文件也不行）
唯一稳的办法就是内联。所以这个 HTML 里塞了 11 MB 的 base64，打开时转成 blob 喂给 video。

【这套立绘是什么】
2D 精灵图，来自 claudia-pet（github.com/kirito1207/claudia-pet）：
原图 8 列 × 15 行、每帧 640×360、带透明通道，每个动作 120 帧。
本项目转成 VP9 + alpha 的 webm，接入方式与原有小蓝鱼立绘一致。

来源与授权：
· 精灵图作者 hunmer（github.com/hunmer/aboutme-pets 的 pets/claude）
· 授权 CC BY-NC-SA 4.0，作者 2026-11-05 在 aboutme-pets#1 书面授权
· 经 claudia-pet 原样收录；本项目只改格式，不改绘制内容

【重新生成】
在 D:\\Documents\\大肥鱼书房 下：
    node game-src/pack-desktop.mjs
下载更多动作（147 个全量，约 280 MB 源图）：
    node game-src/fetch-claudia-clips.mjs --all
`;
  await writeFile(path.join(OUT, '说明.txt'), README, 'utf8');
  console.log('说明.txt');
  console.log(`\n完成 → ${OUT}`);
}

main().catch((err) => {
  console.error('[pack-desktop] 失败', err);
  process.exit(1);
});
