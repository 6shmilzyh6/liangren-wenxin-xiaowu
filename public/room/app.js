// 两人温馨小屋 —— 页面表现层。
// 事实/行为在 src/home-state.js；这里只读快照、画房间、处理相机与交互。
import * as THREE from './vendor/three.module.js';
import { createWorld } from './world.js';
import { SpriteActor, CLIPS, CLIP_LABELS, CLIP_GROUPS, CLIP_UNLOCKS } from './actor.js';
import { createGardenClient } from './garden-client.js';
import { createGardenWorld } from './garden-world.js';
import { getGardenFraming } from './garden-camera.js';
// 图标从 emoji 换成内联 SVG：按钮上同时有图标和文字，textContent 会把图标抹掉，
// 所以凡是「图标 + 文字」的按钮统一改用 setIconLabel。
import { setIconLabel, iconSvg } from './icons.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') === '1';
const SHOT_VIEW = params.get('shotView') || (params.get('pov') === '1' ? 'eyes' : 'overview');
const SHOT_LOOK = params.get('shotLook') || 'forward';
const INITIAL_CAM = params.get('cam');
const INITIAL_ROOM = params.get('room');
const TOKEN = params.get('token') || '';
const isTouch = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const tier = params.get('q') || (isTouch ? 'low' : 'balanced');

// 有些云端工作区把端口映射到 https://host/proxy/13100/… 这种带路径前缀的 URL。
// 页面资源是相对路径，天然能跟上；API 是绝对路径，需要把前缀补回去。
const BASE_PATH = (() => {
  const i = location.pathname.indexOf('/room/');
  return i > 0 ? location.pathname.slice(0, i) : '';
})();
const api = (path) => {
  const u = new URL(BASE_PATH && path.startsWith('/') ? BASE_PATH + path : path, location.origin);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  return u.toString();
};
const withToken = api;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ── 操控手感调参表 ────────────────────────────────────────────────────────
// 所有「点得准不准、跟不跟手」的魔法数字都收在这里，之后做设置项直接改这几个字段。
// 单位：像素（tap*/char*/longPressCancelPx）、毫秒（longPressMs）、
//       米（footClearance/predictMaxLag）、秒（predictTau）、条（queueLimit）。
const MOVE_TUNING = {
  // 轻点判定：净位移（按下点到抬起的欧氏距离）小于阈值才算点击。
  tapSlopMouse: 5,
  tapSlopTouch: 12,
  // 第二道门槛：累计路程。手抖画个圈又回到原点，净位移很小但路程很大，靠这个拦住。
  tapPathMouse: 10,
  tapPathTouch: 26,
  // 角色命中半径（屏幕像素，量到身体腰部/头部两个探针取最小值）。
  charHitRadiusMouse: 58,
  charHitRadiusTouch: 80,
  // 落点离她脚底不足这个距离时，沿点击方向外推，避免「原地踏步」的空请求。
  footClearance: 0.4,
  // 长按拖角色。
  longPressMs: 330,
  longPressCancelPx: 8,
  // 预测残差：corr *= exp(-dt / predictTau)，单次残差上限 predictMaxLag 米。
  predictTau: 0.45,
  predictMaxLag: 1.6,
  // 动作队列：最多排 3 条，同种 go 合并成最新落点，超员丢最旧的。
  queueLimit: 3,
  coalesceGo: true
};

// ── 两位操作者 ────────────────────────────────────────────────────────────
// 异地共同经营时，两个人各自开自己的浏览器：让每人给自己起个名字，动作事件里带上
// 是谁做的，另一个人就能在「刚刚发生」里看到「访客 A 让她去书桌前」。
// 名字只存在本机 localStorage，不上传、不做账号，换台电脑就是另一位访客。
const ACTOR_KEY = 'home-actor-name';
// 和 game-src/shell/identity.js 共用同一个键：进门时菜单已经强制定过名字，
// 这里改名也要把「定过了」的标记一起写，否则下次开门又会被拦一次。
const ACTOR_SET_KEY = 'dafiyu-name-set';
function actorName() {
  try { return localStorage.getItem(ACTOR_KEY) || ''; } catch { return ''; }
}
function setActorName(name) {
  const v = String(name || '').trim().slice(0, 12);
  try {
    if (v) {
      localStorage.setItem(ACTOR_KEY, v);
      localStorage.setItem(ACTOR_SET_KEY, '1');
    } else {
      localStorage.removeItem(ACTOR_KEY);
      localStorage.removeItem(ACTOR_SET_KEY);
    }
  } catch { /* 忽略 */ }
  return v;
}
const actorTag = () => actorName() || '小屋访客';

// 客户端沿服务端给的路点前进：快照每 1.2 秒才来一次，靠它做插值，
// 出发那一刻就能连续移动，不再等下一次轮询。
function advanceRoute(points, start, distance) {
  if (!Array.isArray(points) || points.length < 2) return start;
  let idx = 0;
  let best = Infinity;
  // Choose the current segment, not the nearest waypoint. After a segment's
  // midpoint, nearest-waypoint prediction would skip the next corner and cut
  // through a wall or raised bed before the next server snapshot arrives.
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
    const t = len2 ? clamp(((start[0] - a[0]) * dx + (start[1] - a[1]) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(a[0] + dx * t - start[0], a[1] + dz * t - start[1]);
    if (d < best) { best = d; idx = i; }
  }
  let pos = [start[0], start[1]];
  let left = Math.max(0, distance);
  for (let i = idx + 1; i < points.length; i += 1) {
    const nx = points[i][0];
    const nz = points[i][1];
    const seg = Math.hypot(nx - pos[0], nz - pos[1]);
    if (seg < 1e-6) continue;
    if (left <= seg) {
      const t = left / seg;
      return [pos[0] + (nx - pos[0]) * t, pos[1] + (nz - pos[1]) * t];
    }
    left -= seg;
    pos = [nx, nz];
  }
  return pos;
}

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, tier === 'low' ? 1 : 1.35));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = tier !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;
if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;

const world = createWorld(renderer, { quality: tier });

// ── 电视投屏（浏览器标签页 → 电视纹理）───────────────────────────────────
// 抖音网页不能可靠地 iframe 进 3D 画布；这里用用户主动选择的屏幕共享流做实时纹理，
// 选「抖音标签页」后，原标签页里滚动/刷视频，房间电视同步显示。
let tvStream = null;
let tvTexture = null;
let tvVideoEl = null;
const tvMat = world.tvScreen?.material || null;
const tvOriginalMap = tvMat?.map || null;
const tvOriginalEmissiveMap = tvMat?.emissiveMap || null;
const tvOriginalEmissiveIntensity = tvMat?.emissiveIntensity ?? 0.55;

// ── 书房投屏（浏览器标签页 → 书房屏纹理）─────────────────────────────────
// 和电视投屏同一套流程：getDisplayMedia 拿屏幕流，VideoTexture 贴到书房显示器。
// 投屏时她会自动去书房沙发旁坐好，并周期性说一句观后感。
let studyStream = null;
let studyTexture = null;
let studyVideoEl = null;
const studyMat = world.studyScreen?.material || null;
const studyOriginalMap = studyMat?.map || null;
const studyOriginalEmissiveMap = studyMat?.emissiveMap || null;
const studyOriginalEmissiveIntensity = studyMat?.emissiveIntensity ?? 0.12;
let studyOpinionBusy = false;
let studyOpinionTimer = 0;
let studyFollowOn = false;

// 投屏控制扩展：页面只发命令，真正的鼠标事件由本机 Chrome/Edge 扩展转发到抖音标签页。
let tvControlOn = false;
let tvFollowOn = false;
let tvCompanionSize = Math.max(160, Math.min(520, Number(localStorage.getItem('home-tv-companion-size')) || 320));
let tvBubbleOn = localStorage.getItem('home-tv-bubble') === '1';
let tvOpinionBusy = false;
let tvOpinionTimer = 0;
let tvOpinionWarmup = 0;
let tvBubbleTimer = 0;
let tvExtensionReady = false;
let tvCommandSeq = 0;
const tvCommandWaiters = new Map();
let tvLastMoveAt = 0;
let tvPointerStart = null;

