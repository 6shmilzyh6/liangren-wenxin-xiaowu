# 把参考立绘和我的渲染图并排拼在一起，同高对比 —— 这是唯一可靠的"对没对上"的判断方式。
# 用法: python compare.py <参考图> <渲染图> <输出图> [参考裁剪盒] [渲染裁剪盒]
import sys
import numpy as np
from PIL import Image

ref_p, mine_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
ref_box = sys.argv[4] if len(sys.argv) > 4 else None
mine_box = sys.argv[5] if len(sys.argv) > 5 else None
TARGET_H = 640


def load_trim(p, box):
    im = Image.open(p).convert('RGB')
    if box:
        x0, y0, x1, y1 = [int(v) for v in box.split(',')]
        im = im.crop((x0, y0, x1, y1))
    else:
        a = np.asarray(im).astype(int)
        H, W, _ = a.shape
        cs = np.array([a[1, 1], a[1, W - 2], a[H - 2, 1], a[H - 2, W - 2]]).astype(int)
        bg = np.median(cs, axis=0)
        m = np.abs(a - bg).sum(axis=2) > 36
        ys, xs = np.where(m)
        if len(xs) == 0:
            return im
        pad = 6
        im = im.crop((max(0, xs.min() - pad), max(0, ys.min() - pad),
                      min(W, xs.max() + pad), min(H, ys.max() + pad)))
    return im


ref = load_trim(ref_p, ref_box)
mine = load_trim(mine_p, mine_box)


def scale(im):
    w, h = im.size
    return im.resize((int(w * TARGET_H / h), TARGET_H), Image.LANCZOS)


ref = scale(ref)
mine = scale(mine)
gap = 14
canvas = Image.new('RGB', (ref.width + gap + mine.width, TARGET_H + 30), (246, 239, 225))
canvas.paste(ref, (0, 30))
canvas.paste(mine, (ref.width + gap, 30))
canvas.save(out_p)
print(f'输出 {out_p}  {canvas.width}x{canvas.height}  左=参考 {ref.width}px  右=我的 {mine.width}px')
