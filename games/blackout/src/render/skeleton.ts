import { Mesh, MAT } from "./mesh"
import { personModels, type PersonModels } from "./person"

/** Same joints and lengths as the human rig, with open ribs and paired forearm bones. */
export function skeletonModels(): PersonModels {
  const p=personModels(), bone=[0.82,0.79,0.66] as const
  const box=(x:number,y:number,z:number,X:number,Y:number,Z:number) => { const m=new Mesh(); m.box(x,y,z,X,Y,Z,bone,MAT.actor); return m }
  p.pelvis=box(-0.07,-0.07,-0.16,0.08,0.08,0.16)
  p.torso=box(-0.08,0,-0.035,-0.02,0.5,0.035)
  for(const y of [0.15,0.24,0.33,0.42]) {
    p.torso.box(-0.06,y,-0.2,0.1,y+0.035,-0.16,bone,MAT.actor)
    p.torso.box(-0.06,y,0.16,0.1,y+0.035,0.2,bone,MAT.actor)
    p.torso.box(0.075,y,-0.18,0.11,y+0.035,0.18,bone,MAT.actor)
  }
  p.head=box(-0.1,0.04,-0.115,0.13,0.3,0.115)
  p.head.box(0.1,0.02,-0.085,0.15,0.07,0.085,bone,MAT.actor)
  for(const z of [-0.07,0.07]) {
    p.head.box(0.13,0.14,z-0.034,0.137,0.215,z+0.034,[0.018,0.01,0.03],MAT.glow,1)
    p.head.box(0.138,0.165,z-0.012,0.14,0.19,z+0.012,[0.24,0.08,0.4],MAT.glow,1.5)
  }
  p.upperArm=box(-0.035,-0.29,-0.035,0.035,0.03,0.035)
  p.foreArm=box(-0.028,-0.3,-0.035,0.008,0.015,-0.012)
  p.foreArm.box(-0.028,-0.3,0.012,0.008,0.015,0.035,bone,MAT.actor)
  p.thigh=box(-0.04,-0.42,-0.04,0.04,0.03,0.04)
  p.shin=box(-0.027,-0.41,-0.035,0.027,0.03,0.035)
  p.foot=box(-0.04,-0.04,-0.045,0.15,0.015,0.045)
  return p
}
