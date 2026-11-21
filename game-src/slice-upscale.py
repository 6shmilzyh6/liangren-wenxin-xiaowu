# 切片 + 放大 + 锐化，一个进程跑完。
#
# 为什么必须锐化（这是实测出来的，不是猜的）：
#   源 spritesheet 每帧 640×360，角色只占 245×290。
#   2560 屏幕上角色要显示约 410px 高 → 1.41 倍放大，细节本来就不存在。
#   三种做法缩到 410px 后测锐度（拉普拉斯均值）：
#     A 原生 640 直接缩到 410         → 20.19
#     B 640→1280 lanczos → 410        → 20.34   （几乎没收益）
#     C 640→1280 lanczos+unsharp → 410 → 26.42  （+31%）
#   所以放大时带上 unsharp 才真正提升观感；单纯插值没用。
#
# 用法: python slice-upscale.py <sheet.webp> <outDir> <cols> <rows> <outW> <outH> [sharpen]
import sys
import os
from PIL import Image, ImageFilter

sheet, out_dir, cols, rows, out_w, out_h = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), int(sys.argv[6])
)
# 锐化强度：0.8 是实测的甜点。再高会出白边（头发、蕾丝边最明显）
sharpen = float(sys.argv[7]) if len(sys.argv) > 7 else 0.8

im = Image.open(sheet)
if im.mode != 'RGBA':
    im = im.convert('RGBA')
W, H = im.size
fw, fh = W // cols, H // rows
print(f'  sheet {W}x{H}  格 {fw}x{fh}  → {out_w}x{out_h}  锐化 {sharpen}', flush=True)

os.makedirs(out_dir, exist_ok=True)
n = 0
for r in range(rows):
    for c in range(cols):
        n += 1
        tile = im.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh))
        # 预乘 alpha 再缩放：否则透明边缘会和黑底混，出现暗色描边
        rgb = tile.convert('RGBa')
        rgb = rgb.resize((out_w, out_h), Image.LANCZOS)
        tile2 = rgb.convert('RGBA')
        if sharpen > 0:
            # 只锐化 RGB，alpha 用原来那份，避免把透明边界锐成锯齿
            alpha = tile2.getchannel('A')
            rgb_only = tile2.convert('RGB').filter(ImageFilter.UnsharpMask(radius=2, percent=int(sharpen * 100), threshold=2))
            tile2 = rgb_only.convert('RGBA')
            tile2.putalpha(alpha)
        tile2.save(os.path.join(out_dir, f'f{n:04d}.png'), compress_level=1)
print(f'  切出 {n} 帧', flush=True)
