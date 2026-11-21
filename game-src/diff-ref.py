# 直接对比：参考立绘 vs 我的渲染，把"可见皮肤区"和"眼睛"归一化到身高后比数字。
import sys
import numpy as np
from PIL import Image


def load(p, box=None):
    im = Image.open(p).convert('RGB')
    if box:
        x0, y0, x1, y1 = [int(v) for v in box.split(',')]
        im = im.crop((x0, y0, x1, y1))
    return np.asarray(im).astype(int)


def trim(a):
    H, W, _ = a.shape
    cs = np.array([a[1, 1], a[1, W - 2], a[H - 2, 1], a[H - 2, W - 2]]).astype(int)
    bg = np.median(cs, axis=0)
    m = np.abs(a - bg).sum(axis=2) > 36
    ys, xs = np.where(m)
    return m, xs.min(), xs.max(), ys.min(), ys.max(), bg


def analyze(name, a):
    H, W, _ = a.shape
    m, x0, x1, y0, y1, bg = trim(a)
    ch = y1 - y0 + 1
    cw = x1 - x0 + 1
    r = a[..., 0]; g = a[..., 1]; b = a[..., 2]
    lum = (r * 299 + g * 587 + b * 114) / 1000

    print(f'\n=== {name}  {W}x{H} ===')
    print(f'角色 {cw}x{ch}  全宽/身高={cw/ch:.3f}  背景={bg.astype(int).tolist()}')

    # 皮肤：只在头区（自顶 0~50%）里找，且要"肤色"而不是"奶油"——
    # 肤色的特征是 R>G>B 且 R-G 有明显差值、整体偏亮但不发黄
    head = np.zeros_like(m)
    head[y0:y0 + int(ch * 0.52)] = True
    skin = m & head & (r > 225) & (g > 185) & (g < 232) & (b > 165) & (b < 220) \
        & (r - g > 12) & (r - g < 55) & (b > g - 40)
    sy, sx = np.where(skin)
    if len(sy):
        sw = sx.max() - sx.min() + 1
        sh = sy.max() - sy.min() + 1
        print(f'  可见皮肤 {sw}x{sh}  宽/身高={sw/ch:.3f} 高/身高={sh/ch:.3f} '
              f'宽高比={sw/sh:.2f}  自顶{(sy.min()-y0)/ch*100:.1f}%~{(sy.max()-y0)/ch*100:.1f}%')
    else:
        print('  可见皮肤: 无')
        sw = sh = 0

    # 深色（睫毛/眼）在头区内
    dark = m & head & (lum < 80)
    dy, dx = np.where(dark)
    if len(dx) > 100:
        dw = dx.max() - dx.min() + 1
        dh = dy.max() - dy.min() + 1
        print(f'  头内深色 {dw}x{dh}  宽/身高={dw/ch:.3f} 高/身高={dh/ch:.3f} '
              f'自顶{(dy.min()-y0)/ch*100:.1f}%~{(dy.max()-y0)/ch*100:.1f}%')
        if sw:
            print(f'    深色宽/皮肤宽={dw/sw:.3f}  深色高/皮肤高={dh/sh:.3f}')
        # 左右分团
        mid = (x0 + x1) // 2
        L = dx < mid
        R = ~L
        if L.sum() > 50 and R.sum() > 50:
            gap = dx[R].min() - dx[L].max()
            print(f'    两眼空隙/皮肤宽={gap/sw:.3f}' if sw else '')

    # 头发宽度（在头区内）
    hair = m & head & (r - b > 60) & (r - g > 30) & (r > 125)
    hy, hx = np.where(hair)
    if len(hx):
        hwid = hx.max() - hx.min() + 1
        print(f'  头部发宽 {hwid}  宽/身高={hwid/ch:.3f}')
        print(f'  发宽/皮肤宽={hwid/sw:.2f}' if sw else '')

    return dict(ch=ch, cw=cw, sw=sw, sh=sh)


ref = analyze('参考立绘', load(sys.argv[1]))
mine = analyze('我的渲染', load(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))

print('\n=== 需要修的比例（参考 → 我的）===')
for k, label in [('sw', '可见皮肤宽/身高'), ('sh', '可见皮肤高/身高')]:
    pass
print(f"{'指标':<22}{'参考':>10}{'我的':>10}{'差':>10}")
for k, label in [('cw_ratio', '全宽/身高'), ('sw_ratio', '皮肤宽/身高'), ('sh_ratio', '皮肤高/身高')]:
    if k == 'cw_ratio':
        rv, mv = ref['cw'] / ref['ch'], mine['cw'] / mine['ch']
    elif k == 'sw_ratio':
        rv, mv = ref['sw'] / ref['ch'], mine['sw'] / mine['ch']
    else:
        rv, mv = ref['sh'] / ref['ch'], mine['sh'] / mine['ch']
    print(f'{label:<20}{rv:>10.3f}{mv:>10.3f}{mv-rv:>+10.3f}')
