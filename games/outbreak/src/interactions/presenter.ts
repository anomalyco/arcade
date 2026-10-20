import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { CoopSim, SurvivorSlot } from "../../shared/coop-sim"
import type { InteractionsState } from "../../shared/interactions/index"
import { arcHeight, isThrowable, isTossStore, THROWABLE_ITEMS, throwPower, tossAt, tossItem, type TossPlan } from "../../shared/interactions/throwables"
import { planFor } from "../../shared/interactions/tosses"
import { supportHeight } from "../../shared/terrain"
import { buildItemMeshes } from "../discovery/items"
import { buildAimMeshes } from "./items"

const MAX_TOSSES = 16
const DOTS = 14
/** The arc's beads, warm white; the landing ring turns red when the throw will hit one of the dead. */
const BEAD = [1.6, 1.45, 1.1] as const
const HIT = [2.4, 0.35, 0.25] as const

export type AimPreview = { plan: TossPlan; power: number; x: number; y: number }

/**
 * Throwables, drawn: each throw in the air spinning along its arc (then hopping to rest; the ground drop takes over
 * from there), and the local survivor's arc preview while winding up: beads along the flight and a ring where it comes
 * down, red when it will hit one of the dead. Everything is read from the ledger's `toss:*` stores and the predicted
 * wind-up, so co-op seats see the same throws.
 */
export class InteractionsPresenter {
  private readonly items = new Map<string, number>()
  private readonly dot: number
  private readonly ring: number
  private readonly data = new Map<number, Float32Array<ArrayBuffer>>()
  private readonly counts = new Map<number, number>()
  private readonly dots = new Float32Array(DOTS * INST_FLOATS)
  private readonly rings = new Float32Array(2 * INST_FLOATS)
  private readonly out: Batch[] = []
  /** Proof readout: throws drawn in the air and the preview last frame. */
  readonly shown = { flying: 0, aiming: false, power: 0, hit: false }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const meshes = buildItemMeshes()
    for (const item of THROWABLE_ITEMS) {
      const mesh = meshes[item]
      if (mesh) this.items.set(item, renderer.addModel(mesh))
    }
    const aim = buildAimMeshes()
    this.dot = renderer.addModel(aim.dot)
    this.ring = renderer.addModel(aim.ring)
  }

  private push(model: number, values: readonly number[]): void {
    let buf = this.data.get(model)
    if (!buf) this.data.set(model, (buf = new Float32Array(MAX_TOSSES * INST_FLOATS)))
    const n = this.counts.get(model) ?? 0
    if (n >= MAX_TOSSES) return
    buf.set(values, n * INST_FLOATS)
    this.counts.set(model, n + 1)
  }

  /** The local survivor's arc while they wind up a throw, or null. */
  preview(sim: CoopSim, slot: SurvivorSlot | undefined): AimPreview | null {
    if (!slot) return null
    const state = sim.getFeatureState<InteractionsState>("interactions")
    const start = state?.toss.wind[slot.id]
    const item = sim.progression.selected(slot.id)?.item
    if (!state || start === undefined || !isThrowable(item)) return null
    const power = throwPower(Math.max(0, sim.time - start), state.tuning)
    return { plan: planFor(sim, slot, item, power, state.tuning), power, x: slot.survivor.x, y: slot.survivor.y }
  }

  collect(sim: CoopSim, slot: SurvivorSlot | undefined, time: number): readonly Batch[] {
    this.out.length = 0
    this.counts.clear()
    const town = sim.town
    let flying = 0
    for (const st of sim.progression.ledger.stores.values()) {
      if (!isTossStore(st.id) || (st.counts.done ?? 0) >= 2) continue
      const at = tossAt(st, time)
      if (!at || at.phase >= 2) continue
      const model = this.items.get(tossItem(st))
      if (model === undefined) continue
      const g = supportHeight(town, at.x, at.y)
      this.push(model, [at.x, g + at.h, at.y, at.spin * 0.37, 1, 1, 1, 1, at.spin, at.spin * 0.6, 1, 0])
      flying++
    }
    this.shown.flying = flying
    const aim = this.preview(sim, slot)
    this.shown.aiming = Boolean(aim)
    this.shown.power = aim?.power ?? 0
    this.shown.hit = Boolean(aim?.plan.hit)
    let dots = 0
    let rings = 0
    if (aim) {
      const { plan } = aim
      const sx = aim.x
      const sy = aim.y
      const tint = plan.hit ? HIT : BEAD
      const g0 = supportHeight(town, sx, sy)
      for (let i = 1; i <= DOTS; i++) {
        const u = i / (DOTS + 1)
        const x = sx + (plan.ix - sx) * u
        const y = sy + (plan.iy - sy) * u
        const h = arcHeight(u, plan.peak) + g0 * (1 - u) + supportHeight(town, x, y) * u
        this.dots.set([x, h, y, 0, BEAD[0], BEAD[1], BEAD[2], 0.6 + 0.5 * u, 0, 0, 1, 0], dots * INST_FLOATS)
        dots++
      }
      const gx = plan.hit ? plan.hit.x : plan.ix
      const gy = plan.hit ? plan.hit.y : plan.iy
      const scale = 0.7 + aim.power * 0.5
      this.rings.set([gx, supportHeight(town, gx, gy) + 0.02, gy, time * 1.5, tint[0], tint[1], tint[2], scale, 0, 0, 1, 0], rings * INST_FLOATS)
      rings++
    }
    for (const [model, n] of this.counts) if (n) this.out.push({ model, data: this.data.get(model)!, count: n })
    if (dots) this.out.push({ model: this.dot, data: this.dots, count: dots })
    if (rings) this.out.push({ model: this.ring, data: this.rings, count: rings })
    return this.out
  }
}