function tvExtensionPost(data) {
  window.postMessage({ source: 'dafiyu-tv-page', ...data }, '*');
}
function sendTvCommand(action, payload = {}) {
  if (!tvStream) return Promise.reject(new Error('先打开电视投屏'));
  if (!tvExtensionReady) return Promise.reject(new Error('没有检测到投屏控制扩展；请安装 extensions/douyin-control'));
  const id = `tv-${Date.now()}-${++tvCommandSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tvCommandWaiters.delete(id);
      reject(new Error('抖音标签页没有响应，请确认它已打开'));
    }, 3000);
    tvCommandWaiters.set(id, { resolve, reject, timer });
    tvExtensionPost({ type: 'command', id, action, payload });
  });
}
function applyTvControlPref() {
  const overlay = $('tvOverlay');
  const button = $('tvControlBtn');
  if (overlay) overlay.classList.toggle('control', tvControlOn && !!tvStream);
  if (button) {
    button.classList.toggle('active', tvControlOn && !!tvStream);
    button.textContent = tvControlOn && !!tvStream ? '控制中' : '控制';
    button.title = tvExtensionReady
      ? '在电视画面上移动/点击/滚动，把鼠标操作转发到抖音标签页'
      : '需要安装扩展 extensions/douyin-control';
  }
}
function applyTvFollow() {
  const box = $('tvCompanion');
  const video = $('tvCompanionVideo');
  const button = $('tvFollowBtn');
  const on = !!tvFollowOn && !!tvStream;
  if (box) {
    box.classList.toggle('on', on);
    box.setAttribute('aria-hidden', String(!on));
  }
  if (video) {
    if (on) video.play().catch(() => {});
    else { try { video.pause(); } catch {} }
  }
  if (button) {
    button.classList.toggle('active', on);
    button.textContent = on ? '跟随中' : '跟随一起看';
    button.setAttribute('aria-pressed', String(on));
  }
  if (!on) hideTvCompanionBubble();
  syncTvOpinionTimer();
}

function applyTvCompanionSize() {
  const box = $('tvCompanion');
  const input = $('tvCompanionSize');
  tvCompanionSize = Math.max(160, Math.min(520, Number(tvCompanionSize) || 320));
  if (box) box.style.setProperty('--tv-companion-size', `${tvCompanionSize}px`);
  if (input && Number(input.value) !== tvCompanionSize) input.value = String(tvCompanionSize);
}
function applyTvBubblePref() {
  const button = $('tvCompanionBubbleBtn');
  if (button) {
    button.classList.toggle('active', tvBubbleOn);
    button.textContent = tvBubbleOn ? '气泡 开' : '气泡 关';
    button.setAttribute('aria-pressed', String(tvBubbleOn));
  }
  if (!tvBubbleOn) hideTvCompanionBubble();
}
function hideTvCompanionBubble() {
  const bubble = $('tvCompanionBubble');
  if (bubble) bubble.hidden = true;
  if (tvBubbleTimer) { clearTimeout(tvBubbleTimer); tvBubbleTimer = 0; }
}
function showTvCompanionBubble(text) {
  if (!tvBubbleOn || !tvFollowOn || !text) return;
  const bubble = $('tvCompanionBubble');
  if (!bubble) return;
  bubble.textContent = String(text).trim().slice(0, 260);
  bubble.hidden = false;
  if (tvBubbleTimer) clearTimeout(tvBubbleTimer);
  tvBubbleTimer = setTimeout(() => { bubble.hidden = true; tvBubbleTimer = 0; }, 14_000);
}
function captureTvFrame() {
  const video = ($('tvOverlayVideo')?.videoWidth ? $('tvOverlayVideo') : tvVideoEl);
  if (!video || !video.videoWidth || video.readyState < 2) return '';
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { return ''; }
  return canvas.toDataURL('image/jpeg', 0.82);
}
function captureStudyFrame() {
  const video = studyVideoEl;
  if (!video || !video.videoWidth || video.readyState < 2) return '';
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { return ''; }
  return canvas.toDataURL('image/jpeg', 0.82);
}
async function requestTvOpinion(manual = false, opening = false) {
  if (tvOpinionBusy) return;
  if (!tvStream || !tvFollowOn) { if (manual) toast(!tvStream ? '先打开电视投屏' : '先让她跟随一起看'); return; }
  if (!manual && document.hidden) return;
  const image = captureTvFrame();
  if (!image) { if (manual) toast('电视画面还没准备好'); return; }
  tvOpinionBusy = true;
  if (manual && tvBubbleOn) showTvCompanionBubble('……让我看看。');
  try {
    const response = await fetch(api('/api/tv/opinion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, opening, target: followTarget })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    const reply = String(data.reply || '').trim();
    if (!reply) throw new Error('她没说出看法');
    const lines = Array.isArray(data.lines) && data.lines.length ? data.lines : [reply];
    if (opening && lines.length > 1) {
      // 开场白是她主动开口 —— 气泡关着的话玩家什么都听不到，那就白说了。
      // 所以开场前先把气泡打开（她自己开口算一次例外，之后玩家关掉就不再动它）。
      if (!tvBubbleOn) { tvBubbleOn = true; applyTvBubblePref(); }
      // 一句一句上，像真的边看边说；同一句也进「一起看」那条聊天，能翻回去。
      lines.forEach((line, i) => {
        setTimeout(() => {
          showTvCompanionBubble(line);
          addRoomChat('tv', line, true);
        }, i * 2200);
      });
    } else {
      showTvCompanionBubble(reply);
      if (opening) addRoomChat('tv', reply, true);
      if (manual && !tvBubbleOn) toast(`她：${reply.slice(0, 90)}`);
    }
  } catch (error) {
    if (manual) toast(`她没看清：${error?.message || error}`);
  } finally {
    tvOpinionBusy = false;
  }
}
function syncTvOpinionTimer() {
  if (tvOpinionTimer) { clearInterval(tvOpinionTimer); tvOpinionTimer = 0; }
  if (tvOpinionWarmup) { clearTimeout(tvOpinionWarmup); tvOpinionWarmup = 0; }
  if (!tvFollowOn || !tvStream) return;
  // 只在开播时说一次开场白。以前这里每 60 秒调一次模型，
  // 一场两小时投屏要 120 次调用，而且大部分是「这画面真有意思」这种空话。
  tvOpinionWarmup = setTimeout(() => { tvOpinionWarmup = 0; requestTvOpinion(false, true); }, 2200);
}

async function takeHerToTv() {
  try {
    if (state?.her?.asleep) {
      await act('wake');
      setTimeout(() => { act('command', { room: 'living', spot: 'tv' }); }, 500);
    } else {
      act('command', { room: 'living', spot: 'tv' });
    }
  } catch { /* 状态轮询会继续；不阻断陪伴层 */ }
}

// ── 书房投屏 ─────────────────────────────────────────────────────────────
function showStudyBubble(text) {
  if (!text) return;
  setBubble(text, 14000);
}

async function requestStudyOpinion(manual = false) {
  if (studyOpinionBusy) return;
  if (!studyStream) { if (manual) toast('先打开书房投屏'); return; }
  if (!manual && document.hidden) return;
  const image = captureStudyFrame();
  if (!image) { if (manual) toast('书房屏幕还没准备好'); return; }
  studyOpinionBusy = true;
  if (manual) showStudyBubble('……让我看看你屏幕上有什么。');
  try {
    const response = await fetch(api('/api/tv/opinion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, study: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    const reply = String(data.reply || '').trim();
    if (!reply) throw new Error('她没说出看法');
    showStudyBubble(reply);
    if (manual) toast(`她：${reply.slice(0, 90)}`);
  } catch (error) {
    if (manual) toast(`她没看清：${error?.message || error}`);
  } finally {
    studyOpinionBusy = false;
  }
}

function syncStudyOpinionTimer() {
  if (studyOpinionTimer) { clearInterval(studyOpinionTimer); studyOpinionTimer = 0; }
  if (!studyStream) return;
  studyOpinionTimer = setInterval(() => requestStudyOpinion(false), 60_000);
}

async function takeHerToStudy() {
  try {
    if (state?.her?.asleep) {
      await act('wake');
      await new Promise((r) => setTimeout(r, 600));
    }
    await act('command', { room: 'study', spot: 'sofa' });
  } catch { /* 状态轮询会继续；不阻断陪伴层 */ }
}

function applyStudyChip() {
  const chip = $('studyChip');
  if (!chip) return;
  const on = !!studyStream;
  chip.classList.toggle('active', on);
  chip.setAttribute('aria-pressed', String(on));
  const stateEl = $('studyState');
  if (stateEl) stateEl.textContent = on ? '投屏中' : '投屏';
  const bar = $('studyBar');
  if (bar) bar.hidden = !on;
  if (!on) {
    studyFollowOn = false;
    if (studyOpinionTimer) { clearInterval(studyOpinionTimer); studyOpinionTimer = 0; }
  }
}

function stopStudyCast(message) {
  if (GAME.running) {
    GAME.stop();
    const btn = $('studyGameBtn');
    if (btn) setIconLabel(btn, 'game', '小游戏');
  }
  if (studyStream) {
    const stream = studyStream;
    studyStream = null;
    try { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); } catch {}
  }
  if (studyVideoEl) {
    try { studyVideoEl.pause(); } catch {}
    try { studyVideoEl.srcObject = null; } catch {}
    try { studyVideoEl.remove(); } catch {}
    studyVideoEl = null;
  }
  if (studyOpinionTimer) { clearTimeout(studyOpinionTimer); studyOpinionTimer = 0; }
  if (studyTexture) {
    try { studyTexture.dispose(); } catch {}
    studyTexture = null;
  }
  if (studyMat) {
    studyMat.map = studyOriginalMap;
    studyMat.emissiveMap = studyOriginalEmissiveMap;
    studyMat.emissiveIntensity = studyOriginalEmissiveIntensity;
    studyMat.needsUpdate = true;
  }
  studyFollowOn = false;
  applyStudyChip();
  if (message) toast(message);
}

async function startStudyCast() {
  if (studyStream) return;
  if (!studyMat) { toast('书房屏幕还没准备好，等房间加载完再点'); return; }
  const reason = tvCastUnavailableReason();
  if (reason) { toast(reason); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
    if (!stream) return;
    studyStream = stream;
    studyVideoEl = document.createElement('video');
    studyVideoEl.muted = true;
    studyVideoEl.playsInline = true;
    studyVideoEl.autoplay = true;
    studyVideoEl.srcObject = stream;
    studyVideoEl.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(studyVideoEl);
    studyVideoEl.play().catch(() => { /* 静音的 MediaStream 一般能自动播放 */ });
    studyTexture = new THREE.VideoTexture(studyVideoEl);
    studyTexture.colorSpace = THREE.SRGBColorSpace;
    studyTexture.minFilter = THREE.LinearFilter;
    studyTexture.magFilter = THREE.LinearFilter;
    studyTexture.generateMipmaps = false;
    studyMat.map = studyTexture;
    studyMat.emissiveMap = studyTexture;
    studyMat.emissiveIntensity = 0.95;
    studyMat.needsUpdate = true;
    const track = stream.getVideoTracks?.()[0];
    if (track) track.addEventListener('ended', () => stopStudyCast('书房投屏已结束'), { once: true });
    studyFollowOn = true;
    applyStudyChip();
    syncStudyOpinionTimer();
    void takeHerToStudy();
    toast('已投到书房屏幕：小蓝鱼会到书房沙发旁坐好陪你');
  } catch (error) {
    const name = String(error?.name || '');
    if (name === 'NotAllowedError' || name === 'AbortError') {
      stopStudyCast();
      toast('投屏已取消：你没有选择标签页，或浏览器/系统权限拦截了屏幕共享。请点允许后重试。');
      return;
    }
    if (name === 'NotFoundError') {
      stopStudyCast();
      toast('没有可共享的窗口：请打开一个窗口后再点投屏');
      return;
    }
    if (name === 'NotReadableError' || name === 'SecurityError' || name === 'NotSupportedError') {
      stopStudyCast();
      toast(`投屏被浏览器拦截（${name}）：请检查系统屏幕录制权限，或换桌面 Chrome/Edge`);
      return;
    }
    studyStream = null;
    stopStudyCast();
    toast(`投屏失败：${error?.message || name || '浏览器拒绝共享'}`);
  }
}

// ── 书架抽书 ─────────────────────────────────────────────────────────────
// icon 字段是 icons.js 里的图标 id，不再是 emoji：emoji 的画风由系统字体决定，
// 换了机器就换一套长相，跟纸/陶皮肤对不上。
const BOOKS = [
  { id: 'seashell', name: '《海边的小贝壳》', desc: '绘本 · 讲一只小贝壳找回家的路', icon: 'shell', cover: 'linear-gradient(160deg,#e0a44a,#a86a3c)', lines: ['从前，有一枚蓝色的小贝壳，住在浪花够得着的沙子里。', '每天涨潮的时候，海会来敲敲它，问它要不要去更远的地方。', '它说：再等等，我的月亮还没落下来。'] },
  { id: 'cloud', name: '《云朵邮局》', desc: '童话 · 云上有一家寄信的小邮局', icon: 'cloud', cover: 'linear-gradient(160deg,#8fadb0,#5a7679)', lines: ['云朵邮局的门口挂着一串风铃，风一吹，就掉下来几封没写地址的信。', '邮差是只打瞌睡的小海鸥，它把信折成小船，从天上放下去。', '收到信的人都说，信纸上有一股雨过天晴的味道。'] },
  { id: 'starfish', name: '《海星和五点钟》', desc: '短篇 · 五点钟的海星总爱迟到', icon: 'star', cover: 'linear-gradient(160deg,#d9a05a,#8a5e2e)', lines: ['海星先生总是迟到，因为它的五个角各有各的想法。', '一个角想去东边的礁石，一个角想去西边的食堂。', '等它们吵完，五点钟已经变成六点半了。'] },
  { id: 'lamp', name: '《灯》', desc: '散文 · 一盏路灯和晚归的人', icon: 'lamp', cover: 'linear-gradient(160deg,#d2714a,#7d3d26)', lines: ['巷口的路灯在六点四十分亮起来，比谁都准时。', '它数着每一个晚归的人：背书包的、拎菜的、打着电话的。', '数到最后一个，它就放心地把影子铺得又长又软。'] },
  { id: 'island', name: '《一个人的小岛》', desc: '随笔 · 关于发呆和看海', icon: 'island', cover: 'linear-gradient(160deg,#9caf95,#5b6b52)', lines: ['小岛上只有一张椅子，面朝大海，椅子腿有点生锈。', '坐上去的人都不说话，因为海已经把想说的都说了。', '坐够了就站起来，把剩下的下午还给海浪。'] }
];

let bookBusy = false;
function openBookPanel() {
  const panel = $('bookPanel');
  const list = $('bookList');
  if (!panel || !list) return;
  list.innerHTML = '';
  for (const book of BOOKS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'book-item';
    item.innerHTML = `<span class="book-cover" style="background:${book.cover}">${iconSvg(book.icon || 'leaf')}</span><span><b>${book.name}</b><span>${book.desc}</span></span><i>${bookBusy ? '阅读中…' : '抽这本'}</i>`;
    item.disabled = bookBusy;
    item.addEventListener('click', () => pickBook(book));
    list.appendChild(item);
  }
  panel.classList.remove('hide');
}
function closeBookPanel() {
  $('bookPanel')?.classList.add('hide');
}
$('bookClose')?.addEventListener('click', closeBookPanel);

async function pickBook(book) {
  if (bookBusy) return;
  if (!book) return;
  bookBusy = true;
  closeBookPanel();
  $('info').classList.add('hide');
  setBubble('我看看这本……好像挺有意思的。', 4200);
  try {
    // 睡着先叫醒，再把她叫到书架前；之后让她抱着书去阅读角坐好。
    if (state?.her?.asleep) {
      await act('wake');
      await new Promise((r) => setTimeout(r, 600));
    }
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'command', room: 'study', spot: 'shelf' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    // 走过去的路上就开始“抽书”台词；到达后轮询 spot 再坐阅读角。
    setTimeout(() => {
      setBubble(`她踮起脚，从书架上抽出了${book.name}。`, 4800);
    }, 900);
    setTimeout(async () => {
      try {
        await fetch(withToken('/api/home/act'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'command', room: 'study', spot: 'sofa' })
        });
      } catch { /* 走不到也不打断念书 */ }
    }, 2200);
    // 三段内容，按阅读节奏分三次气泡，最后一段读完收尾。
    const total = book.lines.length;
    for (let i = 0; i < total; i++) {
      setTimeout(() => {
        const isLast = i === total - 1;
        setBubble(isLast ? `${book.lines[i]} —— 念完了，还挺好看的。` : book.lines[i], isLast ? 8200 : 6500);
        if (i === Math.min(1, total - 1)) playPetAction('idle_hum', '她抱着书，小声念起来');
        if (isLast) {
          setBubble(`合上${book.name}，她把它放回手边，抬头看你：还要再抽一本吗？`, 8000);
        }
      }, 2600 + i * 7000);
    }
  } catch (error) {
    toast(`没抽成：${error.message}`);
  } finally {
    setTimeout(() => {
      bookBusy = false;
      // 念完自动把书架面板再打开，方便直接抽下一本。
      openBookPanel();
    }, 2600 + book.lines.length * 7000);
  }
}

// ── 打砖块小游戏（书房屏）────────────────────────────────────────────────
const GAME = (() => {
  const W = 480, H = 296;
  const ROWS = 5, COLS = 9;
  // 砖块配色跟着纸/陶皮肤走：陶土、赤陶、赭黄、水青、草绿。
  const colors = ['#d2714a', '#e0a44a', '#6d8b8e', '#6f8468', '#c0ad93'];
  let canvas = null, ctx = null;
  let raf = 0;
  let last = 0;
  let gs = null; // { paddleX, ball, bricks, score, lives, over, won }
  let texture = null;
  let running = false;
  let lastCheer = 0; // 分数里程碑
  let padBound = false;

  function newState() {
    const bricks = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) bricks.push({ r, c, alive: true, color: colors[r % colors.length] });
    }
    return {
      paddleX: W / 2, ball: { x: W / 2, y: H - 44, vx: 2.4, vy: -3.2 }, bricks,
      score: 0, lives: 3, over: false, won: false
    };
  }
  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      ctx = canvas.getContext('2d');
    }
    return ctx;
  }
  function padPointer(e) {
    if (!running || !gs || gs.over) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    gs.paddleX = x * W;
  }
  function bindPad() {
    const pad = $('gamePad');
    if (!pad || padBound) return;
    padBound = true;
    pad.addEventListener('pointermove', padPointer);
    pad.addEventListener('pointerdown', padPointer);
  }
  function tick(now) {
    if (!running) return;
    const s = gs;
    if (!s) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    if (s.over || s.won) {
      // 结束帧继续画，等外部关掉；暂停球，画面保持。
      draw();
      raf = requestAnimationFrame(tick);
      return;
    }
    s.ball.x += s.ball.vx * dt * 60;
    s.ball.y += s.ball.vy * dt * 60;
    if (s.ball.x < 6 || s.ball.x > W - 6) s.ball.vx *= -1;
    if (s.ball.y < 8) s.ball.vy = Math.abs(s.ball.vy);
    // 挡板（尺寸 74）
    const px = s.paddleX, half = 37;
    if (s.ball.y > H - 16 && s.ball.y < H - 8 && s.ball.x > px - half && s.ball.x < px + half) {
      const hit = clamp((s.ball.x - px) / half, -1, 1);
      const speed = Math.min(5.2, Math.hypot(s.ball.vx, s.ball.vy) + 0.12);
      const ang = hit * 0.9;
      s.ball.vx = Math.sin(ang) * speed;
      s.ball.vy = -Math.abs(Math.cos(ang) * speed);
      s.ball.y = H - 17;
      playTap?.();
    }
    // 砖块
    const bw = (W - 20) / COLS, bh = 15;
    for (const b of s.bricks) {
      if (!b.alive) continue;
      const bx = 10 + b.c * bw, by = 26 + b.r * (bh + 5);
      if (s.ball.x >= bx && s.ball.x <= bx + bw && s.ball.y >= by && s.ball.y <= by + bh) {
        b.alive = false;
        s.score += 10;
        s.ball.vy *= -1;
        onScore();
        if (s.bricks.every((x) => !x.alive)) { s.won = true; onEnd(true); }
        break;
      }
    }
    if (s.ball.y > H + 8) {
      s.lives -= 1;
      if (s.lives <= 0) { s.over = true; onEnd(false); }
      else { s.ball.x = W / 2; s.ball.y = H - 44; s.ball.vx = 2.4 * (Math.random() < 0.5 ? -1 : 1); s.ball.vy = -3.2; }
    }
    draw();
    raf = requestAnimationFrame(tick);
  }
  function onScore() {
    const s = gs;
    if (!s) return;
    if (s.score >= 120 && lastCheer < 120) { lastCheer = 120; setBubble('好耶！你已经打掉一大半了，再来再来！', 5000); }
    else if (s.score >= 250 && lastCheer < 250) { lastCheer = 250; setBubble('哇，你手好稳，这块砖墙要撑不住了。', 5000); }
    else if (s.score % 60 === 0 && s.score > 0) { setBubble(`已经 ${s.score} 分了，我在旁边给你计数呢。`, 4500); }
  }
  function onEnd(won) {
    if (won) {
      setBubble('通关啦！你把砖墙全打掉了，我请你吃小鱼干！', 9000);
      playPetAction?.('react_happy', '她高兴得直拍手');
    } else {
      setBubble('差一点点……手别抖，再来一局我陪你。', 8000);
      playPetAction?.('idle_look', '她有点替你可惜');
    }
  }
  function draw() {
    const s = gs;
    if (!ctx || !s) return;
    // 投屏进行中：把投屏画面当背景，游戏作为叠加层；否则纯色底。
    const castOn = !!studyStream && studyVideoEl && studyVideoEl.readyState >= 2;
    if (castOn) {
      try {
        ctx.drawImage(studyVideoEl, 0, 0, W, H);
        ctx.fillStyle = 'rgba(43,28,20,.46)';
        ctx.fillRect(0, 0, W, H);
      } catch {
        ctx.fillStyle = '#2b1c14';
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      ctx.fillStyle = '#2b1c14';
      ctx.fillRect(0, 0, W, H);
    }
    const bw = (W - 20) / COLS, bh = 15;
    for (const b of s.bricks) {
      if (!b.alive) continue;
      const bx = 10 + b.c * bw, by = 26 + b.r * (bh + 5);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw - 3, bh - 3, 3);
      ctx.fill();
    }
    ctx.fillStyle = '#f6f0e4';
    ctx.beginPath();
    ctx.roundRect(s.paddleX - 37, H - 12, 74, 7, 3.5);
    ctx.fill();
    ctx.fillStyle = '#fffaf3';
    ctx.beginPath();
    ctx.arc(s.ball.x, s.ball.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e0d5c1';
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`分数 ${s.score}`, 10, 18);
    ctx.textAlign = 'right';
    ctx.fillText(`球 ${s.lives}`, W - 10, 18);
    if (s.won) {
      ctx.fillStyle = 'rgba(111,132,104,.94)';
      ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('通关啦！', W / 2, H / 2);
    } else if (s.over) {
      ctx.fillStyle = 'rgba(210,113,74,.94)';
      ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('再来一局', W / 2, H / 2);
    }
    if (texture) texture.needsUpdate = true;
  }
  function start() {
    ensureCanvas();
    bindPad();
    if (!texture) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
    }
    const prevMap = studyMat?.map;
    const prevEmissive = studyMat?.emissiveMap;
    const prevIntensity = studyMat?.emissiveIntensity;
    gs = newState();
    lastCheer = 0;
    last = 0;
    running = true;
    raf = requestAnimationFrame(tick);
    if (studyMat) {
      studyMat.map = texture;
      studyMat.emissiveMap = texture;
      studyMat.emissiveIntensity = 0.9;
      studyMat.needsUpdate = true;
    }
    if (world.studyScreen) world._studyGameOn = true;
    const env = {
      hour: state?.hour ?? 14,
      lamp: state?.env?.lamp !== false,
      asleep: !!state?.her?.asleep,
      kind: state?.her?.kind || 'idle'
    };
    world.updateEnvironment?.(env);
    $('gamePad').hidden = false;
    // 记下进入游戏前的投屏状态，供 stop 恢复（投屏纹理可能正在使用）。
    GAME._prev = { map: prevMap, emissiveMap: prevEmissive, intensity: prevIntensity };
    setBubble('来打砖块！我把挡板交给你了，鼠标在下面动。', 6000);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    $('gamePad').hidden = true;
    if (world.studyScreen) world._studyGameOn = false;
    if (studyMat) {
      const prev = GAME._prev;
      const cast = !!studyStream;
      studyMat.map = cast ? studyTexture : (prev?.map ?? null);
      studyMat.emissiveMap = cast ? studyTexture : (prev?.emissiveMap ?? null);
      studyMat.emissiveIntensity = cast ? 0.95 : (prev?.intensity ?? 0.12);
      studyMat.needsUpdate = true;
    }
    const env = {
      hour: state?.hour ?? 14,
      lamp: state?.env?.lamp !== false,
      asleep: !!state?.her?.asleep,
      kind: state?.her?.kind || 'idle'
    };
    world.updateEnvironment?.(env);
    if (!studyStream) setBubble('不玩啦？那我把屏幕让出来了。', 5000);
  }
  function toggle() {
    if (running) stop();
    else start();
  }
  return { start, stop, toggle, get running() { return running; } };
})();

function tvContentPoint(e) {
  const video = $('tvOverlayVideo');
  if (!video) return { x: 0.5, y: 0.5 };
  const rect = video.getBoundingClientRect();
  const vw = Number(video.videoWidth) || rect.width || 1;
  const vh = Number(video.videoHeight) || rect.height || 1;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const contentW = vw * scale;
  const contentH = vh * scale;
  const left = rect.left + (rect.width - contentW) / 2;
  const top = rect.top + (rect.height - contentH) / 2;
  return {
    x: clamp((e.clientX - left) / contentW, 0, 1),
    y: clamp((e.clientY - top) / contentH, 0, 1)
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'dafiyu-tv-extension') return;
  if (event.data.type === 'ready') {
    tvExtensionReady = true;
    applyTvControlPref();
    return;
  }
  if (event.data.type !== 'result' || !event.data.id) return;
  const waiter = tvCommandWaiters.get(event.data.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  tvCommandWaiters.delete(event.data.id);
  if (event.data.ok === false) waiter.reject(new Error(event.data.error || '投屏控制失败'));
  else waiter.resolve(event.data);
});
// 扩展的 content script 可能比 app.js 晚，页面主动握手并重试两次。
tvExtensionPost({ type: 'ping' });
setTimeout(() => tvExtensionPost({ type: 'ping' }), 900);
setTimeout(() => tvExtensionPost({ type: 'ping' }), 2600);

function applyTvCastChip() {
  const chip = $('tvChip');
  if (!chip) return;
  const on = !!tvStream;
  chip.classList.toggle('active', on);
  chip.setAttribute('aria-pressed', String(on));
  const state = $('tvState');
  if (state) state.textContent = on ? '投屏中' : '投屏';
  const bar = $('tvBar');
  if (bar) bar.hidden = !on;
  if (!on) {
    tvControlOn = false;
    tvFollowOn = false;
    setTvOverlayMode('off');
  }
  applyTvControlPref();
  applyTvFollow();
}

function stopTvCast(message) {
  if (tvStream) {
    const stream = tvStream;
    tvStream = null;
    try { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); } catch {}
  }
  if (tvVideoEl) {
    try { tvVideoEl.pause(); } catch {}
    try { tvVideoEl.srcObject = null; } catch {}
    try { tvVideoEl.remove(); } catch {}
    tvVideoEl = null;
  }
  const overlayVideo = $('tvOverlayVideo');
  if (overlayVideo) {
    try { overlayVideo.pause(); } catch {}
    try { overlayVideo.srcObject = null; } catch {}
  }
  if (tvQuoteTimer) { clearTimeout(tvQuoteTimer); tvQuoteTimer = 0; }
  const quote = $('tvQuote');
  if (quote) quote.hidden = true;
  if (tvTexture) {
    try { tvTexture.dispose(); } catch {}
    tvTexture = null;
  }
  if (tvMat) {
    tvMat.map = tvOriginalMap;
    tvMat.emissiveMap = tvOriginalEmissiveMap;
    tvMat.emissiveIntensity = tvOriginalEmissiveIntensity;
    tvMat.needsUpdate = true;
  }
  tvControlOn = false;
  tvFollowOn = false;
  applyTvControlPref();
  applyTvFollow();
  applyTvCompanionSize();
applyTvBubblePref();
applyTvCastChip();
  if (message) toast(message);
}

function tvCastUnavailableReason() {
  if (!window.isSecureContext) {
    const where = location.host || location.protocol;
    return `投屏需要 HTTPS 或 localhost；当前是 ${where}。用局域网 IP 直接打开时浏览器不会弹共享窗口，请用 localhost/SSH 隧道或 HTTPS。`;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return '这个浏览器不支持投屏，请用桌面 Chrome / Edge，不要用手机内置浏览器';
  }
  return '';
}

async function startTvCast() {
  if (tvStream) return;
  if (!tvMat) { toast('电视屏幕还没准备好，等房间加载完再点'); return; }
  const reason = tvCastUnavailableReason();
  if (reason) { toast(reason); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
    if (!stream) return;
    tvStream = stream;
    tvVideoEl = document.createElement('video');
    tvVideoEl.muted = true;
    tvVideoEl.playsInline = true;
    tvVideoEl.autoplay = true;
    tvVideoEl.srcObject = stream;
    tvVideoEl.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(tvVideoEl);
    tvVideoEl.play().catch(() => { /* 静音的 MediaStream 一般能自动播放 */ });
    tvTexture = new THREE.VideoTexture(tvVideoEl);
    tvTexture.colorSpace = THREE.SRGBColorSpace;
    tvTexture.minFilter = THREE.LinearFilter;
    tvTexture.magFilter = THREE.LinearFilter;
    tvTexture.generateMipmaps = false;
    tvMat.map = tvTexture;
    tvMat.emissiveMap = tvTexture;
    tvMat.emissiveIntensity = 0.95;
    tvMat.needsUpdate = true;
    const overlayVideo = $('tvOverlayVideo');
    if (overlayVideo) {
      overlayVideo.srcObject = stream;
      overlayVideo.play().catch(() => { /* 用户已点击，静音视频通常可以播放 */ });
    }
    const track = stream.getVideoTracks?.()[0];
    if (track) track.addEventListener('ended', () => stopTvCast('电视投屏已结束'), { once: true });
    applyTvCastChip();
    toast('已投到电视：在原标签页里打开抖音并滚动，房间电视会同步');
  } catch (error) {
    const name = String(error?.name || '');
    if (name === 'NotAllowedError' || name === 'AbortError') {
      stopTvCast();
      toast('投屏已取消：你没有选择标签页，或浏览器/系统权限拦截了屏幕共享。请点允许后重试。');
      return;
    }
    if (name === 'NotFoundError') {
      stopTvCast();
      toast('没有可共享的窗口：请打开一个抖音标签页后再点投屏');
      return;
    }
    if (name === 'NotReadableError' || name === 'SecurityError' || name === 'NotSupportedError') {
      stopTvCast();
      toast(`投屏被浏览器拦截（${name}）：请检查系统屏幕录制权限、企业策略，或换桌面 Chrome/Edge`);
      return;
    }
    tvStream = null;
    stopTvCast();
    toast(`投屏失败：${error?.message || name || '浏览器拒绝共享'}`);
  }
}

const scene = world.scene;
let gardenController = null;

// 点击移动用的透明拾取面：放在所有地面装饰之上、家具之下。
const pickFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(21.0, 17.0),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
);
pickFloor.rotation.x = -Math.PI / 2;
pickFloor.position.set(7.5, 0.12, .6);
pickFloor.name = 'pick-floor';
pickFloor.renderOrder = -1;
scene.add(pickFloor);

const clickMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.17, 0.235, 36),
  new THREE.MeshBasicMaterial({ color: 0xe0a44a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
);
clickMarker.rotation.x = -Math.PI / 2;
clickMarker.position.set(6.6, 0.13, 4.5);
clickMarker.visible = false;
clickMarker.raycast = () => {}; // 不挡住下一次点击
scene.add(clickMarker);
let clickMarkerUntil = 0;

// 角色的统一外层：点击时对整只角色做 Q 弹/压扁，不碰地面阴影和相机。
const charWrap = new THREE.Group();
charWrap.name = 'char-wrap';
scene.add(charWrap);
let bounceAt = 0;

function bounceCharacter() {
  bounceAt = performance.now();
}

function updateBounce(now) {
  if (!bounceAt) return;
  const t = (now - bounceAt) / 420;
  if (t >= 1) {
    bounceAt = 0;
    charWrap.position.y = 0;
    charWrap.scale.set(1, 1, 1);
    return;
  }
  const e = Math.sin(t * Math.PI);
  // 只压 Y；X/Z 缩放会把角色按世界原点缩放，导致她横向漂移。
  charWrap.position.y = e * 0.055;
  charWrap.scale.set(1, 1 - e * 0.10, 1);
}
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.08, 120);

const actor = new SpriteActor(scene, {
  onEnded: () => { /* 由 syncActor 兜底 */ }
});
charWrap.add(actor.group);
let chibi = null;
let chibiReady = false;
let chibiLoading = null;
// 小公主：程序化 3D 小人，独立于小蓝鱼的立绘/模型切换，常驻加载。
let claude = null;
let claudeReady = false;
let claudeLoading = null;
// ── 两端身份：这一页是谁的屋子 ─────────────────────────────────────────────
// 异地共同经营时两个人各自开页面，用 ?as=her / ?as=claude 认门：
//   · 锁定后这一端只能指挥自己那位，切换按钮不再出现（两个人不抢手）
//   · 整页配色、字形、控件也跟着换，Claude 那边是暖陶纸，不是同一块深蓝玻璃
// 不写参数就是「房主端」：两边都能看能切。
const AS_PARAM = String(params.get('as') || '').toLowerCase();
// 这一端住哪一侧。'' = 没定（两端都能看能切），'her' / 'claude' = 定了这一侧。
// 进房时定一次；房内不能随手切，只能向对方申请交换身份（双方都同意才换）。
let SIDE = AS_PARAM === 'claude' ? 'claude' : AS_PARAM === 'her' ? 'her' : '';
// 主菜单里选的「你住哪一侧」由 main.js 放进 __homeSide；URL 参数优先。
if (!SIDE) {
  const chosen = String(globalThis.__homeSide || '');
  SIDE = chosen === 'claude' ? 'claude' : chosen === 'her' ? 'her' : '';
}
let SIDE_LOCKED = !!SIDE;

// 当前指挥对象：'her'=小蓝鱼，'claude'=小公主。动作/命令都发给它。
let followTarget = SIDE_LOCKED
  ? SIDE
  : (localStorage.getItem('home-follow-target') === 'claude' ? 'claude' : 'her');
let model3d = null;
let modelReady = false;
let modelLoading = null;
let modelQuality = 'optimized';
let modelSwitching = null;
const MODEL_URLS = Object.freeze({
  optimized: './assets/models/da-feiyu.opt.glb',
  source: './assets/models/da-feiyu.glb'
});
let charMode = localStorage.getItem('home-char-mode') === '3d' ? '3d' : 'webm';
if (params.get('char') === '3d') charMode = '3d';
const HIDE_HUD = params.get('hud') === '0';

// 成品模型优先；加载失败才退回程序化占位。默认（立绘）不加载 3D 模型。
// 两个画质档共用同一套 ModelActor，只换 GLB URL。
function ensureModel3d(quality = modelQuality) {
  if (modelReady && model3d && modelQuality === quality) return Promise.resolve(true);
  if (modelLoading) return modelLoading;
  modelLoading = import('./model-actor.js').then(async (mod) => {
    if (!mod?.ModelActor) return false;
    const url = MODEL_URLS[quality] || MODEL_URLS.optimized;
    const m = new mod.ModelActor(scene, { url, quality });
    charWrap.add(m.group);
    const ok = await m.load();
    if (!ok) { try { m.dispose(); } catch { /* 忽略 */ } return false; }
    const old = model3d;
    model3d = m;
    modelReady = true;
    modelQuality = quality;
    if (old) { try { old.dispose(); } catch { /* 忽略 */ } }
    return true;
  }).catch(() => false).finally(() => { modelLoading = null; });
  return modelLoading;
}
function ensureChibi() {
  if (chibiLoading) return chibiLoading;
  chibiLoading = import('./actor3d.js').then((mod) => {
    if (!mod?.ChibiActor) return false;
    chibi = new mod.ChibiActor(scene);
    charWrap.add(chibi.group);
    chibiReady = true;
    return true;
  }).catch(() => false);
  return chibiLoading;
}
// 小公主固定走 claudia-pet 的 147 段手绘精灵动画：画风与她本人的立绘一致，且有真动作。
// （试过 Hunyuan3D 图生模型，形体对但贴图与拓扑过不了验收，已放弃这条线。）
function ensureClaude() {
  if (claudeReady && claude) return Promise.resolve(true);
  if (claudeLoading) return claudeLoading;
  claudeLoading = import('./claude-actor.js').then((mod) => (mod?.ClaudeActor
    ? new mod.ClaudeActor(scene) : null)).then((inst) => {
    if (!inst) return false;
    const old = claude;
    claude = inst;
    claudeReady = true;
    if (old && old !== inst) { try { old.dispose(); } catch { /* 忽略 */ } }
    applyCharVisibility();
    return true;
  }).catch(() => false).finally(() => { claudeLoading = null; });
  return claudeLoading;
}
async function ensure3d(quality = modelQuality) {
  if (await ensureModel3d(quality)) return true;
  return ensureChibi();
}
function updateModelQualityChip(loading = false) {
  const button = $('modelQualityChip');
  const stateEl = $('modelQualityState');
  if (!button) return;
  const high = modelQuality === 'source';
  button.classList.toggle('active', high);
  button.setAttribute('aria-pressed', String(high));
  button.disabled = loading;
  button.title = high
    ? '当前：高画质 58.9 MB 原始模型；点击切回 6.7 MB 标准模型'
    : '当前：标准 6.7 MB；点击加载 58.9 MB 原始模型（首次较慢）';
  if (stateEl) stateEl.textContent = loading ? '加载中…' : high ? '高画质' : '标准';
}

async function switchModelQuality() {
  if (modelSwitching || modelLoading) return;
  const next = modelQuality === 'source' ? 'optimized' : 'source';
  const previousMode = charMode;
  const previousQuality = modelQuality;
  modelSwitching = next;
  updateModelQualityChip(true);
  toast(next === 'source'
    ? '正在加载 58.9 MB 原始模型，首次会比较久…'
    : '正在切回 6.7 MB 标准模型…');
  try {
    // 如果当前还在加载标准模型，等它结束后再加载目标档；不能误报成功。
    let ok = await ensureModel3d(next);
    if (ok && modelQuality !== next) ok = await ensureModel3d(next);
    if (!ok) {
      toast(next === 'source' ? '原始模型加载失败，继续用标准模型' : '模型切换失败');
      if (!modelReady && previousQuality === 'optimized') await ensureModel3d('optimized').catch(() => false);
      if (!modelReady) {
        charMode = previousMode;
        document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
      }
    } else {
      charMode = '3d';
      document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
      applySpriteViewPref();
      applyCharVisibility();
      syncCharacter();
      focusCharacter();
      toast(next === 'source' ? '已切换高画质：原始模型 58.9 MB' : '已切回标准画质：6.7 MB');
    }
  } catch (error) {
    toast(`模型切换失败：${error?.message || error}`);
  } finally {
    modelSwitching = null;
    updateModelQualityChip(false);
    applyCharVisibility();
  }
}

function use3dActive() { return charMode === '3d' && (modelReady || chibiReady); }
function applyCharVisibility() {
  const eyes = VIEW.mode === 'eyes';
  const use = use3dActive();
  actor.setVisible(!eyes && !use);
  model3d?.setVisible(!eyes && charMode === '3d' && modelReady);
  chibi?.setVisible(!eyes && charMode === '3d' && !modelReady && chibiReady);
  // 小公主永远显示（有她的快照时），不受立绘/3D 切换影响。
  if (claude) claude.setVisible(!eyes && !!state?.claude);
}

// ── 相机 ──────────────────────────────────────────────────────────────────
const VIEW = {
  target: new THREE.Vector3(6.7, 0.35, 4.6),
  az: -0.62,
  elev: 1.0,
  radius: 19.2,
  mode: 'overview',
  fpRoom: 'living',
  fpPos: new THREE.Vector3(4.7, 1.55, 7.0),
  fpLook: new THREE.Vector3(7.2, 1.05, 2.2),
  fpYaw: 0,
  fpPitch: 0,
  follow: false,
  shot: false
};
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3(6.4, 1.0, 4.35);
const desiredPos = new THREE.Vector3();
const desiredLook = new THREE.Vector3();

// 房间照片用的近景机位：给 QQ 发图时，重点是她和所在的房间，而不是整张大平层平面图。
const ROOM_CAM = {
  living: { center: [6.3, 4.3], az: -0.72, elev: 0.8, r: 8.2 },
  kitchen: { center: [2.0, 2.1], az: 0.65, elev: 0.78, r: 7.0 },
  dining: { center: [2.1, 5.1], az: 0.55, elev: 0.78, r: 6.8 },
  her_room: { center: [10.8, 2.2], az: -0.75, elev: 0.78, r: 7.6 },
  corridor: { center: [10.4, 5.0], az: 0.55, elev: 0.8, r: 6.0 },
  bathroom: { center: [12.0, 6.9], az: -0.6, elev: 0.76, r: 5.4 },
  laundry: { center: [9.6, 6.5], az: 0.5, elev: 0.78, r: 5.2 },
  study: { center: [15.3, 4.6], az: -1.05, elev: 0.78, r: 4.2 },
  balcony: { center: [4.6, 8.2], az: 0.15, elev: 0.72, r: 7.0 },
  foyer: { center: [1.0, 6.2], az: -0.55, elev: 0.76, r: 5.2 },
  garden: { center: [6.6, -3.8], az: -2.92, elev: .85, r: 9.2 },
  yard: { center: [-.65, 3.0], az: -1.8, elev: .75, r: 7 }
};

const FP_PRESETS = {
  living: { pos: [4.7, 1.55, 7.05], look: [7.2, 1.05, 2.1], label: '客厅' },
  kitchen: { pos: [3.9, 1.55, 3.25], look: [0.8, 1.0, 0.9], label: '厨房' },
  dining: { pos: [0.75, 1.55, 6.95], look: [2.6, 1.0, 4.6], label: '餐厅' },
  her_room: { pos: [8.75, 1.55, 4.15], look: [11.6, 0.95, 1.15], label: '她的房间' },
  corridor: { pos: [12.9, 1.55, 5.0], look: [8.6, 1.2, 5.0], label: '走廊' },
  bathroom: { pos: [12.85, 1.55, 5.8], look: [11.1, 1.0, 7.4], label: '卫生间' },
  laundry: { pos: [9.0, 1.55, 5.8], look: [10.4, 1.0, 7.0], label: '家政间' },
  study: { pos: [16.9, 1.55, 5.6], look: [13.6, 1.05, 4.6], label: '书房' },
  balcony: { pos: [7.55, 1.55, 7.85], look: [1.8, 1.1, 8.8], label: '阳台' },
  foyer: { pos: [1.55, 1.55, 6.9], look: [0.15, 1.2, 5.55], label: '玄关' },
  garden: { pos: [.72, 1.55, -3.6], look: [6.2, .85, -4.6], label: '菜园' },
  yard: { pos: [-.65, 1.55, 3], look: [-.65, 1, -3.6], label: '屋外小径' }
};
function setFP(room, snap = true) {
  if (room === 'garden' && gardenController) {
    gardenController.setOpen(true);
    return;
  }
  const p = FP_PRESETS[room] || FP_PRESETS.living;
  VIEW.fpRoom = FP_PRESETS[room] ? room : 'living';
  if (snap) {
    VIEW.fpPos.set(...p.pos);
    VIEW.fpLook.set(...p.look);
    const d = new THREE.Vector3().subVectors(VIEW.fpLook, VIEW.fpPos);
    VIEW.fpYaw = Math.atan2(d.x, d.z);
    VIEW.fpPitch = Math.asin(clamp(d.y / d.length(), -1, 1));
  }
  updateRoomsUI();
}
function setMode(mode, requestedRoom = null) {
  VIEW.mode = mode;
  if (mode !== 'overview') VIEW.follow = false;
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));
  const fp = mode === 'first';
  $('rooms').classList.toggle('show', fp);
  world.setCeilingVisible(mode !== 'overview');
  world.setLabelsVisible(mode === 'overview');
  if (fp) setFP(requestedRoom || state?.her?.room || VIEW.fpRoom);
  if (mode === 'eyes') $('bubble').classList.remove('show');
}
function resetView() {
  VIEW.follow = false;
  setMode('overview');
  VIEW.az = -0.62; VIEW.elev = 1.02; VIEW.radius = 19.2;
  VIEW.target.set(6.7, 0.35, 4.6);
}
// 切到 3D 时给一个「在她正面偏侧」的半身机位：静态模型坐在沙发上也不会被靠背挡住。
function focusCharacter() {
  // 跟着「这一端的那位」走：小蓝鱼端镜头围着小蓝鱼，大小姐端围着小公主。
  const her = characterNow();
  if (!her) return;
  const facing = (Number(her.facing) || 0) * Math.PI / 180;
  VIEW.follow = true;
  VIEW.mode = 'overview';
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === 'overview'));
  world.setCeilingVisible(false);
  world.setLabelsVisible(true);
  $('rooms').classList.remove('show');
  VIEW.target.set(her.pos[0], (her.elev || 0) + 0.8, her.pos[1]);
  VIEW.az = Math.PI - facing + 0.42;
  VIEW.elev = 0.6;
  VIEW.radius = followTarget === 'claude' ? 4.4 : 5.0;
}

function updateCamera(dt) {
  if (VIEW.mode === 'overview' || VIEW.shot) {
    if (VIEW.follow && !VIEW.shot) {
      const h = characterNow();
      if (h) {
        const dp = followTarget === 'claude'
          ? (lastClaudePos || h.pos)
          : (lastDisplayPos || h.pos);
        VIEW.target.lerp(new THREE.Vector3(dp[0], (h.elev || 0) + 0.8, dp[1]), Math.min(1, dt * 3.2));
      }
    }
    const az = VIEW.shot ? -0.58 : VIEW.az;
    const elev = VIEW.shot ? 1.0 : VIEW.elev;
    const r = VIEW.shot ? 18.8 : VIEW.radius;
    const cy = Math.sin(elev) * r;
    const horiz = Math.cos(elev) * r;
    desiredPos.set(
      VIEW.target.x + Math.sin(az) * horiz,
      VIEW.target.y + cy,
      VIEW.target.z + Math.cos(az) * horiz
    );
    desiredLook.copy(VIEW.target);
  } else if (VIEW.mode === 'first') {
    desiredPos.copy(VIEW.fpPos);
    const dir = new THREE.Vector3(
      Math.sin(VIEW.fpYaw) * Math.cos(VIEW.fpPitch),
      Math.sin(VIEW.fpPitch),
      Math.cos(VIEW.fpYaw) * Math.cos(VIEW.fpPitch)
    );
    desiredLook.copy(VIEW.fpPos).add(dir.multiplyScalar(5));
  } else {
    // 她的视角
    const her = state?.her;
    if (her) {
      const facing = (her.facing || 0) * Math.PI / 180;
      const eye = her.asleep ? 0.86 : 1.22;
      desiredPos.set(her.pos[0] + Math.sin(facing) * 0.08, eye, her.pos[1] - Math.cos(facing) * 0.08);
      desiredLook.set(her.pos[0] + Math.sin(facing) * 4, eye - 0.35, her.pos[1] - Math.cos(facing) * 4);
    } else {
      desiredPos.set(6.3, 1.5, 5.0);
      desiredLook.set(6.3, 1.2, 2.0);
    }
  }
  const k = 1 - Math.pow(0.0008, Math.min(dt, 0.06));
  camPos.lerp(desiredPos, k);
  camLook.lerp(desiredLook, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// 初始化相机位置，避免第一帧从原点飞过来
(() => {
  const cy = Math.sin(VIEW.elev) * VIEW.radius;
  const horiz = Math.cos(VIEW.elev) * VIEW.radius;
  camPos.set(VIEW.target.x + Math.sin(VIEW.az) * horiz, VIEW.target.y + cy, VIEW.target.z + Math.cos(VIEW.az) * horiz);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
})();

// ── 输入 ──────────────────────────────────────────────────────────────────
let dragging = false;
let charPress = null;
let charPressTimer = 0;
let charDrag = null;
let placeHold = null;
let last = { x: 0, y: 0 };
let moved = 0;
// 轻点判定的两把尺子：moved 是累计路程（手抖画圈会很大），tapSpread 是净位移
// （按下点到抬起的直线距离）。两者都要过阈值才当点击，见 isTapRelease()。
let tapSpread = 0;
let tapStart = { x: 0, y: 0 };
let tapPointerType = 'mouse';

function tapSlop(pointerType) {
  return pointerType === 'touch' ? MOVE_TUNING.tapSlopTouch : MOVE_TUNING.tapSlopMouse;
}
function tapPathLimit(pointerType) {
  return pointerType === 'touch' ? MOVE_TUNING.tapPathTouch : MOVE_TUNING.tapPathMouse;
}
function isTapRelease(e) {
  const type = tapPointerType || e.pointerType || 'mouse';
  const net = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  tapSpread = net;
  if (net > tapSlop(type)) return false;
  if (moved > tapPathLimit(type)) return false;
  return true;
}

// 开放视角：用移动键改变观察位置/方向，不依赖右键拖拽。
const openViewKeys = new Set();
let openViewBoost = false;
const OPEN_VIEW_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
function openViewTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
function updateOpenView(dt) {
  if (!cameraUsesKeyboard() || SHOT || VIEW.mode !== 'overview') return;
  const boost = openViewBoost ? 2.1 : 1;
  const pan = Math.min(0.12, Math.max(0, dt)) * 3.6 * boost;
  const turn = Math.min(0.12, Math.max(0, dt)) * 1.35 * boost;
  const tilt = Math.min(0.12, Math.max(0, dt)) * 0.85 * boost;
  const rightX = Math.cos(VIEW.az);
  const rightZ = -Math.sin(VIEW.az);
  const forwardX = -Math.sin(VIEW.az);
  const forwardZ = -Math.cos(VIEW.az);
  if (openViewKeys.has('KeyW')) { VIEW.target.x += forwardX * pan; VIEW.target.z += forwardZ * pan; }
  if (openViewKeys.has('KeyS')) { VIEW.target.x -= forwardX * pan; VIEW.target.z -= forwardZ * pan; }
  if (openViewKeys.has('KeyD')) { VIEW.target.x += rightX * pan; VIEW.target.z += rightZ * pan; }
  if (openViewKeys.has('KeyA')) { VIEW.target.x -= rightX * pan; VIEW.target.z -= rightZ * pan; }
  if (openViewKeys.has('ArrowLeft')) VIEW.az += turn;
  if (openViewKeys.has('ArrowRight')) VIEW.az -= turn;
  if (openViewKeys.has('ArrowUp')) VIEW.elev = clamp(VIEW.elev + tilt, 0.06, 1.45);
  if (openViewKeys.has('ArrowDown')) VIEW.elev = clamp(VIEW.elev - tilt, 0.06, 1.45);
  VIEW.target.x = clamp(VIEW.target.x, -4, 15);
  VIEW.target.z = clamp(VIEW.target.z, -9.5, 11);
  VIEW.target.y = clamp(VIEW.target.y, 0.15, 2.6);
}
function clearOpenViewKeys() {
  openViewKeys.clear();
  openViewBoost = false;
}
window.addEventListener('keydown', (e) => {
  if (!cameraUsesKeyboard() || SHOT) return;
  if (e.key === 'Shift') { openViewBoost = true; return; }
  if (!OPEN_VIEW_CODES.has(e.code)) return;
  if (openViewTypingTarget(e.target) || openViewTypingTarget(document.activeElement)) return;
  e.preventDefault();
  openViewKeys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') { openViewBoost = false; return; }
  openViewKeys.delete(e.code);
});
window.addEventListener('blur', clearOpenViewKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearOpenViewKeys(); });

function clearCharPress() {
  if (charPressTimer) {
    clearTimeout(charPressTimer);
    charPressTimer = 0;
  }
  charPress = null;
}

function legalDragPoint(p) {
  const rooms = state?.layout?.rooms;
  if (!Array.isArray(rooms) || !rooms.length) {
    return [clamp(p[0], 0.3, 12.9), clamp(p[1], 0.3, 8.7)];
  }
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    if (p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1) {
      if (room.id === 'garden' || room.id === 'yard') {
        // 和房间一样连续跟随鼠标；不要每一步都吸附到最近的菜畦/门口，
        // 否则拖拽会一跳一跳。服务端 place 会保留这个自由落点。
        const pad = 0.18;
        return [
          Math.min(x1 - pad, Math.max(x0 + pad, p[0])),
          Math.min(z1 - pad, Math.max(z0 + pad, p[1]))
        ];
      }
      return [p[0], p[1]];
    }
  }
  let best = rooms[0];
  let bestD = Infinity;
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    const d = Math.hypot(p[0] - (x0 + x1) / 2, p[1] - (z0 + z1) / 2);
    if (d < bestD) { bestD = d; best = room; }
  }
  const [x0, z0, x1, z1] = best.bounds;
  return [clamp(p[0], x0 + 0.22, x1 - 0.22), clamp(p[1], z0 + 0.22, z1 - 0.22)];
}

function beginCharDrag() {
  if (!charPress || !dragging || SHOT) return;
  const e = { clientX: charPress.lastX, clientY: charPress.lastY };
  // 拖谁？这一端跟着的那个。锁定端只能拖自己那位。
  const base = (followTarget === 'claude'
    ? (lastClaudePos || state?.claude?.pos)
    : (lastDisplayPos || state?.her?.pos)) || [6.3, 5.1];
  const start = base.slice();
  const fp = floorPointAt(e) || start;
  charDrag = {
    active: true,
    who: followTarget,
    pos: start.slice(),
    offset: [start[0] - fp[0], start[1] - fp[1]]
  };
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging');
  canvas.classList.add('grabbing');
  if (charMode === 'webm') {
    try { actor.setClip('react_scare'); } catch { /* 忽略 */ }
  }
  showClickMarker(base);
  playPickup();
  toast('按住拖动她，松手放下');
}

function updateCharDrag(e) {
  if (!charDrag?.active) return;
  const fp = floorPointAt(e);
  if (!fp) return;
  charDrag.pos = legalDragPoint([fp[0] + charDrag.offset[0], fp[1] + charDrag.offset[1]]);
  showClickMarker(charDrag.pos);
}

function finishCharDrag(e) {
  if (!charDrag?.active) return;
  if (e) updateCharDrag(e);
  const p = charDrag.pos.slice();
  const who = charDrag.who === 'claude' ? 'claude' : 'her';
  charDrag = null;
  canvas.classList.remove('grabbing');
  if (who === 'claude') {
    // 大小姐没有立绘弹跳，直接摆位；服务端 place 会带 target 落到她身上。
    lastClaudePos = p.slice();
    if (claude) { try { claude.setPose({ pos: p, elev: 0, pose: 'stand', walking: false, facing: state?.claude?.facing || 0 }); } catch { /* 忽略 */ } }
    placeHold = null;
    showClickMarker(p);
    playDrop();
    act('place', { pos: p, free: true });
    return;
  }
  placeHold = { pos: p, until: performance.now() + 1800 };
  lastDisplayPos = p.slice();
  showClickMarker(p);
  playDrop();
  bounceCharacter();
  act('place', { pos: p, free: true });
}

function cancelCharDrag() {
  charDrag = null;
  clearCharPress();
  canvas.classList.remove('grabbing');
  try { syncCharacter(); } catch { /* 恢复当前片段 */ }
}

canvas.addEventListener('pointerdown', (e) => {
  if (SHOT || charDrag?.active) return;
  if (e.button !== 0) return;
  if (soundOn) unlockAudio();
  dragging = true;
  moved = 0;
  tapSpread = 0;
  tapStart = { x: e.clientX, y: e.clientY };
  // 触摸和鼠标的抖动幅度差一个量级，阈值分开算（见 MOVE_TUNING）。
  tapPointerType = e.pointerType === 'touch' ? 'touch' : 'mouse';
  last = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无活动指针 */ }
  // 点在角色身上：先挂长按；移动超过阈值就作废，交给相机拖拽。
  if (charHit(e) && !characterNow()?.asleep) {
    clearCharPress();
    charPress = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
    charPressTimer = setTimeout(() => {
      charPressTimer = 0;
      beginCharDrag();
    }, MOVE_TUNING.longPressMs);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (charDrag?.active) { updateCharDrag(e); return; }
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  // 路程沿用曼哈顿累加当第二道门槛，净位移在抬手时单独算。
  moved += Math.abs(dx) + Math.abs(dy);
  if (charPress) {
    charPress.lastX = e.clientX;
    charPress.lastY = e.clientY;
    if (Math.hypot(e.clientX - charPress.startX, e.clientY - charPress.startY) > MOVE_TUNING.longPressCancelPx) clearCharPress();
  }
  if (!isTouch && !cameraUsesMouse()) return;
  // 还没离开抖动区之前不驱动相机：轻点时手抖 2-3px 不该让镜头跟着晃。
  const netNow = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  if (netNow <= tapSlop(tapPointerType)) return;
  if (VIEW.mode === 'overview') {
    VIEW.az -= dx * 0.0045;
    VIEW.elev = clamp(VIEW.elev + dy * 0.0035, 0.2, 1.35);
  } else if (VIEW.mode === 'first') {
    VIEW.fpYaw -= dx * 0.004;
    VIEW.fpPitch = clamp(VIEW.fpPitch - dy * 0.003, -0.7, 0.55);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (charDrag?.active) { finishCharDrag(e); return; }
  const wasDragging = dragging;
  dragging = false;
  clearCharPress();
  canvas.classList.remove('dragging');
  if (!wasDragging || SHOT) return;
  if (isTapRelease(e)) onClick(e);
});
canvas.addEventListener('pointercancel', () => {
  dragging = false;
  clearCharPress();
  if (charDrag) cancelCharDrag();
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('lostpointercapture', () => {
  if (charDrag) cancelCharDrag();
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('wheel', (e) => {
  if (SHOT) return;
  e.preventDefault();
  if (VIEW.mode === 'overview') VIEW.radius = clamp(VIEW.radius + e.deltaY * 0.012, 3.5, gardenController?.isOpen ? 48 : 26);
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (!SHOT) { if (gardenController?.isOpen) focusGarden(); else resetView(); } });

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hotspotAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(world.hotspots, false);
  return hits[0]?.object?.userData?.hotspot || null;
}
// 把世界坐标投到屏幕像素；在相机后面返回 null。
function screenOf(dp, elev) {
  const v = new THREE.Vector3(dp[0], elev, dp[1]);
  v.project(camera);
  if (v.z > 1) return null;
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
}

// 这一端正在被指挥的那个人，及其当前显示位置。
function activeFoot() {
  const who = followTarget === 'claude' && state?.claude ? state.claude : state?.her;
  const dp = followTarget === 'claude' && state?.claude
    ? (lastClaudePos || state.claude.pos)
    : (lastDisplayPos || state?.her?.pos);
  return { who, dp };
}

// 命中判定跟着「这一端的那个人」：锁定大小姐的页面上，点她自己才算点到了人。
// 返回的不只是 true/false —— 还要给出头顶/脚底的屏幕位置，onClick 靠脚底线
// 仲裁「摸头还是走过去」（见 arbitrateTap）。
function charHitInfo(e) {
  const { who, dp } = activeFoot();
  const radius = (e && e.pointerType === 'touch') || isTouch
    ? MOVE_TUNING.charHitRadiusTouch
    : MOVE_TUNING.charHitRadiusMouse;
  const miss = { hit: false, inBox: false, loose: false, radius, footY: 0, headY: 0, bodyPx: 0, midX: 0, dist: Infinity };
  if (!who || !dp) return miss;
  const elev = who.elev || 0;
  const head = screenOf(dp, elev + (who.asleep ? 0.75 : 1.35));
  const foot = screenOf(dp, elev + 0.02);
  if (!head || !foot) return miss;
  const bodyPx = Math.abs(foot.y - head.y);
  const midX = (head.x + foot.x) / 2;
  // 横向半宽按身体投影高度收放：远看小人只有几十像素，近看能占半屏。
  const halfW = Math.min(radius, Math.max(16, bodyPx * 0.42));
  // 纵向只到脚底线再放 2px：脚底以下一律算「点地板」，这是摸头/走过去的仲裁依据。
  const top = head.y - Math.max(6, bodyPx * 0.16);
  const bottom = foot.y + 2;
  const inBox = Math.abs(e.clientX - midX) <= halfW && e.clientY >= top && e.clientY <= bottom;
  // 兜底：身体投影过小（贴地/远到看不见）时，退回原来的圆形半径判据。
  // 注意 loose 只是「够得着人」，不能直接当成摸头 —— 身体框之外、脚线以下
  // 的那一圈仍然是地板，仲裁交给 arbitrateTap。
  const anchor = screenOf(dp, elev + 0.85);
  const dist = anchor ? Math.hypot(anchor.x - e.clientX, anchor.y - e.clientY) : Infinity;
  const loose = dist < radius * 0.8;
  const hit = inBox || loose;
  return { hit, inBox, loose, radius, footY: foot.y, headY: head.y, bodyPx, midX, dist };
}

function charHit(e) {
  return charHitInfo(e).hit;
}
// ── 静默失败的可见反馈 ────────────────────────────────────────────────────
// 以前「点不到/去不了/被限流」全靠 toast 一闪或者干脆什么都不说，玩家以为卡了。
// 这里统一走 #toast，但按 kind 做 3 秒去重：同一类提示刷屏等于没提示。
const hintAt = Object.create(null);
const HINT_GAP_MS = 3000;
function hint(kind, text, ms = 2200) {
  const now = performance.now();
  if (hintAt[kind] && now - hintAt[kind] < HINT_GAP_MS) return false;
  hintAt[kind] = now;
  toast(text);
  // 气泡比 toast 更靠角色，重要的一次性反馈走气泡，但同样受去重保护。
  if (ms > 0) setBubble(text, ms);
  return true;
}

// 落点离她脚底太近时沿点击方向外推：0.2m 的移动只会让她原地转个身，
// 看起来像「没反应」，所以推到 footClearance 之外，保证这一步看得见。
function pushOutFromFoot(pos, foot, minDist) {
  if (!foot || !pos) return pos;
  const dx = pos[0] - foot[0];
  const dz = pos[1] - foot[1];
  const d = Math.hypot(dx, dz);
  if (d >= minDist) return pos;
  if (d < 1e-4) return [foot[0] + minDist, foot[1]];
  const k = (minDist + 0.06) / d;
  return [
    Math.round((foot[0] + dx * k) * 1000) / 1000,
    Math.round((foot[1] + dz * k) * 1000) / 1000
  ];
}

// 摸头 or 走过去：不再无条件让角色吃掉落点。
// 判据按优先级从上到下，第一条件成立即返回：
//   ① 身体框命中且没落到脚线以下          → 摸头（最明确的「点到了人」）
//   ② 落点在脚线以下（点的是她脚前地板）  → 走过去（落点会被推到 clearance 之外）
//   ③ 有地板命中且离脚 ≥ footClearance    → 走过去
//   ④ 圆形兜底命中且没落到脚线以下        → 摸头（远看时身体框退化成一个点）
//   ⑤ 只剩「地板就在她脚下」              → 摸头，别发一条原地踏步的空请求
function arbitrateTap(e) {
  const info = charHitInfo(e);
  const floor = floorPointAt(e);
  const { dp } = activeFoot();
  const worldDist = (floor && dp) ? Math.hypot(floor[0] - dp[0], floor[1] - dp[1]) : Infinity;
  const clearance = MOVE_TUNING.footClearance;
  // 脚底线只在投影有效时才算数：打不到人时 footY 是 0，不能拿它当判据。
  const belowFootLine = info.bodyPx > 0 && e.clientY > info.footY + 2;
  if (info.inBox && !belowFootLine) return { kind: 'pet', info, floor };
  if (belowFootLine && floor) return { kind: 'go', info, floor };
  if (floor && worldDist >= clearance) return { kind: 'go', info, floor };
  if (info.loose && !belowFootLine) return { kind: 'pet', info, floor };
  if (floor && worldDist < clearance) return { kind: 'pet', info, floor };
  if (info.hit) return { kind: 'pet', info, floor };
  return { kind: 'none', info, floor: null };
}

// 一条 go 的完整本地链路：吸附落点 → 落点标记 → 入队（拿序号）→ 乐观位移。
// 所有「走过去」的入口都走这里，避免有的地方做了乐观反馈、有的地方没有。
function commandGo(floor) {
  const { dp } = activeFoot();
  if (!floor) return 0;
  const pos = pushOutFromFoot(floor, dp, MOVE_TUNING.footClearance);
  showClickMarker(pos);
  const seq = act('go', { pos }).seq;
  startOptimisticGo(pos, seq);
  return seq;
}

function onClick(e) {
  if (gardenController?.handlePointer(e)) return;
  if (VIEW.mode === 'eyes') {
    // 第一人称/眼部视角下不接收地面点击，但要说一句，别让人以为点坏了。
    hint('eyes', '眼睛视角下点不动她，按 V 切回房间视角');
    return;
  }
  // 游戏里点她 = 摸头；点她脚下的地板 = 走过去。顺序和阈值见 arbitrateTap。
  const tap = arbitrateTap(e);
  const sleepNote = () => hint('asleep', '她睡着了，先点「叫醒」再指挥');
  if (tap.kind === 'pet') {
    if (characterNow()?.asleep) { sleepNote(); return; }
    playClick();
    bounceCharacter();
    if (tap.floor) showClickMarker(tap.floor);
    act('pet');
    return;
  }
  if (gardenController?.isOpen) {
    if (!tap.floor) { hint('garden-miss', '点菜园地面，别点房子或围栏'); return; }
    if (!clickMoveOn) { hint('clickmove-off', '点击移动没开：先点底部「点地面」开关'); return; }
    commandGo(tap.floor);
    return;
  }
  if (!clickMoveOn) {
    // 默认关闭会让人以为点击失效；点地板时提醒一次开关在哪。
    const hs = hotspotAt(e);
    if (hs) { showInfo(hs); return; }
    $('info').classList.add('hide');
    if (tap.floor) hint('clickmove-off', '点击移动没开：点底部「点地面」开关，或用「去那边」');
    else hint('floor-miss', '这一下没打到地面，往房间中间点点');
    return;
  }
  $('info').classList.add('hide');
  if (!tap.floor) { hint('floor-miss', '这一下没打到地面，往房间中间点点'); return; }
  commandGo(tap.floor);
}

// ── 数据 / 表现 ───────────────────────────────────────────────────────────
let state = null;
let roomView = null;
let petActionOverride = null;
let requestInFlight = false;
let lastActivity = '';
let bubbleUntil = 0;
let lastSleep = false;
let sleepPhase = 'none';
let lastOnceKey = '';
let lastOnceAt = 0;
let opinionUntil = 0;
let opinionClip = '';
let opinionTimer = 0;
let tvOverlayMode = 'off';
let tvQuoteTimer = 0;
let pendingAction = '';
let bubbleOn = localStorage.getItem('home-bubble') !== '0';
if (params.get('bubble') === '0') bubbleOn = false;
let clickMoveOn = localStorage.getItem('home-click-move') === '1';
const CAMERA_MODES = new Set(['open', 'left', 'both']);
const CAMERA_MODE_SAVED = (() => {
  const saved = localStorage.getItem('home-camera-mode');
  if (CAMERA_MODES.has(saved)) return saved;
  // 兼容旧版“开放视角开/关”：开=只用键盘，关=原来的左键视角。
  return localStorage.getItem('home-free-cam') === '1' ? 'open' : 'left';
})();
let cameraMode = CAMERA_MODE_SAVED;
function cameraUsesKeyboard() { return cameraMode === 'open' || cameraMode === 'both'; }
function cameraUsesMouse() { return cameraMode === 'left' || cameraMode === 'both'; }
if (params.get('clickmove') === '1') clickMoveOn = true;
if (params.get('clickmove') === '0') clickMoveOn = false;
let soundOn = localStorage.getItem('home-sound') !== '0';
if (params.get('sound') === '0') soundOn = false;
let spriteView = localStorage.getItem('home-sprite-view') === 'free' ? 'free' : 'front';
if (params.get('view') === 'free') spriteView = 'free';
if (params.get('view') === 'front') spriteView = 'front';
let lastBackView = null;
let lastViewZone = null;
let audioCtx = null;
const clickSfx = new Audio('assets/sound/click-duck.wav');
clickSfx.preload = 'auto';
clickSfx.volume = 0.38;

function unlockAudio() {
  if (!soundOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { /* 浏览器禁用音频 */ }
}

function playClick() {
  if (!soundOn) return;
  try {
    const a = new Audio(clickSfx.src);
    a.volume = clickSfx.volume;
    a.play().catch(() => {});
  } catch { /* 忽略 */ }
}

function playTone({ from = 440, to = from, dur = 0.12, vol = 0.07, type = 'sine' } = {}) {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* 忽略 */ }
}

function playPickup() { playTone({ from: 430, to: 690, dur: 0.10, vol: 0.055, type: 'sine' }); }
function playDrop() { playTone({ from: 190, to: 105, dur: 0.16, vol: 0.085, type: 'triangle' }); }
function playTap() { playTone({ from: 520, to: 610, dur: 0.065, vol: 0.032, type: 'sine' }); }
let walkPredict = null;
let lastDisplayPos = null;
// 小公主的本地预测路线（与 walkPredict 互不干扰：两人可能各自在被指挥）。
let claudePredict = null;
// ── 预测防回跳 ────────────────────────────────────────────────────────────
// 旧行为：快照每 1.2s 落地一次，applyState 无条件把 walkPredict 重置到服务端
// 的旧坐标，网络慢时画面会往回跳最多 1.26m（1.05m/s × 1.2s）。
// 现在两条约束：
//   ① 本地还有没被确认的 go 时，不用快照覆盖预测起点，只换终点路线；
//   ② 无论如何都把「服务端位置 − 预测位置」记成残差 residual，按指数衰减慢慢补，
//      于是偏差被摊到 ~0.45s 里吃掉，而不是一帧跳回去。
let predictResidual = null;   // [x, z]，正值表示「显示位置比服务端靠前」
let predictResidualAt = 0;
let optimisticGo = null;      // { pos, seq, at } 本地已发但未确认的 go
let optimisticUntil = 0;
const OPTIMISTIC_TIMEOUT_MS = 4000;

function residualNow() {
  if (!predictResidual) return [0, 0];
  const dt = Math.max(0, (performance.now() - predictResidualAt) / 1000);
  const k = Math.exp(-dt / MOVE_TUNING.predictTau);
  if (k < 0.02) { predictResidual = null; return [0, 0]; }
  return [predictResidual[0] * k, predictResidual[1] * k];
}

function setResidual(dx, dz) {
  // 单次残差封顶：真瞬移（换房间/被拖动）时别硬拽，直接让快照说了算。
  const d = Math.hypot(dx, dz);
  const cap = MOVE_TUNING.predictMaxLag;
  const k = d > cap ? cap / d : 1;
  predictResidual = [dx * k, dz * k];
  predictResidualAt = performance.now();
}

// 点击当场把她的显示位置朝落点推一小步，不等网络：这是「跟手」的来源。
// seq 由 act() 入队时返回，服务端回 changed:false 时按 seq 精确回滚。
function startOptimisticGo(pos, seq = 0) {
  if (SHOT || !pos) return;
  const { who, dp } = activeFoot();
  if (!who || !dp) return;
  const at = performance.now();
  // target 必须记下来：指挥对象是小公主时，这条乐观位移不该让小蓝鱼播跑帧。
  optimisticGo = { pos: pos.slice(), seq, at, target: followTarget };
  optimisticUntil = at + OPTIMISTIC_TIMEOUT_MS;
  // 立刻转向落点：即使位置还没动，也能看出她「听懂了」。
  const dx = pos[0] - dp[0];
  const dz = pos[1] - dp[1];
  if (Math.hypot(dx, dz) > 0.02) {
    const deg = Math.atan2(dx, -dz) * 180 / Math.PI;
    if (followTarget === 'claude' && state?.claude) state.claude.facing = deg;
    else if (state?.her) state.her.facing = deg;
  }
  // 从当前显示位置到落点拉一条预测直线，让 frame 立刻开始推。
  if (followTarget !== 'claude') {
    walkPredict = {
      points: [dp.slice(), pos.slice()],
      start: dp.slice(),
      at: at - 60,             // 提前 60ms，动起来更跟手
      speed: Math.max(0.5, Number(state?.her?.speed) || 1.05)
    };
  } else {
    // 小公主同样要立刻起步，但她的路线单独存，别覆盖小蓝鱼的 walkPredict。
    claudePredict = {
      points: [dp.slice(), pos.slice()],
      start: dp.slice(),
      at: at - 60,
      speed: Math.max(0.5, Number(state?.claude?.speed) || 1.05)
    };
  }
  playTap();
}

function dropOptimistic(seq) {
  if (!optimisticGo) return;
  if (seq && seq !== optimisticGo.seq) return;
  // 回滚到服务端权威位置；用残差而不是硬切，避免撤销也变成一次跳动。
  // 取当前指挥对象的坐标：指挥切到小公主时，回滚的也应该是她的位置。
  const server = characterNow()?.pos;
  if (server && lastDisplayPos) {
    setResidual(lastDisplayPos[0] - server[0], lastDisplayPos[1] - server[1]);
  }
  optimisticGo = null;
  optimisticUntil = 0;
  walkPredict = null;
  claudePredict = null;
  syncCharacter();
}

// 只在对小蓝鱼下指令时才算「她没确认」。指挥切到小公主时这条预测与她无关，
// 否则小蓝鱼会莫名播起跑帧。
function hasUnconfirmedGo() {
  if (!optimisticGo) return false;
  if (optimisticGo.target === 'claude') return false;
  if (performance.now() > optimisticUntil) { optimisticGo = null; return false; }
  return true;
}
// 小公主那一侧的同款判断：她的指令走 claudePredict，别和小蓝鱼的混在一起。
function hasUnconfirmedClaudeGo() {
  if (!optimisticGo) return false;
  if (optimisticGo.target !== 'claude') return false;
  if (performance.now() > optimisticUntil) {
    optimisticGo = null;
    claudePredict = null;
    return false;
  }
  return true;
}
// 小公主的走路预测起点；applyState 里记录，frame 里按路线推进。
let claudeWalkAt = 0;
let lastClaudeWalking = false;
let lastClaudePos = null;

function fmtAgo(min) {
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时前`;
}

