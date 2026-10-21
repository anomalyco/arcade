import { START } from "../world"

export type CameraPose = { x: number; y: number; z: number; yaw: number; pitch: number; fov: number }

export const VIEWPOINTS: Record<string, CameraPose> = {
  gate: {x:START.x,y:START.height,z:START.z,yaw:START.yaw,pitch:START.pitch,fov:68},
  lot: {x:0,y:1.7,z:65,yaw:0,pitch:0,fov:68},
  entrance: {x:2,y:1.7,z:34,yaw:0,pitch:0,fov:68},
  lobby: {x:5,y:1.7,z:19,yaw:0.6,pitch:0,fov:68},
  corridor: {x:-11,y:1.65,z:0.2,yaw:Math.PI/2,pitch:0,fov:68},
}
