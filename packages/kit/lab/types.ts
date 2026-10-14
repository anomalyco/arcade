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
  /** Catalog kind (for example "cone"); the Outliner folds repeated kinds into one row. */
  kind?: string
  /** Characters that are vehicles group under Vehicles in the Outliner. */
  vehicle?: boolean
}

/** Library drawer categories. */
export type LabLibraryCategory = "effects" | "objects" | "lighting" | "audio" | "materials" | "foliage" | "looks"

export type LabLibraryItem = {
  id: string
  label: string
  tag?: string
  group?: string
  select(): void
  active?(): boolean
}

/** How a section appears in the Library drawer. Sections without this still get one entry, categorised by id. */
export type LabSectionLibrary = {
  category?: LabLibraryCategory
  label?: string
  tag?: string
  items?(): readonly LabLibraryItem[]
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
  selectedObjectIds?:readonly string[]
  selectObject?(id:string|null):void
  selectObjects?(ids:readonly string[]):void
  moveObject?(id:string,x:number,z:number,yaw?:number):boolean
  deleteObject?(id:string):boolean
  deleteObjects?(ids?:readonly string[]):number
  duplicateObject?(id:string):string|null
  duplicateObjects?(ids?:readonly string[]):string[]
  groundHeight?(x:number,z:number):number
  /** Details panel: control groups relevant to the selection, in display order. Omit to show every group. */
  detailsGroups?(selected:readonly LabWorldObject[]):readonly string[]|undefined
  library?:LabSectionLibrary
  registerCommands?(commands:import("../lab-commands").LabCommandRegistry):void
}
/** Something audible happened in a section (an effect fired). Cosmetic only; hosts may sonify it. */
export type LabEvent = {
  type:"effect"
  section:string
  effect:string
  /** Effect-specific detail, for example the struck surface. */
  variant?:string
  x:number
  y:number
  z:number
}
export type LabContext = {
  device:GPUDevice
  stage:Stage
  particles:Particles
  volume:SmokeVolumes
  trail:SmokeTrail
  sync():void
  transact?:(label:string,run:()=>void)=>void
  input:LabInput
  activeWalls?:()=>readonly (readonly [number,number,number,number])[]
  activeGround?:(x:number,z:number)=>number
  hasPlaygroundScene?:()=>boolean
  emit?:(event:LabEvent)=>void
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
