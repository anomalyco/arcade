import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, SPRITE_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { flareAge, flareBurning, isFlareStore } from "../../shared/flares/flares"
import type { SessionView } from "../../shared/session"
import { hex } from "../level"
import type { OutbreakNightLightSettings } from "../night-lights/settings"

const MAX = 32
const RANGE = 30
/** The flare's flame, as the accent tint its tip glows with. */
const RED = [1, 0.12, 0.06] as const

export type FlareLook = Pick<OutbreakNightLightSettings, "nlFlarePower" | "nlFlareRadius" | "nlFlareSmoke">

const fract = (v: number) => v - Math.floor(v)
const noise = (i: number, seed: number) => fract(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453)

/** How bright a burning flare is at `time`: a fierce sputter, guttering in its last tenth. */
export function flareLevel(st: StoreState, time: number): number {
  if (!flareBurning(st, time)) return 0
  const id = st.id.length * 7.1 + (st.at?.x ?? 0)
  const sputter = 0.78 + 0.22 * noise(Math.floor(time * 24), id) * (0.6 + 0.4 * Math.sin(time * 31 + id))
  const age = flareAge(st, time)
  const gutter = age > 0.9 ? Math.max(0.15, 1 - (age - 0.9) * 8) * (noise(Math.floor(time * 12), id + 3) > 0.3 ? 1 : 0.4) : 1
  return sputter * gutter
}

/** The burning flares near `(x, y)`, from the ledger. */
function burning(view: SessionView, x: number, y: number): StoreState[] {
  const out: StoreState[] = []
  for (const st of view.progression.ledger.stores.values()) {
    if (!isFlareStore(st.id) || !st.at || !flareBurning(st, view.time)) continue
    if (Math.abs(st.at.x - x) > RANGE || Math.abs(st.at.y - y) > RANGE) continue
    out.push(st)
  }
  return out
}

/**
 * Road flares (AR-56) on the ground: a red paper stick with its tip burning, lying where it landed. Their light goes in
 * through `flareLights` (the night-lights presenter packs it), their smoke through `flareSprites`. Reads the ledger's
 * `flare:*` stores only, so every co-op client sees the same.
 */
export class FlareProps {
  private readonly stick: number
  private readonly tip: number
  private readonly sticks = new Float32Array(MAX * INST_FLOATS)
  private readonly tips = new Float32Array(MAX * INST_FLOATS)
  private readonly out: Batch[] = []
  /** Proof readout: flares drawn last frame. */
  readonly shown = { burning: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    // Lying along +x: a 22 cm paper tube, a black cap at the back, the striker end burning at the front.
    const stick = new Mesh()
    stick.box(-0.11, 0, -0.017, 0.09, 0.034, 0.017, hex(0xb3241a), MAT.lit)
    stick.box(-0.12, 0.002, -0.015, -0.11, 0.032, 0.015, hex(0x18140f), MAT.lit)
    stick.box(-0.04, 0.0, -0.0175, -0.01, 0.035, 0.0175, hex(0xe8dcc4), MAT.lit)
    const tip = new Mesh()
    tip.box(0.09, 0.002, -0.014, 0.12, 0.032, 0.014, hex(0xff4020), MAT.accent)
    this.stick = renderer.addModel(stick)
    this.tip = renderer.addModel(tip)
  }

  collect(view: SessionView, time: number, support: (x: number, z: number) => number): readonly Batch[] {
    this.out.length = 0
    let n = 0
    for (const st of burning(view, view.player.x, view.player.y)) {
      if (n >= MAX) break
      const { x, y } = st.at!
      const g = support(x, y)
      const yaw = (st.id.length * 1.7 + x * 3.1) % (Math.PI * 2)
      const glow = 4 * flareLevel(st, time)
      this.sticks.set([x, g + 0.004, y, yaw, 1, 1, 1, 1, 0, 0, 1, 0], n * INST_FLOATS)
      this.tips.set([x, g + 0.004, y, yaw, RED[0] * glow, RED[1] * glow, RED[2] * glow, 1, 0, 0, 1, 0], n * INST_FLOATS)
      n++
    }
    this.shown.burning = n
    if (n) {
      this.out.push({ model: this.stick, data: this.sticks, count: n })
      this.out.push({ model: this.tip, data: this.tips, count: n })
    }
    return this.out
  }
}

/** Light for each burning flare near the camera: harsh red, low to the ground, sputtering. */
export function flareLights(
  view: SessionView,
  camX: number,
  camY: number,
  look: FlareLook,
  support: (x: number, z: number) => number,
  push: (x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number) => void,
): number {
  let n = 0
  for (const st of burning(view, camX, camY)) {
    const { x, y } = st.at!
    const k = flareLevel(st, view.time)
    push(x, support(x, y) + 0.35, y, look.nlFlareRadius, [1, 0.1, 0.05], look.nlFlarePower * k)
    n++
  }
  return n
}

/** Smoke curling up from each burning flare, lit red from below, and the white-hot core; returns the new count. */
export function flareSprites(view: SessionView, support: (x: number, z: number) => number, look: FlareLook, sprites: Float32Array, count: number): number {
  const max = Math.floor(sprites.length / SPRITE_FLOATS)
  const push = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number) => {
    if (count >= max) return
    const o = count++ * SPRITE_FLOATS
    sprites.set([x, y, z, size, r, g, b, a, kind, 0, 1, 0], o)
  }
  const time = view.time
  for (const st of burning(view, view.player.x, view.player.y)) {
    const { x, y } = st.at!
    const g = support(x, y)
    const k = flareLevel(st, time)
    const seed = st.id.length + x
    push(x, g + 0.06, y, 0.16 + 0.04 * k, 1, 0.72, 0.6, 0.9 * k, 0)
    push(x, g + 0.02, y, 1.6, 1, 0.08, 0.04, 0.22 * k, 2)
    if (look.nlFlareSmoke <= 0) continue
    for (let i = 0; i < 6; i++) {
      const u = fract(time * 0.35 + i / 6 + seed * 0.13)
      const drift = Math.sin(time * 0.9 + i * 1.7 + seed) * 0.25 * u
      push(x + drift + u * 0.35, g + 0.15 + u * 2.2, y - u * 0.2, 0.18 + u * 0.7, 0.85, 0.16, 0.1, 0.16 * (1 - u) * look.nlFlareSmoke * (0.4 + 0.6 * k), 1)
    }
  }
  return count
}
