import sys
from PIL import Image, ImageDraw
S=1024; inner=824; r=190
for f in sys.argv[1:]:
    art=Image.open(f).convert('RGBA').resize((inner,inner),Image.LANCZOS)
    m=Image.new('L',(inner,inner),0); ImageDraw.Draw(m).rounded_rectangle((0,0,inner-1,inner-1),r,fill=255)
    ic=Image.new('RGBA',(S,S),(0,0,0,0)); ic.paste(art,(100,100),m); ic.save(f.replace('.png','-icon.png'))
