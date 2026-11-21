// 造型预览服务：起一个只监听 127.0.0.1 的静态服务，方便在浏览器里直接看造型。
//   node game-src/preview-server.mjs          默认 8756
//   node game-src/preview-server.mjs 8800     指定端口
// 打开 http://127.0.0.1:PORT/preview-claude.html
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOM = path.join(ROOT, 'public', 'room');
const PORT = Number(process.argv[2] || 8756);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/preview-claude.html';
    const full = path.join(ROOM, rel);
    // 只允许读 public/room 以内的文件
    if (!path.resolve(full).startsWith(path.resolve(ROOM))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`造型预览：http://127.0.0.1:${PORT}/preview-claude.html`);
  console.log(`机位示例：?yaw=38&pitch=8&dist=2.45&ty=0.95`);
  console.log(`表情/姿势：&face=happy  &gesture=curtsy  &pose=sit`);
  console.log('Ctrl+C 停止');
});
