// 把造型预览打成「一个 HTML，双击就能开」的完全自包含文件。
//
// 为什么必须打包：
//   file:// 页面的 ES module 会被 CORS 拦掉（origin 是 "null"），
//   `import * as THREE from './vendor/three.module.js'` 直接失败，
//   控制台只会给一句看不出原因的 "Failed to load module script"。
//   把 three.js + claude-actor.js + 预览外壳全打成一份 IIFE 塞进 HTML，
//   就没有任何外部请求，双击即开。
//
//   node game-src/pack-preview.mjs              输出到桌面
//   node game-src/pack-preview.mjs --out DIR    指定目录
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOM = path.join(ROOT, 'public', 'room');

const outIdx = process.argv.indexOf('--out');
const OUT_DIR = outIdx > 0 ? path.resolve(process.argv[outIdx + 1])
  : path.join(process.env.USERPROFILE || ROOT, 'Desktop', '小公主造型预览');

// 预览外壳：和 public/room/preview-claude.html 同一套逻辑，但改成
// 「先加载打包好的 bundle，再由它自己建立场景」。
const SHELL = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude 小公主 · 造型预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #f6efe1; overflow: hidden; }
  canvas { display: block; }
  #bar {
    position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px 12px;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    font: 12px/1.5 "PingFang SC","Microsoft YaHei",sans-serif; color: #5b4a3a;
    background: linear-gradient(to top, rgba(246,239,225,.96), rgba(246,239,225,0));
  }
  #bar button {
    font: inherit; padding: 5px 12px; border-radius: 7px; cursor: pointer;
    border: 1px solid #d9cbb5; background: #fffdf8; color: #3a2f26;
  }
  #bar button:hover { background: #f2e9d8; }
  #bar button.on { background: #d2714a; border-color: #d2714a; color: #fff; }
  #hint { position: fixed; left: 16px; top: 14px; font: 12px/1.7 "PingFang SC",sans-serif; color: #8a7560; }
  #hint b { color: #3a2f26; font-weight: 600; }
</style>
</head>
<body>
<div id="hint">
  <b>拖动</b> 旋转 · <b>滚轮</b> 缩放 · <b>双击</b> 复位<br>
  下方按钮切换机位 / 表情 / 手势
</div>
<div id="bar"></div>
<script>/*__BUNDLE__*/</script>
</body>
</html>`;

// 打包入口：把 three 与 actor 一起编成 IIFE，并把预览逻辑写在同一个文件里。
const ENTRY = `
import * as THREE from './vendor/three.module.js';
import { ClaudeActor } from './claude-actor.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearAlpha(0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 60);

const key = new THREE.DirectionalLight(0xfff1dd, 2.1);
key.position.set(2.4, 3.6, 3.2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 14;
key.shadow.bias = -0.002;
scene.add(key);
const fill = new THREE.DirectionalLight(0xd8e6ff, 0.55);
fill.position.set(-3, 1.6, 1.4);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffd9b8, 0.7);
rim.position.set(-1.2, 2.2, -3.4);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c8b2, 0.85));

const ground = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.18 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const actor = new ClaudeActor(scene);
actor.setVisible(true);
// 必须显式给一次位姿：ClaudeActor 的 group 初始位置在场景原点，
// 但不调 setPose 的话 update() 里没有目标点，角色会被留在原地或被阴影盖住。
actor.setPose({ pos: [0, 0], elev: 0, pose: 'stand', kind: 'idle', walking: false, facing: 0 });

// ── 机位状态 ──────────────────────────────────────────────
const VIEW = { yaw: 0, pitch: 4, dist: 2.45, ty: 0.95, fov: 32 };
function applyCamera() {
  camera.fov = VIEW.fov;
  camera.updateProjectionMatrix();
  const yaw = VIEW.yaw * Math.PI / 180;
  const pitch = VIEW.pitch * Math.PI / 180;
  const look = new THREE.Vector3(0, VIEW.ty, 0);
  camera.position.set(Math.sin(yaw) * VIEW.dist, VIEW.ty + Math.sin(pitch) * VIEW.dist, Math.cos(yaw) * VIEW.dist);
  camera.lookAt(look);
}
applyCamera();

