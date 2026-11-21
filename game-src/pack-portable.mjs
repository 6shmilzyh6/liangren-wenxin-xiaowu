// 两种「不需要 exe」的分发形态：
//
//   itch 包   game/ 原样压成 zip，上传到 itch.io 后勾「在浏览器里玩」。
//             不需要 Node、不需要 exe、不触发任何 Windows 拦截。
//             itch 会把它当静态站托管，路径挂在 /html/<id>/ 这种子目录下。
//
//   便携包   node.exe + game/ + start.mjs + 快速启动.cmd。
//             解压后双击 cmd 就能玩，不需要装 Node。
//             cmd 脚本不算「应用程序」，node.exe 又有 OpenJS Foundation 的签名，
//             所以 Windows 11 的智能应用控制不会拦。
//
// 这两个包都不含 exe 启动器，所以都不会撞 SmartScreen / SAC。
import { cp, mkdir, rm, writeFile, stat, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME = path.join(ROOT, 'game');
const DIST = path.join(ROOT, 'dist');
const LAUNCHER = path.join(HERE, 'launcher');

const log = (...a) => console.log('[portable]', ...a);
const sizeOf = async (p) => { try { return (await stat(p)).size; } catch { return 0; } };
const MB = (n) => (n / 1024 / 1024).toFixed(1);

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : await sizeOf(p);
  }
  return total;
}

/** GBK 写盘：cmd 文件必须按 936 存，否则中文文件名会被 node 找错。 */
async function writeGbk(file, text) {
  const tmp = `${file}.utf8.tmp`;
  await writeFile(tmp, text.replace(/\r?\n/g, '\r\n'), 'utf8');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `$t = [System.IO.File]::ReadAllText('${tmp}', [System.Text.Encoding]::UTF8); ` +
    `[System.IO.File]::WriteAllText('${file}', $t, [System.Text.Encoding]::GetEncoding(936))`
  ], { stdio: 'inherit' });
  await rm(tmp, { force: true });
}

const ITCH_README = `两人温馨小屋 · itch.io 上传说明
=============================

这个 zip 里就是游戏本体（game/ 的内容），没有 exe。

上传步骤：
  1. 打开 itch.io，进入你的项目 → Edit game → Uploads
  2. 上传这个 zip
  3. 上传完，勾选这个文件下面的「This file will be played in the browser」
  4. 保存。itch 会自己解压并按静态站托管

为什么这个能跑：
  · 游戏的后端在浏览器里（game-src/shell/net-shim.js 拦截 fetch，
    把 /api/* 就地应答），存档走 localStorage。
  · 唯一依赖网络的功能是「两个人住」的房间号配对，走公共 PeerJS 云；
    它不需要你的服务器，但需要玩家能连外网。

体积：约 119 MB，itch 免费账号单文件上限 1 GB。

注意：
  · itch 上的存档是每个玩家各自的（localStorage 按 origin 存）。
    评委看到的进度不会互相影响，这通常正是你想要的。
  · 想让评委直接看到满级/满亲密度，按 F12 打开控制台，敲：
        __cheat('yu-all')
    或者 __cheat() 看全部作弊码。
`;

const PORTABLE_README = `两人温馨小屋 · 便携版
=====================

不用安装任何东西，解压后双击「快速启动.cmd」就能玩。

为什么这样不会被 Windows 拦：
  · 「快速启动.cmd」是批处理脚本，不算「应用程序」，
    Windows 11 的智能应用控制（Smart App Control）不会拦它。
  · 它调用的是本目录里的 node.exe，那个文件有 OpenJS Foundation 的
    有效数字签名，也不会被拦。
  · 所以这个包不需要点「更多信息 → 仍要运行」，也不需要关掉任何安全设置。

第一次启动会稍慢（几秒），之后很快。

目录里有什么：
  node.exe              运行游戏的 Node 运行时（自带，不用另装）
  game\\                 游戏本体，start.mjs 也在里面（它和 index.html 必须同级）
  快速启动.cmd          双击这个

存档：
  存在浏览器的 localStorage 里。换电脑、换浏览器、清缓存都会丢。
  面板里「存档」页可以导出成一段文本，换机器时粘回去就行。

作弊码（给评委或想直接看结局的人）：
  按 F12 打开控制台，敲：
    __cheat()              看所有码
    __cheat('yu-all')      满级 + 满亲密度 + 金币
    __cheat('yu-level 30') 等级直接到 30
    __cheat('yu-full')     亲密度拉满
    __cheat('yu-coins 999')菜园金币
    __cheat('yu-reset')    清回初始（成就保留）
`;

