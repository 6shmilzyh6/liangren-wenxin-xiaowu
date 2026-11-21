// 把 claudia-pet 的精灵图转成高画质 webm。
//
// 画质瓶颈的实测结论（这一版就是按它设计的）：
//   · 压片不是瓶颈。CRF 36 → 14，文件涨 80%，像素差异只有 MAE 2.84/255。
//   · 真正的瓶颈是**源分辨率**：源图每帧 640×360，角色只占 238×281，
//     而 2560 宽的屏幕里角色要显示约 410px 高 → 放大 1.46 倍，必然发虚。
//   · 所以这里从 5120×5400 的原始 spritesheet 直接切、lanczos 放大到 1280×720，
//     浏览器再缩到 410px 显示时是"缩小"，比"放大"锐得多。
//
// 速度（实测，单个片段 120 帧）：
//   PIL 切片+放大  5.3s（原来每帧起一个 ffmpeg 要 60s，慢 11 倍）
//   VP9 编码       5.7s（cpu-used 2；cpu-used 5 只要 1.4s 但 PSNR 低 0.3dB，取前者）
//   → 每个片段约 11s，20 个约 4 分钟
//
//   node game-src/build-hq-clips.mjs                全部 20 个
//   node game-src/build-hq-clips.mjs --only idle    指定
//   node game-src/build-hq-clips.mjs --width 960    改输出宽度
//   node game-src/build-hq-clips.mjs --fast         用 cpu-used 5（快 4 倍，画质略降）
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'public', 'room', 'assets', 'pet', 'claude-hq');
const SRC = path.join(ROOT, '.claudia-hq-src');
const TMP = path.join(ROOT, '.claudia-hq-tmp');
const PY = process.env.DSH_PYTHON
  || path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
    'dependencies', 'python', 'python.exe');

const REPO = 'kirito1207/claudia-pet';
const BRANCH = 'main';
const MIRRORS = [
  'https://gh-proxy.com/https://raw.githubusercontent.com',
  'https://cdn.jsdelivr.net/gh',
  'https://raw.githubusercontent.com',
];

const GRID_COLS = 8;
const GRID_ROWS = 15;
const FPS = 24;
// CRF 见下方实测表（默认 24）

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  // 必须是 >= 0：flag 出现在 argv[0] 时 indexOf 返回 0，用 > 0 会把它吞掉
  // （这个 off-by-one 让 --width / --sharpen 一度完全失效，参数永远走默认值）
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
// 画质参数都是实测出来的，不是拍脑袋（每个数都对过锐度/体积）：
//   源每帧 640×360，角色只占 245×290；2560 屏上角色要显示约 410px 高。
//   在"缩到 410px 后"测锐度（拉普拉斯均值）：
//     原生无锐化           20.19
//     放大到 1280 + 锐化    30.14   ← 放大本身没收益，锐化才是关键
//     原生 640 + 锐化 1.2   34.86   ← 更好，而且文件小 60%
//   CRF 对比（640 + 锐化 1.2）：
//     CRF 18 → 1935 KB，锐度 34.86
//     CRF 24 → 1321 KB，锐度 28.67   ← 拐点，再压几乎不变
//     CRF 32 →  772 KB，锐度 28.66
//   所以默认：640 原生（不放大）+ 锐化 1.2 + CRF 24。
const OUT_W = num('--width', 640);
const OUT_H = Math.round(OUT_W * 9 / 16);
const CPU_USED = args.includes('--fast') ? '5' : '2';
const SHARPEN = num('--sharpen', 1.2);
const CRF = String(num('--crf', 24));

