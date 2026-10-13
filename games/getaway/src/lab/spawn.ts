import type { LabContext } from "@arcade/kit/lab/types"
import type { CharacterSpawnable, ItemWorld, SpawnPoint } from "@arcade/kit/lab/spawn-types"
import type { LabLight } from "@arcade/kit/lab/stage"
import type { ParticleSpec } from "@arcade/kit/fx/particles"
import { yardGround, yardRamp, yardWalls } from "@arcade/kit/lab/yard"
import { VEHICLES } from "../../shared/config"
import { newBody, stepAndCollide, lateralSpeed, type Input } from "../../shared/sim/vehicle"
import type { CarView } from "../../shared/sim/world"
import type { City } from "../../shared/sim/city"
import { buildCar } from "../render/car-mesh"
import { splitChassis } from "../render/chassis-mesh"
import { Chassis, chassisSettings, wheelRotation } from "../game/chassis"
import { VehicleEmissions, EmissionState } from "../game/vehicle-emissions"
import { StreetProps } from "../game/props"
import { PROP_KINDS } from "../game/props/placement"
import type { SpriteWriter } from "../game/props/particles"

/** Small explicit city supplies the production car's wall, ramp and wheel-contact queries. */
const city:City={seed:7,boxes:yardWalls.map(([x0,z0,x1,z1])=>({x0,z0,x1,z1,h:2,color:[.3,.34,.38],neon:null,kind:"wall",label:null})),ramps:[{...yardRamp,kind:"plate"}],
  parks:[],trees:[],alleys:[],parked:[],lamps:[],nodes:[],adj:[],sites:[],extraction:[],precinct:{x:0,z:0,h:0,spawnNode:0},helipad:{x:0,y:0,z:0},waterZ:100,max:100,yards:[],sidewalk:0,shops:[]}

