import type { MapDef } from "../../shared/maps"
import type { SpellView } from "../../shared/sim/spells"
import { MAT, Mesh } from "../render/mesh"
import { castleProp } from "../render/castle"
import type { Caster, DynLight } from "../render/lighting"
import type { Renderer } from "../render/renderer"
import { animate, newAvatar, pose, type Avatar, type PartModels } from "./anim"
type Sprite = (add: boolean, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void

export class SpellFx {
  private moon: number
  private scroll: number
  private props: number[] = []
  private actors=new Map<number,Avatar>()
  constructor(private renderer: Pick<Renderer, "addModel">, private bones: PartModels) {
    const m=new Mesh(), point=(a:number,b:number) => [Math.cos(a)*Math.cos(b),Math.sin(b),Math.sin(a)*Math.cos(b)]
    for(let j=0;j<10;j++) for(let i=0;i<16;i++) {
      const a=i*Math.PI/8,b=(j/10-0.5)*Math.PI,A=a+Math.PI/8,B=b+Math.PI/10
      const n=point((a+A)/2,(b+B)/2)
      const crater = [[0.3,0.65,0.7],[-0.6,0.6,0.5],[0.75,0.1,0.6]].some(p=>Math.hypot(n[0]!-p[0]!,n[1]!-p[1]!,n[2]!-p[2]!)<0.25)
      const shade = (0.6+0.32*Math.max(0,-n[0]!*0.4+n[1]!*0.8+n[2]!*0.4))*(crater?0.72:1)
      m.quadAuto(point(a,b),point(a,B),point(A,B),point(A,b),[shade*0.87,shade*0.91,shade],MAT.glow,0.8)
    }
    this.moon=renderer.addModel(m)
    const s=new Mesh()
    s.box(-0.25,0,-0.2,0.25,0.025,0.2,[0.8,0.65,0.4],MAT.actor)
    for(const x of [-0.25,0.25]) s.box(x-0.04,-0.015,-0.24,x+0.04,0.09,0.24,[0.95,0.82,0.56],MAT.actor)
    s.box(-0.035,0.026,-0.21,0.035,0.035,0.21,[0.42,0.12,0.12],MAT.actor)
    this.scroll=renderer.addModel(s)
  }
  setMap(map: MapDef) {
    // Wizards owns a fixed fixture; its prop meshes are reusable across match seeds.
    if(this.props.length) return
    for(const p of map.props) {
      const x=(p.rect[0]+p.rect[2])/2,y=(p.rect[1]+p.rect[3])/2,m=new Mesh()
      castleProp(m,{...p,rect:[p.rect[0]-x,p.rect[1]-y,p.rect[2]-x,p.rect[3]-y]},map.seed)
      this.props.push(this.renderer.addModel(m))
    }
  }
  lights(s:SpellView,dyn:DynLight[],casters:Caster[]) {
    for(const m of s.moons) dyn.push({x:m.x,y:m.y,h:1.5,r:5.5,color:[0.72,0.8,1],power:0.5,size:m.radius*0.6})
    for(const p of s.skeletons) casters.push({x:p.x,y:p.y,r:0.3,h:1.55})
    for(const p of s.props) casters.push({x:p.x,y:p.y,r:0.45,h:0.85+p.h})
  }
  draw(s:SpellView,t:number,dt:number,parts:Map<number,number[]>,fx:Sprite) {
    const push=(model:number,x:number,y:number,z:number,yaw=0,scale=1,pitch=0,roll=0,alpha=1) => {
      let a=parts.get(model); if(!a) parts.set(model,a=[])
      a.push(x,y,z,yaw,1,1,1,scale,pitch,roll,alpha,0)
    }
    for(const p of s.props) if(this.props[p.id]!==undefined) push(this.props[p.id]!,p.x,p.h,p.y,p.angle)
    for(const scroll of s.scrolls) {
      push(this.scroll,scroll.x,scroll.h+0.07,scroll.y)
      fx(true,scroll.x,scroll.h+0.15,scroll.y,0.45,1,0.65,0.25,0.25,0)
    }
    for(const m of s.moons) {
      const age=t-m.born, grow=Math.min(1,age/s.config.moonAnticipation)
      const warn=Math.max(0,1-(m.end-t)/0.38), size=m.radius*(0.4+0.6*grow)*(1-0.12*warn)
      push(this.moon,m.x,1.5,m.y,age*0.2,size)
      fx(true,m.x,1.5,m.y,size*1.3,0.7,0.8,1,0.1+warn*0.1,0)
      fx(true,m.x,0.03,m.y,m.radius+0.65,0.6,0.7,0.9,0.2+warn*0.35,2,0,0.025)
      // A few travelling points describe the orbit without a bloom cloud.
      for(let i=0;i<6;i++) {const a=age*2.4+i*Math.PI/3,r=m.radius+0.65;fx(true,m.x+Math.cos(a)*r,0.1,m.y+Math.sin(a)*r,0.045,0.65,0.8,1,0.6,0)}
    }
    for(const id of this.actors.keys()) if(!s.skeletons.some(v=>v.id===id)) this.actors.delete(id)
    for(const sk of s.skeletons) {
      let a=this.actors.get(sk.id)
      if(!a) {a=newAvatar(`skeleton${sk.id}`,sk.x,sk.y,sk.aim,"rifle");this.actors.set(sk.id,a)}
      a.bare=true
      a.shambler=true
      a.swingAt=sk.attackAt?sk.attackAt-0.35:sk.struckAt-0.35
      // Hit recoil is driven by the authoritative timestamp, including retarget hits.
      a.torsoKick.x=Math.max(0,1-(t-sk.hitAt)/0.3)*0.35-Math.max(0,1-(t-sk.struckAt)/0.25)*0.12
      animate(a,dt,t,sk.x,sk.y,sk.vx,sk.vy,sk.aim)
      const rise=Math.min(1,(t-sk.born)/s.config.skeletonRise), low=-(1-rise)*1.45-(sk.crawl?0.7:0)
      pose((model,x,y,z,yaw,_tint,pitch,roll,_flash,alpha) => {
        if(sk.crawl && [this.bones.thigh,this.bones.shin,this.bones.foot,this.bones.toe].includes(model)) return
        push(model,x,y+low,z,yaw,1,pitch,roll,alpha)
      },a,[1,1,1],this.bones)
      if(rise<1) {
        fx(false,sk.x,0.02,sk.y,0.7,0.025,0.017,0.033,0.9,6)
        fx(true,sk.x,0.04,sk.y,0.8,0.5,0.2,0.85,1-rise,2,0,0.08)
      }
    }
    for(const f of s.flashes) {
      const age=t-f.at,u=Math.max(0,1-age/1.1)
      if(f.kind==="pop") {
        fx(true,f.x,1.2,f.y,0.8+age*6,0.65,0.8,1,u*u,2,0,0.12)
        for(let i=0;i<16;i++) {const a=i*Math.PI/8,r=age*5;fx(true,f.x+Math.cos(a)*r,1.5-age,f.y+Math.sin(a)*r,0.1+u*0.12,0.8,0.9,1,u,0)}
      } else if(f.kind==="fizzle" || f.kind==="burn") {
        for(let i=0;i<8;i++) {const a=i*2.4;fx(f.kind==="burn",f.x+Math.cos(a)*age*0.6,0.6+age+Math.sin(a)*0.3,f.y+Math.sin(a)*age*0.6,0.15+age*0.4,0.7,f.kind==="burn"?0.3:0.65,0.45,u*0.7,0)}
      }
    }
  }
}
