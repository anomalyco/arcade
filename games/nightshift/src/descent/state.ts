import type { Rect } from "@arcade/kit/sim/geom"
import { descentLines, type DescentLineId } from "../../shared/descent-lines"
import recordings from "../../shared/descent-recordings.json"

export const BASEMENT_X=40
export const smooth=(t:number)=>{t=Math.max(0,Math.min(1,t));return t*t*t*(10+t*(-15+6*t))}
export const descentDefaults=()=>({rideSeconds:12,doorSeconds:1.8,sway:.004,heat:.35,voice:.32,machinery:.32,lingerSeconds:1.4})
export type DescentSettings=ReturnType<typeof descentDefaults>
/** The closed car changes location once. No camera orientation or input ownership changes. */
export class Descent {
  phase:"floor"|"closing"|"ride"|"opening"|"basement"|"ending"="floor"
  elapsed=0
  closure=0
  downstairs=false
  private linger=0
  private station=-1
  private visited=new Set<number>()
  private floorLines=0
  line:DescentLineId|null=null
  lineTime=0
  private queue:DescentLineId[]=[]
  private hallQueued=false
  private doorProgress=0
  private rideSeconds=12
  readonly doorWalls:Rect[]=[]
  get fade(){return this.phase==="ending"?smooth(this.elapsed/1.5):0}
  get done(){return this.fade===1}
  get riding(){return this.phase==="ride"}
  get leafX(){return 1.5-1.01*this.closure}
  get speed(){if(!this.riding)return 0;const t=this.elapsed/this.rideSeconds*12;return smooth(t/1.4)*(1-.86*smooth((t-3)/3))*(1-smooth((t-9)/3))}
  get subtitle(){return this.line&&this.lineTime<recordings[this.line].speechEnd?descentLines.find(l=>l.id===this.line)!.text:""}
  private start(lines:DescentLineId[],replace=false){if(replace){this.line=null;this.lineTime=0;this.queue=[]}this.queue.push(...lines)}
  /** ready is per-line; unavailable speech never holds the elevator, movement or final door. */
  step(dt:number,body:{x:number;y:number},enabled:boolean,station:number,settings:DescentSettings,ready:(id:DescentLineId)=>boolean=()=>true){
    dt=Math.max(0,Math.min(.05,dt));if(!enabled||dt===0)return
    this.rideSeconds=settings.rideSeconds
    if(this.phase==="floor"){
      if(station!==this.station){this.station=station;this.linger=0}
      if(station>=0&&!this.visited.has(station)&&!this.line){
        this.linger+=dt
        if(this.linger>=settings.lingerSeconds&&this.floorLines<2){this.visited.add(station);this.start([this.floorLines++===0?"floor-private":"floor-apologise"]);this.linger=0}
      }
      if(Math.abs(body.x)<.72&&body.y>9.65){this.phase="closing";this.elapsed=0}
    }else if(this.phase==="closing"){
      // Reopen if the player backs out before the doors meet. Never pinch or pull them into the car.
      this.doorProgress=Math.max(0,Math.min(1,this.doorProgress+(body.y<9.4?-1:1)*dt/settings.doorSeconds))
      this.closure=smooth(this.doorProgress)
      if(this.doorProgress===0){this.phase="floor";this.elapsed=0}
      if(this.closure===1){this.downstairs=true;body.x+=BASEMENT_X;this.phase="ride";this.elapsed=0;this.start(descentLines.filter(l=>l.room==="elevator").map(l=>l.id),true)}
    }else if(this.phase==="ride"){
      this.elapsed+=dt
      if(this.elapsed>=settings.rideSeconds){this.phase="opening";this.elapsed=0}
    }else if(this.phase==="opening"){
      this.elapsed+=dt;this.closure=1-smooth(this.elapsed/settings.doorSeconds)
      if(this.closure===0){this.phase="basement";this.elapsed=0}
    }else if(this.phase==="basement"){
      if(body.y<7&&!this.hallQueued){this.hallQueued=true;this.start(descentLines.filter(l=>l.room==="basement").map(l=>l.id))}
      if(body.y< -15.5&&Math.abs(body.x-BASEMENT_X)<.8){this.phase="ending";this.elapsed=0}
    }else this.elapsed+=dt
    if(this.line){this.lineTime+=dt;const line=descentLines.find(l=>l.id===this.line)!;if(this.lineTime>=recordings[this.line].duration+line.pause){this.line=null;this.lineTime=0}}
    if(!this.line&&this.queue.length){const id=this.queue[0]!;if(ready(id)){this.queue.shift();this.line=id;this.lineTime=0}}
  }
  collisions():readonly Rect[]{
    const x=this.downstairs?BASEMENT_X:0,c=this.leafX
    this.doorWalls.length=0
    // Actual leaves, including their pockets. The player remains free inside the car.
    for(const side of [-1,1])this.doorWalls.push([x+side*c-.488,9.025,x+side*c+.488,9.095])
    return this.doorWalls
  }
  sway(time:number,reduced:boolean,settings:DescentSettings){return reduced?0:Math.sin(time*2.1)*this.speed*settings.sway}
}
