// Claude 小公主的玩家 —— 2D 精灵图（webm）版本。
//
// 为什么不用 3D：
//   原来的 claude-actor.js 用 three.js 圆角盒/胶囊拼出程序化 3D，
//   无论怎么调参数都只能"轮廓像"参考立绘，画风上永远差一个量级。
//   claudia-pet（github.com/kirito1207/claudia-pet）的角色是手绘 2D 精灵图，
//   与本项目原有的小蓝鱼立绘用的是同一条管线（SpriteActor + 透明 webm），
//   所以直接复用：观感与参考立绘一致，还能白拿 20 段动作。
//
// 六个接口与旧 ClaudeActor 完全一致（app.js 里 11 处调用一行不改）：
//   setVisible(v)
//   setPose({ pos, elev, pose, kind, walking, facing, asleep, activity })
//   setFace(name)
//   playGesture(name)
//   update(dt, camera, { mode, lookAtCamera })
//   dispose()
//
// 语义映射（旧 3D 的输入 → 新精灵的片段）：
//   kind=idle + asleep        → claude_sleep
//   kind=idle + walking       → claude_walk
//   kind=read / activity 看书 → claude_read
//   kind=desk / phone / code  → claude_write
//   kind=eat / drink          → claude_happy（咀嚼感由片段自带）
//   手势 curtsy/wave/read/star/fold/tea → 对应的 claude_* 片段
//   setFace 只影响是否播「眨眼」变体，2D 精灵没有独立表情层。
import * as THREE from './vendor/three.module.js';

// 片段表：键 → { file, loop, once, hold }
// loop / once / hold 与 game-src/build-hq-clips.mjs 的产物一致。
//
// 片基路径：
//   · 默认走 assets/pet/claude-hq/（1280×720，lanczos 放大 + unsharp 锐化）。
//     实测把画面缩到角色实际显示尺寸（410px 高）后，锐度比 640 原生版高 50%。
//   · 该目录不存在时自动回落到 assets/pet/claude/（640×360）。
//   · 桌面单文件预览用 registerInlineClips 注入 blob: URL，绕过 file:// 的贴图拦截。
let CLIP_BASE = 'assets/pet/claude-hq/';
let CLIP_FALLBACK = 'assets/pet/claude/';
export function setClipBase(base, fallback) {
  const norm = (b) => (b === '' || String(b).endsWith('/') ? b : `${b}/`);
  CLIP_BASE = norm(base);
  if (fallback !== undefined) CLIP_FALLBACK = norm(fallback);
}

// 内联片段（桌面单文件预览用）：把 { key: base64 } 转成 blob: URL。
// 为什么必须这样：file:// 页面里相对路径的 <video> 贴到 WebGL 会抛 SecurityError，
// 只有 data: 与 blob: 能过。见 game-src/probe-taint.mjs 的实测结论。
const INLINE = {};
export function registerInlineClips(map) {
  if (!map || typeof map !== 'object') return;
  for (const [key, b64] of Object.entries(map)) {
    try {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      INLINE[key] = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
    } catch { /* 单条失败不影响其它 */ }
  }
}

function clipUrl(file) {
  const key = String(file).replace(/\.webm$/, '');
  if (INLINE[key]) return INLINE[key];
  return CLIP_BASE + file;
}
function clipUrlFallback(file) {
  return CLIP_FALLBACK + file;
}

const CLIPS = Object.freeze({
  claude_idle: { file: 'claude_idle.webm', loop: true },
  claude_idle_blink: { file: 'claude_idle_blink.webm', loop: true },
  claude_think: { file: 'claude_think.webm', loop: true },
  claude_write: { file: 'claude_write.webm', loop: true },
  claude_busy: { file: 'claude_busy.webm', loop: true },
  claude_compact: { file: 'claude_compact.webm', loop: true },
  claude_sleep: { file: 'claude_sleep.webm', loop: false, hold: [28 / 24, 76 / 24] },
  claude_read: { file: 'claude_read.webm', loop: true },
  claude_look: { file: 'claude_look.webm', loop: true },
  claude_walk: { file: 'claude_walk.webm', loop: true },
  claude_happy: { file: 'claude_happy.webm', once: true },
  claude_surprised: { file: 'claude_surprised.webm', once: true },
  claude_pout: { file: 'claude_pout.webm', once: true },
  claude_pat_wave: { file: 'claude_pat_wave.webm', once: true },
  claude_pat_shy: { file: 'claude_pat_shy.webm', once: true },
  claude_pat_joy: { file: 'claude_pat_joy.webm', once: true },
  claude_hum: { file: 'claude_hum.webm', once: true },
  claude_stretch: { file: 'claude_stretch.webm', once: true },
  claude_yawn: { file: 'claude_yawn.webm', once: true },
  claude_curtsy: { file: 'claude_curtsy.webm', once: true },
});