function applyBubblePref() {
  const chip = $('bubbleChip');
  if (!chip) return;
  chip.classList.toggle('active', bubbleOn);
  chip.setAttribute('aria-pressed', String(bubbleOn));
  const st = $('bubbleState');
  if (st) st.textContent = bubbleOn ? '开' : '关';
  if (!bubbleOn) $('bubble').classList.remove('show');
}

function applyClickMovePref(announce = false) {
  const chip = $('clickMoveChip');
  if (chip) {
    chip.classList.toggle('active', clickMoveOn);
    chip.setAttribute('aria-pressed', String(clickMoveOn));
    const st = $('clickMoveState');
    if (st) st.textContent = clickMoveOn ? '开' : '关';
  }
  canvas.classList.toggle('picking', clickMoveOn);
  if (announce) toast(clickMoveOn ? '点击地面，让她走过去' : '点击移动已关闭');
}

function applySoundPref() {
  const chip = $('soundChip');
  if (chip) {
    chip.classList.toggle('active', soundOn);
    chip.setAttribute('aria-pressed', String(soundOn));
    const st = $('soundState');
    if (st) st.textContent = soundOn ? '开' : '关';
  }
  if (!soundOn) {
    try { clickSfx.pause(); } catch { /* 忽略 */ }
  }
}

