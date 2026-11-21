# 把 3D 渲染图（指定区域）转成字符图，用来看清"贴到头上之后"的效果。
# 用法: python ascii-render.py <png> <x0,y0,x1,y1> [cols]
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
box = sys.argv[2] if len(sys.argv) > 2 else None
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 46

im = Image.open(path).convert('RGB')
a = np.asarray(im).astype(int)
H, W, _ = a.shape

if box and box != 'auto':
    x0, y0, x1, y1 = [int(v) for v in box.split(',')]
else:
    bg = np.array([246, 239, 225])
    m = (np.abs(a - bg).sum(axis=2) > 26)
    ys, xs = np.where(m)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()

sub = a[y0:y1 + 1, x0:x1 + 1]
sh, sw, _ = sub.shape
r = sub[..., 0]; g = sub[..., 1]; b = sub[..., 2]
lum = (r * 299 + g * 587 + b * 114) / 1000

out = np.full((sh, sw), ' ', dtype='<U1')
rules = [
    ('@', (lum < 62)),                                       # 睫毛/瞳/描边
    ('W', (lum > 243) & (np.abs(r - b) < 26)),               # 高光/眼白
    ('Y', (r > 195) & (r - b > 95) & (g > 130)),             # 虹膜金
    ('O', (r > 140) & (r - b > 78) & (g > 66) & (g < 178)),  # 虹膜橙
    ('s', (r > 200) & (g > 120) & (g < 196) & (b > 96) & (r - g > 26)),  # 腮红/嘴
    ('#', (r > 198) & (r - b > 110) & (g > 96) & (g < 172)),  # 橙发
    ('o', (r > 130) & (r < 205) & (r - b > 62) & (g < 108)),  # 暗发
    (',', (r > 232) & (g > 208) & (b > 180) & (np.abs(r - b) < 52)),  # 奶油裙
    ('.', lum > 200),                                         # 亮面
    ('-', lum > 120),                                         # 中间调
    ('+', lum <= 120),                                        # 暗部
]
for ch, mk in rules:
    out[mk & (out == ' ')] = ch

sx = max(1, sw // cols)
sy = max(1, int(round(sx * 2.05)))
print(f'{path}  region {x0},{y0}-{x1},{y1}  {sw}x{sh}  step {sx}x{sy}')
print('    ' + ''.join(str((i // 10) % 10) for i in range(cols)))
print('    ' + ''.join(str(i % 10) for i in range(cols)))
print('   +' + '-' * cols)
for yy in range(0, sh, sy):
    line = ''
    for xx in range(0, sw, sx):
        blk = out[yy:yy + sy, xx:xx + sx]
        vals, cnts = np.unique(blk, return_counts=True)
        best, bn = ' ', 0
        for v, c in zip(vals, cnts):
            if v == ' ':
                continue
            if c > bn:
                bn, best = c, v
        line += best
    print(f'{y0 + yy:4d}|' + line)
print('   +' + '-' * cols)
print('@ 睫毛/瞳  W 高光/眼白  Y 虹膜金  O 虹膜橙  s 腮红/嘴  # 橙发  o 暗发  , 奶油裙')
