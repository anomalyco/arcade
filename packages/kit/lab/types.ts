import type { LabControl, LabSettings } from "../lab-panel"
import type { Particles } from "../fx/particles"
import type { SmokeTrail } from "../fx/smoke-trail"
import type { SmokeVolumes } from "../fx/volume"
import type { Stage } from "./stage"
import type { LabInput } from "./input"

export type LabWorldObject = {
  id: string
  label: string
  category: "emitter" | "specimen" | "character" | "prop" | "light"
  x: number
  y: number
  z: number
  yaw?: number
  radius?: number
  movable?: boolean
  deletable?: boolean
}

/** All hooks execute on the client. Section-owned simulations never change multiplayer state. */
export type LabSection = {
  id:string
  label:string
  settings:LabSettings
  controls:readonly LabControl[]
  enter?():void
  leave?():void
  update?(dt:number):void
  /** Upload resources before the command encoder starts. Called even while playback is paused. */
  prepare?():void
  /** Optional instanced meshes/debug geometry inside the Lab's 4x MSAA RGBA16F/depth24plus pass. */
  draw?(pass:GPURenderPassEncoder):void
  telemetry?():string
  /** Workbench hooks for transport, framing, environment reroll and world object manipulation. */
  retrigger?():void
  reroll?():void
  frameTarget?():{x:number;y:number;z:number;dist?:number}
  objects?():readonly LabWorldObject[]
  selectedObjectId?:string
  selectObject?(id:string|null):void
  moveObject?(id:string,x:number,z:number,yaw?:number):boolean
  deleteObject?(id:string):boolean
  duplicateObject?(id:string):string|null
  groundHeight?(x:number,z:number):number
}
export type LabContext = {
  device:GPUDevice
  stage:Stage
  particles:Particles
  volume:SmokeVolumes
  trail:SmokeTrail
  sync():void
  input:LabInput
}
export type SectionFactory = (context:LabContext)=>LabSection
/** Shape is compatible with getaway-clutter's Body; no dependency on that worktree's solver. */
export type DebugBody = {
  x:number;y:number;z:number;hx:number;hy:number;hz:number
  yaw:number;pitch:number;roll:number;awake:boolean;enabled:boolean
}
export type PhysicsAdapter = {
  bodies:Iterable<DebugBody>
  update(dt:number):void
  reset():void
  wakeAll?():void
  prepare?():void
}
export type MaterialAdapter = {
  game:string
  codes:Readonly<Record<string,number>>
  /** Draw a calibration sphere and box using this game's actual shader/material code. */
  draw?:(pass:GPURenderPassEncoder,code:number)=>void
  prepare?:(code:number,context:LabContext)=>void
}
