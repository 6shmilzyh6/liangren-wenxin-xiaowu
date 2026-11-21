# 量用户发的参考立绘（394x438，浅色背景），输出与 3D 模型可比的比例。
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGB')
a = np.asarray(im).astype(int)
H, W, _ = a.shape

# 背景：四角中位数
cs = np.array([a[1, 1], a[1, W - 2], a[H - 2, 1], a[H - 2, W - 2]]).astype(int)
bg = np.median(cs, axis=0)
diff = np.abs(a - bg).sum(axis=2)
mask = diff > 36

ys, xs = np.where(mask)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
ch = y1 - y0 + 1
cw = x1 - x0 + 1
print(f'参考立绘 {W}x{H}  背景 {bg.astype(int).tolist()}')
print(f'角色 bbox x[{x0},{x1}] y[{y0},{y1}]  {cw}x{ch}')
print(f'  全宽/身高 = {cw/ch:.3f}')

r = a[..., 0]; g = a[..., 1]; b = a[..., 2]
lum = (r * 299 + g * 587 + b * 114) / 1000

widths = np.array([(lambda w: (w.max() - w.min() + 1) if len(w) else 0)(np.where(mask[yy])[0])
                   for yy in range(y0, y1 + 1)])
wr = int(np.argmax(widths))
print(f'\n最宽行 y={y0+wr} 宽={widths[wr]} = {widths[wr]/ch:.3f}×身高  位于自顶 {wr/ch*100:.1f}%')
print('  自顶%   宽px   /身高')
for frac in np.arange(0.05, 1.0, 0.05):
    idx = min(int(frac * ch), len(widths) - 1)
    print(f'  {frac*100:5.1f}  {widths[idx]:4d}  {widths[idx]/ch:.3f}')

hair = (r - b > 62) & (r - g > 34) & (r > 130) & mask
skin = (r > 226) & (g > 192) & (b > 168) & (r - b > 16) & (r - b < 82) & (lum > 175) & mask
cream = (r > 232) & (g > 205) & (b > 180) & (np.abs(r - b) < 55) & (r - b > 3) & (lum > 190) & mask
ink = (lum < 68) & mask
iris = (r - b > 88) & (r > 148) & (g > 78) & (g < 192) & (lum > 82) & (lum < 212) & mask

print()
for name, m in [('橙发', hair), ('肤色', skin), ('奶油裙', cream), ('墨黑', ink), ('虹膜', iris)]:
    yy, xx = np.where(m)
    if len(xx) == 0:
        print(f'{name}: 无')
        continue
    print(f'{name:6s} n={len(xx):6d}  x[{xx.min()},{xx.max()}] y[{yy.min()},{yy.max()}]  '
          f'{xx.max()-xx.min()+1}x{yy.max()-yy.min()+1}  '
          f'宽/身高={(xx.max()-xx.min()+1)/ch:.3f}  自顶{(yy.min()-y0)/ch*100:.1f}%~{(yy.max()-y0)/ch*100:.1f}%')

# 脸：取肤色行中最靠上且连续的那一块
rowcnt = np.array([skin[yy].sum() for yy in range(y0, y1 + 1)])
idx = np.where(rowcnt > 4)[0]
if len(idx):
    ft = y0 + idx[0]
    # 脸的横向范围：在 ft 到 ft+脸高 之间的肤色
    fy, fx = np.where(skin)
    # 简单办法：取肤色最上面 35% 高度作为脸
    fh_guess = int(ch * 0.30)
    band = skin[ft:ft + fh_guess]
    by, bx = np.where(band)
    if len(bx):
        fw = bx.max() - bx.min() + 1
        fh = by.max() - by.min() + 1
        print(f'\n脸带（自肤色顶起 30% 身高）: x[{bx.min()},{bx.max()}] y[{ft},{ft+by.max()}]  {fw}x{fh}')
        print(f'  脸宽/身高={fw/ch:.3f}  脸高/身高={fh/ch:.3f}')
        print(f'  头身比（身高/脸高）= {ch/fh:.2f}')
        fcx = (bx.min() + bx.max()) // 2
        print(f'  脸中心 x={fcx}（画面中心 {W//2}）')

    # 眼睛：虹膜分左右
    iy, ix = np.where(iris)
    if len(ix) > 60:
        mid = (bx.min() + bx.max()) // 2
        L = ix < mid
        R = ~L
        print(f'\n虹膜 左{L.sum()} 右{R.sum()}')
        for tag, sel in [('左', L), ('右', R)]:
            if sel.sum() < 30:
                continue
            ex, ey = ix[sel], iy[sel]
            ew = ex.max() - ex.min() + 1
            eh = ey.max() - ey.min() + 1
            print(f'  {tag}眼 x[{ex.min()},{ex.max()}] y[{ey.min()},{ey.max()}] {ew}x{eh} '
                  f'中心=({(ex.min()+ex.max())//2},{(ey.min()+ey.max())//2})')
            print(f'    眼宽/脸宽={ew/(bx.max()-bx.min()+1):.3f}  眼高/脸高={eh/fh:.3f}')
        if L.sum() > 30 and R.sum() > 30:
            gap = ix[R].min() - ix[L].max()
            print(f'  两眼空隙 {gap}px = {gap/(bx.max()-bx.min()+1):.3f}×脸宽')
            eyc = (iy.min() + iy.max()) / 2
            print(f'  眼中心在脸内的相对高度 = {(eyc - ft) / fh:.3f}')