function applySpriteViewPref() {
  const chip = $('viewChip');
  if (!chip) return;
  chip.style.display = charMode === 'webm' ? '' : 'none';
  chip.classList.toggle('active', spriteView === 'free');
  chip.setAttribute('aria-pressed', String(spriteView === 'free'));
  const st = $('viewState');
  if (st) st.textContent = spriteView === 'free' ? '自由' : '正面';
}

function applyCameraModePref() {
  const chip = $('camModeChip');
  if (!chip) return;
  chip.querySelectorAll('button[data-cam-mode]').forEach((button) => {
    const active = button.dataset.camMode === cameraMode;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  });
  chip.classList.toggle('active', cameraMode !== 'left');
  canvas.classList.toggle('free-cam', cameraUsesKeyboard());
  if (!cameraUsesKeyboard()) clearOpenViewKeys();
  if (cameraUsesKeyboard()) {
    VIEW.follow = false;
    if (VIEW.mode !== 'overview') setMode('overview');
  }
}
function setCameraMode(next) {
  if (!CAMERA_MODES.has(next)) return;
  cameraMode = next;
  localStorage.setItem('home-camera-mode', cameraMode);
  localStorage.removeItem('home-free-cam');
  applyCameraModePref();
  const text = {
    open: '开放视角：WASD 移动，方向键转动视角，Shift 加速',
    left: '左键视角：按住鼠标左键拖动镜头',
    both: '组合视角：键盘和鼠标左键都能移动视角'
  }[cameraMode];
  toast(text);
}

function showClickMarker(pos) {
  clickMarker.position.set(pos[0], 0.13, pos[1]);
  clickMarker.visible = true;
  clickMarker.material.opacity = 0.95;
  clickMarker.scale.setScalar(1);
  clickMarkerUntil = performance.now() + 1300;
}

// 地面平面 y=0.12 的数学求交（不依赖 pickFloor 那张有限大小的 mesh）。
// 用在 pickFloor 打空的场合：点墙根、地毯边缘、家具腿旁边，这些位置射线确实
// 错过了 21×17 的拾取面，但地板物理上还在那儿。
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.12);
const FLOOR_MAX_DIST = 20;
function planeFloorPoint() {
  const ray = raycaster.ray;
  // 射线几乎平行于地面时求交会飞到几十米外，直接判无效。
  if (Math.abs(ray.direction.y) < 0.06) return null;
  const hit = ray.intersectPlane(FLOOR_PLANE, new THREE.Vector3());
  if (!hit) return null;
  if (!Number.isFinite(hit.x) || !Number.isFinite(hit.z)) return null;
  if (ray.origin.distanceTo(hit) > FLOOR_MAX_DIST) return null;
  return [Math.round(hit.x * 1000) / 1000, Math.round(hit.z * 1000) / 1000];
}

function floorPointAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // 先打拾取面：它在所有地面装饰之上、家具之下，家具挡住的点会落空。
  const hit = raycaster.intersectObject(pickFloor, false)[0];
  if (hit) return [Math.round(hit.point.x * 1000) / 1000, Math.round(hit.point.z * 1000) / 1000];
  // 打空：用平面数学求交兜底。菜园地面本来就不在木地板拾取面上，同一套兜底即可。
  // 服务端仍会做「必须在房间内、离墙 0.22m」的合法化，这里只负责别丢点击。
  return planeFloorPoint();
}

function applyState(next) {
  if (!next) return;
  state = next;
  roomView = next.room || roomView;
  if (next.her) {
    world.updateEnvironment({
      hour: next.hour, lamp: next.env?.lamp !== false, asleep: next.her.asleep, kind: next.her.kind
    });
    world.setClock?.(next.hour || 0, 0);
    // P-E：本地还有没被确认的 go 时，别用这份（还停在出发点的）快照覆盖预测起点，
    // 否则画面会往回跳。只更新路线终点，起点沿用本地显示位置。
    const unconfirmed = hasUnconfirmedGo();
    if (next.her.walking && Array.isArray(next.her.route) && next.her.route.length > 1) {
      const speed = Math.max(0.5, Number(next.her.speed) || 1.05);
      if (unconfirmed && walkPredict && lastDisplayPos) {
        walkPredict = {
          points: next.her.route,
          start: lastDisplayPos.slice(),
          at: performance.now(),
          speed
        };
      } else {
        walkPredict = { points: next.her.route, start: next.her.pos.slice(), at: performance.now(), speed };
      }
    } else if (unconfirmed) {
      // 服务端这一帧还在「没走」状态：保持本地预测，等服务端追上。
    } else {
      walkPredict = null;
    }
    // 残差：服务端位置和本地显示位置的差，按指数衰减吃掉，而不是一帧跳过去。
    if (lastDisplayPos && !unconfirmed) {
      setResidual(lastDisplayPos[0] - next.her.pos[0], lastDisplayPos[1] - next.her.pos[1]);
    }
    // 未确认时别把「本地显示位置」拉回服务端的旧坐标：下一帧 compute 会以它为准，
    // 一拉回去就等于原地跳一下（这正是 P-E 要消灭的回跳）。
    if (!unconfirmed) lastDisplayPos = next.her.pos.slice();
  }
  if (next.claude) {
    if (next.claude.walking && !lastClaudeWalking) claudeWalkAt = performance.now();
    lastClaudeWalking = next.claude.walking === true;
    if (!next.claude.walking) claudeWalkAt = 0;
    // 小公主同样要防回跳：本地还有没确认的 go 时保留预测，等服务端追上再交回权威路线。
    if (!hasUnconfirmedClaudeGo()) claudePredict = null;
    if (claudeReady && claude) claude.setVisible(true);
  }
  if (placeHold && next.her) {
    const hp = next.her.pos;
    if (next.her.spot === 'free' && Math.hypot(hp[0] - placeHold.pos[0], hp[1] - placeHold.pos[1]) < 0.2) {
      placeHold = null;
    }
  }
  renderHUD();
  // 第一份带 growth 的快照到了就把抽屉重建一次（首帧建的时候还没有成长数据，
  // 会全显示成解锁）。只在等级/亲密度/锁数变化时重建，不是每次轮询都造 114 个按钮。
  refreshPetDrawerIfNeeded();
  if (!charDrag?.active) syncCharacter();
  if (SHOT) return;
  const bubbleText = (characterNow() || {})?.activity || '';
  if (bubbleOn && bubbleText && (bubbleText !== lastActivity || Date.now() < bubbleUntil)) {
    lastActivity = bubbleText;
    bubbleUntil = Date.now() + 4800;
  }
}

// 当前指挥对象的小公主视角版；指挥切到小公主时，房间名/动作/心情都显示她的。
function characterNow() {
  return followTarget === 'claude' && state?.claude ? state.claude : state?.her;
}
function switchFollowTarget(target, silent = false) {
  // 锁定的那一端没有切人权：页面就是她自己那一侧。
  if (SIDE_LOCKED) {
    followTarget = SIDE;
    renderHUD();
    return;
  }
  followTarget = target === 'claude' ? 'claude' : 'her';
  localStorage.setItem('home-follow-target', followTarget);
  const chip = $('followChip');
  if (chip) {
    chip.classList.toggle('active', followTarget === 'claude');
    chip.setAttribute('aria-pressed', String(followTarget === 'claude'));
  }
  const name = followTarget === 'claude' ? '小公主' : '小蓝鱼';
  const el = $('followState');
  if (el) el.textContent = name;
  renderHUD();
  if (!silent) toast(followTarget === 'claude' ? '现在指挥小公主：点房间会带她过去' : '现在指挥小蓝鱼');
}

