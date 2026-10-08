# preview sheet: each icon at 256 + 64 + 32 on mid-gray, for my own judging
import sys
from PIL import Image, ImageDraw, ImageFont
fs=sys.argv[2:]; out=sys.argv[1]
fnt=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',18)
cw=400; im=Image.new('RGB',(cw*min(5,len(fs)),330*((len(fs)+4)//5)),(128,128,130)); d=ImageDraw.Draw(im)
for i,f in enumerate(fs):
    x=(i%5)*cw; y=(i//5)*330; ic=Image.open(f)
    for s,(ox,oy) in [(256,(10,30)),(64,(280,60)),(32,(296,150))]:
        t=ic.resize((s,s),Image.LANCZOS); im.paste(t,(x+ox,y+oy),t)
    d.text((x+10,y+5),f.replace('-icon.png',''),fill=(255,255,255),font=fnt)
im.save(out)
