import { angleDiff, clearLine, distToRect } from "@arcade/kit/sim/geom"
import type { OutbreakAISubsystem } from "../ai"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { sightRects, type Town } from "../map"
import { buildingAt } from "../progression/loot"
import { CHANNEL_SLACK } from "../progression/tuning"
import type { OutbreakProgressionSnapshot, ProgressionActor, ProgressionHost, ProgressionSlot, Study, WorldContext } from "../progression/types"
import { HELD_OUT_PLANKS, heldOutWindow, looksReinforced, pageSite, PIN_FOUND, practiceFactor, type PageSite } from "./found"
import type { Tinkering } from "./tinkering"

const PAGE_RANGE = 1.4
/** How square on, in radians, a survivor must face a reinforced barricade to study it. */
const STUDY_CONE = 0.6
/** Movement, in metres per second, under which a survivor counts as standing still to study. */
const STUDY_STILL = 0.4
/** How close, in metres, a survivor must stand to a reinforced barricade to study it. */
const STUDY_RANGE = 2.2
/** How far off their aim, in radians, a teammate can be and still be watching someone work. */
const WATCH_CONE = 1.3

type KnowledgeSnapshot = Pick<OutbreakProgressionSnapshot, "mastery" | "study" | "heldOut">

/**
 * Found knowledge (D-19 slice 3): pages left in buildings, practice that makes hands faster and quieter with nothing on
 * screen to say so, learning by watching a teammate and by looking closely at a reinforced barricade, and the held-out
 * buildings someone boarded up before the squad arrived.
 */
export class FoundKnowledge {
  /** Practice per survivor and skill: boarding up gets faster and quieter, with no bar to show it. */
  mastery: Record<string, Record<string, number>> = {}
  /** Survivors looking closely at a reinforced barricade they could learn from. */
  study: Record<string, Study> = {}
  /** Held-out buildings already boarded up (see `heldOutWindow`). */
  heldOut: string[] = []
  /** Pages left in buildings (flyers, charts, photos), one per building type that has one. */
  readonly pages: PageSite[] = []

  constructor(
    private readonly host: ProgressionHost,
    private readonly tinkering: Tinkering,
  ) {}

  snapshot(): KnowledgeSnapshot {
    return {
      mastery: JSON.parse(JSON.stringify(this.mastery)),
      study: JSON.parse(JSON.stringify(this.study)),
      heldOut: [...this.heldOut],
    }
  }

  restore(snap: KnowledgeSnapshot): void {
    this.mastery = JSON.parse(JSON.stringify(snap.mastery ?? {}))
    this.study = JSON.parse(JSON.stringify(snap.study ?? {}))
    this.heldOut = [...(snap.heldOut ?? [])]
  }

  /**
   * The pages in the buildings now in the world, and a store for each the first time its building appears (a read
   * page is an empty store, so it stays read when its chunk streams out and back).
   */
  ensurePageStores(): void {
    this.pages.length = 0
    for (const b of this.host.town.buildings) {
      const site = pageSite(this.host.town, b)
      if (!site) continue
      this.pages.push(site)
      if (!this.host.ledger.store(site.id)) this.host.ledger.createStore({ id: site.id, mode: "counters", scope: "shared", at: { x: site.x, y: site.y }, initial: { page: 1 } })
    }
  }