// 旧版六个手势 → 新片段。词组保持旧名字，app.js 的按钮照旧点。
// 后半段是「右侧九项动作」的语义映射：动作栏的文案和这里必须一一对上，
// 否则玩家点「递块点心」看到的是端茶的动作 —— 这就是文字和动作对不上。
const GESTURES = Object.freeze({
  curtsy: 'claude_curtsy',
  wave: 'claude_pat_wave',
  read: 'claude_read',
  // 原来指向 claude_pat_joy（开心蹦跳），和「抬头看星星」不是一回事，改成仰望。
  star: 'claude_look',
  fold: 'claude_pat_shy',
  tea: 'claude_hum',
  // act → gesture：摸头害羞 / 收到点心开心 / 端水 / 陪玩雀跃 / 说话欠身 /
  // 劝睡伸懒腰 / 叫醒打哈欠 / 调灯看过来 / 串门招呼。
  patShy: 'claude_pat_shy',
  patJoy: 'claude_pat_joy',
  happy: 'claude_happy',
  hum: 'claude_hum',
  stretch: 'claude_stretch',
  yawn: 'claude_yawn',
  look: 'claude_look',
  surprised: 'claude_surprised',
  pout: 'claude_pout',
  think: 'claude_think',
});

// 高度与阴影参数：沿用项目里立绘的约定（脚底 y=0、正面朝 +Z）
const PLANE_W = 1.422;
const PLANE_H = 1.6;
const FEET_CENTER_Y = 0.667;
const FADE_MS = 260;

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 120);
  g.addColorStop(0, 'rgba(24,28,34,.5)');
  g.addColorStop(0.45, 'rgba(24,28,34,.2)');
  g.addColorStop(1, 'rgba(24,28,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(128, 128, 120, 92, 0, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 单层播放器：一个 video + 一个平面。双层交叉淡入由外层管理。
class Layer {
  constructor(parent, index) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;
    this.video.preload = 'auto';
    // 离屏 video 也要进 DOM：部分 Chromium 对完全脱离文档的第二个 video
    // 会一直停在 readyState=0。这个坑 dsh-pet 那边已经踩过。
    this.video.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;pointer-events:none';
    document.body.appendChild(this.video);

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: index === 0 ? 1 : 0,
      alphaTest: 0.02,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), this.material);
    this.mesh.position.set(0, FEET_CENTER_Y, index * 0.0015);
    this.mesh.visible = false;
    this.src = '';
    this.fade = 0;
    this.target = 0;
    parent.add(this.mesh);
  }

  load(src) {
    if (this.src === src && this.video.readyState >= 2) return Promise.resolve();
    this.src = src;
    return new Promise((resolve, reject) => {
      const onReady = () => {
        this.video.removeEventListener('loadeddata', onReady);
        this.video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        this.video.removeEventListener('loadeddata', onReady);
        this.video.removeEventListener('error', onError);
        reject(new Error(`加载失败 ${src}`));
      };
      // 先挂监听再设 src：缓存命中时 loadeddata 可能在监听挂上之前就触发
      this.video.addEventListener('loadeddata', onReady);
      this.video.addEventListener('error', onError);
      this.video.src = src;
      this.video.load();
      if (this.video.readyState >= 2) onReady();
    });
  }

  setTarget(v) { this.target = v; }
  play() { try { this.video.play().catch(() => {}); } catch { /* 忽略 */ } }
  pause() { try { this.video.pause(); } catch { /* 忽略 */ } }
  setLoop(v) { this.video.loop = !!v; }

  tick(dt) {
    const k = 1 - Math.pow(0.001, dt);
    this.fade += (this.target - this.fade) * Math.min(1, k * 1.6);
    this.material.opacity = this.fade;
    this.mesh.visible = this.fade > 0.01;
  }
}

