# usage: python3 sheet.py out.png name1.png name2.png ...  (makes NAME-icon.png masks + contact sheet)
import sys, os
from PIL import Image, ImageDraw, ImageFont
def mask(src):
    dst = os.path.basename(src)[:-4] + '-icon.png'  # always write into cwd
    im = Image.open(src).convert('RGBA').resize((824, 824), Image.LANCZOS)
    m = Image.new('L', (824*4, 824*4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, 824*4-1, 824*4-1), 190*4, fill=255)
    m = m.resize((824, 824), Image.LANCZOS)
    c = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); c.paste(im, (100, 100), m); c.save(dst); return c
sizes = [256, 128, 64, 32, 16]
out, files = sys.argv[1], sys.argv[2:]
rowh, half = 290, 30 + sum(s + 24 for s in sizes)
W = 110 + half * 2
sheet = Image.new('RGB', (W, rowh * len(files)), '#ececec')
d = ImageDraw.Draw(sheet)
d.rectangle((110 + half, 0, W, rowh * len(files)), fill='#1e1f22')
try: font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 22)
except: font = None
for r, f in enumerate(files):
    ic = mask(f) if not f.endswith('-icon.png') else Image.open(f).convert('RGBA')
    y0 = r * rowh
    d.text((10, y0 + rowh // 2 - 10), os.path.basename(f)[:-4][:9], fill='#333', font=font)
    for side in range(2):
        x = 110 + side * half + 15
        for s in sizes:
            t = ic.resize((s, s), Image.LANCZOS)
            sheet.paste(t, (x, y0 + (rowh - s) // 2), t); x += s + 24
sheet.save(out); print(out, sheet.size)
