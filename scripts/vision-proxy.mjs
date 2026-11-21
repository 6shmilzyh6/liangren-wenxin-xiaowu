// 视觉代理：把 dsh-vision-toolkit 的请求转给 OpenCode Go 网关。
//
// 为什么需要它：
//   插件默认走它自己的免费公共网关 https://vision.anionex.me/v1（内置共享 key，
//   模型 gemini-3.7-flash）。那是按 IP 共享额度的，用完返回
//   error.code = "rate_limit_exceeded"；而 vendor/agent-vision-toolkit/vision_client.py
//   的 _retryable_http_error() 把这三个 code 显式排除在重试之外，所以十个视觉工具
//   会同时、立刻失败，退避也没用。
//   OpenCode Go 网关有我们自己的额度（gemini-4-argon 支持图片），但它要求
//   x-opencode-session 头，而那个 Python 客户端不会带 —— 直连返回 400。
//   于是在本机开一层代理，补上这个头。
//
// 用法：
//   node scripts/vision-proxy.mjs            # 前台，默认 127.0.0.1:13177
//   PORT=13178 node scripts/vision-proxy.mjs # 换端口
//
// 然后把 vision-toolkit 的 provider 指过来：
//   baseUrl:    http://127.0.0.1:13177/v1
//   credential: OPENCODE_GO_API_KEY
//   model:      gemini-4-argon

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const UPSTREAM = 'https://opencode.ai/inference/go/openai/v1';
const PORT = Number(process.env.PORT || 13177);
const HOST = process.env.HOST || '127.0.0.1';

function readKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY.trim();
  for (const name of ['.env']) {
    const p = path.join(os.homedir(), '.dsh', name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^OPENCODE_GO_API_KEY\s*=\s*(.+)$/.exec(line.trim());
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('没找到 OPENCODE_GO_API_KEY');
}

const KEY = readKey();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // 只代理 chat/completions；模型清单之类也放行，方便自检
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
    return;
  }

  const upstreamUrl = UPSTREAM + url.pathname.replace(/^\/v1/, '') + (url.search || '');
  const body = req.method === 'GET' ? undefined : await readBody(req);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Authorization: `Bearer ${KEY}`,
        'x-opencode-session': crypto.randomUUID(),
      },
      body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    // 透传 429 时把 Retry-After 补上，避免客户端只看 code 就放弃
    const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/json' };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) headers['Retry-After'] = retryAfter;
    res.writeHead(upstream.status, headers);
    res.end(buf);
    const note = upstream.ok ? 'ok' : `HTTP ${upstream.status}`;
    console.log(`[proxy] ${req.method} ${url.pathname} -> ${note}`);
  } catch (err) {
    console.error('[proxy] 上游失败', err?.message || err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'proxy_upstream_failed', message: String(err?.message || err) } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening http://${HOST}:${PORT}/v1  ->  ${UPSTREAM}`);
});