  /** A page left in a building: E reads it. A page the squad already knows is still read, and just as gone. */
  pageHandler(): InteractionHandler {
    return {
      kind: "page",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const site of this.pages) {
          if (site.buildingId !== here || Math.hypot(actor.x - site.x, actor.y - site.y) > PAGE_RANGE) continue
          if (this.host.ledger.count(site.id, "page") <= 0) continue
          const primary: InteractAction = { id: "read", label: "Read" }
          const r = 0.2
          out.push({ kind: "page", id: site.id, label: "Page", rect: [site.x - r, site.y - r, site.x + r, site.y + r], worldX: site.x, worldY: site.y, primary, actions: [primary], priority: 3 })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.host.slotOf(actor)
        const site = this.pages.find((p) => p.id === targetId)
        if (!slot || !site || action !== "read" || Math.hypot(actor.x - site.x, actor.y - site.y) > PAGE_RANGE + CHANNEL_SLACK) return { handled: false }
        return { handled: this.readPage(slot, site), kind: "page", targetId, action }
      },
    }
  }

  private readPage(slot: ProgressionSlot, site: PageSite): boolean {
    const res = this.host.ledger.apply({ kind: "drain", store: site.id, item: "page", actor: slot.id })
    if (!res.ok) return false
    this.tinkering.learnRecipe(slot, site.recipe, { x: site.x, y: site.y }, PIN_FOUND[site.style])
    return true
  }

  /** How practised a survivor is at a skill (boards nailed, plus a share of those watched). */
  practice(actor: string, skill: string): number {
    return this.mastery[actor]?.[skill] ?? 0
  }

  private practise(actor: string, skill: string, amount: number): void {
    const skills = (this.mastery[actor] ??= {})
    skills[skill] = Number(((skills[skill] ?? 0) + amount).toFixed(3))
  }

  /** `slot` finished a piece of `skill` work: they gain practice, and so does any teammate who watched. */
  worked(slot: ProgressionSlot, skill: string, world: WorldContext): void {
    this.practise(slot.id, skill, 1)
    for (const other of this.watchers(slot, world)) this.practise(other.id, skill, this.host.tuning.watchShare)
  }

  /**
   * Practice on a timed action `slot` just started: hands that have done it a few times do it faster and quieter.
   * Returns the noise it now makes.
   */
  practised(slot: ProgressionSlot, skill: string, noise: number): number {
    const practice = this.practice(slot.id, skill)
    const ch = this.host.ledger.channel(slot.id)
    const quieter = noise * practiceFactor(practice, this.host.tuning.practiceNoiseFloor)
    if (ch) {
      ch.duration *= practiceFactor(practice, this.host.tuning.practiceTimeFloor)
      ch.noise = quieter
    }
    return quieter
  }

  /** Teammates close enough, facing the right way and in clear sight, to pick something up from watching `slot`. */
  private watchers(slot: ProgressionSlot, world: WorldContext): ProgressionSlot[] {
    const p = slot.survivor
    const walls = sightRects(world.town)
    return world.slots.filter((o) => {
      if (o === slot || o.survivor.health <= 0) return false
      const q = o.survivor
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d > this.host.tuning.watchRange) return false
      if (d > 1 && Math.abs(angleDiff(Math.atan2(p.y - q.y, p.x - q.x), q.aim)) > WATCH_CONE) return false
      return clearLine(q.x, q.y, p.x, p.y, walls)
    })
  }

  /**
   * Boards up each held-out building's window the first time it is in the world: reinforced, two planks. The sim
   * calls this once it is built and the room's step calls it for buildings streamed in later. Returns whether any
   * window was boarded (the caller rebuilds topology).
   */
  boardHeldOut(town: Town, ai: OutbreakAISubsystem): boolean {
    let changed = false
    for (const b of town.buildings) {
      if (this.heldOut.includes(b.id)) continue
      const id = heldOutWindow(town, b)
      if (!id || !ai.portalStates.has(id)) continue
      this.heldOut.push(b.id)
      for (let i = 0; i < HELD_OUT_PLANKS; i++) ai.addBarricadePlank(id, this.host.tuning.reinforcedPlankHp)
      const win = town.windows.find((w) => w.id === id)
      if (win) win.open = false
      changed = true
    }
    return changed
  }

  /**
   * Learning by looking: a survivor who stands still close to a reinforced barricade, facing it, for `studyTime`
   * works out how it was done. The squad learns it and their sketch goes up on the board.
   */
  stepStudy(dt: number, world: WorldContext): void {
    if (this.host.learned("reinforced")) {
      for (const k of Object.keys(this.study)) delete this.study[k]
      return
    }
    for (const slot of world.slots) {
      const p = slot.survivor
      const prev = this.study[slot.id]
      const target = p.health > 0 && !p.channel ? this.studyTarget(p, world) : null
      if (!target) {
        delete this.study[slot.id]
        continue
      }
      const still = prev && prev.portal === target.id && Math.hypot(p.x - prev.x, p.y - prev.y) <= STUDY_STILL * dt + 1e-6
      const t = still ? prev.t + dt : 0
      if (t + 1e-6 >= this.host.tuning.studyTime) {
        this.tinkering.learnRecipe(slot, "reinforced", { x: target.x, y: target.y }, 0)
        for (const k of Object.keys(this.study)) delete this.study[k]
        return
      }
      this.study[slot.id] = { portal: target.id, t: Number(t.toFixed(4)), x: p.x, y: p.y }
    }
  }

  /** The reinforced barricade a survivor is close to and squarely facing, if any. */
  private studyTarget(p: ProgressionActor, world: WorldContext): { id: string; x: number; y: number } | null {
    for (const o of [...world.town.doors, ...world.town.windows]) {
      const st = world.ai.portalStates.get(o.id)
      if (!st || !looksReinforced(st.barricadePlanks, st.barricadeHp)) continue
      const x = (o.rect[0] + o.rect[2]) / 2
      const y = (o.rect[1] + o.rect[3]) / 2
      if (distToRect(p.x, p.y, o.rect) > STUDY_RANGE) continue
      if (Math.abs(angleDiff(Math.atan2(y - p.y, x - p.x), p.aim)) > STUDY_CONE) continue
      return { id: o.id, x, y }
    }
    return null
  }
}