// ── 鼠标交互 ──────────────────────────────────────────────
let dragging = false; let lastX = 0; let lastY = 0;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup', (e) => { dragging = false; try { cv.releasePointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  VIEW.yaw += (e.clientX - lastX) * 0.42;
  VIEW.pitch = Math.max(-40, Math.min(60, VIEW.pitch - (e.clientY - lastY) * 0.30));
  lastX = e.clientX; lastY = e.clientY;
  applyCamera();
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  VIEW.dist = Math.max(0.55, Math.min(6, VIEW.dist * (1 + Math.sign(e.deltaY) * 0.09)));
  applyCamera();
}, { passive: false });
cv.addEventListener('dblclick', () => { VIEW.yaw = 0; VIEW.pitch = 4; VIEW.dist = 2.45; VIEW.ty = 0.95; VIEW.fov = 32; applyCamera(); });

// ── 控制条 ────────────────────────────────────────────────
const PRESETS = [
  ['正面', { yaw: 0, pitch: 4, dist: 2.45, ty: 0.95, fov: 32 }],
  ['侧面', { yaw: 90, pitch: 4, dist: 2.45, ty: 0.95, fov: 32 }],
  ['背面', { yaw: 180, pitch: 6, dist: 2.45, ty: 0.95, fov: 32 }],
  ['放大头', { yaw: 6, pitch: 2, dist: 0.62, ty: 1.12, fov: 26 }],
  ['放大裙', { yaw: 12, pitch: -4, dist: 1.5, ty: 0.62, fov: 34 }],
];
const FACES = [['常态', 'idle'], ['开心', 'happy'], ['害羞', 'shy'], ['困', 'sleep']];
const GESTURES = [['收裙', 'curtsy'], ['招手', 'wave'], ['看书', 'read'], ['看星', 'star'], ['端茶', 'tea']];

const bar = document.getElementById('bar');
function mkBtn(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', onClick);
  bar.appendChild(b);
  return b;
}
PRESETS.forEach(([label, v], i) => {
  const b = mkBtn(label, () => {
    Object.assign(VIEW, v);
    applyCamera();
    bar.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  });
  if (i === 0) b.classList.add('on');
});
mkBtn('　', () => {});
FACES.forEach(([label, name]) => mkBtn(label, () => actor.setFace(name)));
mkBtn('　', () => {});
GESTURES.forEach(([label, name]) => mkBtn(label, () => actor.playGesture(name)));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  actor.update(dt, camera, { mode: 'overview', lookAtCamera: false });
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
`;

async function main() {
  const entryPath = path.join(ROOM, '__preview-entry.js');
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
      loader: { '.js': 'js' },
    });
    code = res.outputFiles[0].text;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(entryPath, { force: true });
  }

  const html = SHELL.replace('/*__BUNDLE__*/', () => code);
  await mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, '造型预览.html');
  await writeFile(target, html, 'utf8');
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`已生成 ${target}  (${kb} KB，单文件，双击即开)`);

  // 顺手把参考立绘和我的对比图一起放过去，方便对着看
  const shots = path.join(ROOT, 'game-shots');
  const copies = [
    ['try-a.png', '参考立绘.png'],
    ['cmp-body.png', '对比-全身.png'],
    ['cmp-head.png', '对比-头部.png'],
  ];
  for (const [from, to] of copies) {
    const src = path.join(shots, from);
    if (existsSync(src)) {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(src, path.join(OUT_DIR, to));
      console.log(`  附带 ${to}`);
    }
  }
}

main().catch((err) => {
  console.error('[pack-preview] 失败', err);
  process.exit(1);
});
