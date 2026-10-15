import { distToRect } from "@arcade/kit/sim/geom"
import type { ItemId, Stack } from "@arcade/kit/sim/ledger"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { RECIPES } from "../progression/catalog"
import { buildingAt } from "../progression/loot"
import type { ProgressionHost, ProgressionSlot, WorldContext } from "../progression/types"
import {
  ALL_PAIRS,
  benchOfMat,
  ideaToken,
  judgeMat,
  matStoreId,
  nextPair,
  pairCost,
  pairIndex,
  pinStoreId,
  TINKER_MATERIALS,
  tinkerRule,
  triedToken,
  type TinkerOutcome,
} from "./tinker"

/**
 * The workbench mat and the corkboard at runtime (D-19 slices 2 and 3): laying materials out, trying them together,
 * and pinning what the squad learns, wherever they learn it. Rules and judging live in `tinker.ts`; this holds no state
 * of its own, everything is ledger stores (`mat:*`, `pin:*`, `team/known`).
 */
export class Tinkering {
  constructor(private readonly host: ProgressionHost) {}

  /** What lies on a bench's mat, slot by slot (materials, or what they made). */
  mat(benchId: string): Stack[] {
    return this.host.contents(matStoreId(benchId))
  }

  /** What holding E at this bench would do with what is on its mat now (null until it holds two materials). */
  judge(benchId: string): TinkerOutcome | null {
    return judgeMat(RECIPES, this.mat(benchId).map((s) => s.item), this.host.tier(benchId), (r) => this.host.learned(r))
  }

  /** The corkboard: every recipe the squad has, ideas waiting on a better bench, and pairs that came to nothing. */
  corkboard(): { learned: string[]; ideas: string[]; tried: string[] } {
    const known = this.host.ledger.store("team/known")
    const has = (token: string) => (known?.counts[token] ?? 0) > 0
    return {
      learned: RECIPES.filter((r) => this.host.learned(r.id)).map((r) => r.id),
      ideas: RECIPES.filter((r) => !this.host.learned(r.id) && has(ideaToken(r.id))).map((r) => r.id),
      tried: ALL_PAIRS.map(([a, b]) => `${a}+${b}`).filter((p) => has(triedToken(p))),
    }
  }

  /**
   * The workbench: carrying a part, E installs it. Otherwise E lays two materials on the mat, a pair at a time (each
   * tap swaps in the next pair you can make up), and holding E tries them together. Whatever they make waits on the
   * mat for a tap to take it.
   */
  benchHandler(): InteractionHandler {
    return {
      kind: "bench",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const slot = this.host.slotOf(actor)
        const out: RawInteractCandidate[] = []
        for (const b of this.host.benches) {
          if (b.buildingId !== here || distToRect(actor.x, actor.y, b.bench.rect) > 1.45) continue
          const mat = this.mat(b.id)
          let primary: InteractAction | null = null
          let secondary: InteractAction | undefined
          if (slot && this.host.partsOn(slot.id).length) primary = { id: "install", label: "Install" }
          else if (mat.some((s) => !this.isMaterial(s.item))) primary = { id: "take", label: "Take" }
          else if (slot && this.cyclePair(slot.id, b.id) !== this.matPair(b.id)) primary = { id: "place", label: mat.length ? "Swap" : "Lay out" }
          else if (mat.length) primary = { id: "take", label: "Take back" }
          if (this.judge(b.id)) secondary = { id: "tinker", label: "Tinker", hold: true }
          if (!primary && secondary) primary = { id: "take", label: "Take back" }
          if (!primary) continue
          out.push({
            kind: "bench",
            id: b.id,
            label: "Workbench",
            rect: b.bench.rect,
            worldX: b.bench.x,
            worldY: b.bench.y,
            primary,
            secondary,
            actions: secondary ? [primary, secondary] : [primary],
            // A held E tinkers; the tap waits for the release so a hold never swaps the pair first.
            deferPrimary: Boolean(secondary),
          })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.host.slotOf(actor)
        if (!slot || !this.host.ledger.store(targetId)) return { handled: false }
        if (action === "install") return { handled: this.host.install(slot, targetId), kind: "bench", targetId, action }
        if (action === "take") return { handled: this.host.take(slot, matStoreId(targetId)), kind: "bench", targetId, action }
        if (action === "place") return { handled: this.setMat(slot, targetId, this.cyclePair(slot.id, targetId)), kind: "bench", targetId, action }
        if (action === "tinker") return { handled: this.startTinker(slot, targetId), kind: "bench", targetId, action }
        return { handled: false }
      },
    }
  }

  private isMaterial(item: ItemId): boolean {
    return (TINKER_MATERIALS as readonly string[]).includes(item)
  }

