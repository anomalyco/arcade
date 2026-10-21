import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { DeathState } from "../../shared/death/rules"
import { clampSurvivorVariant } from "../../shared/loadout"
import { supportHeight } from "../../shared/terrain"
import type { Vision } from "../../shared/vision"
import type { OutbreakBloodSettings } from "../blood/settings"
import { currentBloodStains } from "../blood/stains"
import type { CoopView } from "../coop-view"
import { BODY_LOOK, bodyMesh } from "../discovery/vignettes"
import { hex } from "../level"
import type { NetSession } from "../net-session"
import { SURVIVOR_COLOURS } from "../seat-colours"
import { noteLyingBody } from "../soft-shadows/lying-bodies"
import type { LocalSession } from "../../shared/session"
import { localSlot } from "./spectate"

const MAX = 24
/** A downed survivor drags a smear every this many metres. */
const DRAG_STEP = 0.55

/** The look a seat's survivor wears (their trousers and jacket, the default skin and hair). */
function seatLook(variant: number) {
  const c = SURVIVOR_COLOURS[variant % SURVIVOR_COLOURS.length]!
  return { ...BODY_LOOK.survivor, top: hex(c.torso), legs: hex(c.legs) }
}

/** Which look a survivor in the session wears, by slot index. */
export function variantOf(session: LocalSession | NetSession, coop: CoopView, index: number): number {
  if ("local" in session) return index === session.local.index ? session.variant : session.variantOfSeat(index)
  return index === session.slot.index ? coop.soloVariant : clampSurvivorVariant(index)
}

/**
 * Survivors on the floor (AR-61): the downed, face down and dragging themselves along with a smear behind, and the
 * dead where they fell over a spreading pool, in their seat's colours. Their standing rigs are hidden meanwhile.
 */
export class FallenBodies {
  private readonly models = new Map<string, number>()
  private readonly pool = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly out: Batch[] = []
  private readonly pooled = new Set<string>()
  private readonly dragFrom = new Map<number, { x: number; y: number }>()

  constructor(private readonly renderer: Pick<Renderer, "addModel">) {}

  reset(): void {
    this.pooled.clear()
    this.dragFrom.clear()
  }

  private model(variant: number, pose: number): number {
    const key = `${variant}:${pose}`
    let id = this.models.get(key)
    if (id === undefined) this.models.set(key, (id = this.renderer.addModel(bodyMesh(seatLook(variant), pose))))
    return id
  }

  collect(session: LocalSession | NetSession, coop: CoopView, vision: Vision, blood: OutbreakBloodSettings, time: number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const state = session.sim.getFeatureState<DeathState>("death")
    if (!state) return this.out
    const town = session.view.town
    const stains = currentBloodStains()
    const local = localSlot(session).index
    for (const b of state.bodies) {
      const key = `${b.index}:${b.n}`
      if (!this.pooled.has(key)) {
        this.pooled.add(key)
        stains?.survivorPool(town, blood, b.x, b.y, (b.index + 1) * 7919 + b.n * 104729)
      }
      this.put(this.model(variantOf(session, coop, b.index), 1 + (b.n % 2)), b.x, supportHeight(town, b.x, b.y) + 0.008, b.y, b.yaw, 0)
      noteLyingBody(b.x, supportHeight(town, b.x, b.y), b.y, b.yaw)
    }
    for (const slot of session.sim.slots) {
      const rec = state.records[slot.index]
      if (rec?.state !== "down") {
        this.dragFrom.delete(slot.index)
        continue
      }
      const p = slot.survivor
      const from = this.dragFrom.get(slot.index)
      if (!from) this.dragFrom.set(slot.index, { x: p.x, y: p.y })
      else if (Math.hypot(p.x - from.x, p.y - from.y) > DRAG_STEP) {
        stains?.survivorDrag(town, blood, from.x, from.y, p.x, p.y, slot.index * 131 + Math.floor(time * 10))
        from.x = p.x
        from.y = p.y
      }
      if (slot.index !== local && !vision.visible(p.x, p.y)) continue
      // Face down, reaching ahead; the shoulders rise and fall with each breath, and lurch as they pull.
      const moving = Math.hypot(p.vx, p.vy) > 0.05
      const roll = Math.sin(time * (moving ? 9 : 2.4)) * (moving ? 0.07 : 0.025)
      const lift = 0.008 + Math.max(0, Math.sin(time * 2.4)) * 0.012
      this.put(this.model(variantOf(session, coop, slot.index), 0), p.x, supportHeight(town, p.x, p.y) + lift, p.y, p.aim, roll)
      noteLyingBody(p.x, supportHeight(town, p.x, p.y), p.y, p.aim)
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, roll: number): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * INST_FLOATS), count: 0 }))
    if (v.count >= MAX) return
    v.data.set([x, y, z, yaw, 1, 1, 1, 1, 0, roll, 1, 0], v.count++ * INST_FLOATS)
  }
}
