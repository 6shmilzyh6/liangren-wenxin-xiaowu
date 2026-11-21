// 从 progress.json 的 clips 表生成 pet-clips.js 的解锁门槛表。
//
// 为什么要生成而不是手写：
//   progress.json 是门槛的唯一来源。手写第二份必然漂移，
//   改了 JSON 忘了改 JS 就是"界面显示锁着、其实能点"这类幽灵 bug。
//   check-progress.mjs 里有一条断言会重新读这个文件核对。
//
//   node scripts/gen-pet-unlocks.mjs            # 写回 pet-clips.js
//   node scripts/gen-pet-unlocks.mjs --check    # 只核对，不写（CI 用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROGRESS = path.join(ROOT, 'assets', 'data', 'progress.json');
const CLIPS_JS = path.join(ROOT, 'public', 'room', 'pet-clips.js');

const BEGIN = '// ==== 解锁门槛 BEGIN（由 scripts/gen-pet-unlocks.mjs 生成，勿手改）====';
const END = '// ==== 解锁门槛 END ====';

function buildBlock(clips) {
  const keys = Object.keys(clips).sort();
  const lines = keys.map((k) => {
    const c = clips[k] || {};
    return `  ${k}: { level: ${Number(c.level) || 1}, intimacy: ${Number(c.intimacy) || 0} },`;
  });
  return [
    BEGIN,
    '// level    —— 要到这个等级才进抽屉',
    '// intimacy —— 操作者与她的亲密度也要到这个数',
    '// 文案不写系统提示，由 app.js 用 lockedLines 里的原话显示。',
    'export const CLIP_UNLOCKS = Object.freeze({',
    ...lines,
    '});',
    END,
  ].join('\n');
}

function main() {
  const progress = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
  const clips = progress.clips || {};
  const block = buildBlock(clips);

  let src = fs.readFileSync(CLIPS_JS, 'utf8');
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  const next = i >= 0 && j > i
    ? src.slice(0, i) + block + src.slice(j + END.length)
    : `${src.trimEnd()}\n\n${block}\n`;

  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    if (next === src) {
      console.log(`pet-clips.js 的解锁表与 progress.json 一致（${Object.keys(clips).length} 项）`);
      return;
    }
    console.error('pet-clips.js 的解锁表与 progress.json 不一致，请运行 node scripts/gen-pet-unlocks.mjs');
    process.exit(1);
  }
  fs.writeFileSync(CLIPS_JS, next, 'utf8');
  console.log(`已写入 ${Object.keys(clips).length} 项解锁门槛 → public/room/pet-clips.js`);
}

main();