  /** The pair on a bench's mat as an index into `ALL_PAIRS`, or -1 when it holds anything else. */
  private matPair(benchId: string): number {
    const mat = this.mat(benchId)
    return mat.length === 0 ? -1 : pairIndex(mat.map((s) => s.item))
  }

  /** The pair a tap of E would lay out next: the following one the survivor can make up with what is on the mat. */
  private cyclePair(actor: string, benchId: string): number {
    const mat = matStoreId(benchId)
    return nextPair(this.matPair(benchId), (item) => this.host.ledger.count(`${actor}/belt`, item) + this.host.ledger.count(mat, item))
  }

  /** Puts what is on the mat back on the survivor, then lays out pair `index` (or leaves the mat empty for -1). */
  setMat(slot: ProgressionSlot, benchId: string, index: number): boolean {
    const mat = matStoreId(benchId)
    if (this.host.contents(mat).length) {
      const back = this.host.ledger.apply({ kind: "take", actor: slot.id, from: mat })
      if (!back.ok || this.host.contents(mat).length) {
        this.host.feedback(slot, back.events)
        return false
      }
    }
    const pair = ALL_PAIRS[index]
    if (!pair) return true
    const res = this.host.ledger.apply({ kind: "deposit", actor: slot.id, to: mat, items: pairCost(pair) })
    return res.ok
  }

  private startTinker(slot: ProgressionSlot, benchId: string): boolean {
    const outcome = this.judge(benchId)
    if (!outcome) return false
    const site = this.host.benches.find((b) => b.id === benchId)!
    const res = this.host.ledger.start({ kind: "run", actor: slot.id, rule: tinkerRule(outcome), station: matStoreId(benchId), ref: outcome.pair }, this.host.envFor(slot), { x: site.bench.x, y: site.bench.y })
    this.host.feedback(slot, res.events)
    return res.ok
  }

  /** Whether a try already running at `station` still matches its mat (someone may have changed the shared mat). */
  stillMatches(station: string, rule: string): boolean {
    const outcome = this.judge(benchOfMat(station))
    return Boolean(outcome) && tinkerRule(outcome!) === rule
  }

  /**
   * A finished try at the mat. Assembling puts the thing on the mat and, the first time, pins the sketch with the
   * maker's seat; a pair that needs the toolbox pins a faint idea (the rule did that); anything else clatters, and the
   * first time a pair fails a crossed-out scrap goes up so nobody tries it twice. No words either way.
   */
  tinkered(slot: ProgressionSlot, rule: string, mat: string, pair: string, world: WorldContext): void {
    const site = this.host.benches.find((b) => b.id === benchOfMat(mat))
    const at = site ? { x: site.bench.x, y: site.bench.y } : { x: slot.survivor.x, y: slot.survivor.y }
    if (rule === "tinker:clatter") {
      world.ai.emitNoise(at.x, at.y, this.host.tuning.clatterNoise, "clatter", world.time, slot.id)
      const token = triedToken(pair)
      if (this.host.ledger.items.has(token) && this.host.ledger.count("team/known", token) === 0) {
        this.host.ledger.apply({ kind: "grant", actor: slot.id, item: token, store: "team/known" })
      }
      return
    }
    if (rule.startsWith("tinker:idea:")) return
    const recipe = RECIPES.find((r) => rule === `tinker:${r.id}`)
    if (!recipe) return
    if (recipe.produces) this.host.ledger.apply({ kind: "grant", actor: slot.id, item: recipe.produces, store: mat })
    this.pinRecipe(slot, recipe.id, at, 0)
  }

  /**
   * Teaches the squad a recipe they picked up away from the bench (a page, a barricade studied, cans taken down) and
   * pins it: a sketch in the learner's hand, or the page itself (`found`, see `PIN_FOUND`). Returns whether it was new.
   */
  learnRecipe(slot: ProgressionSlot, recipe: string, at: { x: number; y: number }, found: number): boolean {
    if (this.host.learned(recipe)) return false
    this.host.ledger.apply({ kind: "grant", actor: slot.id, item: `learned:${recipe}`, store: "team/known" })
    this.pinRecipe(slot, recipe, at, found)
    return true
  }

  private pinRecipe(slot: ProgressionSlot, recipe: string, at: { x: number; y: number }, found: number): void {
    if (this.host.ledger.store(pinStoreId(recipe))) return
    const initial: Record<string, number> = found ? { seat: slot.index + 1, found } : { seat: slot.index + 1 }
    this.host.ledger.createStore({ id: pinStoreId(recipe), mode: "counters", scope: "shared", owner: slot.id, at, initial })
  }
}
