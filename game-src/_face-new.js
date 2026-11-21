// ════════════════════════════════════════════════════════════════════════
// 脸贴图：只画五官，不画皮肤和脸轮廓（皮肤由头骨球体本身提供）。
// 贴到球面片段上，UV 是 0..1 铺满整块，所以贴图里的坐标＝脸上的相对位置。
//
// 比例按 Q 版萌系脸的常规画法（对着立绘量的）：
//   · 眼睛占脸高的 40% 左右，两眼之间留一个眼宽的间距
//   · 眼白要露出来，虹膜是眼宽的 0.62（之前画到 0.90，整只眼糊成一坨橙色）
//   · 鼻尖只是一个点，嘴很小，腮红在眼睛下缘之下、不压在眼白上
// 画布 512×462，但真实有效区只有中间约 80%：球面片段边缘会绕到侧面去。
// ════════════════════════════════════════════════════════════════════════
const FACE_W = 512;
const FACE_H = 462;

function faceTexture(expression = 'idle') {
  const W = FACE_W;
  const H = FACE_H;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const closed = expression === 'sleep';
  const happy = expression === 'happy';
  const shy = expression === 'shy';
  const sick = expression === 'sick';
  const blink = expression === 'blink';

  // ── 关键坐标（相对 512×462 画布）───────────────────────────────────
  const cxL = 162;           // 左眼中心 x
  const cxR = 350;           // 右眼中心 x
  const eyeY = 218;          // 眼睛中心 y（略高于中线，留出下巴）
  const eyeRx = 78;          // 单眼半宽 → 眼宽 156（占宽 30%）
  const eyeRy = 88;          // 单眼半高 → 眼高 176（占高 38%）
  const irisR = eyeRx * 0.62;// 虹膜半宽，留出两侧眼白
  const mouthY = eyeY + eyeRy * 1.30;
  const cheekY = eyeY + eyeRy * 1.02;
  const squint = shy ? 0.78 : sick ? 0.50 : happy ? 0.84 : 1;

  // ── 1. 腮红：在眼睛下缘以下，淡淡的横椭圆 ──────────────────────────
  for (const dir of [-1, 1]) {
    const bx = (W / 2) + dir * 132;
    const g = ctx.createRadialGradient(bx, cheekY, 2, bx, cheekY, 74);
    const a0 = shy ? 0.34 : 0.18;
    g.addColorStop(0, `rgba(238,124,102,${a0})`);
    g.addColorStop(0.55, `rgba(238,124,102,${a0 * 0.42})`);
    g.addColorStop(1, 'rgba(238,124,102,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(bx, cheekY, 74, 32, 0, 0, TAU);
    ctx.fill();
  }

  // ── 2. 鼻子：一个极小的暗点 ────────────────────────────────────────
  if (!closed && !blink) {
    ctx.fillStyle = 'rgba(198,138,112,.30)';
    ctx.beginPath();
    ctx.ellipse(W / 2, eyeY + eyeRy * 1.06, 9, 5, 0, 0, TAU);
    ctx.fill();
  }

  // ── 3. 眼睛 ────────────────────────────────────────────────────────
  for (let i = 0; i < 2; i += 1) {
    const cx = i === 0 ? cxL : cxR;
    const outer = i === 0 ? -1 : 1;          // 外眼角方向

    ctx.save();
    ctx.translate(cx, eyeY);
    ctx.scale(1, squint);

    // 3a. 闭眼 / 眨眼 / 开心：只画一道弧
    if (closed || blink || happy) {
      ctx.strokeStyle = '#2a1408';
      ctx.lineWidth = happy ? 13 : 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (happy) {
        // 开心：上弯的月牙
        ctx.arc(0, eyeRy * 0.22, eyeRx * 0.86, Math.PI * 1.12, Math.PI * 1.88);
      } else {
        // 睡/眨：平缓下弯
        ctx.moveTo(-eyeRx * 0.92, -eyeRy * 0.10);
        ctx.quadraticCurveTo(0, eyeRy * 0.18, eyeRx * 0.92, -eyeRy * 0.10);
      }
      ctx.stroke();
      ctx.restore();
      continue;
    }

    // 3b. 杏形眼型：上缘高拱、下缘平缓、外眼角上挑
    const eyePath = () => {
      ctx.beginPath();
      ctx.moveTo(-eyeRx, eyeRy * 0.04);
      ctx.bezierCurveTo(
        -eyeRx * 0.62, -eyeRy * 1.16,
        eyeRx * 0.58, -eyeRy * 1.18,
        eyeRx * 0.97, -eyeRy * 0.20
      );
      ctx.bezierCurveTo(
        eyeRx * 0.86, eyeRy * 0.76,
        -eyeRx * 0.58, eyeRy * 0.82,
        -eyeRx, eyeRy * 0.04
      );
      ctx.closePath();
    };

    // 眼白
    ctx.fillStyle = '#fdf7f0';
    eyePath();
    ctx.fill();

    // 虹膜 + 瞳孔 + 高光，全部裁在眼型内
    ctx.save();
    eyePath();
    ctx.clip();

    const iy = eyeRy * 0.12;
    const iry = eyeRy * 0.86;
    const ig = ctx.createLinearGradient(0, iy - iry, 0, iy + iry);
    ig.addColorStop(0, '#40170a');
    ig.addColorStop(0.24, '#8c3c0e');
    ig.addColorStop(0.56, '#d2801c');
    ig.addColorStop(0.86, '#f9bd55');
    ig.addColorStop(1, '#ffe9b8');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.ellipse(0, iy, irisR, iry, 0, 0, TAU);
    ctx.fill();

    // 虹膜外缘描边
    ctx.strokeStyle = 'rgba(50,22,8,.88)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(0, iy, irisR, iry, 0, 0, TAU);
    ctx.stroke();

    // 下半圈金色亮环
    ctx.strokeStyle = 'rgba(255,226,158,.9)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.ellipse(0, iy, irisR * 0.80, iry * 0.80, 0, Math.PI * 0.14, Math.PI * 0.86);
    ctx.stroke();

    // 瞳孔
    ctx.fillStyle = '#140803';
    ctx.beginPath();
    ctx.ellipse(0, iy + iry * 0.04, irisR * 0.40, iry * 0.44, 0, 0, TAU);
    ctx.fill();

    // 高光：左上大块 + 右下小块
    ctx.fillStyle = 'rgba(255,255,255,.97)';
    ctx.beginPath();
    ctx.ellipse(-irisR * 0.38, iy - iry * 0.42, irisR * 0.36, iry * 0.26, -0.32, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.70)';
    ctx.beginPath();
    ctx.ellipse(irisR * 0.44, iy + iry * 0.44, irisR * 0.16, iry * 0.11, 0.3, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 3c. 上睫毛：粗黑，压在眼型上缘，外眼角甩出一根
    ctx.strokeStyle = '#1c0c04';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-eyeRx, eyeRy * 0.04);
    ctx.bezierCurveTo(
      -eyeRx * 0.62, -eyeRy * 1.16,
      eyeRx * 0.58, -eyeRy * 1.18,
      eyeRx * 0.97, -eyeRy * 0.20
    );
    ctx.stroke();
    // 外眼角那一小撮
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(eyeRx * 0.92, -eyeRy * 0.26);
    ctx.quadraticCurveTo(eyeRx * 1.18, -eyeRy * 0.52, eyeRx * 1.26, eyeRy * 0.02);
    ctx.stroke();

    // 3d. 下眼睑：细，只画外半段
    ctx.strokeStyle = 'rgba(74,36,18,.45)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(eyeRx * 0.94, eyeRy * 0.06);
    ctx.bezierCurveTo(eyeRx * 0.80, eyeRy * 0.74, eyeRx * 0.06, eyeRy * 0.84, -eyeRx * 0.36, eyeRy * 0.66);
    ctx.stroke();

    ctx.restore();
  }

  // ── 4. 眉毛：细、拱形、橙褐，在眼睛上方留白处 ──────────────────────
  if (!closed && !blink) {
    ctx.strokeStyle = sick ? '#ab8d78' : '#8d4a20';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i += 1) {
      const cx = i === 0 ? cxL : cxR;
      const dir = i === 0 ? -1 : 1;
      const by = eyeY - eyeRy * 1.58;
      ctx.beginPath();
      if (sick) {
        ctx.moveTo(cx - dir * 54, by + 10);
        ctx.quadraticCurveTo(cx, by + 4, cx + dir * 54, by + 12);
      } else {
        ctx.moveTo(cx - dir * 58, by + 8);
        ctx.quadraticCurveTo(cx + dir * 6, by - 18, cx + dir * 58, by + 6);
      }
      ctx.stroke();
    }
  }

  // ── 5. 嘴：小，闭合，微微上扬 ────────────────────────────────────
  if (sick) {
    ctx.strokeStyle = '#a3554a';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 22, mouthY + 5);
    ctx.quadraticCurveTo(W / 2, mouthY - 7, W / 2 + 22, mouthY + 5);
    ctx.stroke();
  } else if (happy) {
    ctx.strokeStyle = '#a83c2c';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(W / 2, mouthY - 12, 26, Math.PI * 0.20, Math.PI * 0.80);
    ctx.stroke();
  } else if (!closed) {
    // 常态：一个小小的圆嘴
    ctx.fillStyle = '#ab422f';
    ctx.beginPath();
    ctx.ellipse(W / 2, mouthY, 15, 10, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#d9765f';
    ctx.beginPath();
    ctx.ellipse(W / 2, mouthY + 4, 8, 4, 0, 0, TAU);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
