// 生成 exe 图标：两位住户并排，不是只有小蓝鱼。
//
//   node game-src/make-icon.mjs            → 覆盖 game-src/launcher/icon.ico
//
// 为什么要有这个脚本：
//   原来的 ensureIcon() 直接拿 assets/pet/idle.png 居中裁正方形，
//   而 idle.png 里只有小蓝鱼一个人 —— 桌面上的 exe 图标就成了「只有一条鱼」，
//   和「两人温馨小屋」这个名字对不上，也和游戏里两位住户的实际样子对不上。
//
// 做法：两张立绘各自按 alpha 包围盒裁掉大面积透明的边，
// 再按固定比例并排贴进正方形，导出 16/32/48/64/128/256 六个尺寸打包成 .ico。
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PET_HER = path.join(ROOT, 'public', 'room', 'assets', 'pet', 'idle.png');
const PET_CLAUDE = path.join(ROOT, 'public', 'room', 'assets', 'pet', 'claude', 'claude_idle.png');
const OUT_ICO = path.join(HERE, 'launcher', 'icon.ico');
// 托盘图标走的是运行时读 PNG（Launcher.cs 的 BuildTray），所以还要留一张 256 的 PNG 进素材。
// 不带 ico 也能跑：Launcher 会按「app-icon.png 优先、idle.png 兜底」的顺序找。
const OUT_PNG = path.join(ROOT, 'public', 'room', 'assets', 'ui', 'app-icon.png');
const TMP = path.join(HERE, 'launcher', '.icon-build');

// ICO 里塞这几个尺寸：16/32 是任务栏与资源管理器列表，48 是中等图标，
// 256 是大图标与桌面（Win10/11 默认拿 256 或 48）。
const SIZES = [16, 32, 48, 64, 128, 256];

const p = (f) => f.replace(/\\/g, '/');

async function main() {
  if (!existsSync(PET_HER)) throw new Error(`缺立绘：${PET_HER}`);
  if (!existsSync(PET_CLAUDE)) throw new Error(`缺立绘：${PET_CLAUDE}`);
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  // 每个尺寸各画一张 PNG：PowerShell 只负责画，打包 ICO 交给下面的 Node 逻辑。
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$her    = [System.Drawing.Bitmap]::FromFile('${p(PET_HER)}')
$claude = [System.Drawing.Bitmap]::FromFile('${p(PET_CLAUDE)}')

# alpha 包围盒：两位立绘在 640x360 里只占中间一小块，不裁掉就是一片空白。
function Get-Box($img, [int]$step) {
  $minX = $img.Width; $maxX = -1; $minY = $img.Height; $maxY = -1
  for ($y = 0; $y -lt $img.Height; $y += $step) {
    for ($x = 0; $x -lt $img.Width; $x += $step) {
      if ($img.GetPixel($x, $y).A -gt 24) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return @($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
}

$boxHer    = Get-Box $her 2
$boxClaude = Get-Box $claude 2

# 两个人并排：各占 56% 宽、重叠 12%，合起来正好填满正方形的一条横带。
# 高度统一到画布的 82%，基线对齐在底部留 9% 的呼吸位。
function Draw-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $bandH = [int]($size * 0.82)
  $slotW = [int]($size * 0.56)
  $overlap = [int]($size * 0.12)
  $leftX = [int](($size - ($slotW * 2 - $overlap)) / 2)
  $baseY = [int](($size - $bandH) / 2 + $bandH)

  # 谁在前谁在后：小蓝鱼在左（前景），小公主在右（稍微靠后半步）。
  # 先画右边，再画左边，自然形成「她站在他侧后」的层次。
  $slots = @(
    @{ img = $claude; box = $boxClaude; x = ($leftX + $slotW - $overlap) },
    @{ img = $her;    box = $boxHer;    x = $leftX }
  )
  foreach ($s in $slots) {
    $bw = [double]$s.box[2]
    $bh = [double]$s.box[3]
    $scale = [Math]::Min($slotW / $bw, $bandH / $bh)
    $dw = [int]($bw * $scale)
    $dh = [int]($bh * $scale)
    # 窄的画布上两个人要略微靠拢，否则 16px 会糊成一团。
    $destX = [int]($s.x + ($slotW - $dw) / 2)
    $destY = [int]($baseY - $dh)
    $srcRect = New-Object System.Drawing.Rectangle ([int]$s.box[0]), ([int]$s.box[1]), ([int]$s.box[2]), ([int]$s.box[3])
    $dstRect = New-Object System.Drawing.Rectangle $destX, $destY, $dw, $dh
    $g.DrawImage($s.img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  }

  $g.Dispose()
  return $bmp
}

foreach ($s in @(${SIZES.join(', ')})) {
  $bmp = Draw-Icon $s
  $bmp.Save('${p(TMP)}/' + $s + '.png', [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  icon {0}x{0}" -f $s)
}
$her.Dispose(); $claude.Dispose()
Write-Host 'icon png done'
`;

  const ps1 = path.join(TMP, '_make-icon.ps1');
  // PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解码，中文注释直接变语法错。
  await writeFile(ps1, `\uFEFF${script}`, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' });

  // 打包成 ICO：Vista 以后的 .ico 允许每一层直接存 PNG，
  // 比 BMP+AND 掩码简单得多，也不会在小尺寸上丢 alpha。
  const pngs = [];
  for (const size of SIZES) {
    const buf = await readFile(path.join(TMP, `${size}.png`));
    pngs.push({ size, buf });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type = icon
  header.writeUInt16LE(pngs.length, 4); // count
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);                      // 调色板数
    e.writeUInt8(0, 3);                      // reserved
    e.writeUInt16LE(1, 4);                   // color planes
    e.writeUInt16LE(32, 6);                  // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  await writeFile(OUT_ICO, Buffer.concat([header, ...entries, ...pngs.map((x) => x.buf)]));
  const kb = (await readFile(OUT_ICO)).length / 1024;
  console.log(`[icon] ${OUT_ICO}  ${kb.toFixed(1)} KB  ${SIZES.join('/')}`);

  // 256 那张同时留一份 PNG：托盘/窗口图标在运行时按路径读，不解析 ico。
  await mkdir(path.dirname(OUT_PNG), { recursive: true });
  await writeFile(OUT_PNG, pngs[pngs.length - 1].buf);
  console.log(`[icon] ${OUT_PNG}  256x256`);

  await rm(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[icon] 失败', err.message);
  process.exit(1);
});
