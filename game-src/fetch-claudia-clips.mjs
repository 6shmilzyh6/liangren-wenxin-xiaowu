// 把 claudia-pet 的精灵图（8×15 网格 webp，每帧 640×360）转成本项目在用的 webm 片段。
//
// 为什么这样做：
//   claudia-pet（github.com/kirito1207/claudia-pet）的角色是**手绘/AI 生成的 2D 精灵图**，
//   画风与用户给的立绘完全一致；而本项目的 claude-actor.js 是程序化 3D 拼出来的，
//   无论怎么调都只能"轮廓像"，达不到那个观感。项目里 actor.js 的 SpriteActor
//   已经有一套成熟的 webm 播放管线（双 video 交叉淡入、预取、双阴影），
//   所以把精灵图转成同样规格的 webm，就能直接复用，一行不用改。
//
// 用法：
//   node game-src/fetch-claudia-clips.mjs              下载并转换核心 20 个动作
//   node game-src/fetch-claudia-clips.mjs --all        147 个全量（约 280MB 源图）
//   node game-src/fetch-claudia-clips.mjs --only idle,happy
//   node game-src/fetch-claudia-clips.mjs --keep-src   保留下载的 spritesheet
//
// 产物：public/room/assets/pet/claude/*.webm（640×360，VP9 + alpha，24fps）
//
// 授权：精灵图来自 hunmer/aboutme-pets 的 claude 动作包（CC BY-NC-SA 4.0，
//       作者 2026-11-05 书面授权），经 claudia-pet 原样收录。转码只是格式转换，
//       不改绘制内容。详见 public/room/assets/pet/CREDITS.md。
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'public', 'room', 'assets', 'pet', 'claude');
const SRC = path.join(ROOT, '.claudia-src');
const TMP = path.join(ROOT, '.claudia-tmp');

const REPO = 'kirito1207/claudia-pet';
const BRANCH = 'main';
// 国内直连 github 会被墙，这个反代实测可用
const MIRRORS = [
  'https://gh-proxy.com/https://raw.githubusercontent.com',
  'https://cdn.jsdelivr.net/gh',
  'https://raw.githubusercontent.com',
];

const GRID_COLS = 8;
const GRID_ROWS = 15;
const FRAME_W = 640;
const FRAME_H = 360;
const FPS = 24;

// claudia-pet character.json 里的状态名 → 精灵图文件名 → 本项目的片段键
// 键名沿用现有约定：英文小写下划线
const CORE = [
  ['idle', '待机呼吸休闲', 'claude_idle', { loop: true }],
  ['idle_blink', '待机呼吸休闲', 'claude_idle_blink', { from: 60, loop: true }],
  ['thinking', '工作状态-思考冒泡', 'claude_think', { loop: true }],
  ['writing', '写代码', 'claude_write', { loop: true }],
  ['running', '工作状态-忙碌点按', 'claude_busy', { loop: true }],
  ['compact', '工作状态-清点归档', 'claude_compact', { loop: true }],
  ['sleeping', '原地小憩沉眠', 'claude_sleep', { to: 76, hold: [28, 76] }],
  ['happy', '工作状态-雀跃庆祝', 'claude_happy', { once: true }],
  ['surprised', '被吓一跳', 'claude_surprised', { once: true }],
  ['pout', '点击回应-傲娇生气', 'claude_pout', { once: true }],
  ['pat_wave', '点击回应-元气挥手', 'claude_pat_wave', { once: true }],
  ['pat_shy', '点击回应-害羞惊讶', 'claude_pat_shy', { once: true }],
  ['pat_joy', '点击回应-开心跃动', 'claude_pat_joy', { once: true }],
  ['hum', '悠闲哼歌', 'claude_hum', { once: true }],
  ['stretch', '超大伸懒腰', 'claude_stretch', { once: true }],
  ['yawn', '哈欠连天', 'claude_yawn', { once: true }],
  ['reading', '书页拍打节奏', 'claude_read', { loop: true }],
  ['look', '东张西望', 'claude_look', { loop: true }],
  ['walk_crab', '螃蟹走路', 'claude_walk', { loop: true }],
  ['curtsy', '优雅裙摆舞', 'claude_curtsy', { once: true }],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10000) throw new Error(`内容太小 ${buf.length}B`);
  await writeFile(dest, buf);
  return buf.length;
}

