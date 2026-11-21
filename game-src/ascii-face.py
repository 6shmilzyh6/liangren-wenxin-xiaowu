# 把脸贴图渲染成可读的字符图（用 Python 直接读 png，不依赖视觉接口）。
import sys
import numpy as np
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else r'D:\Documents\大肥鱼书房\game-shots\claude\face-idle.png'
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 64

im = Image.open(path).convert('RGBA')
a = np.asarray(im)
H, W, _ = a.shape
r = a[..., 0].astype(int)
g = a[..., 1].astype(int)
b = a[..., 2].astype(int)
al = a[..., 3] > 30

# 精细分类：按实际绘制用的颜色归类
def classify():
    out = np.full((H, W), ' ', dtype='<U1')
    # 顺序即优先级
    rules = [
        ('@', (r < 70) & (g < 60) & (b < 55) & al),                    # 睫毛/瞳孔/眉
        ('W', (r > 240) & (g > 235) & (b > 228) & al),                 # 高光
        ('w', (r > 228) & (g > 220) & (b > 205) & (r - b < 40) & al),  # 眼白
        ('Y', (r > 200) & (g > 150) & (b < 130) & (r - b > 90) & al),  # 虹膜亮部(金)
        ('O', (r > 130) & (g > 60) & (g < 160) & (b < 110) & (r - b > 70) & al),  # 虹膜主色
        ('D', (r > 60) & (r < 140) & (g < 80) & (b < 70) & al),        # 虹膜暗部
        ('s', (r > 205) & (g > 120) & (g < 200) & (b > 100) & (b < 180) & (r - g > 25) & al),  # 腮红/嘴
        ('-', al),                                                      # 其余透明层
    ]
    for ch, m in rules:
        out[m & (out == ' ')] = ch
    return out

cls = classify()
step = max(1, W // cols)
stepy = max(1, int(round(step * 2.05)))
print(f'{path}  {W}x{H}  采样 {step}x{stepy}')
print('    ' + ''.join(str((i // 10) % 10) for i in range(cols)))
print('    ' + ''.join(str(i % 10) for i in range(cols)))
print('   +' + '-' * cols)
for yy in range(0, H, stepy):
    line = ''
    for xx in range(0, W, step):
        block = cls[yy:yy + stepy, xx:xx + step]
        vals, cnts = np.unique(block, return_counts=True)
        # 非空格优先，避免被空白淹没
        best, bn = ' ', 0
        for v, c in zip(vals, cnts):
            if v == ' ':
                continue
            if c > bn:
                bn, best = c, v
        line += best
    print(f'{yy:3d}|' + line)
print('   +' + '-' * cols)
print('@ 睫毛/瞳   W 高光   w 眼白   Y 虹膜亮   O 虹膜   D 虹膜暗   s 腮红/嘴   - 其它')
