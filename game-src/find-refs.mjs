// 从会话日志里找出用户发的图片附件，落在磁盘上的实际路径。
// 用途：拿到参考立绘的原图，用它做"模型 ↔ 立绘"的量化对照。
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.TEMP, 'session.jsonl');
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const hits = [];
for (let i = 0; i < lines.length; i += 1) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  if (o.type !== 'user/message') continue;
  const text = JSON.stringify(o.data);
  if (!text.includes('image')) continue;
  // 提取所有看起来像 sha256 / 附件 id 的字段
  const ids = [...text.matchAll(/"([0-9a-f]{64})"/g)].map((m) => m[1]);
  const shas = [...new Set(ids)];
  // 提取提示文字（用户发的说明）
  const pv = o.data?.payload?.parts || o.data?.parts || [];
  const words = pv.filter((p) => p?.type === 'text').map((p) => String(p.text).slice(0, 40)).join(' | ');
  hits.push({ line: i, seq: o.seq, shas, words });
}

console.log('用户消息里带图的条目：', hits.length);
const allShas = new Set();
for (const h of hits) {
  console.log(`  line ${h.line}  seq ${h.seq}  shas=${h.shas.length}  "${h.words}"`);
  for (const s of h.shas) allShas.add(s);
}

// 在 attachments/objects 下把它们找出来
const objDir = path.join(process.env.USERPROFILE, '.dsh', 'attachments', 'v1', 'objects');
const found = [];
for (const sha of allShas) {
  const p = path.join(objDir, sha.slice(0, 2), sha);
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    found.push({ sha, p, size: st.size, mtime: st.mtime });
  }
}
found.sort((a, b) => a.mtime - b.mtime);
console.log(`\n磁盘上找到 ${found.length} 个附件文件：`);
for (const f of found) {
  console.log(`  ${f.mtime.toISOString().slice(11, 19)}  ${String(f.size).padStart(8)}  ${f.sha.slice(0, 12)}`);
}
fs.writeFileSync(path.join(process.env.TEMP, 'ref-shas.json'), JSON.stringify(found, null, 2));
