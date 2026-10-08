from PIL import Image, ImageFont, ImageDraw
S=1024; inner=824; r=190
def icon(f):
    art=Image.open(f).convert('RGBA').resize((inner,inner),Image.LANCZOS)
    mask=Image.new('L',(inner,inner),0); ImageDraw.Draw(mask).rounded_rectangle((0,0,inner-1,inner-1),r,fill=255)
    ic=Image.new('RGBA',(S,S),(0,0,0,0)); ic.paste(art,(100,100),mask); return ic
items=[('r2-f-dark.png','A 线f·暗'),('r2-f-light.png','B 线f·亮'),('r2-prompt.png','C 三线提示符'),('r2-braid.png','D 三股辫'),('r1-stitch.png','E 缝线'),('r1-knot.png','F 绳结'),('r2-plumb.png','G 铅垂'),('r1-pinch.png','H 交汇'),('r1-shuttle.png','I 梭子'),('r1-spool.png','J 线轴')]
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
