// 打分享包。两种形态，同一个启动器源码：
//
//   node game-src/pack.mjs            生成 dist/大肥鱼书房/（文件夹版）+ dist/两人温馨小屋.exe（单文件版）
//   node game-src/pack.mjs --zip      顺便打 zip
//
// 单文件版就是玩家说的「直接放桌面，点击就开始玩」：整个游戏（index.html、
// game.js、garden.css、assets/ 共 82MB）压缩后嵌在 exe 里，玩家拿到只有一个文件。
// 第一次启动会解到 %LOCALAPPDATA%\dafiyu-house\app\<版本>\，之后秒开；版本号里带
// 内容哈希，所以换了包会重新解、旧目录自动删掉。
//
// 文件夹版保留：体积小、能直接改、验收脚本都靠它。
//
// 双人不需要服务器：两端靠 WebRTC 直连（PeerJS 公共云只做配对信令），所以包里
// **没有必须启动的服务器**。Node 只剩「想长期共用一份存档」那种高级玩法才需要。
//
// 打包后布局：
//   大肥鱼书房/
//     index.html  game.js  garden.css  assets/      ← 游戏本体
//     开始玩.exe                                     ← 双击这个（内置本地 HTTP 服务器）
//     启动联机服务器.cmd  server.mjs                 ← 可选：想让两个人共用一份存档
//     README.txt
//     data/                                          ← 只有跑服务器时才生成
//   两人温馨小屋.exe                                   ← 单文件版：拖到桌面双击就玩
//
// 为什么是 .exe 而不是「双击 index.html」：
//   file:// 页面里，从 file:// 载入的 <video>/<img> 会被浏览器判成"跨源数据"，
//   拿去做 WebGL 贴图直接抛 SecurityError —— 人物立绘、3D 模型全都是空白。
//   实测见 game-src/probe-taint.mjs。所以启动器起一个只监听 127.0.0.1 的静态
//   服务器，用 http://127.0.0.1:8787/ 打开页面：http 同源后怎么用都合法，
//   localhost 又是安全上下文，WebRTC/剪贴板/localStorage 一个都不缺。
//   端口固定 8787 —— 存档按 origin 存，端口一变存档就找不到了。
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, stat, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME = path.join(ROOT, 'game');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, '大肥鱼书房');
const LAUNCHER = path.join(HERE, 'launcher');

const log = (...a) => console.log('[pack]', ...a);
const sizeOf = async (p) => { try { return (await stat(p)).size; } catch { return 0; } };

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : await sizeOf(p);
  }
  return total;
}

