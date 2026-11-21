// 看图小工具：走 OpenCode Go 网关的 gemini-4-argon，绕开 dsh-vision-toolkit 的免费额度限流。
// 用法：
//   node scripts/vision-look.mjs <图片1> [图片2 ...] -- "问题"
//   不给问题时默认要一段详细描述。
// 依赖：~/.dsh/.env 里的 OPENCODE_GO_API_KEY。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
const MODEL = process.env.VISION_LOOK_MODEL || 'gemini-4-argon';

function readKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY.trim();
  const envPath = path.join(os.homedir(), '.dsh', '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^OPENCODE_GO_API_KEY\s*=\s*(.+)$/.exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('没找到 OPENCODE_GO_API_KEY');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function dataUrl(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
  const mime = MIME[path.extname(abs).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const files = sep === -1 ? argv : argv.slice(0, sep);
const question = sep === -1
  ? '详细描述这张图的内容。'
  : argv.slice(sep + 1).join(' ').trim() || '详细描述这张图的内容。';

if (files.length === 0) {
  console.error('用法: node scripts/vision-look.mjs <图片...> -- "问题"');
  process.exit(2);
}

const content = [{ type: 'text', text: question }];
for (const f of files) content.push({ type: 'image_url', image_url: { url: dataUrl(f) } });

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${readKey()}`,
    'x-opencode-session': crypto.randomUUID(),
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content }],
    max_tokens: 2048,
    stream: false,
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(text.slice(0, 2000));
  process.exit(1);
}
let parsed;
try { parsed = JSON.parse(text); } catch { console.log(text); process.exit(0); }
const reply = parsed?.choices?.[0]?.message?.content;
console.log(typeof reply === 'string' ? reply : JSON.stringify(parsed, null, 2));
