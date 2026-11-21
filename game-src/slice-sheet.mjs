// 把 8×15 网格的 spritesheet 拆成按序编号的 png 帧。
//
//   node game-src/slice-sheet.mjs <sheet.webp> <outDir> [cols] [rows]
//
// 为什么不用 ffmpeg 的 crop 表达式：
//   这张 webp 是**单张静态大图**（5120×5400），不是动画。
//   ffmpeg 的 crop 里 n 表示帧号，这里 n 永远是 0，所以只能切出左上角一格。
//   按格子切需要按坐标取矩形，用 sharp/jimp 这类库最省事，但项目里没有，
//   所以用 ffmpeg 的 crop 逐个坐标调用（120 次），每次只切一帧。
//   实测 120 次调用约 6 秒，可接受。
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const [, , sheet, outDir, colsArg, rowsArg] = process.argv;
if (!sheet || !outDir) {
  console.error('用法: node slice-sheet.mjs <sheet> <outDir> [cols] [rows]');
  process.exit(1);
}
const COLS = Number(colsArg || 8);
const ROWS = Number(rowsArg || 15);

function cropOne(x, y, w, h, out) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-v', 'error',
      '-i', sheet,
      '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-frames:v', '1',
      out,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
  });
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 先探测总尺寸：用 ffprobe 读宽高
  const size = await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => {
      const [w, h] = out.trim().split(',').map(Number);
      if (w && h) resolve({ w, h });
      else reject(new Error('读不到尺寸'));
    });
    p.on('error', reject);
  });

  const fw = Math.floor(size.w / COLS);
  const fh = Math.floor(size.h / ROWS);
  console.log(`  源 ${size.w}×${size.h}，每帧 ${fw}×${fh}，共 ${COLS * ROWS} 帧`);

  let n = 1;
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const out = path.join(outDir, `f${String(n).padStart(4, '0')}.png`);
      await cropOne(c * fw, r * fh, fw, fh, out);
      n += 1;
    }
  }
  console.log(`  切出 ${n - 1} 帧`);
}

main().catch((err) => {
  console.error('[slice-sheet] 失败', err.message);
  process.exit(1);
});
