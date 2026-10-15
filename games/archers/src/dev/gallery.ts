import { BTN, type Buttons } from "../../shared/input"
import { type Archer, type ArrowKind, type Item, World } from "../../shared/world"
import type { Game } from "../game/game"

/** Ticks one demonstration runs before it starts again. */
export const DEMO_TICKS = 210

const ARROWS: readonly Item[] = ["bomb", "laser", "drill", "bramble"]

/** What each power-up demonstration shows, for the caption. */
export const DEMO_NOTES: Record<Item, string> = {
  bomb: "A bomb arrow bursts where it lands and takes out anyone close",
  laser: "A laser shot is instant, goes through everyone in its path and bounces off walls; it can come back around",
  drill: "A drill arrow bores through blocks to reach the target behind them",
  bramble: "A bramble arrow grows a thorn hedge where it sticks; touching it kills",
  shield: "A shield takes one hit: the first arrow breaks it, the second kills",
  wings: "Wings: press jump in the air to flap, hold it to glide",
}

/**
 * The power-up gallery on the real World: a shooter and a target on the Bell Tower's lower left floor, the item
 * given, and both archers' buttons scripted through `game.script`.
 */
export function stageItem(game: Game, item: Item, seed: number): string {
  game.restart(seed, "belltower", [
    { id: "a0", name: "TEAL", device: null },
    { id: "a1", name: "WINE", device: null },
  ])
  const w = game.world
  w.startRound()
  w.s.phase = "play"
  w.s.phaseAt = w.s.time
  w.s.nextChest = 1e9
  const [shooter, target] = w.s.archers as [Archer, Archer]
  const at = STAGES[item] ?? STAGES.bomb!
  Object.assign(shooter, { x: at.shooter[0], y: at.shooter[1], face: 1, aimX: 1, aimY: 0, bot: false, quiver: arrowsFor(item) })
  Object.assign(target, { x: at.target[0], y: at.target[1], face: -1, aimX: -1, aimY: 0, bot: false, quiver: [] })
  if (item === "shield") target.shield = true
  if (item === "wings") shooter.wings = true
  const start = w.s.tick
  game.script = (a, world) => {
    const t = world.s.tick - start
    if (a.id === shooter.id) return demoButtons(item, t, world)
    // The bramble's target walks into the hedge once it has grown.
    return item === "bramble" && t > 90 ? BTN.left : 0
  }
  return at.focus ?? shooter.id
}

/**
 * Where the two stand (feet, tiles). Bell Tower: the lower floor is y 4, with a one-tile ledge at y 6 over x 6–9
 * (the wall above it covers x 0–7, so x 8–9 has headroom). Drill shoots up through that ledge at a target standing on
 * it. Bramble shoots into the floor just ahead and walks off (out through the left edge) before its own hedge can
 * hurt it; the camera stays on the target, who walks into the hedge.
 */
const STAGES: Partial<Record<Item, { shooter: [number, number]; target: [number, number]; focus?: string }>> = {
  bomb: { shooter: [2.5, 4], target: [9.5, 4] },
  laser: { shooter: [2.5, 4], target: [9.5, 4] },
  shield: { shooter: [2.5, 4], target: [9.5, 4] },
  wings: { shooter: [2.5, 4], target: [10.5, 4] },
  drill: { shooter: [8.6, 4], target: [8.6, 7] },
  bramble: { shooter: [4.5, 4], target: [10.5, 4], focus: "a1" },
}

function arrowsFor(item: Item): ArrowKind[] {
  if ((ARROWS as readonly string[]).includes(item)) return [item as ArrowKind, item as ArrowKind]
  return item === "shield" ? ["normal", "normal"] : []
}

/** Hold the draw for `from`..`to` aiming `dir`, release after. */
const shot = (t: number, from: number, to: number, dir: Buttons): Buttons => (t >= from && t < to ? BTN.shoot | dir : 0)

function demoButtons(item: Item, t: number, w: World): Buttons {
  switch (item) {
    case "bramble":
      return shot(t, 20, 46, BTN.right | BTN.down) | (t > 50 && t < 110 ? BTN.left : 0)
    case "drill":
      return shot(t, 20, 46, BTN.up)
    case "shield":
      return shot(t, 20, 46, BTN.right) | shot(t, 96, 122, BTN.right)
    case "wings": {
      // Run right, take off, flap three times, then glide down holding jump.
      let b = t > 10 && t < 120 ? BTN.right : t >= 120 && t < 170 ? BTN.left : 0
      if (t === 20 || t === 21 || t === 52 || t === 53 || t === 84 || t === 85 || t === 116 || t === 117) b |= BTN.jump
      if (t > 130 && t < 190 && !w.s.archers[0]!.ground) b |= BTN.jump
      return b
    }
    default:
      return shot(t, 20, 46, BTN.right)
  }
}
