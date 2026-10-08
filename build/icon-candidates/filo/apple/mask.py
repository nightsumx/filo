import sys,glob,os
from PIL import Image, ImageDraw, ImageFont
S=1024; inner=824; r=190
def icon(f):
    art=Image.open(f).convert('RGBA').resize((inner,inner),Image.LANCZOS)
    mask=Image.new('L',(inner,inner),0); ImageDraw.Draw(mask).rounded_rectangle((0,0,inner-1,inner-1),r,fill=255)
    ic=Image.new('RGBA',(S,S),(0,0,0,0)); ic.paste(art,(100,100),mask); return ic
files=sorted(f for f in glob.glob('[0-9]*.png') if not f.endswith('-icon.png'))
for f in files: icon(f).save(f[:-4]+'-icon.png')
# grid: each icon at 280 with 64px and 32px previews below
fnt=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',22)
cols=5; cw=300; chh=420
rows=(len(files)+cols-1)//cols
g=Image.new('RGB',(cols*cw,rows*chh),(236,236,236)); d=ImageDraw.Draw(g)
for i,f in enumerate(files):
    ic=Image.open(f[:-4]+'-icon.png'); x=(i%cols)*cw+10; y=(i//cols)*chh+10
    g.paste(ic.resize((280,280),Image.LANCZOS),(x,y),ic.resize((280,280),Image.LANCZOS))
    s64=ic.resize((64,64),Image.LANCZOS); s32=ic.resize((32,32),Image.LANCZOS)
    g.paste(s64,(x+60,y+330),s64); g.paste(s32,(x+150,y+346),s32)
    d.text((x+4,y+290),f[:-4],fill=(30,30,30),font=fnt)
g.save(sys.argv[1] if len(sys.argv)>1 else 'grid.png')
print(files)
