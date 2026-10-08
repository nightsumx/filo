from PIL import Image, ImageFont, ImageDraw
S=1024; inner=824; r=190
def icon(f):
    art=Image.open(f).convert('RGBA').resize((inner,inner),Image.LANCZOS)
    mask=Image.new('L',(inner,inner),0); ImageDraw.Draw(mask).rounded_rectangle((0,0,inner-1,inner-1),r,fill=255)
    ic=Image.new('RGBA',(S,S),(0,0,0,0)); ic.paste(art,(100,100),mask); return ic
items=[('11-loop-blue.png','11 圈'),('12-loop-cream.png','12 圈·米'),('15-needle-dark.png','15 针·黑'),('05-eye.png','05 针·靛'),('14-f-orange.png','14 f·橙'),('02-f.png','02 f·黑'),('06-bars.png','06 双线'),('08-fork.png','08 分叉'),('01-loop.png','01 圈·细'),('16-needle-cream.png','16 斜针')]
src=Image.open('../anime/_dockbottom.png').convert('RGB'); W,H=src.size
L,R=1405,2500; pitch=219; ic=170; pad_l=22; pad_r=28
mid_w=pad_l+(len(items)-1)*pitch+ic+pad_r
bg=src.crop((1290,0,1340,H)).resize((mid_w,H),Image.BICUBIC)
tile=round(ic*1024/824)
for i,(f,n) in enumerate(items):
    t=icon(f).resize((tile,tile),Image.LANCZOS)
    bg.paste(t,(pad_l+i*pitch-round(100*tile/1024),139-round(100*tile/1024)),t)
out=Image.new('RGB',(L+mid_w+(W-R),H))
out.paste(src.crop((0,0,L,H)),(0,0)); out.paste(bg,(L,0)); out.paste(src.crop((R,0,W,H)),(L+mid_w,0))
out=out.crop((0,80,out.width,H))
lab=Image.new('RGB',(out.width,out.height+70),(30,31,34)); lab.paste(out,(0,0)); d=ImageDraw.Draw(lab)
fnt=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',34)
for i,(f,n) in enumerate(items):
    cx=L+pad_l+i*pitch+ic//2; w=d.textlength(n,font=fnt); d.text((cx-w/2,out.height+16),n,fill=(220,220,220),font=fnt)
lab.save('dock.png')
