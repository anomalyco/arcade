import { SPELL_ICONS, SPELL_NAMES, type SpellId } from "../../shared/sim/spell-config"
import { RUNES, resample, type Point } from "../game/runes"
import type { Game } from "../game/game"
import type { Input } from "../game/input"
import type { Camera } from "../render/camera"

/** Screen-space ink and world-anchored rune billboards. No persistent rune hints without the assist. */
export class SpellHud {
  private canvas=document.createElement("canvas")
  private ctx:CanvasRenderingContext2D
  constructor() {
    this.canvas.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:12"
    document.body.append(this.canvas);this.ctx=this.canvas.getContext("2d")!
  }
  private line(points:readonly Point[],color:string,width=3) {
    if(!points.length) return
    const c=this.ctx;c.beginPath();c.moveTo(points[0]!.x,points[0]!.y)
    for(const p of points.slice(1)) c.lineTo(p.x,p.y)
    c.strokeStyle=color;c.lineWidth=width;c.lineJoin=c.lineCap="round";c.shadowColor=color;c.shadowBlur=12;c.stroke();c.shadowBlur=0
  }
  private rune(id:SpellId,x:number,y:number,size:number,progress=1,color="#d4e6ff") {
    this.line(resample(RUNES[id],96).slice(0,Math.ceil(progress*96)).map(p=>({x:x+p.x*size,y:y+p.y*size})),color)
    if(id==="moon" && progress>0.94) {const c=this.ctx;c.fillStyle=color;c.beginPath();c.arc(x,y,3,0,Math.PI*2);c.fill()}
  }
  draw(g:Game,input:Input,cam:Camera,w:number,h:number) {
    const c=this.ctx
    if(this.canvas.width!==w || this.canvas.height!==h) {this.canvas.width=w;this.canvas.height=h}
    c.clearRect(0,0,w,h)
    const s=g.snap?.spells;if(!s) return
    const t=g.snap!.t
    c.font="14px 'IBM Plex Mono', monospace";c.fillStyle="#d9d5c7";c.textAlign="left"
    c.fillText((s.learned[g.myId]??[]).map(id=>`${SPELL_ICONS[id]} ${SPELL_NAMES[id]}`).join("   "),24,h-102)
    for(const scroll of s.scrolls) {
      const p=cam.project(scroll.x,scroll.h+0.4,scroll.y,w,h)
      if(!p.ok) continue
      if(!scroll.reader && g.alive && g.body && Math.hypot(g.body.x-scroll.x,g.body.y-scroll.y)<2.4) {
        c.textAlign="center";c.fillStyle="#ffe1a1";c.fillText(`F · ${SPELL_NAMES[scroll.spell]}`,p.x,p.y-20)
      }
      if(scroll.reader===g.myId) {
        const progress=Math.max(0,Math.min(1,(t-(scroll.end-2))/2)), width=160*Math.min(1,progress*6)
        const x=w/2,y=h/2-60
        c.fillStyle="#dec28e";c.shadowColor="#000";c.shadowBlur=25;c.fillRect(x-width/2,y-95,width,190);c.shadowBlur=0
        c.fillStyle="#a68145";c.fillRect(x-width/2-5,y-100,8,200);c.fillRect(x+width/2-3,y-100,8,200)
        if(progress>0.15) this.rune(scroll.spell,x,y+8,55,Math.min(1,(progress-0.15)/0.7),"#34263d")
        c.fillStyle="#34263d";c.textAlign="center";c.fillText(SPELL_NAMES[scroll.spell],x,y-70)
      }
    }
    for(const f of s.flashes) if(f.kind==="cast" && f.spell) {
      const who=g.snap!.players.find(p=>p.id===f.by),p=cam.project(who?.x??f.x,2.7,who?.y??f.y,w,h)
      c.globalAlpha=Math.max(0,1-(t-f.at)/1.1)
      if(p.ok) this.rune(f.spell,p.x,p.y,28,1,f.quality===1?"#d5eaff":"#dcb1ed")
      c.globalAlpha=1
    }
    if(g.juice.showRunes) for(const [i,id] of (["moon","necromancy"] as const).entries()) {
      const x=w-100-i*160;c.textAlign="center";c.fillStyle="#d4e6ff";c.fillText(SPELL_NAMES[id],x,82);this.rune(id,x,139,37)
    }
    this.line(input.stroke,"#c8eaff",3)
    if(g.runeResult && performance.now()-g.runeResult.at<1100) {
      c.textAlign="center";c.fillStyle="#d4e6ff";c.fillText(g.runeResult.text,w/2,h-110)
    }
  }
}
