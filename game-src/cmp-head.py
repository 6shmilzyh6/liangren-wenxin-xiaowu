# 头部并排对比：把参考立绘和我的渲染的头部裁成同样高度，左右拼接。
# 用法: python cmp-head.py <参考图> <渲染图> <输出> <参头盒> <我头盒>
import sys
from PIL import Image

ref_p, mine_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
rb = [int(v) for v in sys.argv[4].split(',')]
mb = [int(v) for v in sys.argv[5].split(',')]
H = 560

ref = Image.open(ref_p).convert('RGB').crop(tuple(rb))
mine = Image.open(mine_p).convert('RGB').crop(tuple(mb))
ref = ref.resize((int(ref.width * H / ref.height), H), Image.LANCZOS)
mine = mine.resize((int(mine.width * H / mine.height), H), Image.LANCZOS)

gap = 10
canvas = Image.new('RGB', (ref.width + gap + mine.width, H), (250, 246, 238))
canvas.paste(ref, (0, 0))
canvas.paste(mine, (ref.width + gap, 0))
canvas.save(out_p)
print(f'{out_p}  {canvas.width}x{canvas.height}   左=参考({ref.width}px)  右=我的({mine.width}px)')
