import { distToRect } from "@arcade/kit/sim/geom"
import type { ItemId } from "@arcade/kit/sim/ledger"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { RECIPES } from "../progression/catalog"
import { buildingAt } from "../progression/loot"
import type { ProgressionHost, ProgressionSlot } from "../progression/types"
import { pinStoreId, recipeFillsIn, recipeWaitsOnPart } from "./recipes"

/** The actor recorded on knowledge the board fills in by itself. */
const BOARD_ACTOR = "board"

/**
 * The workbench and its corkboard at runtime (D-39): installing parts, filling recipes in as the squad picks up their
 * materials, and pinning what the squad learns wherever they learn it. Rules live in `recipes.ts`; this holds no state
 * of its own, everything is ledger stores (`pin:*`, `team/known`, the bench's parts).
 */
export class RecipeBoard {
  constructor(private readonly host: ProgressionHost) {}

  private seen = (material: ItemId) => this.host.ledger.count("team/known", `seen:${material}`) > 0

  /** Whether any of the squad's benches has `part` installed (the toolbox, or the car battery wired as a generator). */
  installed = (part: ItemId) => this.host.benches.some((b) => this.host.ledger.count(b.id, part) > 0)

  /** The corkboard: every recipe the squad has, and ideas waiting on a bench part. */
  corkboard(): { learned: string[]; ideas: string[] } {
    return {
      learned: RECIPES.filter((r) => this.host.learned(r.id)).map((r) => r.id),
      ideas: RECIPES.filter((r) => !this.host.learned(r.id) && recipeWaitsOnPart(r, this.seen, this.installed)).map((r) => r.id),
    }
  }

  /**
   * Fills in every recipe whose materials the squad has now picked up (and whose part is installed): the squad
   * learns it and its sketch goes up with a brass pin. Called once a tick; returns what it filled in.
   */
  fillIn(): string[] {
    const out: string[] = []
    for (const r of RECIPES) {
      if (this.host.learned(r.id) || !recipeFillsIn(r, this.seen, this.installed)) continue
      this.host.ledger.apply({ kind: "grant", actor: BOARD_ACTOR, item: `learned:${r.id}`, store: "team/known" })
      const site = this.host.benches[0]
      this.pin(r.id, null, site ? { x: site.bench.x, y: site.bench.y } : { x: 0, y: 0 }, 0)
      out.push(r.id)
    }
    return out
  }

  /**
   * The workbench: carrying a part, E installs it. Otherwise E opens the bench's recipe board (the client shows it;
   * crafting there draws on the bench's stock too).
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
          const primary: InteractAction = slot && this.host.partsOn(slot.id).length ? { id: "install", label: "Install" } : { id: "board", label: "Recipes" }
          out.push({ kind: "bench", id: b.id, label: "Workbench", rect: b.bench.rect, worldX: b.bench.x, worldY: b.bench.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.host.slotOf(actor)
        if (!slot || !this.host.ledger.store(targetId)) return { handled: false }
        if (action === "install") return { handled: this.host.install(slot, targetId), kind: "bench", targetId, action }
        // The board itself is drawn by the client; the sim has nothing to change.
        if (action === "board") return { handled: true, kind: "bench", targetId, action }
        return { handled: false }
      },
    }
  }

  /**
   * Teaches the squad a recipe they picked up away from the bench (a page, a barricade studied, cans taken down) and
   * pins it: a sketch in the learner's hand, or the page itself (`found`, see `PIN_FOUND`). Returns whether it was new.
   */
  learnRecipe(slot: ProgressionSlot, recipe: string, at: { x: number; y: number }, found: number): boolean {
    if (this.host.learned(recipe)) return false
    this.host.ledger.apply({ kind: "grant", actor: slot.id, item: `learned:${recipe}`, store: "team/known" })
    this.pin(recipe, slot, at, found)
    return true
  }

  private pin(recipe: string, slot: ProgressionSlot | null, at: { x: number; y: number }, found: number): void {
    if (this.host.ledger.store(pinStoreId(recipe))) return
    const initial: Record<string, number> = {}
    if (slot) initial.seat = slot.index + 1
    if (found) initial.found = found
    this.host.ledger.createStore({ id: pinStoreId(recipe), mode: "counters", scope: "shared", owner: slot?.id, at, initial })
  }
}