/** 服务器 → 单文件。node: 内置模块全部外置（跑的时候是真实的 Node）。 */
async function bundleServer() {
  log('打包服务器 …');
  await build({
    entryPoints: [path.join(HERE, 'server', 'server.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    outfile: path.join(OUT, 'server.mjs'),
    minify: false,          // 服务器代码留可读，出问题好查
    legalComments: 'none',
    // 只外置 node: 前缀的内置模块；项目自己的源码全部打进来。
    external: ['node:*'],
    banner: {
      js: '// 两人温馨小屋 · 联机服务器（打包产物，源码在 game-src/server/server.mjs）\n'
    },
    logLevel: 'warning'
  });
  log(`server.mjs ${(await sizeOf(path.join(OUT, 'server.mjs')) / 1024).toFixed(0)} KB`);
}

async function copyGame() {
  log('复制游戏本体 …');
  await cp(GAME, OUT, { recursive: true, force: true });
  log(`游戏本体 ${((await dirSize(OUT)) / 1024 / 1024).toFixed(1)} MB`);
}

// 批处理里的中文必须存成 GBK：
// cmd.exe 读 .cmd 是按"当前代码页"逐行解码的，中文版 Windows 是 936(GBK)，
// 存 UTF-8 就会整段变乱码（chcp 65001 写在文件里也救不了，因为读文件时还没生效）。
// 折中办法：本文件的消息用 GBK，node 输出的 UTF-8 在临时切到 65001 的区间里打印。
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

/**
 * 编译启动器 → 开始玩.exe。
 *
 * 用系统自带的 csc（.NET Framework 4.x，Win10/11 都有），不用装 SDK。
 * 产物只有十几 KB —— 它是一个 WinForms 小托盘程序，把当前目录当静态站点根，
 * 起 HTTP 服务后打开默认浏览器。
 */
async function buildLauncher() {
  log('编译启动器 …');
  const { execFileSync } = await import('node:child_process');
  if (!existsSync(CSC)) throw new Error(`找不到 C# 编译器：${CSC}（Win10/11 一般自带 .NET Framework 4.x）`);
  const src = path.join(HERE, 'launcher', 'Launcher.cs');
  if (!existsSync(src)) throw new Error(`找不到启动器源码：${src}`);
  const target = path.join(OUT, '开始玩.exe');
  const args = ['/nologo', '/target:winexe', '/optimize+', `/out:${target}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    // 两份 exe 是同一份源码：单文件版要用 ZipArchive 解自己，所以引用一并带上
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll'];
  const ico = await ensureIcon();
  if (ico) args.push(`/win32icon:${ico}`);
  args.push(src);
  execFileSync(CSC, args, { stdio: 'inherit' });
  log(`开始玩.exe ${(await sizeOf(target) / 1024).toFixed(0)} KB`);
}

/**
 * exe 的图标。
 *
 * 现在这份 icon.ico 是 game-src/make-icon.mjs 生成的：两位住户并排，
 * 不是单从 idle.png 裁出来的「只有一条鱼」—— 桌面图标和游戏名对不上那件事，
 * 就是这张图修掉的。只有 ico 不存在时才回退到老做法（裁 idle.png）。
 */
async function ensureIcon() {
  const ico = path.join(HERE, 'launcher', 'icon.ico');
  if (existsSync(ico) && (await sizeOf(ico)) > 0) return ico;
  // 没有 ico 就现场生成一次，跑的还是同一个脚本，不再在这里重复一遍裁剪逻辑。
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.join(HERE, 'make-icon.mjs')], { stdio: 'inherit' });
    if (existsSync(ico) && (await sizeOf(ico)) > 0) return ico;
  } catch { /* 生成不出来就往下走，没有图标也能玩 */ }
  const png = path.join(GAME, 'assets', 'pet', 'idle.png');
  if (existsSync(ico) && (await sizeOf(ico)) > 0) return ico;
  if (!existsSync(png)) return null;
  const { execFileSync } = await import('node:child_process');
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$src = [System.Drawing.Image]::FromFile('${png}');`,
    '$n = [Math]::Min($src.Width, $src.Height);',
    '$x = [int](($src.Width - $n) / 2); $y = [int](($src.Height - $n) / 2);',
    '$bmp = New-Object System.Drawing.Bitmap 256, 256;',
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 256, 256), $x, $y, $n, $n, [System.Drawing.GraphicsUnit]::Pixel);',
    '$g.Dispose(); $src.Dispose();',
    '$ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon());',
    `$fs = [System.IO.File]::Create('${ico}'); $ico.Save($fs); $fs.Close();`
  ].join(' ');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  } catch {
    return null;
  }
  return existsSync(ico) ? ico : null;
}

/**
 * 单文件版：把 game/ 整个压成 zip 当嵌入资源，编出一个自带游戏的 exe。
 *
 * 产物是 dist/两人温馨小屋.exe —— 玩家拿到一个文件，拖到桌面双击就玩。
 * 版本号用内容哈希（不是时间），内容没变就不会让所有人重解一遍 82MB。
 */
