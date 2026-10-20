import { pushOut } from "@arcade/kit/sim/geom"
import type { AIAgent } from "../../shared/ai"
import {
  ACT_REST_SIT,
  ACT_REST_SLUMP,
  ACT_REST_STAND,
} from "../../shared/behaviour/activities"
import { behaviourOf, freshMind } from "../../shared/behaviour/mind"
import { zombiePersonality, type ZombiePersonality } from "../../shared/behaviour/personality"
import type { BodiesState } from "../../shared/bodies/runtime"
import { inBuildingFootprint } from "../../shared/map"
import type { OutbreakSim } from "../../shared/sim-types"

/**
 * Staged scenes for the Lab (`arcade cmd behaviour.stage scene=…`, the `outbreak-zombie-behaviour` station): each puts
 * the survivor somewhere fitting, clears the dead nearby and places a few whose personalities make the behaviour
 * happen within seconds. Offline sessions only; the rules that then play out are the real ones.
 */
export const BEHAVIOUR_SCENES = ["listen", "follow", "search", "rest", "herd", "feed", "climb", "light", "flinch", "lightning", "crowd"] as const
export type BehaviourScene = (typeof BEHAVIOUR_SCENES)[number]

function seedWith(want: (p: ZombiePersonality) => boolean, from: number): number {
  const p = zombiePersonality(0)
  for (let s = from; s < from + 500000; s++) if (want(zombiePersonality(s, p))) return s
  return from
}

function free(sim: OutbreakSim, x: number, y: number): { x: number; y: number } {
  const q = sim.ai.nav.nearest({ x, y })
  const p = { x: q.x, y: q.y }
  pushOut(p, 0.3, sim.solids)
  return p
}

function clearAround(sim: OutbreakSim, x: number, y: number, r: number): void {
  const ai = sim.ai
  ai.agents = ai.agents.filter((a) => a.state === "dead" || Math.hypot(a.x - x, a.y - y) > r)
  ai.config.zombieCount = ai.agents.filter((a) => a.state !== "dead" && a.hordeId === undefined).length
}

function place(sim: OutbreakSim, x: number, y: number, aim: number, seed: number): AIAgent {
  const p = free(sim, x, y)
  const a = sim.ai.spawnZombie(sim.town, p.x, p.y, "wander", aim)
  a.seed = seed >>> 0
  a.wanderX = a.x
  a.wanderY = a.y
  a.timer = 6
  return a
}

function pose(sim: OutbreakSim, x: number, y: number, aim: number, torch: boolean): { x: number; y: number } {
  const s = sim.slots[0]!.survivor
  const p = free(sim, x, y)
  s.x = p.x
  s.y = p.y
  s.vx = 0
  s.vy = 0
  s.aim = aim
  s.flashlightOn = torch
  if (torch) s.flashlightOutput = Math.max(0.9, s.flashlightOutput)
  return p
}

/** Scenes the dead play out on their own: with `watch`, the survivor hides indoors and the camera watches them. */
export const WATCHABLE_SCENES: readonly BehaviourScene[] = ["rest", "herd", "feed", "light", "lightning", "crowd"]

export type StagedBehaviour = { scene: string; zombies: number[]; note: string; centre?: { x: number; y: number }; watch?: boolean }

/** Out of sight inside the nearest house 12–40 m from (x, y), torch off, so the dead there do as they would alone. */
function hideSurvivor(sim: OutbreakSim, x: number, y: number): boolean {
  const s = sim.slots[0]!.survivor
  const centreOf = (b: (typeof sim.town.buildings)[number]) => ({ x: (b.rect[0] + b.rect[2]) / 2, y: (b.rect[1] + b.rect[3]) / 2 })
  const house = sim.town.buildings
    .map((b) => ({ b, c: centreOf(b) }))
    .filter(({ c }) => {
      const d = Math.hypot(c.x - x, c.y - y)
      return d > 12 && d < 40
    })
    .sort((a, b) => Math.hypot(a.c.x - x, a.c.y - y) - Math.hypot(b.c.x - x, b.c.y - y))[0]
  if (!house) return false
  const p = free(sim, house.c.x, house.c.y)
  Object.assign(s, { x: p.x, y: p.y, vx: 0, vy: 0, flashlightOn: false })
  return true
}