const CMD_PORTABLE = `@echo off
title 两人温馨小屋
cd /d "%~dp0"

echo.
echo   两人温馨小屋 · 启动中…
echo.

if not exist "%~dp0node.exe" goto nonode
if not exist "%~dp0game\start.mjs" goto nofiles

rem 只用本目录里的 node.exe：不碰系统 PATH 上的版本，避免版本不一致。
rem 文件名保持 ASCII：这个 cmd 是 GBK 编码，改代码页之后中文文件名会乱掉。
"%~dp0node.exe" "%~dp0game\start.mjs"
if errorlevel 1 (
  echo.
  echo   启动出错。按任意键关闭。
  pause >nul
)
exit /b 0

:nonode
echo   这个包里缺少 node.exe，文件可能没解压完整。
echo   重新解压一次；还是不行就换个包。
echo.
pause
exit /b 1

:nofiles
echo   这个包里缺少 game\\start.mjs，文件可能没解压完整。
echo.
pause
exit /b 1
`;

/** itch.io 包：game/ 的内容直接放在 zip 根目录（itch 解压后 index.html 要在根上）。 */
async function buildItch() {
  log('打 itch 包 …');
  const stage = path.join(ROOT, '.pack-itch');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(GAME, stage, { recursive: true, force: true });
  await writeFile(path.join(stage, 'README-itch.txt'), '\ufeff' + ITCH_README, 'utf8');
  const target = path.join(DIST, '两人温馨小屋-itch.zip');
  if (existsSync(target)) await rm(target, { force: true });
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${target}' -CompressionLevel Optimal`],
  { stdio: 'inherit' });
  await rm(stage, { recursive: true, force: true });
  log(`itch 包 ${MB(await sizeOf(target))} MB → ${target}`);
  return target;
}

/** 便携包：node.exe + game/ + start.mjs + 快速启动.cmd。 */
async function buildPortable() {
  log('打便携包 …');
  const nodeExe = process.execPath;
  if (!existsSync(nodeExe)) throw new Error(`找不到 node.exe：${nodeExe}`);
  log(`用 ${nodeExe}（${MB(await sizeOf(nodeExe))} MB）`);

  const stage = path.join(ROOT, '.pack-portable');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await copyFile(nodeExe, path.join(stage, 'node.exe'));
  await cp(GAME, path.join(stage, 'game'), { recursive: true, force: true });
  // start.mjs 的 ROOT 就是它自己所在的目录，所以必须跟 index.html 放在一起。
  // 放根目录会「找不到 index.html」，因为游戏在 game/ 子目录里。
  await copyFile(path.join(LAUNCHER, 'start.mjs'), path.join(stage, 'game', 'start.mjs'));
  await writeGbk(path.join(stage, '快速启动.cmd'), CMD_PORTABLE);
  await writeFile(path.join(stage, 'README.txt'), '\ufeff' + PORTABLE_README, 'utf8');

  const target = path.join(DIST, '两人温馨小屋-便携版.zip');
  if (existsSync(target)) await rm(target, { force: true });
  const total = await dirSize(stage);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${target}' -CompressionLevel Optimal`],
  { stdio: 'inherit' });
  await rm(stage, { recursive: true, force: true });
  log(`便携包 解压后 ${MB(total)} MB，压缩后 ${MB(await sizeOf(target))} MB → ${target}`);
  return target;
}

async function main() {
  if (!existsSync(path.join(GAME, 'index.html'))) {
    throw new Error('还没构建游戏本体，先跑 node game-src/build.mjs');
  }
  await mkdir(DIST, { recursive: true });
  const want = process.argv.slice(2);
  const all = want.length === 0 || want.includes('--all');
  if (all || want.includes('--itch')) await buildItch();
  if (all || want.includes('--portable')) await buildPortable();
}

main().catch((err) => {
  console.error('[portable] 失败', err);
  process.exit(1);
});
