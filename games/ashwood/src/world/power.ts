import * as THREE from "three/webgpu"
import { uniform } from "three/tsl"
import type { Lamp } from "./context"
import { SurfaceMaterial } from "../render/materials"

// The station's mains. In play mode the building arrives with the power out (src/game/power.ts switches it off for the
// run); the MAIN POWER switch on TX-1 in 3-08 brings it back (storeys/s3/transmitter.ts). Everything else (the Look Lab,
// `?view=` captures, audits) keeps the power on unless `?power=off`.
//
// Nothing here rebuilds a shader. Mains-fed fixtures register once while their module builds:
//  - lamps (interior + facility exterior, never exit signs or warning beacons): their live `intensity` is set to 0 / ramped
//    / restored (the light rig, the fluorescent hum and the hunter all read it);
//  - surface-class emissives (render/materials `flat` and `emissive` members): their per-object emissive constants are
//    scaled in place (shared singletons such as emissive_sodium are cloned first: a clone shares the program);
//  - node emissives (fluorescent panels, CRT screens, the facility's lit window panes): wrapped once in `× MAINS`, a
//    uniform, before they first compile.
// Battery fittings (exit signs, the emergency twin-heads in the stairs and at the fire doors) are never switched.

/** 0..1 mains level for node emissives (the restore's stutter included). */
export const MAINS = uniform(1)

/** Names never switched by the mains (battery or own-blink fixtures). */
const UNPOWERED = /exit|emergency|beacon|blood|red_led|led_red|hazard_red|card_reader/

type PoweredMat = { m: SurfaceMaterial; base: Float32Array; at: number }
type PoweredLamp = { lamp: Lamp; base: number; delay: number }

const lamps: PoweredLamp[] = []
const mats: PoweredMat[] = []
const wrapped = new WeakSet<THREE.Material>()
const exempt = new WeakSet<Lamp>()
const listeners = new Set<(on: boolean) => void>()
let on = true
/** Seconds (performance clock) the power last came on; -1 = never ramped (instant). */
let since = -1
let applied = ""

/** The restore: the breaker clunk, then the tubes strike over ~1.5 s, each lamp at its own moment, a couple of blinks. */
const RAMP_S = 1.9
function strike(t: number, delay: number) {
  const k = t - delay
  if (k < 0) return 0
  if (k < 0.07) return 1
  if (k < 0.18) return 0
  if (k < 0.24) return 0.7
  if (k < 0.33) return 0.05
  return 1
}
/** The shared emissives' level (one uniform for every panel): an average of the strikes. */
function mainsLevel(t: number) {
  if (t < 0.22) return 0
  if (t < 0.3) return 0.9
  if (t < 0.42) return 0.08
  if (t < 0.48) return 0.8
  if (t < 0.62) return 0.15
  return Math.min(1, 0.55 + (t - 0.62) * 0.9)
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

export const power = {
  get on() {
    return on
  },
  /** Mains level now (0..1, the restore's stutter included): for fixtures that drive their own lamp (the lift). */
  get level() {
    return MAINS.value
  },
  /** Switch the mains. `instant`: no strike-up (the run's start, a checkpoint past the restore). */
  set(next: boolean, opts: { instant?: boolean } = {}) {
    if (next === on) return
    on = next
    since = next && !opts.instant ? performance.now() / 1000 : -1
    applied = ""
    power.update()
    for (const l of listeners) l(on)
  },
  /** Every change (true: power back). Returns an unsubscribe. */
  onChange(fn: (on: boolean) => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  /** A lamp the mains don't switch: a battery fitting, or one that applies `power.level` itself (the lift car's). */
  exempt(lamp: Lamp) {
    exempt.add(lamp)
  },
  /** Registers mains-fed lamps (exit signs, warning beacons and exempt lamps are skipped). */
  registerLamps(list: readonly Lamp[]) {
    for (const lamp of list) {
      if (lamp.kind === "exit" || lamp.kind === "warning" || lamp.intensity <= 0) continue
      if (exempt.has(lamp) || lamps.some((p) => p.lamp === lamp)) continue
      const p = lamp.position
      lamps.push({ lamp, base: lamp.intensity, delay: 0.25 + hash(p[0] * 0.37 + p[1] * 1.9 + p[2] * 0.71) * 1.15 })
    }
    applied = ""
  },
  /**
   * Registers every mains-fed emissive under `root` (before it first compiles). Names matching `exclude` (and battery /
   * blinking fixtures) are left alone.
   */
  registerMaterials(root: THREE.Object3D, opts: { exclude?: RegExp } = {}) {
    const clones = new Map<THREE.Material, THREE.Material>()
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material) return
      let m = mesh.material as THREE.Material
      const name = m.name ?? ""
      if (UNPOWERED.test(name) || opts.exclude?.test(name)) return
      if (m instanceof SurfaceMaterial) {
        const at = m.surfaceClass === "flat" ? 20 : m.surfaceClass === "emissive" ? 4 : -1
        if (at < 0 || m.surfaceParams[at]! + m.surfaceParams[at + 1]! + m.surfaceParams[at + 2]! <= 0) return
        // Library singletons (shared with the roads and the lot) get this module's own copy.
        if (!/^(interior|facility)_/.test(name)) {
          let c = clones.get(m)
          if (!c) clones.set(m, (c = m.clone()))
          mesh.material = m = c
        }
        if (mats.some((p) => p.m === m)) return
        mats.push({ m: m as SurfaceMaterial, base: (m as SurfaceMaterial).surfaceParams.slice(), at })
        return
      }
      const node = m as THREE.MeshStandardNodeMaterial
      if (!node.emissiveNode || wrapped.has(m)) return
      wrapped.add(m)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node.emissiveNode = (node.emissiveNode as any).mul(MAINS)
      node.needsUpdate = true
    })
    applied = ""
  },
  /** Per frame (the interior's update): applies the state, animating the restore. Cheap when nothing changes. */
  update() {
    const t = since < 0 ? Infinity : performance.now() / 1000 - since
    const ramping = on && t < RAMP_S
    const key = `${on}:${lamps.length}:${mats.length}`
    if (!ramping && key === applied) return
    applied = ramping ? "" : key
    const g = on ? (ramping ? mainsLevel(t) : 1) : 0
    MAINS.value = g
    for (const p of lamps) {
      const k = on ? (ramping ? strike(t, p.delay) : 1) : 0
      p.lamp.intensity = p.base * k
    }
    for (const p of mats) for (let i = 0; i < 3; i++) p.m.surfaceParams[p.at + i] = p.base[p.at + i]! * g
  },
}

;(globalThis as { __ashwoodPower?: typeof power }).__ashwoodPower = power