async function fetchSheet(sheetName, destFile) {
  if (existsSync(destFile) && statSync(destFile).size > 10000) return statSync(destFile).size;
  const enc = encodeURIComponent(`${sheetName}.webp`);
  const rel = `characters/claude/anim/${enc}`;
  let lastErr;
  for (const m of MIRRORS) {
    const base = m.includes('jsdelivr')
      ? `${m}/${REPO}@${BRANCH}`
      : `${m}/${REPO}/${BRANCH}`;
    const url = m.includes('jsdelivr') ? `${base}/${rel}` : `${base}/${rel}`;
    try {
      const size = await download(url, destFile);
      console.log(`    下载 ok（${m.split('/')[2]}）${(size / 1024 / 1024).toFixed(1)} MB`);
      return size;
    } catch (err) {
      lastErr = err;
      console.log(`    镜像失败 ${m.split('/')[2]}：${err.message}`);
    }
    await sleep(300);
  }
  throw new Error(`所有镜像都失败：${lastErr?.message}`);
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败(${code})：${err.slice(-400)}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const only = (() => {
    const i = args.indexOf('--only');
    if (i < 0) return null;
    return new Set(args[i + 1].split(',').map((s) => s.trim()));
  })();

  await mkdir(OUT, { recursive: true });
  await mkdir(SRC, { recursive: true });
  await mkdir(TMP, { recursive: true });

  const jobs = only ? CORE.filter(([state]) => only.has(state)) : CORE;
  console.log(`准备转换 ${jobs.length} 个动作 → ${OUT}\n`);

  const manifest = {};
  let ok = 0;
  let failed = 0;

  for (const [state, sheet, key, opts] of jobs) {
    console.log(`[${state}] ${sheet} → ${key}.webm`);
    const sheetFile = path.join(SRC, `${sheet.replace(/[/\\:*?"<>|]/g, '_')}.webp`);
    try {
      await fetchSheet(sheet, sheetFile);

      // 1) 用 ffmpeg 按网格切片。webp 是单张静图，靠 crop + 逐帧偏移拿不到，
      //    所以先把它按格子拆成 120 张 png（crop 表达式里用 n 做行列推算）。
      const framesDir = path.join(TMP, key);
      await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir, { recursive: true });

      // crop 一次只能取一块；用 tile 的方向反过来做：先切片再按序编号。
      // ffmpeg 的 crop 支持用 n（帧号）算偏移，但这张 webp 只有 1 帧，
      // 所以改用 Python/PIL 切（见 slice.py），这里只负责调用。
      await run(process.execPath, [
        path.join(HERE, 'slice-sheet.mjs'),
        sheetFile, framesDir, String(GRID_COLS), String(GRID_ROWS),
      ], '切片');

      // 2) 用同一套裁切参数把 120 张 png 编成 webm。
      //    必须 -pix_fmt yuva420p + libvpx-vp9 才有透明通道；
      //    ffmpeg 会自动写 ALPHA_MODE=1 标签，浏览器才能识别。
      const outFile = path.join(OUT, `${key}.webm`);
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'f%04d.png'),
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-b:v', '0', '-crf', '36',
        '-row-mt', '1',
        '-an',
        outFile,
      ], '转码');

      const size = statSync(outFile).size;
      manifest[key] = {
        state,
        sheet,
        file: `${key}.webm`,
        bytes: size,
        ...opts,
      };
      console.log(`    完成 ${(size / 1024).toFixed(0)} KB\n`);
      ok += 1;

      await rm(framesDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`    失败：${err.message}\n`);
      failed += 1;
    }
  }

  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n完成：${ok} 个成功，${failed} 个失败`);
  console.log(`片段目录：${OUT}`);
  console.log(`清单：${path.join(OUT, 'manifest.json')}`);

  if (!args.includes('--keep-src')) {
    await rm(TMP, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[fetch-claudia-clips] 失败', err);
  process.exit(1);
});