// 整页换身份：配色/字形/标题/按钮文案跟着人走，别让两个人看到同一块面板。
// 两套文案必须对称 —— 房内交换身份之后要从 claude 走回 her，缺一条就残留。
const SIDE_COPY = {
  claude: {
    title: '克劳德大小姐的家 · 大平层',
    h1: '克劳德大小姐的家',
    p: '同一间屋子，她那半边',
    acts: {
      pet: ['轻抚发梢', '手落在她发梢，她没躲'],
      feed: ['递块点心', '给她一块小点心，她会小口吃掉'],
      water: ['斟一杯水', '把水杯轻轻放到她手边'],
      talk: ['说句话', '留一句话给她，会记进「刚刚发生」'],
      play: ['陪她坐坐', '陪她坐一会儿，看窗外'],
      wake: ['轻声唤她', '把她从睡里叫起来'],
      sleep: ['劝她歇息', '让她回房歇下'],
      lamp: ['调灯', '把灯调亮/调暗'],
      meet: ['去小蓝鱼那儿', '让小公主走去找小蓝鱼待一会儿']
    },
    study: ['她的书桌屏', '把屏幕共享到她书桌上那块屏'],
    garden: ['后院', '陪她到后院坐坐'],
    chatToggle: '和大小姐聊聊',
    chatNote: '她的私聊 · 独立会话 · 不经过 QQ',
    hint: '拖动旋转 · 滚轮缩放 · 双击复位 · 长按可以把她挪个位置',
    loading: '正在打开房间…',
    talkPlaceholder: '留一句话给她…',
    labels: { energy: '精神', hunger: '饱腹', thirst: '口渴', pain: '倦意' },
    // 这一栏现在只有一套刻度（十段），标签统一叫「和她」：不再分「和小屋的亲近 / 和她的亲近」。
    // 跟着指挥对象走的是数值，不是标签 —— 换人是换「和谁」，不是换一种关系算法。
    aff: '和她',
    events: '她的近况',
    petH3: '大小姐的姿态',
    claudeActions: false,
    petActions: true
  },
  her: {
    title: '两人温馨小屋',
    h1: '两人温馨小屋',
    p: '纸、陶、木，和一盏常亮的灯',
    acts: {
      pet: ['摸摸头', '手落在她头上，她会蹭一下'],
      feed: ['喂小鱼干', '给她一条小鱼干，她会开心地吃掉'],
      water: ['倒杯水', '把水杯放到她手边'],
      talk: ['留句话', '留一句话给她，会记进「刚刚发生」'],
      play: ['陪她玩', '陪她玩一会儿'],
      wake: ['叫醒', '把她从睡里叫起来'],
      sleep: ['哄她睡', '哄她回房睡下'],
      lamp: ['关灯', '把灯调亮/调暗'],
      meet: ['去找大小姐', '让小蓝鱼走去找大小姐待一会儿']
    },
    study: ['书房投屏', '把屏幕共享到书房的大屏幕上，小蓝鱼会坐到你旁边陪着看'],
    garden: ['进入菜园', '进入屋后菜园'],
    chatToggle: '和她聊聊',
    chatNote: '房间私聊 · 各住民独立会话 · 不经过 QQ',
    hint: '拖动旋转 · 滚轮缩放 · 双击复位 · 长按小蓝鱼拖动',
    loading: '正在打开房间…',
    talkPlaceholder: '留一句话给她…',
    labels: { energy: '精力', hunger: '饱', thirst: '渴', pain: '不适' },
    // 与 claude 侧一致：一套十段刻度，一栏「和她」。
    aff: '和她',
    events: '刚刚发生',
    petH3: '小蓝鱼动作',
    claudeActions: true,
    petActions: false
  }
};

function applySide() {
  const body = document.body;
  body.classList.toggle('side-claude', SIDE === 'claude');
  body.classList.toggle('side-her', SIDE === 'her');
  body.classList.toggle('side-locked', SIDE_LOCKED);
  // 没定侧（单机 / 老服务器模式）时保持 index.html 里的原样，什么都不改。
  const copy = SIDE_COPY[SIDE];
  if (!copy) return;
  document.title = copy.title;
  const h1 = document.querySelector('.brand h1');
  const p = document.querySelector('.brand p');
  if (h1) h1.textContent = copy.h1;
  if (p) p.textContent = copy.p;
  const act = (sel, text, title) => {
    const b = document.querySelector(sel);
    if (!b) return;
    if (text) b.textContent = text;
    if (title) b.title = title;
  };
  for (const [key, [text, title]] of Object.entries(copy.acts)) act(`[data-act="${key}"]`, text, title);
  act('#studyChip span:last-child', copy.study[0], copy.study[1]);
  // 菜园按钮现在是「SVG 图标 + .chip-text」两段，直接写 textContent 会把图标抹掉，
  // 所以只改文字那一段。
  act('#gardenChip .chip-text', copy.garden[0], copy.garden[1]);
  const ch = $('chatToggle');
  if (ch) ch.textContent = copy.chatToggle;
  const note = document.querySelector('.chat-note');
  if (note) note.textContent = copy.chatNote;
  const hint = document.querySelector('.hint');
  if (hint) hint.textContent = copy.hint;
  const load = document.querySelector('#loading .loader p');
  if (load) load.textContent = copy.loading;
  const t = $('talkInput');
  if (t) t.placeholder = copy.talkPlaceholder;
  const txt = (sel, s) => { const el = $(sel) || document.querySelector(sel); if (el) el.textContent = s; };
  txt('#lblEnergy', copy.labels.energy);
  txt('#lblHunger', copy.labels.hunger);
  txt('#lblThirst', copy.labels.thirst);
  txt('#lblPain', copy.labels.pain);
  txt('#affLabel', copy.aff);
  txt('.events-panel h3', copy.events);
  txt('#petActions h3', copy.petH3);
  if ($('petActions')) $('petActions').hidden = copy.petActions;
  if ($('claudeActions')) $('claudeActions').hidden = copy.claudeActions;
  // 菜园面板里那一整套人名字（标题、照料安排、请她来…）也跟着换。
  try { gardenController?.setWho(SIDE); } catch { /* 菜园还没挂上就算了 */ }
}

// 运行期换侧（房内申请交换身份通过后，或 mode-menu 选完身份后）。
// 这是唯一改 SIDE 的入口：先改状态，再把整页重刷一遍。
function setSide(next, options = {}) {
  const want = next === 'claude' ? 'claude' : next === 'her' ? 'her' : '';
  SIDE = want;
  SIDE_LOCKED = !!want && options.unlock !== true;
  if (SIDE_LOCKED) followTarget = SIDE;
  else if (want) followTarget = want;
  applySide();
  switchFollowTarget(followTarget, true);
  // 私聊也跟着走：锁定侧只能和这一位说话。
  if (SIDE_LOCKED) {
    if (typeof setChatTarget === 'function') setChatTarget(SIDE, true);
  }
  renderHUD();
  return SIDE;
}

// 「我是」：给自己起个名字，动作事件里就带谁做的（只存本机 localStorage，不做账号）。
function applyActorChip() {
  const el = $('actorState');
  if (el) el.textContent = actorTag();
  const chip = $('actorChip');
  if (chip) chip.classList.toggle('active', !!actorName());
}
function promptActorName() {
  const cur = actorName();
  // 进门时已经强制定过名字了，这里只改不改清：留空等于取消，不再回落到「小屋访客」。
  const next = window.prompt('你在这间屋子里的名字（最多 12 个字）', cur || '');
  if (next === null) return;
  const clean = String(next).trim().slice(0, 12);
  if (!clean) {
    toast('名字不能空着，还是叫「' + (cur || '你') + '」');
    return;
  }
  setActorName(clean);
  applyActorChip();
  toast(`记住了：现在是「${clean}」在动她`);
}

function renderHUD() {
  if (!state?.her) return;
  const focus = characterNow() || state.her;
  const her = state.her;
  const body = state.body || state.mood || {};
  $('roomName').textContent = focus.roomName || '';
  $('clock').textContent = state.clock || '--:--';
  $('spotLabel').textContent = focus.spotLabel ? `${focus.spotLabel} · ` : '';
  $('activityText').textContent = focus.activity || '在发呆';
  $('barEnergy').style.width = `${Math.round((body.energy ?? 0) * 100)}%`;
  $('barHunger').style.width = `${Math.round((body.hunger ?? 0) * 100)}%`;
  $('barThirst').style.width = `${Math.round((body.thirst ?? 0) * 100)}%`;
  $('barPain').style.width = `${Math.round((body.pain ?? 0) * 100)}%`;
  $('wordEnergy').textContent = body.words?.energy || '';
  $('wordHunger').textContent = body.words?.hunger || '';
  $('wordThirst').textContent = body.words?.thirst || '';
  $('wordPain').textContent = body.words?.pain || '';

  // 状态↔好感：她现在难受的时候，照顾她的动作更算数（careFactor 最高 ×2.5），
  // 勉强她的动作更不算数（strainFactor 最低 ×0.4）。这件事必须让玩家看见，
  // 否则他只会觉得「怎么摸头加得不一样」。提醒用她自己的口吻，不是系统告警。
  const fx = focus.state || null;
  const panel = document.querySelector('.her-panel');
  const needHint = $('needHint');
  if (panel) panel.classList.toggle('strained', !!fx && fx.band !== 'calm');
  if (needHint) {
    const show = !!fx && fx.band !== 'calm' && !!fx.line;
    needHint.hidden = !show;
    if (show) {
      needHint.textContent = fx.band === 'critical'
        ? `${fx.line} —— 这时候照顾她，比平时管用得多。`
        : fx.line;
      needHint.classList.toggle('critical', fx.band === 'critical');
    }
  }

  const emo = state.emotion;
  const emoChip = $('emotionChip');
  if (emo && Number.isFinite(emo.mood)) {
    emoChip.textContent = `心情 · ${emo.label || ''}`;
    emoChip.title = '来自 dsh-feiyu-mood 的只读心情';
    emoChip.classList.toggle('low', emo.mood < 40);
    emoChip.classList.toggle('high', emo.mood >= 70);
  } else {
    emoChip.textContent = '';
    emoChip.title = '';
  }
  $('qqText').textContent = focus.asleep ? '睡着了' : (state.env?.unread > 0 ? 'QQ 有人找' : '在家');
  $('qqChip').classList.toggle('active', !!state.env?.unread);

  // 按钮文案跟着这位住户说话：大小姐端不用「哄她睡」这种哄小孩的词。
  const sideClaude = SIDE === 'claude';
  $('sleep').textContent = focus.asleep
    ? (sideClaude ? '叫醒她' : '叫她起来')
    : (sideClaude ? '劝她歇息' : '哄她睡');
  $('lamp').textContent = state.env?.lamp ? '关灯' : '开灯';

  // 「和她」这一栏只认一个数：当前指挥对象的 growth.intimacy。
  // 以前这里读 roomView.affection（profile 那份平铺累加），而下面的「今天的账」读
  // home-state 的 growth —— 同一次摸头在两边分别是 +2 和 +1.38，摸三次后上面写 9、
  // 下面写 4.25，玩家会以为有一处在骗人。两个数必须同源，否则宁可不显示。
  const gNow = (followTarget === 'claude' ? state?.claude : state?.her)?.growth || null;
  const aff = gNow ? gNow.intimacy : roomView?.affection;
  if (aff !== undefined && aff !== null) {
    // 小数点只在真有小数时出现：十段表里 poke/lamp 是 0.5，别把 6 显示成 6.0。
    $('affection').textContent = String(Number.isInteger(Number(aff)) ? Number(aff) : Number(aff).toFixed(1));
    const stageText = gNow?.stage?.title || roomView?.stage || '';
    // 「还差多少到下一段」：以前锁着的片段只给一句她的口吻，玩家不知道该做什么，
    // 只能站在原地猜。这里把差值直接放在档位后面，封顶时不显示。
    const nextMin = Number(gNow?.nextStage?.min);
    const toNext = Number.isFinite(nextMin) && nextMin > 0 && Number(aff) < nextMin
      ? nextMin - Number(aff)
      : Number(roomView?.stageToNext);
    const tail = Number.isFinite(toNext) && toNext > 0 ? ` · 还差 ${Math.ceil(toNext)}` : '';
    $('affStage').textContent = `${stageText}${tail}`;
  }
  renderAffAccount();
  // 左下角状态条（game-shell 的 #gxBar）也要显示同一个数。
  // 它原本读 profile.affection()，那是另一份平铺累加，和这一栏会各自漂移。
  // 把当前指挥对象的亲密度挂到全局，让它自己来读，不在这里替它算。
  globalThis.__gameLiveAffection = () => {
    const live = (followTarget === 'claude' ? state?.claude : state?.her)?.growth;
    return live ? Number(live.intimacy) : null;
  };
  // 同行账本也挂出去：左下角面板要显示「一起待过多久 / 攒了几点」，
  // 但那些数只有 homeView 里有，game-shell 自己取不到。
  globalThis.__gameTogether = () => {
    const tg = state?.together;
    if (!tg) return null;
    return {
      sessionMs: Number(tg.sessionMs) || 0,
      totalMs: Number(tg.totalMs) || 0,
      points: Number(tg.points) || 0,
      cap: Number(tg.pointsCap) || 0,
      fatigueFactor: Number(tg.fatigueFactor) || 1,
      fatigueText: String(tg.fatigueText || ''),
      nextMilestone: tg.nextMilestone || null
    };
  };

  // 指挥对象切换后，事件面板也跟着换人：小公主看 claudeEvents。
  const evSource = followTarget === 'claude' && state.claude ? (state.claudeEvents || []) : (state.events || []);
  const events = evSource.slice(-5).reverse();
  $('events').innerHTML = events.length
    ? events.map((e) => `<li><span>${fmtAgo(e.ago)}</span><b>${escapeHtml(e.text)}</b></li>`).join('')
    : `<li class="empty">${followTarget === 'claude' ? '小公主刚搬进来，还没发生什么。' : '她刚回到家，还没发生什么。'}</li>`;

  // 记忆板只读：优先用 QQ 会话里已有的 activeTopic（旧小屋同源），再补小屋留言，
  // 最后补小柜子换来的便条（那一条在 home 账本里，不在 roomView）。
  const memTopics = Array.isArray(state.memory?.topics) ? state.memory.topics : [];
  const memLines = [
    ...memTopics.slice(-3).map((t) => String(t.text || '')).filter(Boolean),
    ...((roomView?.notes || []).slice(-2).map((n) => n.text)),
    ...((state.together?.notes || []).slice(-2).map((n) => n.text))
  ];
  // 左下角陪伴层跟着当前指挥对象换：以前写死「小蓝鱼 · 陪你一起看」，
  // 切到小公主那边她画面里还是写着小蓝鱼的名字。
  const tvLabel = $('tvCompanionLabel');
  if (tvLabel) tvLabel.textContent = `${followTarget === 'claude' ? '小公主' : '小蓝鱼'} · 陪你一起看`;
  const tvVideo = $('tvCompanionVideo');
  if (tvVideo && followTarget === 'claude') {
    const src = './assets/pet/claude/claude_idle.webm';
    if (!tvVideo.src.endsWith('claude_idle.webm')) {
      tvVideo.src = src;
      tvVideo.poster = './assets/pet/claude/claude_idle.png';
    }
  } else if (tvVideo && followTarget !== 'claude' && !tvVideo.src.endsWith('/idle.webm')) {
    tvVideo.src = './assets/pet/idle.webm';
    tvVideo.poster = './assets/pet/idle.png';
  }

  world.setMemoryNotes(memLines);
  updateRoomsUI();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateRoomsUI() {
  const boxes = state?.layout?.rooms || [];
  const el = $('rooms');
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = boxes.map((r) => `<button data-room="${r.id}">${r.name}</button>`).join('');
    el.querySelectorAll('button[data-room]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.room === 'garden' && gardenController) { gardenController.setOpen(true); return; }
        setMode('first', b.dataset.room);
      });
    });
  }
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.room === VIEW.fpRoom && VIEW.mode === 'first'));
}

function viewDiff(her = state?.her) {
  if (!her) return 0;
  const p = lastDisplayPos || her.pos;
  const toCam = Math.atan2(camera.position.x - p[0], -(camera.position.z - p[1])) * 180 / Math.PI;
  const facing = Number(her.facing) || 0;
  return Math.abs(((facing - toCam + 540) % 360) - 180);
}
function isBackView() {
  if (charMode !== 'webm' || !state?.her) return false;
  // 「正面」只是待机偏好：站着时看镜头；一旦走路，必须按真实移动方向选背面/侧面，
  // 否则朝远处走时还播正面帧，看起来就是倒着走。
  if (spriteView !== 'free' && !state.her.walking) return false;
  // 进入用 108°，退出用 95°，避免镜头在边界附近抖动时来回切正/背面。
  return viewDiff() > (lastBackView ? 95 : 108);
}
/** 侧身跑只用在“镜头看到侧面”的区间；正面/背面不再套用左侧跑。 */
function isSideRun(her = state?.her) {
  if (!her?.walking || charMode !== 'webm') return false;
  if (VIEW.mode === 'first' || VIEW.mode === 'eyes') return false;
  // 背面奔跑已删除：镜头在背后时用侧跑帧，不再切 back_run。
  return viewDiff(her) >= 48;
}

function clipFor(her) {
  if (!her) return 'idle';
  if (petActionOverride && !her.asleep && Date.now() < petActionOverride.until) return petActionOverride.clip;
  if (her.asleep) {
    // 兜底：旧状态/异常状态下如果还没到床，绝不播睡眠动画。
    if (her.spot !== 'bed') return her.walking ? 'run_happy' : 'idle';
    return sleepPhase === 'loop' || sleepPhase === 'none' ? 'sleep_loop' : 'sleep_in';
  }
  // 本地还有未确认的 go 时也按「在走」选帧：不然点了地面她还站着，一眼就是没反应。
  if (her.walking || hasUnconfirmedGo()) {
    // 背面跑 / 侧面跑 / 正面跑分开选，避免拿左侧跑帧去跑右侧方向。
    if (isSideRun(her)) return 'run_hurry';
    return 'run_happy'; // 正面只有 run_happy 是正面帧；walk_fast 是侧跑，不能当前面用
  }
  if (Date.now() < opinionUntil && opinionClip) return opinionClip;

  const k = her.kind || 'idle';
  if (k.startsWith('garden_')) {
    if (k === 'garden_till' || k === 'garden_plant' || k === 'garden_harvest') return 'desk_tap';
    return 'idle_look';
  }
  // 自由视角只在站立/自由落点/行走时用背面；坐着、吃饭、反应等仍保留正面动作。
  if (isBackView() && her.pose === 'stand' && (her.elev || 0) < 0.2 && (k === 'idle' || k === 'free')) return 'back_idle';
  const night = (state?.hour ?? 12) >= 19 || (state?.hour ?? 12) < 7;
  switch (k) {
    case 'eat': return (her.activity || '').includes('小鱼干') ? 'eat_snack' : 'eat_rice';
    case 'drink': return 'eat_snack';
    case 'toilet': return 'mutter';
    case 'bath': return 'brush';
    case 'balcony': return night ? 'mooncake' : 'fan';
    case 'tv': return 'game';
    case 'desk': return 'desk_code';
    case 'phone': return 'desk_mutter';
    case 'nap': return 'nap';
    case 'laundry': return 'mutter';
    case 'sick':
    case 'help': return 'sick';
    case 'react_happy': return 'react_happy';
    case 'react_shy': return 'react_shy';
    case 'react_scare': return 'react_scare';
    case 'idle_look': return 'idle_look';
    case 'wake': return 'stretch';
    case 'play': return 'dance';
    case 'idle':
    default: {
      if (her.pose === 'lie') return 'nap';
      if (her.pose === 'sit') return 'mutter';
      const hour = state?.hour ?? 12;
      if (hour >= 22 || hour < 6) return 'yawn';
      const mood = state?.emotion?.mood;
      if (Number.isFinite(mood) && mood < 40) return 'idle_look';
      const h = [...(her.spot || '')].reduce((n, c) => n + c.charCodeAt(0), 0) + (her.kind || '').length;
      if (Number.isFinite(mood) && mood >= 78 && h % 4 === 0) return 'dance';
      return h % 7 === 0 ? 'dance' : h % 3 === 0 ? 'idle_hum' : h % 2 === 0 ? 'idle_look' : 'idle';
    }
  }
}

const ONCE = new Set(['react_happy', 'react_shy', 'react_scare', 'stretch', 'curtsy']);
function syncCharacter() {
  const her = state?.her;
  if (!her) return;
  if (her.asleep || her.room === 'garden') petActionOverride = null;
  const wasAsleep = lastSleep;
  lastSleep = her.asleep;

  if (her.asleep && her.spot !== 'bed') {
    // 还没进被窝：按移动/站立处理，不进入 sleep_in/sleep_loop。
    const name = her.walking ? 'run_happy' : 'idle';
    if (actor.current !== name) actor.setClip(name);
    return;
  }
  if (her.asleep && her.spot === 'bed') {
    if (!wasAsleep) {
      sleepPhase = 'in';
      actor.setClip('sleep_in', { once: true, onEnded: () => { if (lastSleep) { sleepPhase = 'loop'; actor.setClip('sleep_loop'); } } });
    } else if (sleepPhase === 'none') {
      sleepPhase = 'loop';
      actor.setClip('sleep_loop');
    }
    if (sleepPhase === 'out') sleepPhase = 'loop';
  } else if (!her.asleep && wasAsleep) {
    sleepPhase = 'out';
    actor.setClip('sleep_out', { once: true, onEnded: () => { sleepPhase = 'none'; actor.setClip(clipFor(state.her), { fade: true }); } });
  } else if (!her.asleep && sleepPhase !== 'none' && !her.walking) {
    sleepPhase = 'none';
  }

  if (her.asleep || sleepPhase === 'in' || sleepPhase === 'out') return;

  let name = clipFor(her);
  const once = ONCE.has(name);
  const key = `${name}:${her.activity}:${her.spot}`;
  if (once) {
    if (lastOnceKey === key && Date.now() - lastOnceAt < 9000) name = 'idle';
    else { lastOnceKey = key; lastOnceAt = Date.now(); }
  }
  if (actor.current !== name) {
    actor.setClip(name, { once, onEnded: () => { if (actor.current === name) actor.setClip(clipFor(state?.her), { fade: true }); } });
  }

  const pose = {
    pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: her.walking,
    facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
  };
  model3d?.setPose(pose);
  if (chibi) chibi.setPose(pose);
}

// ── 动作栏 ────────────────────────────────────────────────────────────────
const PET_ACTION_DURATION = Object.freeze({
  dance: 6200, stretch: 4200, curtsy: 3800, game: 5200, fan: 5200,
  mooncake: 5200, eat_snack: 4800, yawn: 4200, nap: 7000,
  idle_look: 4200, brush: 4600, idle_hum: 4600
});
function playPetAction(clip, label) {
  if (!state?.her) { toast('她还没出来'); return; }
  if (charMode !== 'webm') { toast('动作栏目前只在立绘模式播放；先切到「立绘」'); return; }
  if (state.her.asleep) { toast('她睡着了，先叫醒再让她跳舞'); return; }
  // 走路中也可以跳：先把“当前看到的脚下位置”提交为落点，停住路线再播。
  // 不等待网络返回，动作立即可见；place 返回后会把她的服务端位置对齐。
  if (state.her.walking || (state.her.route?.length > 0)) {
    const stopPos = Array.isArray(lastDisplayPos) ? lastDisplayPos.slice() : state.her.pos.slice();
    void act('place', { pos: stopPos });
  }
  const duration = PET_ACTION_DURATION[clip] || 4800;
  const token = `${clip}:${Date.now()}`;
  petActionOverride = { clip, label, until: Date.now() + duration, token };
  try {
    actor.setClip(clip, {
      once: true,
      onEnded: () => {
        if (petActionOverride?.token === token) { petActionOverride = null; syncCharacter(); }
      }
    });
  } catch { petActionOverride = null; toast('这个动作没加载出来'); return; }
  setBubble(label, Math.min(duration, 6000));
  toast(`小蓝鱼：${label}`);
  setTimeout(() => {
    if (petActionOverride?.token === token) { petActionOverride = null; syncCharacter(); }
  }, duration + 120);
}

