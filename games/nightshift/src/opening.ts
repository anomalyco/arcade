/**
 * Authored seated opening. Camera input resumes at the exact settled pose. Playtest Oct 21 (02:47): "Why do I have to
 * listen to this dialogue? I want to explore", so the holds are short: 8 s from Begin to your hands (was 15.5 s). Space
 * skips it on a repeat view.
 */
export const OPENING={seat:{x:-.74,z:-4.47,height:1.2,yaw:0,pitch:-.12},phone:{yaw:-.80,pitch:-.25},across:{yaw:-3.10,pitch:.025,height:1.40},drain:1.4,empty:2.8,ring:3.4,drift:4.6,driftFor:3,end:8}
type Spring={x:number;v:number}
export function spring(s:Spring,target:number,dt:number,duration:number,bounce=0){
  const w=2*Math.PI/duration,z=1-bounce,d=s.x-target
  if(bounce===0){const e=Math.exp(-w*dt),c=s.v+w*d;s.x=target+(d+c*dt)*e;s.v=(s.v-w*c*dt)*e;return}
  const a=w*z,b=w*Math.sqrt(1-z*z),e=Math.exp(-a*dt),c=Math.cos(b*dt),sn=Math.sin(b*dt),q=(s.v+a*d)/b
  s.x=target+e*(d*c+q*sn);s.v=e*((q*b-a*d)*c-(d*b+a*q)*sn)
}
export const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*t*(10+t*(-15+6*t))}
/** How far from the phone the receiver's cord lets you walk during the call (m, horizontal). */
export const CORD_REACH=1.9
/**
 * Keeps the body within `reach` of the phone while on the call: the part of this frame's move that pulls the cord
 * tighter is dropped, so you slide round the edge. Returns true when it moved the body.
 */
export function cordLimit(body:{x:number;y:number},before:readonly number[],phone:{x:number;z:number},reach:number){
  const dx=body.x-phone.x,dz=body.y-phone.z,d=Math.hypot(dx,dz)
  if(d<=reach)return false
  const bx=before[0]!-phone.x,bz=before[1]!-phone.z,bd=Math.hypot(bx,bz)
  if(bd>1e-6&&bd<=reach){
    const rx=bx/bd,rz=bz/bd,mx=body.x-before[0]!,mz=body.y-before[1]!,out=mx*rx+mz*rz
    if(out>0){body.x-=out*rx;body.y-=out*rz}
  }
  const nd=Math.hypot(body.x-phone.x,body.y-phone.z)
  if(nd>reach){body.x=phone.x+(body.x-phone.x)*reach/nd;body.y=phone.z+(body.y-phone.z)*reach/nd}
  return true
}
export const openingSettings=()=>({whipDuration:.38,whipBlur:.65})
export class Opening {
  time=0;started=false;complete=false;standing=false;skipping=false
  yaw:Spring={x:OPENING.seat.yaw,v:0};pitch:Spring={x:OPENING.seat.pitch,v:0};height:Spring={x:OPENING.seat.height,v:0}
  start(){this.started=true}
  skip(seen:boolean){if(seen&&this.started&&!this.complete){this.skipping=true;this.time=Math.max(this.time,OPENING.drift+OPENING.driftFor)}}
  stand(){if(this.complete)this.standing=true}
  get tokens(){return 1-smooth((this.time-OPENING.drain)/(OPENING.empty-OPENING.drain))}
  get fade(){return 1-smooth(this.time/1.3)}
  get roomGain(){return this.time<OPENING.empty?.18:smooth((this.time-OPENING.empty-.55)/.8)}
  step(dt:number,active:boolean,reduced:boolean,whipDuration=.38){
    if(!this.started||!active)return
    const d=Math.min(.05,Math.max(0,dt));this.time+=d
    if(!this.complete){
      let yaw=OPENING.seat.yaw,pitch=OPENING.seat.pitch,height=OPENING.seat.height,duration=.3,bounce=0
      if(this.time>=OPENING.ring){yaw=OPENING.phone.yaw;pitch=OPENING.phone.pitch;duration=reduced?1.15:whipDuration;bounce=reduced?0:.24}
      if(this.time>=OPENING.drift){
        const t=smooth((this.time-OPENING.drift)/OPENING.driftFor)
        yaw=OPENING.phone.yaw+(OPENING.across.yaw-OPENING.phone.yaw)*t
        pitch=OPENING.phone.pitch+(OPENING.across.pitch-OPENING.phone.pitch)*t
        height=OPENING.seat.height+(OPENING.across.height-OPENING.seat.height)*t
        duration=this.skipping?.8:.35;bounce=0
      }
      spring(this.yaw,yaw,d,duration,bounce);spring(this.pitch,pitch,d,duration,bounce);spring(this.height,height,d,.8)
      if(this.time>=OPENING.end&&Math.abs(this.yaw.v)+Math.abs(this.pitch.v)+Math.abs(this.height.v)<.0001)this.complete=true
    }else spring(this.height,this.standing?1.65:OPENING.across.height,d,.65)
  }
}
