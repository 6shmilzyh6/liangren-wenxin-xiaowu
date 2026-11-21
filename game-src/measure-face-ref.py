# 精确量参考立绘：先抠掉背景，再在角色内部按区域找皮肤/眼/发。
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGB')
a = np.asarray(im).astype(int)
H, W, _ = a.shape
r = a[..., 0]; g = a[..., 1]; b = a[..., 2]
lum = (r * 299 + g * 587 + b * 114) / 1000

cs = np.array([a[1, 1], a[1, W - 2], a[H - 2, 1], a[H - 2, W - 2]]).astype(int)
bg = np.median(cs, axis=0)
mask = np.abs(a - bg).sum(axis=2) > 40

ys, xs = np.where(mask)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
ch = y1 - y0 + 1
cw = x1 - x0 + 1
print(f'立绘 {W}x{H} 背景={bg.astype(int).tolist()}')
print(f'角色 {cw}x{ch} 全宽/身高={cw/ch:.3f}')

# ── 肤色：粉白（R 高、G 中、B 中，且明显不是纯白/不是奶油黄）
# 用"在角色内部 + 亮度高 + 饱和度低但 R 明显大于 G"来定
mx = np.max(a, axis=2)
mn = np.min(a, axis=2)
sat = (mx - mn) / np.maximum(1, mx)
skin = mask & (lum > 200) & (lum < 245) & (sat > 0.06) & (sat < 0.32) \
    & (r > g) & (g > b) & (r - b > 18) & (r - b < 62) & (b > 150)

# 只在头顶往下 55% 找（脸必然在这一带）
head = np.zeros_like(mask)
head[y0:y0 + int(ch * 0.55)] = True
skin = skin & head

sy, sx = np.where(skin)
print(f'\n肤色像素 n={len(sy)}')
if len(sy):
    # 脸 = 肤色最密集的那条竖带。用行宽度分布找主体
    rows = {}
    for yy in range(sy.min(), sy.max() + 1):
        c = np.where(skin[yy])[0]
        if len(c) >= 6:
            rows[yy] = (c.min(), c.max(), len(c))
    if rows:
        ys_list = sorted(rows)
        # 找连续段
        segs = []
        cur = [ys_list[0]]
        for yy in ys_list[1:]:
            if yy - cur[-1] <= 3:
                cur.append(yy)
            else:
                segs.append(cur)
                cur = [yy]
        segs.append(cur)
        segs.sort(key=len, reverse=True)
        main = segs[0]
        print(f'  脸主体 y[{main[0]},{main[-1]}] = {main[-1]-main[0]+1}px，占身高 {(main[-1]-main[0]+1)/ch*100:.1f}%')
        # 该段的横向范围
        xs_in = [rows[yy][0] for yy in main] + [rows[yy][1] for yy in main]
        fw = max(xs_in) - min(xs_in) + 1
        fh = main[-1] - main[0] + 1
        print(f'  脸宽 {fw} = {fw/ch:.3f}×身高   脸高 {fh} = {fh/ch:.3f}×身高   宽高比={fw/fh:.2f}')
        print(f'  头身比（身高/脸高）= {ch/fh:.2f}')
        print(f'  脸中心 x={(min(xs_in)+max(xs_in))//2}（画面中心 {W//2}，角色中心 {(x0+x1)//2}）')

        # 逐行看脸宽（形状）
        print('\n  脸逐行宽度：')
        for yy in main[::max(1, fh // 12)]:
            c = np.where(skin[yy])[0]
            c = c[(c >= min(xs_in)) & (c <= max(xs_in))]
            if len(c) >= 3:
                print(f'    y={yy} (自顶{(yy-y0)/ch*100:5.1f}%) x[{c.min()},{c.max()}] w={c.max()-c.min()+1}')

        # 眼睛：脸范围内的深色
        face_box = np.zeros_like(mask)
        face_box[main[0]:main[-1] + 1, min(xs_in):max(xs_in) + 1] = True
        dark = mask & face_box & (lum < 100)
        dy, dx = np.where(dark)
        if len(dx) > 100:
            # 分左右两团
            mid = (min(xs_in) + max(xs_in)) // 2
            L = dx < mid
            R = ~L
            print(f'\n  脸部深色 n={len(dx)}  左{L.sum()} 右{R.sum()}')
            stats = {}
            for tag, sel in [('左', L), ('右', R)]:
                if sel.sum() < 50:
                    continue
                ex, ey = dx[sel], dy[sel]
                ew = ex.max() - ex.min() + 1
                eh = ey.max() - ey.min() + 1
                cx = (ex.min() + ex.max()) // 2
                cy = (ey.min() + ey.max()) // 2
                stats[tag] = (ex.min(), ex.max(), ey.min(), ey.max(), ew, eh, cx, cy)
                print(f'  {tag}眼 x[{ex.min()},{ex.max()}] y[{ey.min()},{ey.max()}] {ew}x{eh} 中心=({cx},{cy})')
                print(f'    眼宽/脸宽={ew/fw:.3f}  眼高/脸高={eh/fh:.3f}  '
                      f'眼中心高于脸底 {(ey.max()-main[0]):.0f}px')
            if '左' in stats and '右' in stats:
                gap = stats['右'][0] - stats['左'][1]
                print(f'  两眼空隙 {gap}px = {gap/fw:.3f}×脸宽')
                ecx = (stats['左'][6] + stats['右'][6]) / 2
                print(f'  眼组中心 x={ecx:.0f}  脸中心 x={(min(xs_in)+max(xs_in))/2:.0f}')

        # 刘海下沿：脸的最上沿就是刘海下沿
        print(f'\n  刘海下沿（＝可见皮肤顶）在自顶 {(main[0]-y0)/ch*100:.1f}%')
        print(f'  下巴（＝可见皮肤底）在自顶 {(main[-1]-y0)/ch*100:.1f}%')

# ── 发饰花：白瓣，在头发区里找最白的一簇
hair = mask & head & (r - b > 65) & (r > 140)
petal = mask & head & (lum > 246) & (sat < 0.10)
py, px = np.where(petal)
if len(px) > 200:
    hx = np.bincount(px // 8, minlength=W // 8 + 2)
    peak = int(np.argmax(hx)) * 8
    print(f'\n白花瓣 n={len(px)} 最密处 x≈{peak}（角色中心 {(x0+x1)//2}）')
    print(f'  → 花在{"观察者左侧" if peak < (x0+x1)//2 else "观察者右侧"}')