// ── 动作队列（乐观串行）─────────────────────────────────────────────────
// 旧实现：`if (pendingAction) return;` —— 上一个请求没回来时，连点全部静默丢弃，
// 玩家看到的是「点了没反应」。现在改成队列：
//   · 点击立刻返回，视觉反馈（标记/音效/起身）由调用方当场给；
//   · 请求仍严格串行（服务端是「一条指令一个状态机」，并发没有意义）；
//   · 同种 go 合并成最新落点（连续点三个地方，只跑最后一个，这是玩家真想要的）；
//   · 队列上限 MOVE_TUNING.queueLimit，超员丢最旧的。
// pendingAction 仍表示「当前在路上的是哪个动作」，兼容原有读取点。
const actQueue = [];
let actPumpBusy = false;
let actSeq = 0;

// 返回值是一个 Promise（老代码里有 5 处 `await act(...)`，语义不变：等到这条动作
// 落地），同时这个 Promise 上挂了 .seq，点击链路靠它把「乐观位移」和这次请求对上号。
function queueAction(action, extra = {}) {
  const item = { action, extra, seq: ++actSeq };
  let settle = null;
  item.done = new Promise((resolve) => { settle = resolve; });
  item.settle = settle;
  if (action === 'go' && MOVE_TUNING.coalesceGo) {
    // 队列里还压着没发出去的 go → 用新落点顶掉它，别让她按点击顺序跳来跳去。
    // 被顶掉的那条立刻 resolve(false)，不会让 await 它的人永远挂着。
    for (let i = actQueue.length - 1; i >= 0; i -= 1) {
      if (actQueue[i].action === 'go') {
        const dropped = actQueue.splice(i, 1)[0];
        dropped.settle?.({ ok: false, coalesced: true, seq: dropped.seq });
        break;
      }
    }
  }
  actQueue.push(item);
  // 超员丢最旧：玩家的最后一下点击永远有效。
  while (actQueue.length > MOVE_TUNING.queueLimit) {
    const dropped = actQueue.shift();
    dropped.settle?.({ ok: false, overflow: true, seq: dropped.seq });
  }
  pumpActQueue();
  const promise = item.done;
  promise.seq = item.seq;
  return promise;
}

async function pumpActQueue() {
  if (actPumpBusy) return;
  actPumpBusy = true;
  try {
    while (actQueue.length) {
      const item = actQueue.shift();
      let result = { ok: true, seq: item.seq };
      try {
        result = await runAction(item.action, item.extra, item.seq);
      } catch (error) {
        result = { ok: false, error, seq: item.seq };
      }
      item.settle?.(result);
    }
  } finally {
    actPumpBusy = false;
    pendingAction = '';
  }
}

// act() 现在是「入队」，不再阻塞点击；await 它等于等这条动作落地。
function act(action, extra = {}) {
  return queueAction(action, extra);
}

async function runAction(action, extra, seq = 0) {
  pendingAction = action;
  try {
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, target: followTarget, by: actorTag(), ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      // 限流不是错误，是「手太快」：给一句能看懂的话，并且不要再排队重试。
      hint('rate', '动得太快了，等一下下再点');
      // 清队列时必须把每条都 settle 掉，否则外面那几处 `await act(...)` 会永远挂着。
      while (actQueue.length) {
        const dropped = actQueue.shift();
        dropped.settle?.({ ok: false, rate: true, seq: dropped.seq });
      }
      dropOptimistic(seq);
      return { ok: false, rate: true, seq };
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    const focus = characterNow();
    if (data.changed === false) {
      // 服务端合法化后判定「到不了」：撤销本地乐观位移，别让她停在非法位置。
      dropOptimistic(seq);
      if (focus?.asleep) hint('asleep', '她睡着了，先叫醒她再点');
      else hint('unreachable', '这里去不了，换块地面试试');
      return { ok: false, changed: false, seq };
    }
    if (data.home) applyState(data.home);
    else await poll();
    // 服务端认了这条 go：解除预测保护，之后的快照正常覆盖。
    if (optimisticGo && optimisticGo.seq === seq) {
      optimisticGo = null;
      optimisticUntil = 0;
      claudePredict = null;
    }
    const reactionText = data.event?.reaction;
    if (reactionText) setBubble(reactionText, 3800);
    const isClaude = followTarget === 'claude';
    // 小公主没有那 114 个立绘片段：她的动作靠片段 + 脸演出来，别照搬小蓝鱼的那套。
    // 九项必须各给各的片段：以前 pet/feed/water 全指 fold/tea/tea，
    // 玩家点「轻抚发梢」看到的是双手交叠，「递块点心」和「斟一杯水」一模一样。
    if (isClaude && claude) {
      const gesture = {
        pet: 'patShy',     // 轻抚发梢 → 缩了一下、脸红
        feed: 'patJoy',    // 递块点心 → 高兴地接过去
        water: 'hum',      // 斟一杯水 → 端着杯子哼一声
        play: 'happy',     // 陪她坐坐 → 开心
        talk: 'curtsy',    // 说句话 → 欠身应一声
        sleep: 'stretch',  // 劝她歇息 → 伸个懒腰
        wake: 'yawn',      // 轻声唤她 → 打着哈欠醒
        lamp: 'look',      // 调灯 → 抬眼看看灯
        meet: 'wave'       // 去小蓝鱼那儿 → 抬手招呼
      }[action];
      if (gesture) claude.playGesture(gesture);
    }
    let msg = { pet: isClaude ? '她眯起眼睛，轻轻晃了晃' : '她眯起眼睛，尾巴晃了一下', feed: isClaude ? '小点心被她接过去了' : '小鱼干被她叼走了', water: '她捧着杯子小口喝', play: '她被逗笑了', talk: '这句话贴到墙上了', sleep: '灯关了，她钻进被窝', wake: '她揉着眼睛坐起来', lamp: '灯换了状态', command: isClaude ? '小公主朝那边走过去' : '她朝那边走过去', go: isClaude ? '小公主朝你指的地方走过去' : '她朝你指的地方走过去', place: isClaude ? '小公主乖乖落在你放下的地方' : '她乖乖落在你放下的地方', meet: isClaude ? '小公主去找小蓝鱼了' : '她去找小公主了' }[action];
    // 同一句话半小时内重复，数值不重复记（去重窗口在 progress.json 的 talkDedupMs）。
    // 以前这种情况她的回应跟平时一模一样，玩家只会觉得「没反应、卡了」，
    // 于是开始刻意换说法——一种很怪的自我审查。换成她听懂了的话，不解释机制。
    const said = data.home?.[followTarget === 'claude' ? 'claude' : 'her']?.growth?.lastGrow;
    if (action === 'talk' && said?.deduped === true) {
      const pool = ['嗯，我记着呢。', '……你今天说过这句。', '我在。'];
      // 按这句话本身挑一句回应：同一句永远得到同一个反应，看着像她真的记得。
      const saidText = String(extra?.text || '');
      msg = pool[saidText.length % pool.length];
    }
    if (msg) toast(msg);
    // 去重时气泡短一点：不抢下一步操作，也不像在强调什么。
    setBubble(msg || '', said?.deduped === true ? 2600 : 3600);
    return { ok: true, seq, home: data.home || null };
  } catch (error) {
    dropOptimistic(seq);
    hint('net', `没接上：${error.message}`);
    return { ok: false, error: error.message, seq };
  } finally {
    pendingAction = '';
  }
}

let talkOpen = false;
// ── 亲密度「今天的账」 ────────────────────────────────────────────────
// 一个 +0.9 摆在那儿，玩家没法知道自己是被重复系数压了、还是撞到每日上限了。
// 服务端在 growBy 里把这些系数都算过一遍（lastGrow），这里只负责照着念，不重算。
let affAccountOpen = false;
const AFF_ACTION_NAME = {
  pet: '摸摸头', feed: '喂小鱼干', water: '倒杯水', talk: '留句话',
  play: '陪她玩', sleep: '哄她睡', wake: '叫醒', lamp: '开灯关灯',
  meet: '去串门', poke: '戳一下', command: '指个地方', go: '走过去',
  place: '放下', sick: '她不舒服', heal: '照顾她', visit: '进屋'
};

/** 把 0.87 显示成 0.87、2 显示成 2，末位不补 0；小于 0.01 但大于 0 显示成 <0.01。 */
function num2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  if (n < 0.01) return '<0.01';
  return String(Math.round(n * 100) / 100);
}

/**
 * 一句人话解释这次为什么涨这么点。顺序按「最可能让人困惑的原因」排：
 * 到顶了 → 说完了 → 打折了 → 正常。
 */
function growExplain(last) {
  if (!last) return '';
  const base = Number(last.base) || 0;
  const gain = Number(last.intimacy) || 0;
  // 一、同一句话：她今天已经听过这句了，数值不重复记。
  if (last.deduped) return '这句话今天说过了，不再记账';
  // 二、撞上限：今日额度已经吃光。
  if (last.capped && gain < base) {
    const left = Number(last.capLeft) || 0;
    return left <= 0 ? '今天的额度已经满了，明天再来' : `今天只剩 ${num2(left)} 的额度`;
  }
  // 三、打折：重复系数或边际递减把它压下来了。
  if (base > 0 && gain > 0 && gain < base * 0.995) {
    return `第 ${Number(last.times || 0) + 1} 次，按 ${Math.round((Number(last.factor) || 0) * 100)}% 记`;
  }
  // 四、标称值就是 0 的动作（生病、被戳到之类），别装作涨了。
  if (base <= 0) return '这个动作本来就不记账';
  return '';
}

function renderAffAccount() {
  const box = $('affAccount');
  if (!box) return;
  const row = $('affRow');
  if (row) {
    row.classList.toggle('open', affAccountOpen);
    row.setAttribute('aria-expanded', String(affAccountOpen));
  }
  if (!affAccountOpen) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  const g = (followTarget === 'claude' ? state?.claude : state?.her)?.growth || null;
  const last = g?.lastGrow || null;
  const cap = Number(g?.dailyCap) || 0;
  const got = Number(g?.gainedToday) || 0;
  const lines = [];
  if (last && (last.action || last.intimacy || last.xp)) {
    const name = AFF_ACTION_NAME[last.action] || last.action || '刚才那下';
    const gain = num2(last.intimacy);
    const sign = Number(last.intimacy) > 0 ? '+' : '';
    lines.push(`<b>${name} ${sign}${gain}</b>`);
    const why = growExplain(last);
    if (why) lines.push(`<span class="k">${why}</span>`);
    const parts = [];
    if (Number(last.base) > 0) parts.push(`标称 ${num2(last.base)}`);
    if (Number(last.times) > 0) parts.push(`今日第 ${Number(last.times) + 1} 次`);
    if (Number(last.decay) > 0 && Number(last.decay) < 0.999) parts.push(`边际 ×${num2(last.decay)}`);
    if (parts.length) lines.push(`<span class="k">${parts.join('　·　')}</span>`);
    lines.push(`<span class="k">经验 +${num2(last.xp)}</span>`);
  } else {
    lines.push('<span class="k">还没做什么，动一下就有了。</span>');
  }
  if (cap > 0) {
    // 今日进度：额度吃满时不再往下写，免得占一行字。
    const pct = Math.min(100, Math.round((got / cap) * 100));
    lines.push(`<span class="k">今日已记 ${num2(got)} / ${num2(cap)}（${pct}%）</span>`);
  }
  box.hidden = false;
  box.innerHTML = lines.join('');
}

function toggleAffAccount() {
  affAccountOpen = !affAccountOpen;
  renderAffAccount();
}

function openTalk() {
  talkOpen = !talkOpen;
  $('talk').classList.toggle('show', talkOpen);
  if (talkOpen) $('talkInput').focus();
}
async function sendTalk() {
  const text = $('talkInput').value.trim();
  if (!text) return;
  $('talkInput').value = '';
  $('talk').classList.remove('show');
  talkOpen = false;
  await act('talk', { text });
}

function showInfo(hs) {
  $('infoTitle').textContent = hs.title || '房间';
  $('infoKind').textContent = hs.label || '';
  $('infoSub').textContent = hs.sub || '';
  $('info').dataset.room = hs.room || '';
  $('info').dataset.spot = hs.spot || '';
  $('info').dataset.action = hs.action || '';
  const actionBtn = $('infoAction');
  if (actionBtn) {
    if (hs.action === 'book') {
      actionBtn.hidden = false;
      actionBtn.textContent = hs.actionLabel || '抽一本书';
    } else {
      actionBtn.hidden = true;
    }
  }
  $('info').classList.remove('hide');
}
$('infoClose').addEventListener('click', () => $('info').classList.add('hide'));
$('infoGo').addEventListener('click', () => {
  const room = $('info').dataset.room;
  const spot = $('info').dataset.spot;
  $('info').classList.add('hide');
  if (room && spot) act('command', { room, spot, target: followTarget });
});
$('infoAction')?.addEventListener('click', () => {
  const action = $('info').dataset.action;
  $('info').classList.add('hide');
  if (action === 'book') openBookPanel();
});

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}
function setBubble(text, ms = 4500) {
  if (!bubbleOn || !text || SHOT || VIEW.mode === 'eyes') return;
  const el = $('bubble');
  el.textContent = text;
  el.classList.add('show');
  bubbleUntil = Date.now() + ms;
}

// 按钮
document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const a = btn.dataset.act;
    if (a === 'talk') { openTalk(); return; }
    if (a === 'sleep') { act(lastSleep ? 'wake' : 'sleep'); return; }
    if (a === 'lamp') { act('lamp', { on: !(state?.env?.lamp) }); return; }
    act(a);
  });
});
document.querySelectorAll('[data-pet-clip]').forEach((button) => {
  button.addEventListener('click', () => playPetAction(button.dataset.petClip, button.dataset.petLabel || '动一下'));
});
// 「和她」那栏点一下展开今天的账。键盘也要能开，否则只能用鼠标。
const affRowEl = $('affRow');
if (affRowEl) {
  affRowEl.addEventListener('click', toggleAffAccount);
  affRowEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAffAccount(); }
  });
}

// 全动作抽屉：把 dsh-pet 的 114 个动画按组铺开，跟桌宠那边对得上。
// 点一下就地播放（still 只在立绘模式可用，playPetAction 里已经校验过）。
// 抽屉里锁着的片段说什么。用她的话，不用「等级不足/未解锁」这种系统口吻。
const LOCKED_LINES = {
  level: ['还不到时候。', '再等等。', '这个……以后吧。'],
  intimacy: ['……你还没到能看这个。', '先熟一点再说。'],
  both: ['两样都差一点。', '两样都还早。'],
};

// 当前成长快照（服务端下发）。没拿到时一律按「全解锁」处理，
// 免得离线/单机旧存档把整个抽屉锁死。
function growthNow() {
  const who = followTarget === 'claude' ? state?.claude : state?.her;
  return who?.growth || null;
}

function clipLocked(key) {
  const g = growthNow();
  const gate = CLIP_UNLOCKS?.[key];
  if (!g || !gate) return null;
  // 服务端下发的 clipLocks 优先（它才是权威，含反刷与版本差异）。
  // 它现在是个对象（line + 门槛 + 缺口），以前是纯字符串，读 .level 永远 undefined，
  // 于是每条都静默回退到本地表 —— 看着没坏，其实服务端那份数据一直没被用上。
  const fromServer = g.clipLocks && g.clipLocks[key];
  const needLevel = Number(fromServer?.level ?? gate.level) || 1;
  const needIntimacy = Number(fromServer?.intimacy ?? gate.intimacy) || 0;
  const levelShort = Number(g.level || 1) < needLevel;
  const intimacyShort = Number(g.intimacy || 0) < needIntimacy;
  if (!levelShort && !intimacyShort) return null;
  const kind = levelShort && intimacyShort ? 'both' : levelShort ? 'level' : 'intimacy';
  const pool = LOCKED_LINES[kind];
  return {
    kind,
    needLevel,
    needIntimacy,
    // 缺口：服务端算过就用它的，没算过（旧服务端）就本地补一次，口径一致。
    gapLevel: Number(fromServer?.gapLevel ?? Math.max(0, needLevel - Number(g.level || 1))) || 0,
    gapIntimacy: Number(fromServer?.gapIntimacy ?? Math.max(0, needIntimacy - Number(g.intimacy || 0))) || 0,
    // 她那句话也优先用服务端的（同一套 lockedLines），本地池只是兜底。
    line: fromServer?.line || pool[(key.charCodeAt(key.length - 1) + key.length) % pool.length],
  };
}

/**
 * 把「还差多少」说成人话。三种缺口三种说法，不说「等级不足」这种系统口吻。
 * 保留一位小数：poke / lamp 是 0.5，舍成整数会显示「还差 0 点」但其实还锁着。
 */
function gapText(lock) {
  if (!lock) return '';
  const gapLv = Number(lock.gapLevel) || 0;
  const gapIa = Number(lock.gapIntimacy) || 0;
  const iaTxt = gapIa > 0 ? `${Number.isInteger(gapIa) ? gapIa : gapIa.toFixed(1)} 点` : '';
  const lvTxt = gapLv > 0 ? `${gapLv} 级` : '';
  if (gapLv > 0 && gapIa > 0) return `还差 ${lvTxt}、${iaTxt}`;
  if (gapLv > 0) return `等级还差 ${lvTxt}`;
  if (gapIa > 0) return `还要再熟 ${iaTxt}`;
  return '';
}

function buildPetDrawer() {
  const box = $('petAllBody');
  if (!box) return;
  box.replaceChildren();
  const frag = document.createDocumentFragment();
  let openCount = 0;
  let total = 0;
  for (const [group, keys] of Object.entries(CLIP_GROUPS || {})) {
    const sec = document.createElement('div');
    sec.className = 'pet-group';
    const h = document.createElement('h4');
    h.textContent = `${group} · ${keys.length}`;
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'pet-group-grid';
    for (const key of keys) {
      total += 1;
      const label = CLIP_LABELS?.[key] || key;
      const lock = clipLocked(key);
      const b = document.createElement('button');
      b.type = 'button';
      if (lock) {
        // 锁定态：不置灰整排（那看着像坏了），压一层蒙版 + 她的一句话 + 还差多少。
        // 只给一句「还不到时候」，玩家会以为这些片段根本没做；
        // 把缺口写出来，他才知道这是进度，不是缺失内容。
        const gap = gapText(lock);
        const say = gap ? `${lock.line}（${gap}）` : lock.line;
        b.textContent = '？？？';
        b.title = say;
        b.className = 'locked';
        b.dataset.lockKind = lock.kind;
        b.addEventListener('click', () => {
          // 用她的嘴说出来，比系统提示不刺人
          setBubble(say, 3000);
          toast(say);
        });
      } else {
        openCount += 1;
        b.textContent = label;
        b.title = label;
        b.addEventListener('click', () => playPetAction(key, label));
      }
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    frag.appendChild(sec);
  }
  box.appendChild(frag);
  const sum = document.querySelector('#petAll summary');
  if (sum) sum.textContent = `全动作抽屉 · 已解锁 ${openCount} / ${total}`;
}
buildPetDrawer();
// 建抽屉时 state 还没到（clipLocked 一律返回 null，会全显示成解锁）。
// 拿到第一份带 growth 的快照后重建一次；之后只在成长变化时重建，避免每次轮询都重造 114 个按钮。
let drawerGrowthKey = '';
function refreshPetDrawerIfNeeded() {
  const g = growthNow();
  if (!g) return false;
  const key = `${followTarget}|${g.level}|${Math.floor(Number(g.intimacy) || 0)}|${Object.keys(g.clipLocks || {}).length}`;
  if (key === drawerGrowthKey) return false;
  drawerGrowthKey = key;
  buildPetDrawer();
  return true;
}

// 大小姐的姿态：她用的是手绘片段（claude-hq），每个按钮都要和她真做的那一下对上。
const CLAUDE_GESTURE_LINES = {
  curtsy: ['……你来了。', '不必客气，坐吧。'],
  wave: ['在这边。', '看见你了。'],
  read: ['这一页写得很好，我念给你听？', '等我把这段看完。'],
  star: ['……那边有什么？', '我看见了。'],
  fold: ['……', '我在听。'],
  tea: ['要不要也来一杯？', '刚泡好的。'],
  happy: ['……别看我。', '嗯，今天还行。'],
  stretch: ['坐久了。', '你也起来动一动。'],
  yawn: ['……几点了。', '再让我躺一会儿。']
};
document.querySelectorAll('[data-claude-gesture]').forEach((b) => {
  b.addEventListener('click', () => {
    const name = b.dataset.claudeGesture;
    const label = b.dataset.claudeLabel || name;
    if (!claudeReady || !claude) { toast('她还没走到屋里来'); return; }
    claude.playGesture(name);
    const face = { star: 'idle', fold: 'shy', happy: 'happy', yawn: 'sleep', tea: 'happy', stretch: 'idle' }[name] || 'idle';
    claude.setFace(face);
    const pool = CLAUDE_GESTURE_LINES[name] || ['……'];
    const line = pool[Math.floor(Math.random() * pool.length)];
    // 她的反馈走气泡，不进「刚刚发生」：那是两个人共同的事件流，别被姿态刷屏。
    setBubble(line, 5200);
    toast(`她${label}`);
  });
});

$('talkSend').addEventListener('click', sendTalk);
$('talkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTalk(); });

document.querySelectorAll('#cams button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.cam === 'overview' && VIEW.follow) resetView();
    else setMode(b.dataset.cam);
  });
});
$('clickMoveChip')?.addEventListener('click', () => {
  clickMoveOn = !clickMoveOn;
  localStorage.setItem('home-click-move', clickMoveOn ? '1' : '0');
  applyClickMovePref(true);
  if (!clickMoveOn) $('info').classList.add('hide');
});

$('viewChip')?.addEventListener('click', () => {
  if (charMode !== 'webm') { toast('这个视角切换只在立绘模式可用'); return; }
  spriteView = spriteView === 'free' ? 'front' : 'free';
  localStorage.setItem('home-sprite-view', spriteView);
  applySpriteViewPref();
  lastBackView = null;
  lastViewZone = null;
  syncCharacter();
  toast(spriteView === 'free' ? '自由朝向：待机也会随镜头转身' : '正面待机：站着看镜头，走路仍按方向');
});