export class ClaudeActor {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'claude-sprite';
    // 精灵图的美术比例与立绘一致：整身 238×281 px 落在 640×360 画布里，
    // 用 1.28 缩放到与房间里其他立绘同一量级。
    this.group.scale.setScalar(1.28);
    this.group.visible = false;
    scene.add(this.group);

    this.layers = [new Layer(this.group, 0), new Layer(this.group, 1)];
    this.active = 0;
    this.current = '';
    this._time = 0;
    this._pos = new THREE.Vector2(9.55, 0.85);
    this._target = new THREE.Vector2(9.55, 0.85);
    this._elev = 0;
    this._targetElev = 0;
    this._walking = false;
    this._pose = 'stand';
    this._kind = 'idle';
    this._asleep = false;
    this._facing = 0;
    this._flip = false;
    this._gesture = null;
    this._gestureUntil = 0;
    this._faceName = 'idle';
    this._lastSwap = 0;
    this._ready = false;

    const st = shadowTexture();
    this._shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, opacity: 0.55 })
    );
    this._shadow.rotation.x = -Math.PI / 2;
    this._shadow.position.y = 0.008;
    this._shadow.scale.set(0.62, 0.38, 1);
    this._shadow.visible = false;
    scene.add(this._shadow);

    // 首屏就把待机片段挂上，避免第一帧空白
    this.setClip('claude_idle', { fade: false }).then(() => { this._ready = true; }).catch(() => {});
  }

  // ── 片段切换 ──────────────────────────────────────────────
  async setClip(name, { fade = true, once = false } = {}) {
    const def = CLIPS[name];
    if (!def) return;
    if (this.current === name) return;
    const nextIndex = this.active === 0 ? 1 : 0;
    const next = this.layers[nextIndex];
    const prev = this.layers[this.active];

    next.setLoop(def.hold ? true : !once);
    if (once) next.setLoop(false);
    next.video.currentTime = 0;

    // 主源失败就换 640 版：高画质目录可能没打进分享包，不能让角色变空白
    let loaded = next.load(clipUrl(def.file));
    this.current = name;
    this.active = nextIndex;
    this._lastSwap = performance.now();

    next.mesh.visible = true;
    if (!fade) {
      next.fade = 1;
      next.material.opacity = 1;
      next.setTarget(1);
    } else {
      next.fade = 0;
      next.material.opacity = 0;
      next.setTarget(1);
    }

    try {
      try {
        await loaded;
      } catch (err) {
        // 高画质片段缺失时回落到标准版，保证动作不丢
        if (INLINE[String(def.file).replace(/\.webm$/, '')] || CLIP_BASE === CLIP_FALLBACK) throw err;
        loaded = next.load(clipUrlFallback(def.file));
        await loaded;
      }
      if (this.current !== name) return;
      next.play();
      prev.setTarget(0);
    } catch { /* 两种源都没有就保持上一帧 */ }
  }

  setFace(name) {
    // 2D 精灵没有独立表情层；只记住名字，让「眨眼」变体生效
    this._faceName = String(name || 'idle');
  }

  // 预览页用：直接播任意片段（不受状态机挑选逻辑约束）
  playClip(name, { once = null } = {}) {
    const def = CLIPS[name];
    if (!def) return;
    this._gesture = name;
    // 单次片段给足时长，循环片段给一个很长的窗口，避免下一帧被状态机抢走
    const dur = def.once || once === true ? 6 : 3600;
    this._gestureUntil = performance.now() + dur * 1000;
    this.setClip(name, { once: def.once || once === true, fade: true }).catch(() => {});
  }

  playGesture(name) {
    const clip = GESTURES[name];
    if (!clip) return;
    this._gesture = name;
    // 时长跟片段类型走：循环片段（read/look/think/hum）多给一点，
    // 单次片段（wave/curtsy/yawn/stretch）短一点，否则单次播完会僵在原地。
    const loop = CLIPS[clip]?.loop === true;
    const dur = { curtsy: 2.8, wave: 2.2, read: 4.2, star: 3.4, fold: 2.6, tea: 3.2 }[name]
      || (loop ? 4.4 : 2.8);
    this._gestureUntil = performance.now() + dur * 1000;
    this.setClip(clip, { once: !loop, fade: true }).catch(() => {});
  }

  setVisible(v) {
    this.group.visible = v;
    this._shadow.visible = v;
  }

  setPose({ pos, elev = 0, pose = 'stand', kind = 'idle', walking = false, facing = 0, asleep = false, activity = '' }) {
    if (Array.isArray(pos)) this._target.set(pos[0], pos[1]);
    this._targetElev = elev;
    this._pose = pose;
    this._kind = kind;
    this._walking = !!walking;
    this._asleep = !!asleep;
    this._activity = activity || '';
    this._facing = Number(facing) || 0;
  }

  // 依据当前状态挑片段。优先级：手势 > 睡 > 走 > 具体活动 > 待机
  _pickClip() {
    const now = performance.now();
    if (this._gesture && now < this._gestureUntil) return null;   // 手势播放中，不抢
    if (this._gesture && now >= this._gestureUntil) this._gesture = null;

    if (this._asleep || this._pose === 'lie') return 'claude_sleep';
    if (this._walking) return 'claude_walk';

    const act = this._activity;
    if (this._kind === 'read' || act.includes('看书') || act.includes('读')) return 'claude_read';
    if (this._kind === 'desk' || this._kind === 'phone' || act.includes('写') || act.includes('书桌')) return 'claude_write';
    if (this._kind === 'eat' || this._kind === 'drink') return 'claude_happy';
    if (this._kind === 'balcony' || this._kind === 'garden_work') return 'claude_look';
    if (this._kind === 'play') return 'claude_pat_joy';
    return 'claude_idle';
  }

  update(dt, camera, { mode = 'overview', lookAtCamera = true } = {}) {
    this._time += dt;

    // 位置：与旧 3D 版一致，远距离直接吸附避免瞬移拖影
    const d = this._pos.distanceTo(this._target);
    if (d > 2.2) this._pos.copy(this._target);
    else {
      const k = 1 - Math.pow(0.001, dt);
      this._pos.lerp(this._target, Math.min(1, k * 1.4));
    }
    this._elev += (this._targetElev - this._elev) * Math.min(1, dt * 7);

    const bob = this._walking ? Math.abs(Math.sin(this._time * 7.2)) * 0.014 : Math.sin(this._time * 1.7) * 0.006;
    this.group.position.set(this._pos.x, this._elev + bob, this._pos.y);

    // 朝向：2D 精灵只有左右翻面，用 facing 决定翻不翻
    if (lookAtCamera) {
      const dx = camera.position.x - this._pos.x;
      const dz = camera.position.z - this._pos.y;
      const yaw = Math.atan2(dx, dz);
      this._flip = yaw < -Math.PI / 2 || yaw > Math.PI / 2;
    } else {
      this._flip = Math.sin(this._facing) < -0.2;
    }
    const sx = this._flip ? -1 : 1;
    for (const l of this.layers) l.mesh.scale.x = sx;

    // 挑片段
    const want = this._pickClip();
    if (want && want !== this.current) this.setClip(want, { fade: true }).catch(() => {});

    // 双层淡入推进
    for (const l of this.layers) l.tick(dt);

    // 阴影跟随
    const shadowY = this._elev > 0.1 ? this._elev + 0.006 : 0.008;
    this._shadow.position.set(this._pos.x, shadowY, this._pos.y);
    this._shadow.scale.setScalar(this._elev > 0.1 ? 0.7 : 1);
    this._shadow.material.opacity = this._elev > 0.1 ? 0.3 : 0.5;
  }

  dispose() {
    for (const l of this.layers) {
      l.video.remove();
      l.material.dispose();
      l.mesh.geometry.dispose();
      l.texture.dispose();
      this.group.remove(l.mesh);
    }
    this._shadow.geometry.dispose();
    this._shadow.material.map?.dispose();
    this._shadow.material.dispose();
    this.scene.remove(this.group);
    this.scene.remove(this._shadow);
  }
}