export function getawaySpawn(context:LabContext){
  const meshes=context.stage.meshes,cars:CarView[]=[],lights:LabLight[]=[]
  const addModel=(mesh:{v:number[]})=>meshes.add(mesh.v,12,code=>[2,5,8,9].includes(code)?1.5:0)
  const props=new StreetProps({boxes:city.boxes,placements:[]},{addModel},yardGround)
  const spriteSpec:ParticleSpec={kind:"soft",life:1,size:1,growth:0,gravity:0,drag:0,bounce:0,r:1,g:1,b:1,alpha:1}
  const sprite:SpriteWriter=(_list,x,y,z,size,r,g,b,alpha,kind,rot=0,stretch=1)=>{
    if([2,3,4,9].includes(kind))return
    Object.assign(spriteSpec,{kind:kind===6?"spark":kind===20?"debris":kind===21?"water":[0,13,22].includes(kind)?"fire":"soft",size,r,g,b,alpha})
    context.stage.transients.spawn(spriteSpec,x,y,z,0,kind===6?stretch:0,0,rot)
  }
  const items:ItemWorld={
    items:PROP_KINDS.map(id=>({id,label:id==="propane"?"Propane tank":id[0].toUpperCase()+id.slice(1)})),
    get bodies(){return [...props.props.map(p=>p.body),...props.chunks.map(c=>c.body)]},
    lights,
    spawn(id,at){const kind=PROP_KINDS.find(k=>k===id);if(kind)props.spawn({kind,x:at.x,y:yardGround(at.x,at.z),z:at.z,yaw:at.yaw})},
    clear:()=>props.clear(),reset:()=>props.reset(),wakeAll:()=>{for(const p of props.props)props.physics.wake(p.body);for(const c of props.chunks)props.physics.wake(c.body)},
    update:dt=>props.update(cars,dt,{x:context.stage.focus[0],z:context.stage.focus[2]},true,()=>true),
    prepare(){
      lights.length=0
      props.draw((...args)=>meshes.instance(...args),sprite,(x,y,z,radius,r,g,b,power)=>lights.push({x,y,z,radius,r,g,b,power}),{x:context.stage.focus[0],z:context.stage.focus[2]},false)
    },
    inspect:()=>({stats:{...props.stats},props:props.props.map(p=>({kind:p.home.kind,x:p.body.x,y:p.body.y,z:p.body.z,awake:p.body.awake,broken:p.broken})),chunks:props.chunks.length}),
  }
  const characters:CharacterSpawnable[]=VEHICLES.map(spec=>{
    let model:ReturnType<typeof splitChassis>|undefined,bodyModel=0,wheelModels:number[]=[]
    return {id:`getaway:${spec.id}`,label:`Getaway · ${spec.name}`,create(_context,at){
      if(!model){model=splitChassis(buildCar(spec));bodyModel=addModel(model.body);wheelModels=model.wheels.map(w=>addModel(w.mesh))}
      const body=newBody(at.x,at.z,at.yaw),point:SpawnPoint={...at},input:Input={throttle:0,brake:0,steer:0,handbrake:false,boost:false}
      const car:CarView={...body,id:1,ownerId:"lab",name:"Lab",role:spec.role,vehicle:spec.id,speed:0,drift:0,boost:1,human:true,impact:0,ghost:false}
      const chassis=new Chassis(car,model.wheels),settings=chassisSettings(),emissions=new VehicleEmissions(context.trail),emission=new EmissionState()
      emissions.reset();cars.splice(0,cars.length,car)
      const alpha=new Float32Array(256*12),add=new Float32Array(256*12)
      const headlights:LabLight[]=[0,1].map(()=>({x:0,y:0,z:0,radius:16,r:1.1,g:1.1,b:.85,power:4,cone:.84}))
      const brake:LabLight={x:0,y:0,z:0,radius:4,r:1,g:.025,b:.01,power:.4}
      return {point,updatesTrail:true,update(dt,keys){
        input.throttle=keys.up?1:keys.down?-1:0;input.brake=keys.up&&keys.down?1:0;input.handbrake=keys.space;input.boost=keys.shift
        const target=Number(keys.left)-Number(keys.right),rate=target===0?10:Math.sign(target)!==Math.sign(input.steer)?12:6
        input.steer+=Math.max(-rate*dt,Math.min(rate*dt,target-input.steer))
        const impact=stepAndCollide(body,input,spec,dt,city.boxes,undefined,city.ramps)
        Object.assign(car,body,{speed:Math.hypot(body.vx,body.vz),drift:Math.abs(lateralSpeed(body)),boost:body.boostFuel,impact})
        chassis.update(car,spec,city,dt,settings,input)
        emissions.update(dt);emissions.car(car,spec,emission,input,dt,chassis.lift.x,true,true)
        Object.assign(point,{x:body.x,y:body.y,z:body.z,yaw:body.h})
      },prepare(){
        meshes.instance(bodyModel,car.x,(car.y??0)+chassis.lift.x,car.z,car.h,chassis.roll.x,chassis.pitch.x)
        model!.wheels.forEach((p,i)=>{const w=chassis.contacts[i];wheelRotation(w,car.h,car.airborne?chassis.roll.x:0,car.airborne?chassis.pitch.x:0,p.z>0?chassis.steer:0,w.spin);meshes.instance(wheelModels[i],w.x,w.y,w.z,w.yaw,w.roll,w.pitch)})
        emissions.emit(alpha,0,add,0,256,true)
        for(let i=0;i<emissions.addCount;i++){const p=i*12;sprite("d",add[p],add[p+1],add[p+2],add[p+3],add[p+4],add[p+5],add[p+6],add[p+7],add[p+8],add[p+9],add[p+10])}
      },lights(){
        const sn=Math.sin(car.h),cs=Math.cos(car.h)
        headlights.forEach((l,i)=>Object.assign(l,{x:car.x+sn*spec.length*.47+cs*(i?1:-1)*spec.width*.34,y:(car.y??0)+.65,z:car.z+cs*spec.length*.47-sn*(i?1:-1)*spec.width*.34,dx:sn*.98,dy:-.2,dz:cs*.98}))
        Object.assign(brake,{x:car.x-sn*spec.length*.5,y:(car.y??0)+.5,z:car.z-cs*spec.length*.5,power:input.brake||input.throttle<0||input.handbrake?2:.4})
        return [...headlights,brake]
      },inspect:()=>({vehicle:spec.id,...point,speed:car.speed,roll:chassis.roll.x,pitch:chassis.pitch.x,tyreParticles:context.trail.count,airborne:car.airborne,input:{...input}}),leave:()=>{cars.length=0;emissions.reset()}}
    }}
  })
  return {items,characters}
}