$('followChip')?.addEventListener('click', () => {
  if (SIDE_LOCKED) {
    // 房内不许随手切：只能向对方发一个交换申请，两边都同意才换。
    requestSideSwap();
    return;
  }
  switchFollowTarget(followTarget === 'claude' ? 'her' : 'claude');
});
applySide();
switchFollowTarget(followTarget, true);
$('actorChip')?.addEventListener('click', promptActorName);
applyActorChip();

document.querySelectorAll('#camModeChip button[data-cam-mode]').forEach((button) => {
  button.addEventListener('click', () => setCameraMode(button.dataset.camMode));
});

function setTvOverlayMode(mode) {
  const overlay = $('tvOverlay');
  const video = $('tvOverlayVideo');
  if (!overlay) return;
  if (!tvStream) mode = 'off';
  if (!['off', '50', '80', 'full'].includes(mode)) mode = 'off';
  tvOverlayMode = mode;
  overlay.classList.remove('is-50', 'is-80', 'is-full');
  overlay.classList.toggle('on', mode !== 'off');
  if (mode !== 'off') overlay.classList.add(`is-${mode}`);
  if (video) {
    if (mode === 'off') {
      try { video.pause(); } catch {}
    } else {
      video.play().catch(() => {});
    }
  }
  const btn = $('tvSizeBtn');
  if (btn) {
    btn.textContent = mode === 'off' ? '电视 50%' : mode === '50' ? '电视 50%' : mode === '80' ? '电视 80%' : '电视 全屏';
    btn.classList.toggle('active', mode !== 'off');
  }
  overlay.setAttribute('aria-hidden', String(mode === 'off'));
}

function showTvQuote(text, ms = 6500) {
  const el = $('tvQuote');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (tvQuoteTimer) clearTimeout(tvQuoteTimer);
  tvQuoteTimer = setTimeout(() => {
    el.hidden = true;
    tvQuoteTimer = 0;
  }, ms);
}

function focusTvCompanion() {
  setMode('overview');
  VIEW.follow = false;
  VIEW.radius = 6.2;
  VIEW.az = 0;
  VIEW.elev = 0.44;
  VIEW.target.set(6.3, 0.95, 2.6);
}

function videoOpinionLine() {
  const mood = Number(state?.emotion?.mood);
  const high = [
    '这个好看，再看一个嘛。',
    '画面好漂亮，我记住了。',
    '你挑的？那我也觉得好看。'
  ];
  const mid = [
    '嗯，还行，挺下饭的。',
    '这个节奏有点慢，不过陪你看看。',
    '刚刚那个转场挺有意思。'
  ];
  const low = [
    '有点吵……我靠一会儿。',
    '这个我不太懂，但你喜欢就好。',
    '看一会儿就好，别熬太晚。'
  ];
  const pool = Number.isFinite(mood) && mood >= 70 ? high : Number.isFinite(mood) && mood < 38 ? low : mid;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showVideoOpinion() {
  if (!tvStream) { toast('先把抖音投到电视上，再看观后感'); return; }
  if (state?.her?.asleep) { toast('她睡着了，先叫醒她'); return; }
  const mood = Number(state?.emotion?.mood);
  // 先让她动起来（这一段是本地表情，不用等模型）。
  opinionClip = Number.isFinite(mood) && mood >= 70 ? 'react_happy' : Number.isFinite(mood) && mood < 38 ? 'idle_look' : 'react_shy';
  opinionUntil = Date.now() + 7000;
  lastOnceKey = '';
  lastOnceAt = 0;
  syncCharacter();
  // 真正的观后感要看画面。以前这里只从本地词库里随机挑一句，
  // 玩家点「观后感」听到的和屏幕上放的完全无关 —— 等于这个按钮是假的。
  // 现在真的截图去问，词库降级成接口失败时的兜底。
  requestTvOpinion(true).then(() => {
    if (opinionTimer) clearTimeout(opinionTimer);
    opinionTimer = setTimeout(() => {
      opinionUntil = 0;
      opinionClip = '';
      opinionTimer = 0;
      syncCharacter();
    }, 7100);
  }).catch(() => {
    const line = videoOpinionLine();
    setBubble(line, 7000);
    showTvQuote(`小蓝鱼：${line}`, 7000);
    if (opinionTimer) clearTimeout(opinionTimer);
    opinionTimer = setTimeout(() => {
      opinionUntil = 0;
      opinionClip = '';
      opinionTimer = 0;
      syncCharacter();
    }, 7100);
  });
}

async function watchTogether() {
  if (!tvStream) { toast('先把抖音投到电视上，再一起看'); return; }
  if (tvOverlayMode === 'off') setTvOverlayMode('50');
  focusTvCompanion();
  showTvQuote('小蓝鱼：我坐这儿，和你一起看。', 5200);
  setBubble('我坐这儿，和你一起看。', 5200);
  if (state?.her?.asleep) {
    await act('wake');
    setTimeout(() => act('command', { room: 'living', spot: 'tv' }), 900);
  } else {
    act('command', { room: 'living', spot: 'tv' });
  }
}

$('tvSizeBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先点右上角电视投屏'); return; }
  const next = tvOverlayMode === 'off' ? '50' : tvOverlayMode === '50' ? '80' : tvOverlayMode === '80' ? 'full' : 'off';
  setTvOverlayMode(next);
});
$('tvPrevBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: -1 }).then(() => toast('已切到上一个视频')).catch((error) => toast(error.message));
});
$('tvNextBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: 1 }).then(() => toast('已切到下一个视频')).catch((error) => toast(error.message));
});
$('tvControlBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏'); return; }
  if (!tvExtensionReady) { toast('没有检测到投屏控制扩展，请按 README 安装'); return; }
  tvControlOn = !tvControlOn;
  applyTvControlPref();
  toast(tvControlOn ? '投屏控制已开启：在电视画面里移动/点击/滚动鼠标' : '投屏控制已关闭');
});
$('tvOverlay')?.addEventListener('pointermove', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  const now = performance.now();
  if (now - tvLastMoveAt < 55) return;
  tvLastMoveAt = now;
  const p = tvContentPoint(e);
  sendTvCommand('move', p).catch(() => {});
});
$('tvOverlay')?.addEventListener('pointerdown', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  tvPointerStart = { x: e.clientX, y: e.clientY };
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
});
$('tvOverlay')?.addEventListener('pointerup', (e) => {
  if (!tvControlOn || !tvExtensionReady || !tvPointerStart) return;
  const moved = Math.hypot(e.clientX - tvPointerStart.x, e.clientY - tvPointerStart.y);
  tvPointerStart = null;
  if (moved < 7) {
    const p = tvContentPoint(e);
    sendTvCommand('click', p).catch((error) => toast(error.message));
  }
});
$('tvOverlay')?.addEventListener('wheel', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  const p = tvContentPoint(e);
  sendTvCommand('wheel', { ...p, deltaY: e.deltaY > 0 ? 1 : -1 }).catch(() => {});
}, { passive: false });
$('tvFollowBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏，再让她跟过来'); return; }
  tvFollowOn = !tvFollowOn;
  applyTvFollow();
  if (tvFollowOn) {
    void takeHerToTv();
    toast(`${followTarget === 'claude' ? '小公主' : '小蓝鱼'}跟过来了：她在左下角陪你一起看电视`);
  } else {
    toast(`${followTarget === 'claude' ? '小公主' : '小蓝鱼'}不再跟随；电视还在继续`);
  }
});
$('tvCompanionSize')?.addEventListener('input', (event) => {
  tvCompanionSize = Math.max(160, Math.min(520, Number(event.target.value) || 320));
  localStorage.setItem('home-tv-companion-size', String(tvCompanionSize));
  applyTvCompanionSize();
});
$('tvCompanionBubbleBtn')?.addEventListener('click', () => {
  tvBubbleOn = !tvBubbleOn;
  localStorage.setItem('home-tv-bubble', tvBubbleOn ? '1' : '0');
  applyTvBubblePref();
  syncTvOpinionTimer();
  if (tvBubbleOn && tvFollowOn && tvStream) requestTvOpinion(false);
  if (btn) { btn.textContent = `气泡 ${tvBubbleOn ? '开' : '关'}`; btn.classList.toggle('active', tvBubbleOn); }
  else if (!tvBubbleOn) toast('气泡已关闭');
});
$('tvCompanionShotBtn')?.addEventListener('click', () => requestTvOpinion(true));
$('tvWatchBtn')?.addEventListener('click', watchTogether);
$('tvOpinionBtn')?.addEventListener('click', showVideoOpinion);
$('tvStopBtn')?.addEventListener('click', () => stopTvCast('电视已关闭'));

$('tvChip')?.addEventListener('click', () => {
  if (tvStream) { stopTvCast('已停止电视投屏'); return; }
  startTvCast();
});

$('studyChip')?.addEventListener('click', () => {
  if (studyStream) { stopStudyCast('已停止书房投屏'); return; }
  startStudyCast();
});
$('studyGameBtn')?.addEventListener('click', () => {
  if (GAME.running) {
    GAME.stop();
    toast('小游戏已关闭');
    const btn = $('studyGameBtn');
    if (btn) setIconLabel(btn, 'game', '小游戏');
    return;
  }
  GAME.start();
  const btn = $('studyGameBtn');
  if (btn) setIconLabel(btn, 'pause', '结束游戏');
  if (!studyStream) {
    toast('打砖块已投到书房大屏（未开投屏，游戏独立运行）');
  } else {
    toast('打砖块已叠加到书房大屏，投屏画面当背景');
  }
});
$('studyStopBtn')?.addEventListener('click', () => stopStudyCast('书房投屏已关闭'));
$('studyOpinionBtn')?.addEventListener('click', () => requestStudyOpinion(true));
$('studyFollowBtn')?.addEventListener('click', () => {
  if (!studyStream && !GAME.running) { toast('先打开书房投屏'); return; }
  void takeHerToStudy();
  toast('小蓝鱼去书房沙发旁陪你');
});

$('soundChip')?.addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('home-sound', soundOn ? '1' : '0');
  applySoundPref();
  if (soundOn) {
    unlockAudio();
    playClick();
  }
});

$('bubbleChip')?.addEventListener('click', () => {
  bubbleOn = !bubbleOn;
  localStorage.setItem('home-bubble', bubbleOn ? '1' : '0');
  applyBubblePref();
  if (bubbleOn && state?.her?.activity) setBubble(state.her.activity, 3600);
});

document.querySelectorAll('#modeChip button').forEach((b) => {
  b.addEventListener('click', async () => {
    const next = b.dataset.mode;
    if (next === '3d' && !modelReady && !chibiReady) toast('正在加载 3D 模型…');
    charMode = next;
    if (charMode === '3d') {
      const ok = await ensure3d();
      if (!ok) {
        charMode = 'webm';
        toast('3D 模型没加载成功，先看立绘');
      } else {
        toast(modelReady ? '成品 3D 模型已就位' : '3D 占位模型已就位');
        focusCharacter();
      }
    }
    if (charMode === 'webm' && VIEW.follow) resetView();
    localStorage.setItem('home-char-mode', charMode);
    applySpriteViewPref();
    document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
    applyCharVisibility();
    setMode(VIEW.mode);
  });
});
$('modelQualityChip')?.addEventListener('click', switchModelQuality);
updateModelQualityChip(false);
document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
applyBubblePref();
applyClickMovePref();
applySoundPref();
applySpriteViewPref();
applyCameraModePref();
applyTvCastChip();
// 小公主 3D 小人：首屏就加载，等 state.claude 来了自然可见（不依赖立绘/3D 切换）。
ensureClaude().catch(() => { claudeReady = false; });

// ── 房间私聊：每位住户各自一条会话，不经过 QQ ────────────────────────────────
const CHAT_KEY = 'home-room-chat-v1';
const CHAT_KEY_CLAUDE = 'home-room-chat-claude-v1';
const CHAT_KEY_GROUP = 'home-room-chat-group-v1';
const CHAT_KEY_PEER = 'home-room-chat-peer-v1';
// 「一起看」：投屏时她说的话单独存一条，翻得回去。
// 不并进 her/claude 私聊，是因为那些话不是回答玩家，混进去会把对话线冲散。
const CHAT_KEY_TV = 'home-room-tv-v1';
let chatHistory = [];
let chatHistoryClaude = [];
let chatHistoryGroup = [];
let chatHistoryPeer = [];
let chatHistoryTv = [];
let chatSending = false;
let chatOpen = false;
// 五种通道：'her' | 'claude' | 'group' | 'peer' | 'tv'
//   her/claude —— 单人私聊（服务端按 pid 隔离会话，两人互不影响）
//   group      —— 两人 + 角色的群聊，上下文权威是中继日志
//   peer       —— 玩家↔玩家，不调模型、不产生 AI 回复
//   tv         —— 投屏时的独白，只写不读模型（不占会话上下文）
let chatTarget = SIDE_LOCKED ? SIDE : 'her';

// 玩家身份：服务端用它做会话隔离与消息分账。
// 与 profile 里的 pid 同源，缺省时生成一次并落 localStorage。
function chatPid() {
  try {
    let pid = localStorage.getItem('dafiyu-player-id');
    if (!pid) {
      pid = `p_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('dafiyu-player-id', pid);
    }
    return pid;
  } catch { return 'host'; }
}

// 对方玩家的 id：只在真正连上双人房时才有值。
// 拿不到就保持 null —— peer 标签会隐藏，而不是发出去石沉大海。
function peerPid() {
  try {
    const v = globalThis.__netPeerId || localStorage.getItem('home-peer-id');
    return v ? String(v) : null;
  } catch { return null; }
}

function chatKeyFor(target) {
  if (target === 'claude') return CHAT_KEY_CLAUDE;
  if (target === 'group') return CHAT_KEY_GROUP;
  if (target === 'peer') return CHAT_KEY_PEER;
  if (target === 'tv') return CHAT_KEY_TV;
  return CHAT_KEY;
}
function chatStoreFor(target) {
  if (target === 'claude') return chatHistoryClaude;
  if (target === 'group') return chatHistoryGroup;
  if (target === 'peer') return chatHistoryPeer;
  if (target === 'tv') return chatHistoryTv;
  return chatHistory;
}
function setChatStore(target, arr) {
  if (target === 'claude') chatHistoryClaude = arr;
  else if (target === 'group') chatHistoryGroup = arr;
  else if (target === 'peer') chatHistoryPeer = arr;
  else if (target === 'tv') chatHistoryTv = arr;
  else chatHistory = arr;
}
function loadRoomChat(target = 'her') {
  try {
    const arr = JSON.parse(localStorage.getItem(chatKeyFor(target)) || '[]');
    if (Array.isArray(arr)) {
      setChatStore(target, arr.filter((m) => m && ['me', 'her', 'other', 'sys'].includes(m.role) && typeof m.text === 'string').slice(-80));
    }
  } catch { setChatStore(target, []); }
}
function saveRoomChat(target = chatTarget) {
  try { localStorage.setItem(chatKeyFor(target), JSON.stringify(chatStoreFor(target).slice(-80))); } catch {}
}
function chatLine(role, text, extra = '') {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}${extra}`;
  el.textContent = text;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}
function renderRoomChat() {
  const log = $('chatLog');
  if (!log) return;
  log.replaceChildren();
  for (const m of chatStoreFor(chatTarget)) chatLine(m.role, m.text);
  log.scrollTop = log.scrollHeight;
}
function addRoomChat(role, text, persist = true) {
  const store = chatStoreFor(chatTarget);
  if (persist) {
    store.push({ role, text: String(text), at: Date.now() });
    setChatStore(chatTarget, store.slice(-80));
    saveRoomChat(chatTarget);
  }
  return chatLine(role, String(text));
}
function setChatTarget(target, force = false) {
  const next = ['claude', 'group', 'peer', 'tv'].includes(target) ? target : 'her';
  // 锁定的那一端不允许把会话切到另一位住户身上；群聊、玩家互通、一起看都不受限。
  if (SIDE_LOCKED && (next === 'her' || next === 'claude') && next !== SIDE) return;
  // 没连上对方时 peer 不可用
  if (next === 'peer' && !peerPid()) return;
  const same = chatTarget === next;
  if (same && !force) return;
  chatTarget = next;
  $('chatTabHer')?.classList.toggle('active', next === 'her');
  $('chatTabClaude')?.classList.toggle('active', next === 'claude');
  $('chatTabGroup')?.classList.toggle('active', next === 'group');
  $('chatTabPeer')?.classList.toggle('active', next === 'peer');
  $('chatTabTv')?.classList.toggle('active', next === 'tv');
  const ph = {
    her: '想和她说点什么…',
    claude: '想和小公主说点什么…',
    group: '两个人都能听见…',
    peer: '只有你们两个人看得到…',
    tv: '一起看的时候她说的话都记在这儿…'
  }[next];
  if ($('chatInput')) $('chatInput').placeholder = ph;
  const note = {
    her: '房间私聊 · 服务端按玩家隔离 · 不经过 QQ',
    claude: '房间私聊 · 服务端按玩家隔离 · 不经过 QQ',
    group: '群聊 · 两人和住户都在 · 每轮一位住户开口',
    peer: '玩家互通 · 不进模型 · 只有你们两人可读',
    tv: '一起看 · 投屏时她说的话 · 只存本地'
  }[next];
  const noteEl = document.querySelector('#roomChat .chat-note');
  if (noteEl) noteEl.textContent = note;
  renderRoomChat();
  if (!same) $('chatInput')?.focus();
}
function setRoomChatOpen(open) {
  chatOpen = !!open;
  $('roomChat').hidden = !chatOpen;
  $('chatToggle').classList.toggle('open', chatOpen);
  const whoLabel = SIDE === 'claude' ? '大小姐' : '她';
  $('chatToggle').textContent = chatOpen ? '收起聊天' : `和${whoLabel}聊聊`;
  if (chatOpen) {
    renderRoomChat();
    setTimeout(() => $('chatInput')?.focus(), 80);
  }
}

async function sendRoomChat() {
  if (chatSending) return;
  const input = $('chatInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  const target = chatTarget;
  const isGroup = target === 'group';
  const isPeer = target === 'peer';
  const isClaude = target === 'claude';
  input.value = '';
  chatSending = true;
  $('chatSend').disabled = true;
  addRoomChat('me', text);
  // 玩家互通不调模型，没有"正在想"这一行
  const typing = isPeer ? null : chatLine('her', isGroup ? '等她们回应…' : (isClaude ? '等待小公主回复…' : '等待回复…'), ' typing');
  try {
    const payload = { text, pid: chatPid(), name: playerName() };
    if (isGroup) payload.channel = 'group';
    else if (isPeer) { payload.channel = 'peer'; payload.peer = peerPid(); }
    else payload.target = target;

    const res = await fetch(api('/api/room/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && data.cooldown) {
      // 冷却：给一行提示，把刚发的字退回输入框，别让玩家白打字
      chatLine('sys', data.error || '说太快了，缓一缓');
      if (input) { input.value = text; }
      return;
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);

    if (isPeer) {
      // 对方看不到即时回执；这一条只是确认已送达服务端
      return;
    }
    const reply = String(data.reply || '嗯。');
    if (chatTarget === target) addRoomChat('her', reply);
    else {
      const store = chatStoreFor(target);
      store.push({ role: 'her', text: reply, at: Date.now() });
      setChatStore(target, store.slice(-80));
      saveRoomChat(target);
    }
  } catch (error) {
    chatLine('sys', `没接上：${error?.message || error}`);
  } finally {
    typing?.remove();
    chatSending = false;
    $('chatSend').disabled = false;
    $('chatInput')?.focus();
  }
}

// 显示用的玩家名（只用于群聊/互通的署名，不参与身份判断）
function playerName() {
  try { return String(localStorage.getItem('home-actor-name') || '').trim() || '你'; } catch { return '你'; }
}

$('chatToggle')?.addEventListener('click', () => setRoomChatOpen(!chatOpen));
$('chatClose')?.addEventListener('click', () => setRoomChatOpen(false));
$('chatForm')?.addEventListener('submit', (event) => { event.preventDefault(); sendRoomChat(); });
$('chatTabHer')?.addEventListener('click', () => setChatTarget('her'));
$('chatTabClaude')?.addEventListener('click', () => setChatTarget('claude'));
$('chatTabGroup')?.addEventListener('click', () => setChatTarget('group'));
$('chatTabTv')?.addEventListener('click', () => setChatTarget('tv'));
$('chatTabPeer')?.addEventListener('click', () => setChatTarget('peer'));
loadRoomChat('her');
loadRoomChat('claude');
loadRoomChat('group');
loadRoomChat('peer');
loadRoomChat('tv');
// 连上对方时才显示互通标签
if (peerPid() && $('chatTabPeer')) {
  $('chatTabPeer').hidden = false;
  $('chatTabPeer').textContent = `她（${String(peerPid()).slice(0, 6)}）`;
}
if (!chatHistory.length) {
  addRoomChat('her', '嗯？我在。想说什么就说吧。');
} else {
  renderRoomChat();
}
if (!chatHistoryClaude.length) {
  const keep = chatTarget;
  chatTarget = 'claude';
  addRoomChat('her', '……你来了呀。要不要坐一会儿？');
  chatTarget = keep;
  saveRoomChat('claude');
}
// 锁定的那一端只能和这一位说话：把会话标签收起来，只在标题里写她的名字。
if (SIDE_LOCKED) setChatTarget(SIDE, true);

if (charMode === '3d') actor.setVisible(false);
applyCharVisibility();

// ── 轮询 ──────────────────────────────────────────────────────────────────
async function poll() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const res = await fetch(withToken('/api/home/state'), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    applyState(data);
    $('qqChip').classList.add('online');
  } catch (error) {
    $('qqText').textContent = '连不上桥接';
    if (!state) {
      $('activityText').textContent = '桥接还没起来，先把房间亮着。';
    }
  } finally {
    requestInFlight = false;
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let prevT = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let lastAdapt = 0;
let ratio = renderer.getPixelRatio();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now - prevT) / 1000);
  prevT = now;
  gardenController?.tick(now);
  updateOpenView(dt);
  updateCamera(dt);

  const her = state?.her;
  if (her) {
    let displayPos = her.pos;
    // P-A：本地已经点了「去那儿」但服务端还没回话时，her.walking 仍是旧的 false。
    // 只看 her.walking 会让她站着不动，看起来像「点了没反应」——所以这里把
    // 「有未确认的 go」也算成在走，让她立刻起步，剩余路程等快照追上。
    const optimistic = hasUnconfirmedGo();
    if (walkPredict && (her.walking || optimistic)) {
      const elapsed = Math.max(0, (performance.now() - walkPredict.at) / 1000);
      displayPos = advanceRoute(walkPredict.points, walkPredict.start, walkPredict.speed * elapsed);
    }
    const dragging = !!charDrag?.active && charDrag.who !== 'claude';
    if (dragging) displayPos = charDrag.pos;
    else if (placeHold && performance.now() < placeHold.until) displayPos = placeHold.pos;
    else {
      // 残差补偿：把「本地预测 − 服务端」的差额按指数衰减叠加回去，
      // 修正量随 dt 单调收敛，不会产生来回抖动，也不会一帧跳回去。
      const res = residualNow();
      if (res[0] || res[1]) displayPos = [displayPos[0] + res[0], displayPos[1] + res[1]];
    }
    const walkingNow = (her.walking || optimistic) && !dragging && !placeHold;
    lastDisplayPos = displayPos;
    const backNow = isBackView();
    // 镜头从正面转到侧面时，虽然背面状态没变，也要切到侧跑帧。
    const viewZone = (her.walking || optimistic) ? (isSideRun(her) ? 'side' : 'front') : (backNow ? 'back' : 'front');
    if (viewZone !== lastViewZone) {
      lastViewZone = viewZone;
      if (!dragging && !placeHold) syncCharacter();
    }
    lastBackView = backNow;
    world.updateCutaway(camera.position, new THREE.Vector3(displayPos[0], 1, displayPos[1]), VIEW.mode !== 'first' && VIEW.mode !== 'eyes');
    const facing = (her.facing || 0) * Math.PI / 180;
    gardenController?.updateCharacter(dragging || placeHold || VIEW.mode === 'eyes' ? { ...her, gardenWork: null } : her, { x: displayPos[0], y: her.elev || 0, z: displayPos[1] }, facing);
    // run_hurry 原片是“朝左跑”：只有侧面跑时按屏幕横向速度决定是否镜像；
    // 正面/背面/待机不镜像，避免左右脸和朝向突然翻面。
    let flip = false;
    if (charMode === 'webm' && isSideRun(her) && !dragging && !placeHold) {
      camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const move = new THREE.Vector3(Math.sin(facing), 0, -Math.cos(facing));
      flip = move.dot(right) > 0.02;
    }
    actor.update(dt, camera, {
      pos: displayPos, elev: her.elev || 0, walking: walkingNow, flip
    });
    const pose = {
      pos: displayPos, elev: her.elev, pose: her.pose, kind: her.kind, walking: walkingNow,
      facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
    };
    if (modelReady && model3d) {
      model3d.setPose(pose);
      model3d.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    if (chibiReady && chibi && !modelReady) {
      chibi.setPose(pose);
      chibi.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    applyCharVisibility();
  }

  // 小公主：常驻程序化 3D，跟 her 一样的位置插值；她也支持长按拖动（锁定端唯一能挪的人）。
  if (state?.claude && claudeReady && claude) {
    let cPos = state.claude.pos;
    const dragClaude = !!charDrag?.active && charDrag.who === 'claude';
    // 和 her 同理：本地已经发了 go、服务端还没回话时，state.claude.walking 还是旧的
    // false，只看它会让小公主站着不动（看起来像「点了没反应」）。
    const claudeOptimistic = hasUnconfirmedClaudeGo();
    if (dragClaude) cPos = charDrag.pos;
    else if (claudePredict && (state.claude.walking || claudeOptimistic)) {
      const elapsed = Math.max(0, (performance.now() - claudePredict.at) / 1000);
      cPos = advanceRoute(claudePredict.points, claudePredict.start, claudePredict.speed * elapsed);
    } else if (state.claude.walking && Array.isArray(state.claude.route) && state.claude.route.length > 1) {
      const elapsed = Math.max(0, (performance.now() - claudeWalkAt) / 1000);
      cPos = advanceRoute(state.claude.route, state.claude.pos, Math.max(0.5, Number(state.claude.speed) || 1.05) * elapsed);
    }
    const claudeWalking = dragClaude ? false : (state.claude.walking || claudeOptimistic);
    claude.setPose({
      pos: cPos, elev: dragClaude ? 0 : state.claude.elev, pose: dragClaude ? 'stand' : state.claude.pose,
      kind: state.claude.kind,
      walking: claudeWalking, facing: state.claude.facing, asleep: state.claude.asleep,
      activity: state.claude.activity
    });
    lastClaudePos = cPos;
    claude.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !claudeWalking && !state.claude.gardenWork });
  }
  updateBounce(now);

  // 气泡：跟随当前指挥对象（指挥小公主时挂她头上）。
  if (bubbleOn && !SHOT && state?.her && VIEW.mode !== 'eyes') {
    const show = Date.now() < bubbleUntil;
    const el = $('bubble');
    const bpOwner = characterNow() || state.her;
    const bp = followTarget === 'claude' && state.claude ? (lastClaudePos || state.claude.pos) : (lastDisplayPos || state.her.pos);
    if (show) {
      const p = new THREE.Vector3(
        bp[0],
        (bpOwner.elev || 0) + (bpOwner.asleep ? 0.75 : 1.72),
        bp[1]
      );
      p.project(camera);
      if (p.z < 1) {
        const x = (p.x * 0.5 + 0.5) * innerWidth;
        const y = (-p.y * 0.5 + 0.5) * innerHeight;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.classList.add('show');
      } else el.classList.remove('show');
    } else el.classList.remove('show');
  } else $('bubble').classList.remove('show');

  if (clickMarkerUntil) {
    const left = clickMarkerUntil - performance.now();
    if (left <= 0) {
      clickMarker.visible = false;
      clickMarkerUntil = 0;
    } else {
      const k = Math.min(1, left / 1300);
      clickMarker.material.opacity = 0.95 * k;
      clickMarker.scale.setScalar(1 + (1 - k) * 0.55);
    }
  }

  if (tvStream && tvMat) tvMat.emissiveIntensity = 0.95;
  renderer.render(scene, camera);
  world.setClock?.(state?.hour || 0, 0);

  // 自适应：帧率低了降像素比，连续高了再升回来
  fpsAcc += dt; fpsN += 1;
  if (fpsN >= 60 && now - lastAdapt > 8000 && !SHOT) {
    const fps = fpsN / fpsAcc;
    fpsAcc = 0; fpsN = 0;
    lastAdapt = now;
    if (fps < 42 && ratio > 1.0) {
      ratio = Math.max(1.0, ratio - 0.2);
      renderer.setPixelRatio(ratio);
    } else if (fps > 57 && ratio < Math.min(devicePixelRatio || 1, 1.35)) {
      ratio = Math.min(Math.min(devicePixelRatio || 1, 1.35), ratio + 0.1);
      renderer.setPixelRatio(ratio);
    }
  }
}

// 灯影刷新：太阳角度变了才重画阴影
const origUpdateEnv = world.updateEnvironment;
world.updateEnvironment = (opts) => {
  const r = origUpdateEnv(opts);
  if (r?.shadowDirty) renderer.shadowMap.needsUpdate = true;
  return r;
};

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (gardenController?.isOpen) focusGarden();
}
addEventListener('resize', onResize);

// Garden camera looks back toward the house from the north yard.
function focusGarden() {
  const framing=getGardenFraming(innerWidth,innerHeight,$('garden-panel')?.getBoundingClientRect().left);
  setMode('overview');VIEW.follow=false;VIEW.az=framing.az;VIEW.elev=framing.elev;VIEW.radius=framing.radius;
  VIEW.target.set(...framing.target);world.setLabelsVisible(false);world.setCeilingVisible(false);
  camera.fov=framing.fov;camera.setViewOffset(innerWidth,innerHeight,framing.offsetX,framing.offsetY,innerWidth,innerHeight);
  $('info').classList.add('hide');
}
// 同行点数兑换：走屋子的账本接口，直接把 home 快照换回来。
// 不走 act() 的队列 —— 兑换不是「对角色做一个动作」，排队会让它排在一次摸头后面，
// 玩家点完小柜子要等前面的动作播完才有反应。
async function claimTogetherOffer(offer, noteText = '') {
  if (!offer) return { ok: false, message: '不知道要换哪一样。' };
  try {
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim', offer, text: String(noteText || ''), target: followTarget, by: actorTag() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, message: data.error || '这次没换成，等一下再试。' };
    }
    if (data.home) applyState(data.home);
    const text = data.event?.text || '';
    if (text) setBubble(text, 3200);
    renderHUD();
    return { ok: true, message: text || '换到了。' };  } catch {
    return { ok: false, message: '连接断了，这一步还没确认。' };
  }
}