async function buildSingleFile() {
  log('打单文件版 …');
  const crypto = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { createReadStream } = await import('node:fs');

  // ---- 内容指纹 ----
  const walk = async (dir, base = dir, acc = []) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, base, acc);
      else acc.push([path.relative(base, p).split(path.sep).join('/'), (await stat(p)).size]);
    }
    return acc;
  };
  const files = await walk(GAME);
  const hash = crypto.createHash('sha256');
  for (const [rel, size] of files) hash.update(rel).update(':').update(String(size)).update('\n');
  const version = hash.digest('hex').slice(0, 12);

  // ---- 压缩 ----
  const staging = path.join(ROOT, '.pack-single');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const bundle = path.join(staging, 'game.bundle.zip');
  const verFile = path.join(staging, 'VERSION');
  await writeFile(verFile, version, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(GAME, '*')}' -DestinationPath '${bundle}' -CompressionLevel Optimal`
  ], { stdio: 'inherit' });

  // ---- 编译 ----
  const src = path.join(HERE, 'launcher', 'Launcher.cs');
  const target = path.join(DIST, '两人温馨小屋.exe');
  const args = ['/nologo', '/target:winexe', '/optimize+', `/out:${target}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
    `/resource:${bundle},dafiyu.bundle`, `/resource:${verFile},dafiyu.version`];
  const ico = await ensureIcon();
  if (ico) args.push(`/win32icon:${ico}`);
  args.push(src);
  execFileSync(CSC, args, { stdio: 'inherit' });
  await rm(staging, { recursive: true, force: true });

  log(`两人温馨小屋.exe ${((await sizeOf(target)) / 1024 / 1024).toFixed(1)} MB（内含 ${version}）`);
  return target;
}


const CMD_QUICK = `@echo off
title 两人温馨小屋
cd /d "%~dp0"

echo.
echo   两人温馨小屋 · 启动中…
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

rem 文件名保持 ASCII：这个 cmd 是 GBK 编码，改代码页之后中文文件名会乱掉。
node "%~dp0start.mjs"
if errorlevel 1 (
  echo.
  echo   启动出错。按任意键关闭。
  pause >nul
)
exit /b 0

:nonode
echo   这台电脑上没找到 Node.js，这个方式用不了。
echo.
echo   换个方式：
echo     双击同目录的「开始玩.exe」或「两人温馨小屋.exe」——
echo     不用装 Node，但 Windows 可能弹一次「Windows 已保护你的电脑」，
echo     点「更多信息」再点「仍要运行」就能开。
echo.
pause
exit /b 1
`;


const CMD_SERVER = `@echo off
title 两人温馨小屋 · 联机服务器（可选）
cd /d "%~dp0"

echo.
echo   这个模式只适合一种情况：两个人想长期共用同一份存档，
echo   或者想一个人用电脑、一个人用手机同时进屋。
echo.
echo   只是想在两台电脑上一起玩的话，不用开这个 ——
echo   直接双击游戏（「两人温馨小屋.exe」或「开始玩.exe」），
echo   在游戏里选「两个人住」就行。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   没找到 Node.js。这个模式需要它，另一个模式不需要。
  echo   装个 LTS 版就行： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

set /p GO= 确定要开吗？(y/N)
if /i not "%GO%"=="y" exit /b 0

echo.
echo   正在启动，这个窗口别关（关了就断了）……
echo.

rem node 输出是 UTF-8，切到 65001 才不乱码
chcp 65001 >nul
node "server.mjs"
chcp 936 >nul

echo.
echo   服务器已停止。
pause
`;

const README = `两人温馨小屋
============

这个游戏有两种发行形态，内容完全一样，看你在哪拿到它：

    两人温馨小屋.exe     单个文件。拖到桌面，双击就玩。第一次启动会自己准备十几秒。
                       拿到这个就用这个，别的都不用管。

    大肥鱼书房\\ 文件夹  里面有「开始玩.exe」和游戏本体。整个文件夹一起用，
                       不能只把「开始玩.exe」单独拖出来（它会找不到游戏本体）。

不知道拿到的哪个：看到一个 120MB 左右的 exe 就是单文件版；
看到一个文件夹、里面有个 70KB 的「开始玩.exe」就是文件夹版。


★ 如果双击 exe 弹出「Windows 已保护你的电脑」

  这个提示来自 Windows SmartScreen。原因很简单：这个 exe 没有花钱买数字签名，
  系统不认识它，于是先拦一下。它不代表程序有问题 —— 用 Windows Defender
  对这个文件做一次定向扫描，结果是「found no threats」。

  两种办法：

  1. 继续运行（最快，任何版本都适用）
     弹窗上点「更多信息」，再点「仍要运行」。只影响这一次，下次还会问。

  2. 换成不需要 exe 的方式启动（只有文件夹版有）
     双击「快速启动.cmd」。它用 Node.js 起同样的小服务、开同一个游戏窗口，
     .cmd 和 .js 不会被 SmartScreen 拦，所以不会再弹。
     代价是这台电脑上要有 Node.js（https://nodejs.org/ 装 LTS 版）。
     没有 Node 的话，这个 cmd 会直接告诉你，那就走第 1 种办法。

  说明一下我试过但没放进来的做法：给 exe 签一张自签名证书、再把证书装进
  "受信任的根证书颁发机构"。实测这一步必然弹系统确认框（"是否允许这个证书
  颁发机构"），而且会卡住脚本等确认，比 SmartScreen 本身还麻烦，所以去掉了。
  如果你的机器上 SmartScreen 特别顽固，第 2 种办法是最省事的。


进去先选玩法：

    一个人住    不用联网。进度存在这台设备上，想玩多久玩多久。
    两个人住    不管对方在哪个网下、用的什么宽带，给个房间号就能进同一间屋子。


零、为什么是双击 exe，不能直接开 index.html
  能开，但立绘和 3D 模型会是空白 —— 这是浏览器的规矩：file:// 页面里读进来的
  视频和图片算"跨源数据"，不许拿去当贴图用。所以 exe 做了一件事：
  它在你自己的电脑上起一个只有本机能访问的小服务（127.0.0.1:8787），
  再用你的浏览器打开 http://127.0.0.1:8787/ 。这样一切都正常了，
  而且断网也能玩 —— 这个服务只在你自己的机器里转，不出网卡。

  · 游戏窗口是一个没有地址栏、没有标签页的独立窗口（Edge 或 Chrome 的 app 模式），
    不是普通浏览器标签页 —— 这样才像个游戏，也不会手滑把标签关掉。
  · 窗口关掉之后，后台服务会再等 90 秒，确认没人用了就自己退出。
  · 右下角托盘图标可以右键「退出」，也可以双击重新打开游戏。
  · 已经开着一份的时候再双击，不会再起第二个，而是把窗口指到已经开着的那个。

  单文件版额外两件事：
  · 第一次双击会把游戏本体释放到 %LOCALAPPDATA%\\dafiyu-house\\app\\<版本>\\ ，
    期间有个小窗口显示"正在准备"，十几秒就好；之后每次双击都是一两秒。
  · 托盘右键里有「在桌面放个快捷方式」，点了就有了带图标的桌面图标
    （你直接从别处拖过去的 exe 是没有游戏图标的，那个快捷方式有）。
    游戏更新之后版本目录会换新的，旧的那份会自动删掉，存档不受影响。


一、两个人住怎么用（这是重点，跟以前不一样了）
  以前的双人得有一台电脑当服务器、还得同一个 WiFi，或者自己去做端口映射。
  现在不用了。

  开房的人：
    exe → 两个人住 → 先选「你住哪一侧」（小蓝鱼这边 / 小公主这边）→ 开一间房
    屏幕上会给你一个 6 位房间号，比如 7D69GB。

  进房的人：
    exe → 两个人住 → 选好自己那一侧 → 把房间号输进去 →「进这间屋子」

  进房时选的这一侧就是你在屋子里的身份，进去之后不能随手换：
    · 页面文案、能指挥谁、菜园里写谁的名字，全都跟着这一侧走；
    · 想换的话，点右下角「屋里的人 / 说话」，在身份那一行点「申请交换」，
      对面点「同意交换」之后两边才会一起换过来——一边不点头就换不了。

  就这样。对方在家里、在学校、在别的城市都一样，不需要公网 IP，
  不需要开端口，不需要内网穿透，也不需要谁装 Node.js。

  屋子里是同一间：等级、亲密度、菜园、她俩的位置和状态，
  还有你们俩的聊天——都是同一份。谁摸的头、谁喂的点心、谁收的菜，
  对面一两秒就能看见。右下角「屋里的人 / 说话」能看到谁在屋里，也能直接聊。

  说明白一点，免得你担心：
    · 屋子由「开房那台电脑」托管，所以那个人关掉页面，屋子就散了（进度还在他那台机器上）；
    · 两个人的画面是同一份状态算出来的，不会出现「她在我这儿睡觉、在他那儿种地」；
    · 这条通道是端到端直连的，中间不经过任何人的服务器存东西；
    · 配对用的是一台公共信令服务器，它只帮忙交换"你们俩怎么互相找到"，看不到屋里的事。
    · 网络断一下能自己接回来（大概几秒），接上以后动作照样同步。

  屋子里是同一间：等级、亲密度、菜园、她俩的位置和状态，
  还有你们俩的聊天——都是同一份。谁摸的头、谁喂的点心、谁收的菜，
  对面一两秒就能看见。右下角「屋里的人 / 说话」能看到谁在屋里，也能直接聊。

  说明白一点，免得你担心：
    · 屋子由「开房那台电脑」托管，所以那个人关掉页面，屋子就散了（进度还在他那台机器上）；
    · 两个人的画面是同一份状态算出来的，不会出现「她在我这儿睡觉、在他那儿种地」；
    · 这条通道是端到端直连的，中间不经过任何人的服务器存东西；
    · 配对用的是一台公共信令服务器，它只帮忙交换"你们俩怎么互相找到"，看不到屋里的事。
    · 网络断一下能自己接回来（大概几秒），接上以后动作照样同步。


二、连不上怎么办
  99% 是这三种情况：

    1. 房间号打错了。房间号是 6 位，只有数字和大写字母，
       而且没有 0、O、1、I、L 这几个（故意去掉了，因为它们长得像）。
    2. 开房那边把页面关了，或者电脑休眠了。
    3. 公司/学校网络把点对点连接挡了（少数企业网会这样）。
       换手机热点试一次，能通就说明是那边网络的问题。

  剩下 1% 是真的打不通（双方都在很严格的 NAT 后面）。
  这种时候两个人就各自玩自己的，进度不会丢。


三、存档在哪
  单机：存在浏览器里。左下状态条 →「存档」可以导出成一个文件、也能导入回来，
        换电脑就靠它。清浏览器数据会清掉存档，记得偶尔导出一次。
  服务器模式：在 data/ 目录下（home.json / garden.json / profile.json / chat.json）。

  双人模式下不给导出/导入/重开：屋子是两个人共用的，
  一个人重开会把另一个人的进度也清掉，所以这个入口在双人时是关着的。


四、礼物和两种货币
  十九件礼物不再一到亲密度就自动塞进背包了。现在要你自己攒、自己递。

  两种货币，对应两个人各自的性子（两种每天各上限 8 点，攒下的不会清空）：

    鲸元券   偏小蓝鱼那一侧。来源：隔天还回来（连着来给得多，最多 3）、
             她睡着时没吵她（每半小时 1 点）、同一句话又说了一遍（1 点）。
    tokens   偏小公主那一侧。来源：菜园有收成（每次 2 点）、今天该照顾的都做了
             （2 点）、她看书时没打断（每 20 分钟 1 点）。

  礼物分三档：随手给她的（2-3 点）、攒了一阵子的（8-15 点）、
  一直没敢拿出来的（25-40 点）。要两样都到位才递得出去：
  亲密度够（不然写「还不到日子」）+ 这种货币够（不然写「还差 3 鲸元券」）。

  在哪递：进菜园，第五个标签「礼物」。递出去以后第二天，她会在玄关还你点什么。


五、她会做什么
  按作息过日子：会饿会困、会自己去菜园浇水收菜、会串门、会睡前关灯。
  你不在的时候她们照常过（最多结算 8 小时），回来会告诉你这段时间发生了什么。
  对话是本地规则生成的，不调用任何模型，也不联网。


六、都在哪
  index.html / game.js / garden.css / assets/   游戏本体
  开始玩.exe                                    双击就玩（含本机小服务，见开头「零」）
  启动联机服务器.cmd / server.mjs               可选，见下

  （单文件版没有这些文件，都装在那一个 exe 里了。
    想找它们：托盘右键 →「打开游戏文件夹」。）


七、可选：联机服务器
  只有当你们想让两个人在不同的设备上长期共用同一份存档时，才需要它。
  双击「启动联机服务器.cmd」，窗口里会打印地址：

      本机      http://localhost:8788/
      局域网    http://<这台电脑的内网IP>:8788/

  用这个地址打开游戏，主菜单会多出一个「连联机服务器」的选项。
  需要 Node.js 22 以上。

  换端口：  set PORT=9000 && node server.mjs
  换存档：  set DAFIYU_DATA_DIR=D:\\saves && node server.mjs


八、说明
  人物立绘来自 dsh-pet（CC BY-NC-SA 4.0），Three.js 部分 MIT。
  所有对话都是本地规则生成，不调用任何模型服务。
`;

/**
 * 比赛版里的「评委说明.txt」。
 *
 * 为什么单独一份：评委不需要「怎么解压」这种话，他要的是
 *   · 一眼看出这游戏在讲什么、核心机制是什么（三十秒内决策要不要玩下去）
 *   · 怎么在不玩十几个小时的前提下看完全部内容（作弊码）
 *   · 哪些是真的做了、哪些是刻意没做（免得把设计决定当成 bug）
 *   · 怎么自己验收（测试命令、实测截图）
 */
const JUDGE_README = `两人温馨小屋 · 评委说明
========================

一句话：一间会自己过日子的大平层，住着两位性格不同的住户。
你不操作的时候，她们照常生活；你做的每件小事都会被记进账本，攒够了换她们开口。

这个包和发给朋友的分享版内容完全一样，只多两份说明（这份 + 玩法说明.txt）。


一、三十秒上手
  1. 双击「两人温馨小屋.exe」。第一次会在 %LOCALAPPDATA%\\dafiyu-house\\app\\<版本>\\
     准备十几秒（有个小窗口提示），之后每次一两秒。
  2. 如果弹「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。
     这个 exe 没有买数字签名，SmartScreen 不认识它。详见 README.txt 里那一节。
  3. 主菜单填一个名字（必填），选「一个人住」。
  4. 进游戏后：右键拖动转视角，滚轮缩放，点地面/家具让她过去，左边动作栏对她做事。


二、这可能不是你以为的那种「养成」
  大部分养成游戏是：你喂 → 数字涨 → 解锁剧情。
  这里的顺序反过来：她有自己的作息和需求，你不在的时候她照样喝水、收菜、串门、关灯睡觉。
  你能做的是「参与」，不是「驱动」。

  三条能直接看到的设计：
  · 好感不是刷出来的。同一动作当天第二次打折、第六次归零；
    她越难受，照顾越值钱（最高 2.5 倍），这时候还要她玩要她跑，给得最少（0.4 倍）。
  · 礼物不是发的，是递的（下面「四」）。亲密度只决定「能不能给」，
    攒够那种货币才决定「给不给得起」。
  · 陪伴有账。一起待着每 30 分钟攒 1 点同行点数，一天最多 8 点；
    待超过 3 小时她会自己去睡 —— 不是惩罚，是她真的累了。


三、想快速看完全部内容（作弊码）
  按 F12 打开控制台，敲：

    __cheat()              列出所有码
    __cheat('yu-all')      满级 + 满亲密度 + 金币 + 两种货币各 200（最省事的一条）
    __cheat('yu-wallet')   只给钱：鲸元券 / tokens 各 40，用来试礼物栏
    __cheat('yu-gift')     把礼物货架摆满（只发随手档，留一半让你看「攒够才给」）
    __cheat('yu-full')     亲密度拉满
    __cheat('yu-level 30') 等级直接到 30
    __cheat('yu-together 20') 同行点数 20，用来试菜园「小柜子」
    __cheat('yu-coins 999')   菜园金币
    __cheat('yu-reset')    清回初始（成就保留）

  每条都落盘，不会下次 tick 被覆盖回去。


四、这一版新做的：礼物分级（两段解锁 + 双货币 + 三档）
  以前：亲密度到门槛，十九条礼物自己进背包，玩家零选择。
  现在：亲密度决定「能不能给」，钱包决定「给不给得起」，两道闸都过才递得出去。

  两种货币对应两个人各自的性子（每天各上限 8 点，攒下的不清空）：
    鲸元券   偏小蓝鱼。来源：隔天还回来（连着来给得多，最多 3）、
             她睡着时没吵她（每半小时 1 点）、同一句话又说了一遍（1 点）。
    tokens   偏小公主。来源：菜园有收成（每次 2 点）、今天该照顾的都做了（2 点）、
             她看书时没打断（每 20 分钟 1 点）。

  三档：随手给她的（2-3 点 / 4 件）、攒了一阵子的（8-15 点 / 8 件）、
        一直没敢拿出来的（25-40 点 / 7 件）。
  在哪：进菜园（右上「菜园」），第五个标签「礼物」。
  按钮上写的不是价格，是「还差 3 鲸元券」「还不到日子」「在你这儿了」。
  递出去以后第二天，她会在玄关还你点什么。


五、故意没做的三件事（别当 bug 报）
  1. 小公主没有 3D 模型，只有 2D 手绘立绘。
     这是决定，不是没做完。原来用 three.js 程序化拼 3D，无论怎么调都只能「轮廓像」，
     画风上永远差一个量级。她的立绘（20 段手绘动作）和小蓝鱼用的是同一条管线。
     所以切到 3D 模式时，小蓝鱼变模型、她仍是立绘 —— 两个角色画风不同源，
     这一点我们知道，暂时没有便宜的解法。
  2. 对话是本地规则生成的，不调用任何模型。
     这个包是单机版：没有网络请求，不需要 API Key，断网也能玩。
     网页版（接 DeepSeek Harness）才有真模型对话，不在这个包里。
  3. 停用了几处老文案。翻遍界面会发现「大肥鱼书房」这个名字：
     那是内部目录名，存档和验收脚本依赖它，改名等于让老存档找不到家。


六、自己验收
  这个 exe 是 dist/大肥鱼书房/ 那份 + 一份 zip 嵌进去的。想验源码那一侧：

    node scripts/test-home.mjs        大平层事实层，27 项
    node scripts/test-room.mjs        房间表现层契约，22 项
    node scripts/check-progress.mjs   数值表，57 项（含礼物分级 6 条）
    node scripts/verify-growth.mjs    成长端到端，32 项（含买礼物 4 条）
    node game-src/smoke-menu.mjs      三种打开方式的菜单
    node game-src/smoke.mjs           单人进游戏

  这一版实测截图在 game-shots/garden-gift-click.png：
  点一下「一枝花」，钱包从 10 变 8、背包多一条 g01-flower、事件面板出现
  「验收把一枝花放在她手边（鲸元券 −2）」。


七、素材与许可
  代码 MIT。2D 立绘来自 dsh-pet（CC BY-NC-SA 4.0）。
  Three.js MIT。3D 模型是作者提供的展示文件，不可单独转售。
`;

/**
 * 比赛版里的「玩法说明.txt」：给评委看的那份「怎么玩」，比玩家 README 短。
 */
const JUDGE_GAMEPLAY = `两人温馨小屋 · 玩法说明
======================

一、界面
  左侧    她现在的状态（饿/渴/精力/不适）、当前动作、九个动作按钮
  右侧    全动作抽屉（114 个立绘动作，九组分类）、互动与技能
  右上    指挥切换（小蓝鱼 / 小公主）、菜园、相机、设置
  底部    聊天、存档

二、操作
  右键拖动    转视角
  滚轮        缩放
  点地面      让她走过去（会自己绕开大件家具）
  点家具      她过去用那件家具（床、沙发、书桌、电视…）
  左侧按钮    摸头 / 喂食 / 倒水 / 陪玩 / 说话 / 哄睡 / 开灯 / 指挥 / 串门

三、核心循环
  1. 她会自己过日子：喝水、吃饭、去菜园浇水收菜、串门、睡前关灯。
     你关掉页面最多结算 8 小时，回来会告诉你这段时间发生了什么。
  2. 你做的每件事都会记进「今天的账」（点开「和她」那栏）：
     标称多少、今天第几次、按百分之几记、今日额度还剩多少。
  3. 攒下来的东西进两种货币（鲸元券 / tokens），在菜园第五个标签「礼物」里
     换成十九件礼物递给她。递出去第二天有回礼。
  4. 一起待着还会攒同行点数（每 30 分钟 1 点，一天最多 8 点），
     在菜园第四个标签「小柜子」里换点心 / 便条 / 一次串门。

四、两个人住（可选）
  主菜单选「两个人住」，一端开房拿到 6 位房间号，另一端输进去。
  两端看到的是同一间屋子、同一份进度，右下角能看到谁在屋里。
  走 WebRTC 直连，配对用公共信令服务器，它看不到屋里的事。

五、想直接看结局
  F12 → __cheat('yu-all')。详见「评委说明.txt」第三节。
`;

/**
 * 按 GBK(936) 写文件。
 *
 * 为什么需要：cmd.exe 解 .cmd 用的是「当前代码页」，中文版 Windows 是 936。
 * 存 UTF-8 的中文批处理会被按 GBK 解一遍，整段变成「灏忚摑楸」那种乱码。
 * Node 没有内置 GBK 编码器，借一次 PowerShell 转码（pack.mjs 本来就要 powershell 打 zip）。
 */
async function writeGbk(file, text) {
  const { execFileSync } = await import('node:child_process');
  const tmp = path.join(OUT, `.${path.basename(file)}.utf8.tmp`);
  await writeFile(tmp, text.replace(/\r?\n/g, '\r\n'), 'utf8');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `$t = [System.IO.File]::ReadAllText('${tmp}', [System.Text.Encoding]::UTF8); ` +
    `[System.IO.File]::WriteAllText('${file}', $t, [System.Text.Encoding]::GetEncoding(936))`
  ], { stdio: 'inherit' });
  await rm(tmp, { force: true });
}

async function main() {
  if (!existsSync(path.join(GAME, 'index.html'))) {
    throw new Error('还没构建游戏本体，先跑 node game-src/build.mjs');
  }
  const wantZip = process.argv.includes('--zip');

  await rm(DIST, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await copyGame();
  await bundleServer();
  await buildLauncher();
  const single = await buildSingleFile();
  await writeGbk(path.join(OUT, '启动联机服务器.cmd'), CMD_SERVER);
  // 不用 exe 的启动方式：.cmd + .mjs 不会被 SmartScreen 拦。
  // exe 是没签名的自制程序，别人机器上大概率会撞"Windows 已保护你的电脑"，
  // 所以除了 exe 还留一条不需要 exe 的路。
  // 注意文件名必须是纯 ASCII：cmd 文件本身是 GBK 编码，一旦 chcp 到 65001，
  // 里面出现的中文文件名会被按 UTF-8 重新解释成乱码，node 就找不到脚本了。
  await copyFile(path.join(LAUNCHER, 'start.mjs'), path.join(OUT, 'start.mjs'));
  await writeGbk(path.join(OUT, '快速启动.cmd'), CMD_QUICK);
  // README 存成带 BOM 的 UTF-8：记事本（尤其老版本）没 BOM 会按 GBK 猜，中文就糊了。
  await writeFile(path.join(OUT, 'README.txt'), '\ufeff' + README, 'utf8');
  // 分享包根目录再放一份：解压完一眼就能看到说明，不用点进子目录找。
  await writeFile(path.join(DIST, 'README.txt'), '\ufeff' + README, 'utf8');

  log(`完成 → ${OUT}`);
  log(`单文件版 → ${single}`);

  if (wantZip) {
    log('打 zip …');
    const { execFileSync } = await import('node:child_process');
    const zipTo = (stage, target) => {
      if (existsSync(target)) return rm(target, { force: true }).then(() => compress(stage, target));
      return compress(stage, target);
    };
    const compress = (stage, target) => {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${target}' -CompressionLevel Optimal`],
      { stdio: 'inherit' });
    };

    // ── 分享版：只装 exe + 玩家说明。发给朋友、发给同学都用这一份。 ──
    // 不把文件夹版也塞进来：两个加起来 160MB，收到的人还得先做选择。
    // 文件夹版留在 dist/大肥鱼书房 里，自己修东西或者 exe 解压出问题时用。
    const shareTarget = path.join(ROOT, '两人温馨小屋-分享版.zip');
    const shareStage = path.join(ROOT, '.pack-zip-share');
    await rm(shareStage, { recursive: true, force: true });
    await mkdir(shareStage, { recursive: true });
    await copyFile(single, path.join(shareStage, '两人温馨小屋.exe'));
    await copyFile(path.join(DIST, 'README.txt'), path.join(shareStage, 'README.txt'));
    await zipTo(shareStage, shareTarget);
    await rm(shareStage, { recursive: true, force: true });
    log(`分享版 ${((await sizeOf(shareTarget)) / 1024 / 1024).toFixed(1)} MB → ${shareTarget}`);

    // ── 比赛版：exe + 评委说明（含作弊码、验收方式、已知限制）+ 玩家说明。 ──
    // 两份说明都放，因为评委既想知道怎么玩，也想知道怎么快速看完全部内容。
    const compTarget = path.join(ROOT, '两人温馨小屋-比赛版.zip');
    const compStage = path.join(ROOT, '.pack-zip-comp');
    await rm(compStage, { recursive: true, force: true });
    await mkdir(compStage, { recursive: true });
    await copyFile(single, path.join(compStage, '两人温馨小屋.exe'));
    await copyFile(path.join(DIST, 'README.txt'), path.join(compStage, 'README.txt'));
    await writeFile(path.join(compStage, '评委说明.txt'), '\ufeff' + JUDGE_README, 'utf8');
    await writeFile(path.join(compStage, '玩法说明.txt'), '\ufeff' + JUDGE_GAMEPLAY, 'utf8');
    await zipTo(compStage, compTarget);
    await rm(compStage, { recursive: true, force: true });
    log(`比赛版 ${((await sizeOf(compTarget)) / 1024 / 1024).toFixed(1)} MB → ${compTarget}`);
  }
}

main().catch((err) => {
  console.error('[pack] 失败', err);
  process.exit(1);
});
