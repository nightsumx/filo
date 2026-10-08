import glob
from PIL import Image, ImageDraw, ImageFont
fs=sorted(glob.glob('r[12]-*-icon.png')); fnt=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',22)
c=6; cw,ch=300,330; rows=(len(fs)+c-1)//c
g=Image.new('RGB',(c*cw,rows*ch),'#ececec'); d=ImageDraw.Draw(g)
for i,f in enumerate(fs):
    x,y=(i%c)*cw,(i//c)*ch; t=Image.open(f).resize((280,280),Image.LANCZOS); g.paste(t,(x+10,y+5),t)
    n=f.replace('-icon.png',''); w=d.textlength(n,font=fnt); d.text((x+cw/2-w/2,y+290),n,fill=(40,40,40),font=fnt)
g.save('grid.png')