// 递礼物：和 claim 一样走屋子的账本，不排队 —— 递东西不该排在一次摸头后面。
// 失败时把服务端的 reason 原样带回去，界面才说得出「还差 3 鲸元券」。
async function giveGiftOffer(giftId) {
  if (!giftId) return { ok: false, message: '不知道要递哪一件。' };
  return homeActQuietly({ action: 'buy', gift: giftId }, '这次没递成，等一下再试。');
}

// 收下玄关的回礼：不带 gift 就是「最早到点的那一件」。
async function claimGiftReturn(giftId = '') {
  return homeActQuietly({ action: 'return', gift: giftId }, '玄关这会儿什么都没有。');
}

/**
 * 「不对角色做动作」的那一类请求（claim / buy / return）共用的发法：
 * 不走 act() 的队列，直接把 home 快照换回来，失败时把服务端的理由带出去。
 */
async function homeActQuietly(payload, fallbackMessage) {
  try {
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, target: followTarget, by: actorTag() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, message: data.error || data.message || fallbackMessage };
    }
    if (data.changed === false) {
      // 服务端认了请求但没有变化：这时候 error/message 里通常有原因。
      return { ok: false, message: data.error || data.message || fallbackMessage };
    }
    if (data.home) applyState(data.home);
    const text = data.event?.text || '';
    if (text) setBubble(text, 3200);
    renderHUD();
    return { ok: true, message: text || '好了。' };
  } catch {
    return { ok: false, message: '连接断了，这一步还没确认。' };
  }
}

function gardenHomeAction(action) {
  // 同行点数兑换走屋子的账本（/api/home/act），不是菜园接口。
  if (action && typeof action === 'object' && action.action === 'claim') {
    return claimTogetherOffer(action.offer, action.text);
  }
  // 递礼物同理：action=buy，带的是 gift id 而不是 offer。
  if (action && typeof action === 'object' && action.action === 'buy') {
    return giveGiftOffer(action.gift);
  }
  // 收回礼：玄关那件东西，点一下就取回来。
  if (action && typeof action === 'object' && action.action === 'return') {
    return claimGiftReturn(action.gift || '');
  }
  if (action === 'talk') {
    const text = window.prompt('留一句话给她：');
    if (!text?.trim()) return;
    act('talk', { text: text.trim() });
    return;
  }
  if (action === 'lamp') {
    act('lamp', { on: !(state?.env?.lamp) });
    return;
  }
  act(action);
}
if (!SHOT) {
  gardenController=createGardenClient({world,renderer,camera,api,who:SIDE||followTarget,onOpen:focusGarden,onClose:()=>{camera.fov=40;camera.clearViewOffset();resetView();},onHomeAction:gardenHomeAction,getTogether:()=>state?.together||null,getGrowth:()=>growthNow()});
  $('gardenChip').addEventListener('click',()=>gardenController.toggle());
  window.__gardenDebug=()=>gardenController.inspect();
}

// ── 房内交换身份 ──────────────────────────────────────────────────────────
// 双人局进房时已经定了这一端住哪一侧（菜单里选的），房内不许随手切：
// 点「指挥」或联机面板里的「申请交换」都走这里 —— 发一个申请，对面点同意才换。
// 单机/没连上时这就是一句提示，不改变任何状态。
function requestSideSwap() {
  const duo = globalThis.__duo;
  if (!duo) {
    toast(SIDE === 'claude' ? '这一端是小公主这一侧，只能陪她' : '这一端是小蓝鱼这一侧，只能陪她');
    return;
  }
  // 联机面板里的「申请交换」按钮是这个流程的正门；这里只是把面板叫出来。
  try {
    const panel = globalThis.__netSwap;
    if (typeof panel === 'function') { panel(); return; }
  } catch { /* 忽略 */ }
  toast('打开右下角「屋里的人 / 说话」，在身份那一行点「申请交换」');
}

// net-duo 在双方都同意之后回调这里：整页跟着换人。
globalThis.__sideChanged = (side) => {
  if (side !== 'her' && side !== 'claude') return;
  setSide(side);
  toast(`身份换过来了：现在陪${side === 'claude' ? '小公主' : '小蓝鱼'}`);
};

// ── 启动 ──────────────────────────────────────────────────────────────────
// 调试入口：无头截图/现场排查时可从控制台读取，不暴露用户数据。
window.__homeDebug = () => ({
  charMode, modelReady, chibiReady,
  actorVisible: !!actor?.visible,
  modelVisible: !!model3d?.group?.visible,
  modelPos: model3d?.group ? model3d.group.position.toArray().map((v) => +v.toFixed(2)) : null,
  statePos: state?.her?.pos || null,
  displayPos: lastDisplayPos || null,
  walking: !!state?.her?.walking,
  asleep: !!state?.her?.asleep,
  bounceY: +charWrap.scale.y.toFixed(3),
  spriteView, backView: lastBackView,
  tvCasting: !!tvStream,
  chatOpen, chatMessages: chatHistory.length,
  soundOn, soundState: document.getElementById('soundState')?.textContent || null,
  audioState: audioCtx?.state || null,
  clickSfxReady: clickSfx?.readyState ?? null,
  clickMoveOn, clickMoveState: document.getElementById('clickMoveState')?.textContent || null,
  cameraMode, cameraKeyboard: cameraUsesKeyboard(), cameraMouse: cameraUsesMouse(),
  bubbleOn, bubbleVisible: !!document.getElementById('bubble')?.classList.contains('show'),
  bubbleLabel: document.getElementById('bubbleState')?.textContent || null,
  bubbleClass: document.getElementById('bubbleChip')?.className || null,
  spot: state?.her?.spot || null,
  clip: actor?.current || null,
  wantClip: state?.her ? clipFor(state.her) : null,
  charScreen: (() => {
    const dp = lastDisplayPos || state?.her?.pos;
    if (!dp) return null;
    const p = new THREE.Vector3(dp[0], (state?.her?.elev || 0) + 0.85, dp[1]).project(camera);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: p.z };
  })(),
  actorSrc: actor?.layers?.[actor.active]?.src || null,
  actorReadyState: actor?.layers?.[actor.active]?.video?.readyState ?? null,
  actorError: actor?.layers?.[actor.active]?.video?.error?.code ?? null,
  sleepPhase,
  clipLog: actor?.clipLog?.slice(-8) || [],
  loadLog: actor?.layers?.map((l, i) => ({ i, src: l.src, rs: l.video.readyState, log: l.loadLog.slice(-4) })) || [],
  runStyle: state?.her?.runStyle || null,
  herRoom: state?.her?.room || null,
  // 小公主：可视化探针（验收用）
  claudeReady: !!claudeReady,
  claudeKind: claude ? claude.constructor?.name || null : null,
  claudeVisible: !!claude?.group?.visible,
  claudeRoom: state?.claude?.room || null,
  claudeSpot: state?.claude?.spot || null,
  claudePos: claude?.group ? claude.group.position.toArray().map((v) => +v.toFixed(2)) : null,
  claudeStatePos: state?.claude?.pos || null,
  claudeScreen: (() => {
    const cp = claude?.group?.position;
    if (!cp) return null;
    const p = new THREE.Vector3(cp.x, cp.y + 0.85, cp.z).project(camera);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: p.z };
  })(),
  followTarget,
  dragWho: charDrag?.who || null,
  claudeGesture: claude?._gesture || null,
  camera: camera.position.toArray().map((v) => +v.toFixed(2)),
  target: VIEW.target.toArray().map((v) => +v.toFixed(2)),
  camLook: camLook.toArray().map((v) => +v.toFixed(2)),
  cameraQuat: camera.quaternion.toArray().map((v) => +v.toFixed(2)),
  view: VIEW.mode,
  shotView: SHOT_VIEW,
  shotLook: SHOT_LOOK,
  follow: VIEW.follow, radius: +VIEW.radius.toFixed(2), az: +VIEW.az.toFixed(2), elev: +VIEW.elev.toFixed(2),
  loading: document.getElementById('loading')?.className || ''
});

async function boot() {
  if (HIDE_HUD) $('hud').style.display = 'none';
  if (SHOT) {
    document.body.classList.add('shot');
    VIEW.shot = true;
    world.setLabelsVisible(false);
    world.setCeilingVisible(false);
  }
  // 先 prime 再拉状态：否则首帧如果她已经在走，poll 会先切跑姿、
  // 紧接着 prime('idle') 又把 current 覆盖回 idle，造成“人在跑但播站立”。
  if (!SHOT) {
    await actor.prime('idle');
  }
  await poll();
  if (SHOT) {
    // A QQ room photograph can now be taken while she is outdoors. Build the
    // same garden without mounting controls, polling, or triggering any actions.
    let gardenShot = null;
    if (state?.her?.room === 'garden' || state?.her?.room === 'yard' || INITIAL_ROOM === 'garden') {
      gardenShot = createGardenWorld(world, renderer, { quality: tier });
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 3500);
      try {
        const response = await fetch(api('/api/garden/state'), { cache: 'no-store', signal: timeout.signal });
        if (response.ok) { const data = await response.json(); if (data.garden) gardenShot.update(data.garden); }
      } catch { /* Keep the real garden structures visible if the snapshot is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    charMode = params.get('char') === '3d' ? '3d' : 'webm';
    if (charMode === '3d') {
      await Promise.race([ensure3d(), new Promise((r) => setTimeout(r, 12000))]);
      if (!modelReady && !chibiReady) charMode = 'webm';
    }
    if (charMode === '3d') {
      actor.setVisible(false);
      applyCharVisibility();
    }
    if (charMode !== '3d') {
      const n = clipFor(state?.her || { kind: 'idle', spot: 'sofa' });
      const ok = await actor.prepareShotPoster(n);
      if (!ok) await actor.prepareShot(n, 2.4);
      actor.setVisible(true);
    }
    world.updateEnvironment({
      hour: state?.hour ?? 14, lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
    });
    // 截图模式：只画一帧，不启动渲染循环。
    // overview = 房间近景（含她）；eyes = 她的第一视角（隐藏她自己）。
    VIEW.shot = true;
    VIEW.follow = false;
    const her = state?.her;
    const pov = SHOT_VIEW === 'eyes' || SHOT_VIEW === 'first';
    if (pov) {
      VIEW.mode = 'eyes';
      // 第一视角用更宽的视场，避免只拍到眼前一件家具。
      camera.fov = 55;
      camera.updateProjectionMatrix();
      world.setCeilingVisible(true);
      world.setLabelsVisible(false);
      actor.setVisible(false);
      model3d?.setVisible(false);
      chibi?.setVisible(false);
      if (her) {
        const facing = (Number(her.facing) || 0) * Math.PI / 180;
        const eye = (her.asleep ? 0.86 : 1.22) + (her.elev || 0);
        camPos.set(
          her.pos[0] + Math.sin(facing) * 0.08,
          eye,
          her.pos[1] - Math.cos(facing) * 0.08
        );
        camLook.set(
          camPos.x + Math.sin(facing) * 4,
          eye - 0.35,
          camPos.z - Math.cos(facing) * 4
        );
        if (SHOT_LOOK === 'room' || SHOT_LOOK === 'center') {
          const roomDef = (state?.layout?.rooms || []).find((r) => r.id === her.room);
          if (roomDef?.bounds) {
            const [x0, z0, x1, z1] = roomDef.bounds;
            let tx = (x0 + x1) / 2;
            let tz = (z0 + z1) / 2;
            // 站在房间中央时，看中心会贴着茶几/墙；改看离她最远的角落，才能看到整间房。
            if (Math.hypot(tx - her.pos[0], tz - her.pos[1]) < 2.2) {
              const corners = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]];
              let best = -1;
              for (const [cx, cz] of corners) {
                const d = Math.hypot(cx - her.pos[0], cz - her.pos[1]);
                if (d > best) { best = d; tx = cx; tz = cz; }
              }
            }
            camLook.set(tx, Math.max(0.85, eye - 0.18), tz);
          }
        }
        world.updateCutaway(camPos, camLook, true);
      } else {
        camPos.set(6.3, 1.5, 5.0);
        camLook.set(6.3, 1.2, 2.0);
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    } else {
      VIEW.mode = 'overview';
      const roomId = her?.room || 'living';
      const preset = ROOM_CAM[roomId] || ROOM_CAM.living;
      const focus = her?.pos || preset.center;
      let az = preset.az, elev = preset.elev, r = preset.r;
      if (params.get('focus') === '1') {
        const facing = (Number(her?.facing) || 0) * Math.PI / 180;
        VIEW.target.set(focus[0], (her?.elev || 0) + 0.8, focus[1]);
        az = Math.PI - facing + 0.42;
        elev = 0.6;
        r = 5.0;
      } else {
        VIEW.target.set(focus[0], 0.75, focus[1]);
      }
      const horiz = Math.cos(elev) * r;
      camPos.set(VIEW.target.x + Math.sin(az) * horiz, VIEW.target.y + Math.sin(elev) * r, VIEW.target.z + Math.cos(az) * horiz);
      camLook.copy(VIEW.target);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      if (her) {
        gardenShot?.updateCharacter(her, { x: her.pos[0], y: her.elev || 0, z: her.pos[1] }, (her.facing || 0) * Math.PI / 180);
        gardenShot?.animateCharacter(performance.now());
        actor.update(0.016, camera, { pos: her.pos, elev: her.elev || 0, walking: false, flip: false });
        if (charMode === '3d' && modelReady && model3d) {
          model3d.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          model3d.setVisible(true);
          model3d.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        } else if (charMode === '3d' && chibi && chibiReady) {
          chibi.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          chibi.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        }
        world.updateCutaway(camera.position, new THREE.Vector3(her.pos[0], 1, her.pos[1]), true);
      }
      // 小公主在截图模式里也要摆好：只画一帧时没有渲染循环，它不会自己更新。
      const cl = state?.claude;
      if (cl && claudeReady && claude) {
        claude.setVisible(true);
        claude.setPose({
          pos: cl.pos, elev: cl.elev, pose: cl.pose, kind: cl.kind,
          walking: false, facing: cl.facing, asleep: cl.asleep, activity: cl.activity
        });
        claude.update(0.016, camera, { mode: 'overview', lookAtCamera: !cl.gardenWork });
        lastClaudePos = cl.pos;
      }
    }
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    setTimeout(() => {
      renderer.render(scene, camera);
      $('loading').classList.add('hide');
      document.title = 'HOME_READY';
    }, 350);
    return;
  }
  if (charMode === '3d') {
    const ok = await ensure3d();
    if (!ok) charMode = 'webm';
    applyCharVisibility();
    if (charMode === '3d') focusCharacter();
  }
  setMode('overview');
  // 3D 模式必须在 setMode 之后聚焦，否则会被默认全景机位盖住。
  if (charMode === '3d') focusCharacter();
  if (INITIAL_CAM === 'first') setMode('first', INITIAL_ROOM || characterNow()?.room || 'living');
  else if (INITIAL_CAM === 'eyes') setMode('eyes');
  world.updateEnvironment({
    hour: state?.hour ?? 14, lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
  });
  renderer.shadowMap.needsUpdate = true;
  // 先把相机吸附到当前机位，避免首帧/无头截图还停在默认全景。
  updateCamera(0.06);
  camPos.copy(desiredPos);
  camLook.copy(desiredLook);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  renderer.render(scene, camera);
  setTimeout(() => $('loading').classList.add('hide'), 250);
  setInterval(poll, 1200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if(params.get('garden')==='1') gardenController?.setOpen(true);
  requestAnimationFrame(frame);
}

boot();
