from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parents[3]
out=root/"captures/getaway-smoke-realistic-v2"
font="/System/Library/Fonts/Helvetica.ttc"
title,label,small=[ImageFont.truetype(font,n) for n in (28,20,16)]
sheet=Image.new("RGB",(1440,1440),"#10151e")
d=ImageDraw.Draw(sheet)
d.text((16,16),"Getaway · Tyres, nitro & exhaust · v2",font=title,fill="#f1f4f7")
rows=[
 ("Drift · rear plumes merge, then dissipate","drift",[32,64,125,245],["1.1s · warming tyres","2.1s · two sources","4.2s · lingering cloud","8.2s · dissipated"]),
 ("Burnout / launch","burnout",[12,72,105,275],["0.4s · light haze","2.4s · hot tyres","3.5s · car leaves cloud","9.2s · dissipated"]),
 ("Standing nitro · rear-wheel smoke & skids","launch",[16,30,64,230],["0.5s · wheels spin","1.0s · connected plumes","2.1s · grip returns","7.7s · dissipated"]),
 ("Nitro · straight run, no tyre smoke","nitro",[12,36,64,84],["0.4s · boost starts","1.2s · attached flames","2.1s · clear road","2.8s · clear road"]),
 ("Occasional orange pops","pops",["pop-30",65,"pop-100",103],["1.0s · shift proxy","2.2s · no flame","3.3s · lift-off","3.4s · fading"]),
 ("Cold exhaust · short condensation wisp","cold",[12,32,64,84],["0.4s","1.1s","2.1s","2.8s"]),
]
for row,(name,case,frames,captions) in enumerate(rows):
 y=64+row*226
 d.text((16,y),name,font=label,fill="#f1f4f7")
 for col,(frame,caption) in enumerate(zip(frames,captions)):
  image=Image.open(out/f"still-{case}-{frame}.jpg")
  box=(140,200,844,560) if case in ["drift","burnout","launch"] else (280,210,704,426)
  image=image.crop(box).resize((348,178),Image.Resampling.LANCZOS)
  sheet.paste(image,(16+col*356,y+26))
  d.text((16+col*356,y+206),caption,font=small,fill="#abb8ca")
sheet.save(out/"getaway-smoke-realistic-v2.jpg",quality=94)

strip=Image.new("RGB",(1200,1035),"#10151e");d=ImageDraw.Draw(strip)
for row,(case,frames) in enumerate([("drift",[32,64,125,245]),("launch",[16,30,64,230]),("pops",["pop-30",65,"pop-100",103])]):
 for col,frame in enumerate(frames):
  image=Image.open(out/f"portrait-{case}-{frame}.jpg").crop((0,320,720,1090)).resize((290,310))
  strip.paste(image,(col*300,row*345+25));d.text((col*300+8,row*345+3),f"{case} · {frame}",font=small,fill="white")
strip.save(out/"motion-inspection.jpg",quality=92)
