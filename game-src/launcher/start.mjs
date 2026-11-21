// 两人温馨小屋 · 不用 exe 的启动器
//
// 为什么要有这个：Windows 对"没签名的 exe"会弹 SmartScreen（"Windows 已保护你的电脑，
// 未知发布者"）。这个游戏是自己做着玩的，没有买代码签名证书，所以 exe 那条路在
// 别人机器上一定会遇到这个提示。
//
// .cmd / .mjs 不会被 SmartScreen 拦。所以这里用 Node 自己起一个只监听 127.0.0.1 的
// 静态服务器，再用 Edge/Chrome 的 --app 开一个没有地址栏的窗口 —— 效果和 exe 版一样，
// 但不需要任何 exe。
//
// 前提：机器上有 Node.js（这台机器有 v24）。没有的话就用 exe 版。
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 这个脚本在 dist\大肥鱼书房\ 里，游戏本体就在同目录
const ROOT = HERE;
const START_PORT = 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

let lastHit = Date.now();

function serve(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    res.writeHead(400).end('bad path');
    return;
  }

  if (pathname === '/launcher.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ launcher: true, app: 'dafiyu-house', version: 3 }));
    return;
  }
  if (pathname === '/__bye') {
    res.writeHead(204, { 'cache-control': 'no-store' }).end();
    // 页面关了：再等 90 秒没有新请求就退出，不留后台进程。
    setTimeout(() => process.exit(0), 90_000).unref?.();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('only GET');
    return;
  }

  lastHit = Date.now();
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const full = path.join(ROOT, pathname.replace(/^[/\\]+/, ''));

  // 别让 ../ 跳出游戏目录
  if (!full.startsWith(ROOT) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + pathname);
    return;
  }

  const size = statSync(full).size;
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';

  // 视频/模型要支持 Range：Chromium 播 webm 会先探一下能不能分段
  const range = req.headers.range;
  if (range && /^bytes=/.test(range) && size > 0) {
    const spec = range.slice(6).trim();
    const dash = spec.indexOf('-');
    let from = 0;
    let to = size - 1;
    if (dash >= 0) {
      const a = spec.slice(0, dash).trim();
      const b = spec.slice(dash + 1).trim();
      if (!a) {
        const tail = Number(b);
        if (tail > 0) from = Math.max(0, size - tail);
      } else {
        from = Number(a) || 0;
        if (b) to = Math.min(Number(b) || to, size - 1);
      }
    }
    if (from > to || from >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': to - from + 1,
      'content-range': `bytes ${from}-${to}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(full, { start: from, end: to }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(full).pipe(res);
}

function listen(port, tries = 12) {
  return new Promise((resolve, reject) => {
    const server = createServer(serve);
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 0) {
        resolve(listen(port + 1, tries - 1));
        return;
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

function findChromium() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find((p) => existsSync(p)) || '';
}

async function main() {
  if (!existsSync(path.join(ROOT, 'index.html'))) {
    console.error('这个目录里没有 index.html —— 请把本文件放在「大肥鱼书房」文件夹里。');
    process.exit(1);
  }

  const { server, port } = await listen(START_PORT);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`两人温馨小屋 · 服务已启动 ${url}`);

  // 配置目录放游戏目录里，第二次起秒开；不传就会用玩家自己的浏览器配置，
  // 那样在有"提权 Edge 实例"的机器上会被接管、弹"是否用普通权限重启"。
  const profile = path.join(ROOT, 'browser');
  try { mkdirSync(profile, { recursive: true }); } catch { /* 忽略 */ }

  const exe = findChromium();
  if (exe) {
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      // 不加 --start-maximized：实测它会让 app 窗口以最小化状态出生
      '--window-size=1400,900',
      '--window-position=20,20',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msEdgeSidebarV2,msImplicitSignin,msEdgeSyncConsent,msEdgeIdentityFeature',
      '--disable-session-crashed-bubble',
      '--disable-background-mode',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--no-service-autorun'
    ];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('已打开游戏窗口（Edge app 模式）。关掉窗口后本进程会在 90 秒内自己退出。');
  } else {
    console.log('没找到 Edge/Chrome，请在浏览器里手动打开上面的地址。');
    const { exec } = await import('node:child_process');
    exec(`start "" "${url}"`);
  }

  // 兜底：一小时完全没请求就退出，别留僵尸
  setInterval(() => {
    if (Date.now() - lastHit > 3_600_000) process.exit(0);
  }, 60_000).unref?.();
}

main().catch((err) => {
  console.error('启动失败：', err?.message || err);
  process.exit(1);
});