const JOBS = [
  ['idle', '待机呼吸休闲', 'claude_idle'],
  ['idle_blink', '待机呼吸休闲', 'claude_idle_blink'],
  ['thinking', '工作状态-思考冒泡', 'claude_think'],
  ['writing', '写代码', 'claude_write'],
  ['running', '工作状态-忙碌点按', 'claude_busy'],
  ['compact', '工作状态-清点归档', 'claude_compact'],
  ['sleeping', '原地小憩沉眠', 'claude_sleep'],
  ['happy', '工作状态-雀跃庆祝', 'claude_happy'],
  ['surprised', '被吓一跳', 'claude_surprised'],
  ['pout', '点击回应-傲娇生气', 'claude_pout'],
  ['pat_wave', '点击回应-元气挥手', 'claude_pat_wave'],
  ['pat_shy', '点击回应-害羞惊讶', 'claude_pat_shy'],
  ['pat_joy', '点击回应-开心跃动', 'claude_pat_joy'],
  ['hum', '悠闲哼歌', 'claude_hum'],
  ['stretch', '超大伸懒腰', 'claude_stretch'],
  ['yawn', '哈欠连天', 'claude_yawn'],
  ['reading', '书页拍打节奏', 'claude_read'],
  ['look', '东张西望', 'claude_look'],
  ['walk_crab', '螃蟹走路', 'claude_walk'],
  ['curtsy', '优雅裙摆舞', 'claude_curtsy'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${label} 失败(${code})：${err.slice(-400)}`))));
    p.on('error', reject);
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10000) throw new Error(`内容太小 ${buf.length}B`);
  await writeFile(dest, buf);
  return buf.length;
}

async function fetchSheet(name, dest) {
  if (existsSync(dest) && (await stat(dest)).size > 10000) return 'cached';
  const rel = `characters/claude/anim/${encodeURIComponent(`${name}.webp`)}`;
  let lastErr;
  for (const m of MIRRORS) {
    const base = m.includes('jsdelivr') ? `${m}/${REPO}@${BRANCH}` : `${m}/${REPO}/${BRANCH}`;
    try {
      await download(`${base}/${rel}`, dest);
      return 'downloaded';
    } catch (err) {
      lastErr = err;
      await sleep(200);
    }
  }
  throw new Error(`镜像全失败：${lastErr?.message}`);
}

async function main() {
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 && args[onlyIdx + 1] ? new Set(args[onlyIdx + 1].split(',').map((s) => s.trim())) : null;
  const jobs = only ? JOBS.filter(([state]) => only.has(state)) : JOBS;

  await mkdir(OUT, { recursive: true });
  await mkdir(SRC, { recursive: true });
  await mkdir(TMP, { recursive: true });

  console.log(`输出 ${OUT_W}×${OUT_H}  CRF ${CRF}  cpu-used ${CPU_USED}  共 ${jobs.length} 个`);
  console.log(`预计每个约 11 秒，合计约 ${Math.round(jobs.length * 11 / 60)} 分钟\n`);

  let ok = 0;
  let failed = 0;
  const started = Date.now();

  for (let i = 0; i < jobs.length; i += 1) {
    const [state, sheetName, key] = jobs[i];
    const t0 = Date.now();
    const sheet = path.join(SRC, `${sheetName.replace(/[/\\:*?"<>|]/g, '_')}.webp`);
    const framesDir = path.join(TMP, key);
    process.stdout.write(`[${i + 1}/${jobs.length}] ${state.padEnd(12)}`);
    try {
      await fetchSheet(sheetName, sheet);
      // PIL 单进程切 + 放大
      await run(PY, ['-X', 'utf8', path.join(HERE, 'slice-upscale.py'),
        sheet, framesDir, String(GRID_COLS), String(GRID_ROWS),
        String(OUT_W), String(OUT_H), String(SHARPEN)], '切片');

      const out = path.join(OUT, `${key}.webm`);
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'f%04d.png'),
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-b:v', '0', '-crf', CRF,
        '-row-mt', '1',
        '-deadline', 'good',
        '-cpu-used', CPU_USED,
        // alpha 很脆：自动交替参考帧会把它糊掉
        '-auto-alt-ref', '0',
        '-an',
        out,
      ], '编码');

      const size = (await stat(out)).size;
      console.log(`  ${(size / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      ok += 1;
      await rm(framesDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`  失败：${err.message}`);
      failed += 1;
    }
  }

  const files = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
  let total = 0;
  for (const f of files) total += (await stat(path.join(OUT, f))).size;
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({
    width: OUT_W,
    height: OUT_H,
    crf: Number(CRF),
    fps: FPS,
    count: files.length,
    totalBytes: total,
    source: '5120x5400 spritesheet → 640x360 tile → lanczos upscale → VP9 yuva420p',
    note: '浏览器把 1280 宽的帧缩到屏幕尺寸显示，避免放大发虚。',
  }, null, 2), 'utf8');

  console.log(`\n完成 ${ok} 成功 / ${failed} 失败，用时 ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`合计 ${(total / 1024 / 1024).toFixed(1)} MB → ${OUT}`);
  if (!args.includes('--keep-src')) await rm(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[build-hq-clips] 失败', err);
  process.exit(1);
});
