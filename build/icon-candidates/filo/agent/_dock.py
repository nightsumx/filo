from PIL import Image, ImageFont, ImageDraw
S=1024; inner=824; r=190
def icon(f):
    art=Image.open(f).convert('RGBA').resize((inner,inner),Image.LANCZOS)
    mask=Image.new('L',(inner,inner),0); ImageDraw.Draw(mask).rounded_rectangle((0,0,inner-1,inner-1),r,fill=255)
    ic=Image.new('RGBA',(S,S),(0,0,0,0)); ic.paste(art,(100,100),mask); return ic
items=[('../anime2/n1.png','n1（上轮）'),('../anime2/n2.png','n2（上轮）'),
 ('r1.png','r1 拉线'),('r4.png','r4 环尾'),('r5.png','r5 浅色'),('r2.png','r2 一笔环'),
 ('c8.png','c8 罗盘'),('c4.png','c4 运行'),('r6.png','r6 运行线'),('r3.png','r3 分叉'),('c1.png','c1 拉线')]
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
# grid: all 15 masked candidates at 280px
names=['c1','c2','c3','c4','c5','c6','c7','c8','c9','r1','r2','r3','r4','r5','r6']
cols=5; cw,ch=300,330
g=Image.new('RGB',(cols*cw+20,((len(names)+cols-1)//cols)*ch+20),(236,236,236)); gd=ImageDraw.Draw(g)
f2=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',24)
for i,n in enumerate(names):
    x,y=20+(i%cols)*cw,20+(i//cols)*ch
    t=icon(n+'.png').resize((280,280),Image.LANCZOS); g.paste(t,(x-10,y),t)
    w=gd.textlength(n,font=f2); gd.text((x+130-w/2,y+285),n,fill=(30,30,30),font=f2)
g.save('grid.png')
print(lab.size,g.size)
