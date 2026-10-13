import type { LabContext } from "../../../../packages/kit/lab/types"
import type { CharacterSpawnable } from "../../../../packages/kit/lab/spawn-types"
import { yardGround, yardWalls } from "../../../../packages/kit/lab/yard"
import { personModels } from "../render/person"
import { newAvatar, animate, pose, type PartModels } from "../game/anim"
import { stepBody } from "../../shared/sim/move"
import { SPEED, SPRINT_SPEED, GUN_IDS } from "../../shared/config"
import type { Mesh } from "../render/mesh"

export function blackoutSpawn(context:LabContext):CharacterSpawnable {
  let models:PartModels|undefined
  return {id:"blackout:soldier",label:"Blackout · Soldier",create(_context,at){
    const meshes=context.stage.meshes
    if(!models){
      const source=personModels(),add=(m:Mesh)=>meshes.add(m.v,11,c=>c===8?-1.5:[2,3].includes(c)?1.5:0)
      const by=(set:Record<typeof GUN_IDS[number],Mesh>)=>({rifle:add(set.rifle),shotgun:add(set.shotgun),sniper:add(set.sniper)})
      models={pelvis:add(source.pelvis),torso:add(source.torso),head:add(source.head),upperArm:add(source.upperArm),foreArm:add(source.foreArm),thigh:add(source.thigh),shin:add(source.shin),foot:add(source.foot),pump:add(source.pump),hole:add(source.hole),gun:by(source.gun),mag:by(source.mag),casing:by(source.casing)}
    }
    const point={...at},body={x:at.x,y:at.z,vx:0,vy:0},avatar=newAvatar("lab",at.x,at.z,-Math.PI/2,"rifle")
    let time=0,aim=-Math.PI/2
    animate(avatar,1/60,0,body.x,body.y,0,0,aim)
    return {point,update(dt,input){
      time+=dt
      // Fixed follow camera is pitched from +Z: screen up is -Z, screen right is +X.
      const mx=Number(input.right)-Number(input.left),mz=Number(input.down)-Number(input.up)
      stepBody(body,mx,mz,input.shift?SPRINT_SPEED:SPEED,yardWalls,dt)
      if(mx||mz)aim=Math.atan2(mz,mx)
      avatar.sprint=input.shift?1:0
      animate(avatar,dt,time,body.x,body.y,body.vx,body.vy,aim)
      Object.assign(point,{x:body.x,y:yardGround(body.x,body.y),z:body.y,yaw:Math.PI/2-aim})
    },prepare(){pose((model,x,y,z,yaw,tint,pitch,roll)=>meshes.instance(model,x,y+point.y,z,-yaw,pitch,roll,1,tint),avatar,[.25,.75,1],models!)},
    lights:()=>[],inspect:()=>({character:"soldier",...point,speed:Math.hypot(body.vx,body.vy),sprint:avatar.sprint})}
  }}
}
