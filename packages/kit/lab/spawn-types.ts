import type { LabContext, PhysicsAdapter } from "./types"
import type { LabLight } from "./stage"
import type { LabInput } from "./input"

export type SpawnPoint={x:number;y:number;z:number;yaw:number}
export type LabCharacter={
  point:SpawnPoint
  updatesTrail?:boolean
  update(dt:number,input:LabInput):void
  prepare():void
  lights():readonly LabLight[]
  /** Adapter-specific telemetry, also used by the deterministic proof. */
  inspect():unknown
  leave?():void
}
export type CharacterSpawnable={id:string;label:string;create(context:LabContext,at:SpawnPoint):LabCharacter}
export type ItemWorld=PhysicsAdapter & {
  items:readonly {id:string;label:string}[]
  spawn(id:string,at:SpawnPoint):void
  clear():void
  /** The character adapter owns car/prop contacts; the item world owns fixed-step simulation. */
  prepare():void
  lights:LabLight[]
  inspect():unknown
}
export type SpawnAdapters={
  items:ItemWorld
  characters:readonly CharacterSpawnable[]
}
export type SpawnFactory=(context:LabContext)=>SpawnAdapters
