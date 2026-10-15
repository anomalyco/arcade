import { Mesh, MAT } from "./mesh"
import { personModels, type PersonModels } from "./person"

/** Same joints and lengths as the human rig, with open ribs and paired forearm bones. */
export function skeletonModels(): PersonModels {
  const p=personModels(), bone=[0.94,0.88,0.71] as const
  const box=(x:number,y:number,z:number,X:number,Y:number,Z:number) => { const m=new Mesh(); m.box(x,y,z,X,Y,Z,bone,MAT.actor); return m }
  p.pelvis=box(-0.07,-0.07,-0.2,0.08,0.08,0.2)
  for(const z of [-0.2,0.14]) p.pelvis.box(-0.07,0.01,z,0.12,0.15,z+0.06,bone,MAT.actor)
  p.torso=box(-0.08,0,-0.035,-0.02,0.5,0.035)
  for(const y of [0.12,0.23,0.34,0.45]) {
    const width=0.19+0.07*Math.sin(y*5)
    p.torso.box(-0.06,y,-width,0.14,y+0.045,-width+0.04,bone,MAT.actor)
    p.torso.box(-0.06,y,width-0.04,0.14,y+0.045,width,bone,MAT.actor)
    p.torso.box(0.11,y,-width+0.03,0.155,y+0.045,width-0.03,bone,MAT.actor)
  }
  p.torso.box(0.13,0.14,-0.025,0.17,0.47,0.025,bone,MAT.actor)
  p.head=new Mesh()
  p.head.bevelBox(-0.16,0.06,-0.18,0.18,0.39,0.18,0.06,bone,bone,MAT.actor)
  p.head.box(0.07,-0.02,-0.12,0.19,0.035,0.12,bone,MAT.actor)
  for(const z of [-0.09,0.09]) {
    p.head.box(0.181,0.14,z-0.055,0.19,0.25,z+0.055,[0.025,0.016,0.035],MAT.glow,0.6)
    p.head.box(0.19,0.18,z-0.015,0.195,0.21,z+0.015,[0.35,0.15,0.55],MAT.glow,0.8)
  }
  for(const z of [-0.08,-0.027,0.027,0.08]) p.head.box(0.14,0.03,z-0.018,0.195,0.08,z+0.018,bone,MAT.actor)
  p.upperArm=box(-0.035,-0.29,-0.035,0.035,0.03,0.035)
  p.foreArm=box(-0.028,-0.3,-0.035,0.008,0.015,-0.012)
  p.foreArm.box(-0.028,-0.3,0.012,0.008,0.015,0.035,bone,MAT.actor)
  p.thigh=box(-0.04,-0.42,-0.04,0.04,0.03,0.04)
  p.shin=box(-0.027,-0.41,-0.035,0.027,0.03,0.035)
  p.foot=box(-0.04,-0.085,-0.045,0.125,-0.03,0.045)
  p.toe=box(-0.005,0,-0.042,0.06,0.042,0.042)
  return p
}
