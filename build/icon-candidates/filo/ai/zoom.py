# usage: python3 zoom.py src.png out.png frac  -> re-frame mark so its bbox max-dim = frac of canvas, on a flattened solid bg
import sys
from PIL import Image, ImageChops
src, out, frac = sys.argv[1], sys.argv[2], float(sys.argv[3])
im = Image.open(src).convert('RGB'); W = im.width
px = [im.getpixel(p) for p in [(8, 8), (W-9, 8), (8, W-9), (W-9, W-9)]]
bg = tuple(sorted(c[i] for c in px)[1] for i in range(3))
# mask of mark pixels (distance from bg), soft for antialiasing
diff = ImageChops.difference(im, Image.new('RGB', im.size, bg)).convert('L')
alpha = diff.point(lambda v: 0 if v < 14 else min(255, (v - 14) * 6))
bbox = alpha.point(lambda v: 255 if v > 128 else 0).getbbox()
mark, a = im.crop(bbox), alpha.crop(bbox)
s = frac * W / max(mark.size)
size = (round(mark.width * s), round(mark.height * s))
mark, a = mark.resize(size, Image.LANCZOS), a.resize(size, Image.LANCZOS)
c = Image.new('RGB', (W, W), bg)
c.paste(mark, ((W - size[0]) // 2, (W - size[1]) // 2), a)
c.save(out); print(out, 'bg', bg, 'bbox', bbox, 'scale %.2f' % s)