/** Stages `scene` around the first survivor; returns what it placed and where it happens. */
export function stageBehaviour(sim: OutbreakSim, scene: BehaviourScene, opts: { watch?: boolean } = {}): StagedBehaviour {
  const s0 = sim.slots[0]!.survivor
  let note = ""
  let centre: { x: number; y: number } | undefined
  // Out on the street first: a scene staged from indoors (after "search", or a hidden watcher) would happen in a room.
  const indoors = sim.town.buildings.find((b) => inBuildingFootprint(b, s0.x, s0.y))
  if (indoors) {
    const q = free(sim, (indoors.rect[0] + indoors.rect[2]) / 2, indoors.rect[3] + 5)
    s0.x = q.x
    s0.y = q.y
  }
  const ids: number[] = []
  const add = (a: AIAgent) => ids.push(a.id)
  const st = behaviourOf(sim)
  const night = () => (sim.hour = 23)
  switch (scene) {
    case "listen": {
      night()
      const p = pose(sim, s0.x, s0.y, 0, false)
      clearAround(sim, p.x, p.y, 40)
      for (let k = 0; k < 4; k++) add(place(sim, p.x + 6 + k * 1.6, p.y - 2 + k * 1.3, 0, seedWith((q) => q.curiosity > 0.85, 100 + k * 1000)))
      note = "Four curious wanderers ahead, facing away. Make a noise (a door, a shot, sprint) and watch them stop, turn and listen."
      break
    }
    case "follow": {
      night()
      const p = pose(sim, s0.x, s0.y, 0, false)
      clearAround(sim, p.x, p.y, 40)
      add(place(sim, p.x + 3, p.y, Math.PI, seedWith((q) => q.curiosity < 0.3, 200)))
      for (let k = 0; k < 4; k++) {
        const ang = 0.6 + k * 0.9
        add(place(sim, p.x + 3 + Math.cos(ang) * 6, p.y + Math.sin(ang) * 6, ang, seedWith((q) => q.sociability > 0.9 && !q.leader, 300 + k * 1000)))
      }
      note = "One zombie 3 m away spots you; the sociable dead around it, facing away, turn and follow it a beat later."
      break
    }
    case "search": {
      night()
      const house = [...sim.town.buildings]
        .filter((b) => b.kind === "house" && sim.town.windows.some((w) => w.buildingId === b.id))
        .sort((a, b) => Math.hypot((a.rect[0] + a.rect[2]) / 2 - s0.x, (a.rect[1] + a.rect[3]) / 2 - s0.y) - Math.hypot((b.rect[0] + b.rect[2]) / 2 - s0.x, (b.rect[1] + b.rect[3]) / 2 - s0.y))[0]
      if (!house) return { scene, zombies: [], note: "no house with windows nearby" }
      const inside = pose(sim, (house.rect[0] + house.rect[2]) / 2, (house.rect[1] + house.rect[3]) / 2, Math.PI / 2, false)
      clearAround(sim, inside.x, inside.y, 40)
      const a = place(sim, inside.x, house.rect[3] + 3.5, -Math.PI / 2, seedWith((q) => q.persistence > 0.9, 400))
      add(a)
      if (st) {
        const m = st.minds[a.id] ?? (st.minds[a.id] = freshMind(a))
        m.memT = sim.time
        m.memX = inside.x
        m.memY = inside.y
        m.memHouse = house.id
        m.last = "search"
        a.state = "search"
        a.timer = 0.05
        a.awareness = 0.3
      }
      note = "You hide in a house it saw you go into: it searches where you were, looks in at the windows, then gives up slowly."
      break
    }
    case "rest": {
      sim.hour = 12.5
      const p = pose(sim, s0.x, s0.y, 0, false)
      clearAround(sim, p.x, p.y, 40)
      const acts = [ACT_REST_SIT, ACT_REST_SLUMP, ACT_REST_STAND, ACT_REST_SIT, ACT_REST_STAND, ACT_REST_SIT]
      for (let k = 0; k < acts.length; k++) {
        const ang = k * 1.05
        const a = place(sim, p.x + Math.cos(ang) * (7 + (k % 3)), p.y + Math.sin(ang) * (7 + (k % 3)), ang + Math.PI, seedWith((q) => q.torpor > 0.7, 500 + k * 1000))
        add(a)
        if (st) {
          const m = st.minds[a.id] ?? (st.minds[a.id] = freshMind(a))
          m.act = acts[k]!
          m.until = sim.time + 1e6
        }
      }
      centre = p
      note = "Noon: the dead sit, slump and stand still. Walk close, or fire a shot, and they get up."
      break
    }
    case "herd": {
      night()
      const p = pose(sim, s0.x, s0.y, Math.PI / 2, true)
      clearAround(sim, p.x, p.y, 45)
      const lead = place(sim, p.x + 14, p.y, Math.PI, seedWith((q) => q.leader, 600))
      add(lead)
      for (let k = 0; k < 7; k++) add(place(sim, p.x + 15 + (k % 3) * 1.4, p.y - 2 + Math.floor(k / 3) * 1.6, Math.PI, seedWith((q) => q.sociability > 0.8 && !q.leader, 700 + k * 1000)))
      centre = { x: lead.x - 4, y: lead.y }
      note = "Night: a loose herd drifts down the street after its leader."
      break
    }
    case "feed": {
      night()
      const bodies = sim.getFeatureState<BodiesState>("bodies")?.sites ?? []
      const body = [...bodies].sort((a, b) => Math.hypot(a.x - s0.x, a.y - s0.y) - Math.hypot(b.x - s0.x, b.y - s0.y))[0]
      if (!body) return { scene, zombies: [], note: "no body nearby" }
      // Off to one side in the dark, out of their sight, so the body has their attention.
      pose(sim, body.x, body.y - 13, Math.PI / 2, false)
      clearAround(sim, body.x, body.y, 40)
      for (let k = 0; k < 3; k++) add(place(sim, body.x + 3 + k, body.y + (k - 1) * 2, Math.PI, seedWith((q) => q.hunger > 0.95 && q.torpor < 0.3, 800 + k * 1000)))
      centre = { x: body.x + 1.5, y: body.y }
      note = "Three hungry dead find a body and crouch over it; a third is shouldered off. Disturb them and they rise."
      break
    }
    case "climb": {
      night()
      const fence = sim.town.barriers
        .filter((b) => b.kind === "fence" && Math.max(b.rect[2] - b.rect[0], b.rect[3] - b.rect[1]) > 6)
        .sort((a, b) => Math.hypot((a.rect[0] + a.rect[2]) / 2 - s0.x, (a.rect[1] + a.rect[3]) / 2 - s0.y) - Math.hypot((b.rect[0] + b.rect[2]) / 2 - s0.x, (b.rect[1] + b.rect[3]) / 2 - s0.y))[0]
      if (!fence) return { scene, zombies: [], note: "no fence nearby" }
      const horizontal = fence.rect[2] - fence.rect[0] > fence.rect[3] - fence.rect[1]
      const cx = (fence.rect[0] + fence.rect[2]) / 2
      const cy = (fence.rect[1] + fence.rect[3]) / 2
      const p = horizontal ? pose(sim, cx, cy + 3, -Math.PI / 2, true) : pose(sim, cx + 3, cy, Math.PI, true)
      clearAround(sim, cx, cy, 40)
      for (let k = 0; k < 3; k++) {
        const off = (k - 1) * 2
        const a = horizontal ? place(sim, cx + off, cy - 1.3, Math.PI / 2, seedWith((q) => q.freshness > 0.5, 900 + k * 1000)) : place(sim, cx - 1.3, cy + off, 0, seedWith((q) => q.freshness > 0.5, 900 + k * 1000))
        a.state = "chase"
        a.awareness = 1
        a.targetX = p.x
        a.targetY = p.y
        add(a)
      }
      note = "Three dead after you across a yard fence climb it (slower than you vault; one may snag) instead of going round."
      break
    }
    case "light": {
      night()
      const lamp = [...sim.town.lamps].filter((l) => l.kind === "street" || l.kind === "porch").sort((a, b) => Math.hypot(a.x - s0.x, a.y - s0.y) - Math.hypot(b.x - s0.x, b.y - s0.y))[0]
      if (!lamp) return { scene, zombies: [], note: "no lamp nearby" }
      pose(sim, lamp.x - 12, lamp.y, 0, false)
      clearAround(sim, lamp.x, lamp.y, 40)
      for (let k = 0; k < 4; k++) {
        const a = place(sim, lamp.x + Math.cos(k * 1.6) * 12, lamp.y + Math.sin(k * 1.6) * 12, k * 1.6 + Math.PI, seedWith((q) => q.curiosity > 0.9, 1000 + k * 1000))
        a.timer = 0.05
        add(a)
      }
      centre = { x: lamp.x, y: lamp.y }
      note = "Night, torch off: curious dead drift in to stand under the lamp and look up at it."
      break
    }
    case "flinch": {
      night()
      const p = pose(sim, s0.x, s0.y, 0, true)
      clearAround(sim, p.x, p.y, 40)
      for (let k = 0; k < 2; k++) add(place(sim, p.x + 3.2, p.y + (k ? 1.2 : -1.2) * 0.3, Math.PI, seedWith((q) => q.curiosity < 0.5, 1100 + k * 1000)))
      note = "Torch on, two dead 3 m ahead and facing you: the beam in their faces makes them flinch and shield their eyes."
      break
    }
    case "lightning": {
      night()
      const p = pose(sim, s0.x, s0.y, 0, true)
      clearAround(sim, p.x, p.y, 40)
      for (let k = 0; k < 6; k++) add(place(sim, p.x + Math.cos(k) * (7 + k), p.y + Math.sin(k) * (7 + k), k, seedWith(() => true, 1200 + k * 1000)))
      centre = p
      note = "Storm (set Weather to storm and raise strikes per minute): each flash freezes the dead out in the open, looking up."
      break
    }
    case "crowd": {
      night()
      const p = pose(sim, s0.x, s0.y, 0, true)
      clearAround(sim, p.x, p.y, 45)
      for (let k = 0; k < 24; k++) {
        const ang = k * 2.39996
        const r = 8 + (k % 6) * 3.2
        add(place(sim, p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r, ang + 1.5, (0x9e3779b1 * (k + 1)) >>> 0))
      }
      centre = p
      note = "A night street of 24 different dead: listen, follow, herd, pause, flinch, search all at once. Compare with Zombie behaviour: Today."
      break
    }
  }
  const watch = Boolean(opts.watch && centre && WATCHABLE_SCENES.includes(scene) && hideSurvivor(sim, centre.x, centre.y))
  sim.syncWorldChunks()
  return { scene, zombies: ids, note, centre, watch }
}

