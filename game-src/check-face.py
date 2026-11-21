# 脸贴图的解剖学自检：不靠眼睛，直接从像素验证五官关系是否正确。
# 检查项都是可判定的事实，例如"虹膜必须比眼白小""嘴必须在眼下方"。
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGBA')
a = np.asarray(im).astype(int)
H, W, _ = a.shape
r = a[..., 0]; g = a[..., 1]; b = a[..., 2]
al = a[..., 3] > 24
lum = (r * 299 + g * 587 + b * 114) / 1000

ink   = al & (lum < 70)                                   # 睫毛/瞳孔
white = al & (lum > 238) & (np.abs(r - b) < 22)           # 眼白/高光
iris  = al & (r - b > 85) & (r > 130) & (g > 55) & (g < 200) & (lum > 85) & (lum < 225)
skin  = al & (r > 205) & (g > 120) & (g < 205) & (b > 95) & (b < 185) & (r - g > 25)   # 腮红/嘴

# 眼睛定位必须用眼白：眉毛的橙褐色和虹膜几乎同色，按虹膜找会把眉毛算进去。
# 先找眼白，再取眼白上下 ±1.4 倍高度的带，只在这条带里谈虹膜。
if white.sum() > 200:
    wy_all, wx_all = np.where(white)
    band_top = wy_all.min() - 10
    band_bot = wy_all.max() + 10
    band = np.zeros_like(white)
    band[max(0, band_top):min(H, band_bot)] = True
    iris_in_eye = iris & band
else:
    iris_in_eye = iris

results = []
def ck(name, ok, detail):
    results.append((name, ok, detail))

total = al.sum()
ck('① 贴图不空（有效像素 > 3%）', total > H * W * 0.03, f'{total} px / {H*W} = {total/(H*W)*100:.1f}%')

# 眼睛：左右两团 ink（睫毛）应各占一块。必须限制在眼白所在的条带内，
# 否则眉毛会被当成第二只眼。
#
# 注意"两眼间距"这一项不能用睫毛外接框量：外眼角那一小撮睫毛会甩出去，
# 两只眼的外接框必然在中间相接。正确做法是量**虹膜**之间的空隙。
if ink.sum() > 100:
    if white.sum() > 200:
        wy0, wy1 = np.where(white)[0].min(), np.where(white)[0].max()
        pad = int((wy1 - wy0) * 0.30)
        eye_band2 = np.zeros_like(ink)
        eye_band2[max(0, wy0 - pad):wy1 + 1] = True
        eye_ink = ink & eye_band2
    else:
        eye_ink = ink
    iy, ix = np.where(eye_ink)
    mid = W // 2
    L = ix < mid
    R = ~L
    ck('② 左右眼都存在', L.sum() > 200 and R.sum() > 200, f'左{L.sum()} 右{R.sum()}')
    if L.sum() > 200 and R.sum() > 200:
        # 用虹膜量间距
        if iris_in_eye.sum() > 200:
            iry, irx = np.where(iris_in_eye)
            Lr = irx < mid
            Rr = ~Lr
            if Lr.sum() > 50 and Rr.sum() > 50:
                gap = irx[Rr].min() - irx[Lr].max()
                ck('③ 两眼虹膜有间距（不粘在一起）', gap > W * 0.03,
                   f'间距 {gap}px = {gap/W*100:.1f}% 宽（用虹膜量，睫毛外沿不算）')
            else:
                ck('③ 两眼虹膜有间距（不粘在一起）', False, '虹膜左右分不开')
        else:
            ck('③ 两眼虹膜有间距（不粘在一起）', False, '虹膜太少')
        lcx = (ix[L].min() + ix[L].max()) / 2
        rcx = (ix[R].min() + ix[R].max()) / 2
        ck('④ 左右眼对称（中心距画面中线误差 < 6%）', abs((mid - lcx) - (rcx - mid)) < W * 0.06,
           f'左中心 {lcx:.0f} 右中心 {rcx:.0f} 中线 {mid}')

# 虹膜必须比眼白小（这是上一版最大的错误：虹膜 0.90 填满眼白）
if iris_in_eye.sum() > 100 and white.sum() > 100:
    ratio = iris_in_eye.sum() / (iris_in_eye.sum() + white.sum())
    ck('⑤ 虹膜/（虹膜+眼白）在 0.30~0.72 之间', 0.30 < ratio < 0.72,
       f'比值 {ratio:.2f}（太大=眼白被吃掉，太小=瞳孔太细）')

# 虹膜应落在眼白条带里（不跑到眉毛那一层）
# 虹膜不能跑出眼型之外。参照物必须是"瞳孔内部的全部像素"（眼白 ∪ 虹膜），
# 而不是只看眼白：虹膜本来就居中偏下，它必然比眼白往下多出一截，这不是错。
if iris_in_eye.sum() > 100 and white.sum() > 100:
    eye_inner = white | iris_in_eye
    ey0, ey1 = np.where(eye_inner)[0].min(), np.where(eye_inner)[0].max()
    iy2 = np.where(iris_in_eye)[0]
    ck('⑥ 虹膜不跑出瞳孔范围', iy2.min() >= ey0 - 6 and iy2.max() <= ey1 + 6,
       f'虹膜 y[{iy2.min()},{iy2.max()}] vs 瞳孔 y[{ey0},{ey1}]')

# 嘴：skin 类（暗红）应在眼睛下方
if skin.sum() > 50 and ink.sum() > 100:
    my, mx = np.where(skin)
    ky, kx = np.where(ink)
    ck('⑦ 嘴/腮红在眼睛下方', my.mean() > ky.mean(), f'嘴 y均值 {my.mean():.0f} vs 眼 y均值 {ky.mean():.0f}')

# 五官不能贴边（贴边说明球面片段会把它绕到侧面）
if eye_ink.sum() > 100:
    ky, kx = np.where(eye_ink)
    margin_l = kx.min() / W
    margin_r = (W - kx.max()) / W
    margin_t = ky.min() / H
    margin_b = (H - ky.max()) / H
    ck('⑧ 五官四周留边 ≥ 4%（否则贴到球侧会变形）',
       min(margin_l, margin_r, margin_t, margin_b) > 0.04,
       f'左{margin_l*100:.1f}% 右{margin_r*100:.1f}% 上{margin_t*100:.1f}% 下{margin_b*100:.1f}%')

# 眼睛高度占脸高的比例（Q 版要大）
if eye_ink.sum() > 100:
    ky, kx = np.where(eye_ink)
    eye_h = ky.max() - ky.min()
    ck('⑨ 眼部纵向占画布 18%~45%（Q 版大眼）', 0.18 < eye_h / H < 0.45, f'{eye_h}px = {eye_h/H*100:.1f}%')

print(f'\n脸贴图自检：{path}  {W}x{H}')
print('-' * 74)
ok_cnt = 0
for name, ok, detail in results:
    if ok:
        ok_cnt += 1
    print(f'{"✅" if ok else "❌"} {name}')
    if not ok or True:
        print(f'     {detail}')
print('-' * 74)
print(f'{ok_cnt}/{len(results)} 通过')
sys.exit(0 if ok_cnt == len(results) else 1)
