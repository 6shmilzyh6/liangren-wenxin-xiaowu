// 打包脚本：把双人养成屋打成「双击就玩」的单页游戏。
//
//   node game-src/build.mjs            生成 game/
//   node game-src/build.mjs --zip      顺便打一个分享用 zip
//
// 产物结构：
//   game/index.html      外壳（原版 index.html 的 HUD 结构 + 游戏状态条）
//   game/game.js         全部 JS 打成一份 IIFE（file:// 下 ES module 不能静态 import）
//   game/assets/...      立绘、动作片段、模型、音效
//
// 关键点：app.js 里 3000 行表现层一行不改，浏览器化的部分全在 game-src/。
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameAdaptPlugin } from './build-plugins.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOM = path.join(ROOT, 'public', 'room');
const OUT = path.join(ROOT, 'game');

const log = (...a) => console.log('[build]', ...a);

async function sizeOf(p) {
  try { return (await stat(p)).size; } catch { return 0; }
}

async function bundle() {
  log('打包 JS …');
  const result = await build({
    entryPoints: [path.join(HERE, 'main.js')],
    bundle: true,
    format: 'iife',
    target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
    platform: 'browser',
    outfile: path.join(OUT, 'game.js'),
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    loader: { '.glb': 'file', '.png': 'file' },
    // node:fs / node:path 换成浏览器替身；这是整个打包唯一的"接线"点。
    alias: {
      'node:fs': path.join(HERE, 'shims', 'fs.js'),
      'node:path': path.join(HERE, 'shims', 'path.js'),
      'fs': path.join(HERE, 'shims', 'fs.js'),
      'path': path.join(HERE, 'shims', 'path.js')
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [gameAdaptPlugin()],
    logLevel: 'warning'
  });
  if (result.warnings.length) log(`警告 ${result.warnings.length} 条`);
  log(`game.js ${(await sizeOf(path.join(OUT, 'game.js')) / 1024).toFixed(0)} KB`);
}

async function writeIndex() {
  log('生成 index.html …');
  const raw = await readFile(path.join(ROOM, 'index.html'), 'utf8');
  // 原版是 <script type="module" src="./app.js">：单文件 IIFE 换掉这一行即可。
  const patched = raw
    .replace(/<script type="module" src="\.\/app\.js"><\/script>\s*$/m, '<script src="./game.js"></script>\n')
    .replace(/<title>[\s\S]*?<\/title>/, '<title>两人温馨小屋</title>');
  if (!/<script src="\.\/game\.js"><\/script>/.test(patched)) {
    throw new Error('index.html 里没找到 app.js 的 script 标签，模板可能改过');
  }
  await writeFile(path.join(OUT, 'index.html'), patched, 'utf8');

  // 样式表是独立文件（<link rel="stylesheet" href="./garden.css">），不复制就是 404。
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(ROOM, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.css')) {
      await cp(path.join(ROOM, entry.name), path.join(OUT, entry.name));
    }
  }
}

async function copyAssets() {
  log('复制素材 …');
  const src = path.join(ROOM, 'assets');
  const dst = path.join(OUT, 'assets');
  await cp(src, dst, {
    recursive: true,
    force: true,
    // 58.9MB 的原始模型只服务"高画质"切换，单机分享包不背它。
    filter: (from) => !from.endsWith(`${path.sep}da-feiyu.glb`)
  });
  log(`assets ${((await dirSize(dst)) / 1024 / 1024).toFixed(1)} MB`);
}

async function dirSize(dir) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += await sizeOf(p);
  }
  return total;
}

async function writeReadme() {
  const text = `两人温馨小屋
============

这是构建产物（game/），别直接发这个文件夹给玩家。
发的时候用：

    node game-src/pack.mjs --zip

它会生成 dist/大肥鱼书房/：里面有 开始玩.exe（双击就玩）、server.mjs、
以及一份给玩家看的 README.txt。

直接双击这里的 index.html 是能进游戏，但人物立绘和 3D 模型会是空白：
file:// 页面上，从本地文件读进来的视频/图片算"跨源数据"，浏览器不允许拿去做
WebGL 贴图。所以正式包用 开始玩.exe 起一个只监听 127.0.0.1 的静态服务，
用 http://127.0.0.1:8787/ 打开页面。实测见 game-src/probe-taint.mjs。

玩法
  · 一个人住：不用联网，进度存在浏览器里，可导出/导入。
  · 两个人住：给个 6 位房间号就能跨网络进同一间屋子（WebRTC 直连，
    公共云只做配对信令），不需要公网 IP、开端口、内网穿透。
  · 连联机服务器：可选，只有"长期共用一份存档"才需要，要 Node 22+。

说明
  人物立绘来自 dsh-pet（CC BY-NC-SA 4.0），Three.js 部分 MIT。
  对话全是本地规则生成，不调用任何模型服务。
`;
  await writeFile(path.join(OUT, 'README.txt'), text, 'utf8');
}

async function zip() {
  log('打 zip …');
  const { execFileSync } = await import('node:child_process');
  const target = path.join(ROOT, '大肥鱼书房-联机版.zip');
  if (existsSync(target)) await rm(target, { force: true });
  // 除 game/ 之外，联机要跑起来还得带上 game-src 与 public/src/state：
  // 服务器自己 import 了引擎和素材目录，所以这里打的是"整包"，用 -Path 列表。
  const include = [
    path.join(OUT, '*'),
    path.join(ROOT, 'game-src', 'server'),
    path.join(ROOT, 'game-src', 'main.js'),
    path.join(ROOT, 'game-src', 'boot-app.js'),
    path.join(ROOT, 'game-src', 'engine'),
    path.join(ROOT, 'game-src', 'shell'),
    path.join(ROOT, 'game-src', 'shims'),
    path.join(ROOT, 'game-src', 'build.mjs'),
    path.join(ROOT, 'game-src', 'build-plugins.mjs')
  ];
  const list = include.map((p) => `'${p}'`).join(',');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path ${list} -DestinationPath '${target}' -CompressionLevel Optimal`],
  { stdio: 'inherit' });
  log(`zip ${((await sizeOf(target)) / 1024 / 1024).toFixed(1)} MB → ${target}`);
}

async function main() {
  const wantZip = process.argv.includes('--zip');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeIndex();
  await bundle();
  await copyAssets();
  await writeReadme();
  log(`完成 → ${OUT}`);
  if (wantZip) await zip();
}

main().catch((err) => {
  console.error('[build] 失败', err);
  process.exit(1);
});
