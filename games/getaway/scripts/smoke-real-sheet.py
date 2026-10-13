"""Real in-engine capture comparison with cited reference crops."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3]
out = root / "captures/getaway-smoke-real"
font = "/System/Library/Fonts/Helvetica.ttc"
title, label, small = [ImageFont.truetype(font, n) for n in (28,18,15)]
sheet = Image.new("RGB",(1440,1410),"#10151e")
d=ImageDraw.Draw(sheet)
d.text((16,16),"Getaway · Connected smoke",font=title,fill="#f1f4f7")
d.text((16,58),"Matched seeded moments · real Metal renders",font=label,fill="#abb8ca")
d.text((16,88),"6 / advected billows   7 / directional lighting   8 / raymarched density",font=small,fill="#abb8ca")
concept=Image.open(root/"games/getaway/concept/dir-d-lowpoly-1.png")
concept.thumbnail((1200,1200))
sheet.paste(concept.crop((390,315,625,490)).resize((168,125)),(828,10))
d.text((828,141),"Concept",font=small,fill="#abb8ca")
ref=Image.open(out/"cs2-reference.jpg").crop((913,165,1270,615))
ref.thumbnail((290,152))
sheet.paste(ref,(1108,8))
d.text((1015,168),"Valve · CS2: Responsive Smokes",font=small,fill="#abb8ca")
for col,text in enumerate(["Launch · 0.6 s","Turning boost · 2.1 s","Streetlamps · 3.1 s","Close-up · 2.4 s"]):
    d.text((16+col*356,195),text,font=label,fill="#abb8ca")
styles=[(0,"0 · Original / reference"),(1,"1 · Earlier faceted puffs"),(6,"6 · Advected billows"),(7,"7 · Directional billows"),(8,"8 · Raymarched cloud")]
for row,(style,name) in enumerate(styles):
    y=223+row*236
    d.text((16,y),name,font=label,fill="#f1f4f7")
    for col,frame in enumerate([18,64,92,"close"]):
        image=Image.open(out/f"style-{style}-{frame}.png")
        left=208 if frame=="close" else 128
        image=image.crop((left,230,left+704,640)).resize((348,203),Image.Resampling.LANCZOS)
        sheet.paste(image,(16+col*356,y+24))
sheet.save(out/"getaway-smoke-real.jpg",quality=94)

# Motion inspection strip: live boost, release, drift, and dissipation for every option.
strip=Image.new("RGB",(1200,1090),"#10151e")
draw=ImageDraw.Draw(strip)
for row,style in enumerate([6,7,8]):
    for col,frame in enumerate([32,54,68,88]):
        image=Image.open(out/f"phone-{style}-{frame:03}.jpg")
        image=image.crop((0,360,720,1190)).resize((290,334))
        x=col*300;y=row*362
        strip.paste(image,(x,y+24))
        draw.text((x+8,y+4),f"{style} · {frame*2/30:.1f}s",font=small,fill="white")
strip.save(out/"motion-inspection.jpg",quality=92)
