// 一次性修编码：把被 PowerShell 用 GBK 读坏的 UTF-8 中文注释还原。
// 原理：坏文件里的字符是"原 UTF-8 字节被当成 GBK 解码"的结果，
// 因此把字符按 GBK 编回字节、再按 UTF-8 解码即可还原。
// 行尾常残留一个替换符（原始截断痕迹），一并清掉。
import fs from 'node:fs';
import path from 'node:path';
import iconv from '../node_modules/iconv-lite/lib/index.js';

const target = path.resolve('public/room/claude-actor.js');
let text = fs.readFileSync(target, 'utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

// 高频乱码字：出现其中之一，基本可以断定这行被 GBK 读坏过
const MOJIBAKE = /[鍙傛暟鏁翠綋缂╂斁閲岀殑韬哄Э浣嶇Щ璺熺潃绠嬪€傛敼杩欓噷灏辩煯寰堝瀛愪粠鑵扮洊鍒伴瀷涓婃柟鐗堢殑鑴氫笂闈沒有鐢╃殑鍋氱殑涓嶈兘杩欎釜浠€涔堣繕娌℃湁鏃跺€欑殑鎵€浠ワ紝浣犲彲浠ヤ簡瑙ｅ埌]/;

const lines = text.split('\n');
let fixed = 0;
const failed = [];

const out = lines.map((line, idx) => {
  if (!/[^\x00-\x7f]/.test(line)) return line;           // 纯 ASCII 不动
  if (!MOJIBAKE.test(line)) return line;                 // 不像被读坏，不动
  let back;
  try {
    back = iconv.encode(line, 'gbk').toString('utf8');
  } catch {
    failed.push(idx + 1);
    return line;
  }
  // 清掉还原残留：替换符 + 紧跟的一个问号（原始截断痕迹）
  back = back.replace(/\uFFFD\??/g, '');
  if (!/[\u4e00-\u9fff]/.test(back)) { failed.push(idx + 1); return line; }
  fixed += 1;
  return back;
});

fs.writeFileSync(target, out.join('\n'), 'utf8');

const rest = (out.join('\n').match(MOJIBAKE) || []).length;
console.log(`还原 ${fixed} 行，仍未处理 ${failed.length} 行，残留乱码字 ${rest}`);
if (failed.length) console.log('未处理行号:', failed.join(','));
