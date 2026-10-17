import * as THREE from "three/webgpu"
import type { LabControl, LabValue } from "@arcade/kit/lab-panel"
import type { Lamp, WorldContext } from "../world/context"

// State shared between the lighting rig (which owns the lights and their flicker) and the post chain (which draws the
// lamps' in-scattering). Lighting fills it every frame before post renders.

export type LampRuntime = {
  lamp: Lamp
  /** World position of the light (sodium heads sit slightly below the fixture so the hemisphere above stays dark). */
  pos: THREE.Vector3
  /** Unit direction for spot-like fixtures, null for omni. */
  dir: THREE.Vector3 | null
  /** Linear colour × candela × global lamp scale, before flicker. */
  radiance: THREE.Color
  /** Current flicker multiplier (0 = off, 1 = nominal). */
  level: number
  /** Fog extinction coefficient at the lamp (1/m) and transmittance lamp → camera this frame. */
  sigma: number
  transmittance: number
  /** Distance to the camera this frame. */
  distance: number
  cosOuter: number
  cosInner: number
  /** Culling fade weight (0 culled … 1 fully on). */
  vis: number
  /** Where the lamp's light may land (interior/exterior, storey heights). */
  mask: { mode: 0 | 1 | 2; y0: number; y1: number }
}

export type FlashState = {
  on: boolean
  pos: THREE.Vector3
  dir: THREE.Vector3
  /** Linear colour × candela. */
  radiance: THREE.Color
  range: number
  cosOuter: number
  cosInner: number
}

export const renderState = {
  lamps: [] as LampRuntime[],
  /** True while modules are still streaming in (set through the post chain's `setBooting`). */
  streaming: false,
  /** The lighting rig's per-frame update, for perf scripts that drive frames themselves. */
  lightingUpdate: null as ((dt: number, time: number) => void) | null,
  flash: {
    on: false,
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, -1),
    radiance: new THREE.Color(),
    range: 30,
    cosOuter: 0.9,
    cosInner: 0.95,
  } as FlashState,
}

export type ControlDef = LabControl & { value: LabValue }

/** Registers Lab controls with their defaults (existing values, e.g. from a preset, win). */
export function addControls(ctx: WorldContext, defs: ControlDef[]) {
  for (const { value, ...control } of defs) {
    if (!(control.key in ctx.settings)) ctx.settings[control.key] = value
    // Automation only (captures, perf ablations): `?post.ssr=0&fog.density=0.02`.
    const q = ctx.params.get(control.key)
    if (q !== null) ctx.settings[control.key] = typeof value === "boolean" ? q === "1" || q === "true" : typeof value === "number" ? Number(q) : q
    ctx.controls.push(control as LabControl)
  }
}

export const num = (ctx: WorldContext, key: string) => Number(ctx.settings[key])
export const flag = (ctx: WorldContext, key: string) => {
  const v = ctx.settings[key]
  return v === true || v === 1 || v === "1" || v === "true"
}
