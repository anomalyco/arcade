import type { AIAgent } from "../../shared/ai"
import { CALLING_IDS, seedForCalling, walksEmptyLeash, type CallingId } from "../../shared/characters/callings"
import { startHabit, type CharactersState } from "../../shared/characters/habits"
import { habitSites, HABIT_KINDS, type HabitKind } from "../../shared/characters/sites"
import type { OutbreakSim } from "../../shared/sim-types"
import { worldToChunk } from "../../shared/world"

/**
 * Lab staging for characters (AR-88), offline only: a line-up of every calling, one of each habit at the nearest site
 * of its kind, and an empty lead out for a walk. Staged zombies are deaf and blind so they keep still for the camera.
 *
 * - `callings`: all thirteen callings in a row ahead of the survivor, facing it.
 * - `knock` / `stove` / `bed` / `fence` / `wedding`: the nearest site of that kind in the active town, the survivor
 *   standing off it.
 * - `leash`: someone walking an empty lead just ahead.
 */
export const CHARACTER_SCENES = ["callings", "knock", "stove", "bed", "fence", "wedding", "leash"] as const
export type CharacterScene = (typeof CHARACTER_SCENES)[number]

export type CharacterStageHost = { pose: (x: number, y: number, aim: number) => void }
type StageSession = { sim: OutbreakSim; view: { player: { x: number; y: number; aim: number } } }

const LAB_ID_BASE = 60420
const LAB_ID_END = 60520

function spawnLab(sim: OutbreakSim, x: number, y: number, aim: number): AIAgent | null {
  const used = new Set(sim.ai.agents.map((a) => a.id))
  for (let id = LAB_ID_BASE; id <= LAB_ID_END; id++) {
    if (used.has(id)) continue
    const a = sim.ai.spawnZombie(sim.town, x, y, "wander", aim)
    a.id = id
    return a
  }
  return null
}

function still(a: AIAgent): void {
  a.speedScale = 0
  a.perceptionScale = 0
  a.awareness = 0
}

/** Clears the dead near the survivor so a staged view shows only what was staged. */
function clearNear(sim: OutbreakSim, x: number, y: number, r = 22): void {
  for (const a of sim.ai.agents) if (Math.hypot(a.x - x, a.y - y) < r) a.state = "dead"
}

export function stageCalling(sim: OutbreakSim, calling: CallingId, x: number, y: number, aim: number): AIAgent | null {
  const a = spawnLab(sim, x, y, aim)
  if (!a) return null
  a.seed = seedForCalling(a.seed, a.id, CALLING_IDS.indexOf(calling))
  still(a)
  a.aim = aim
  return a
}

/** Stages `scene`; returns where the survivor stands, or an error. */
export function stageCharacters(host: CharacterStageHost, session: StageSession, scene: CharacterScene): { x: number; y: number; ids: number[] } | { error: string } {
  const sim = session.sim
  const p = session.view.player
  if (scene === "callings") {
    clearNear(sim, p.x, p.y)
    const ids: number[] = []
    const fx = Math.cos(p.aim)
    const fy = Math.sin(p.aim)
    for (let i = 0; i < CALLING_IDS.length; i++) {
      const row = Math.floor(i / 7)
      const col = (i % 7) - 3
      const x = p.x + fx * (3.2 + row * 1.6) - fy * col * 0.95
      const y = p.y + fy * (3.2 + row * 1.6) + fx * col * 0.95
      const a = stageCalling(sim, CALLING_IDS[i]!, x, y, p.aim + Math.PI)
      if (a) ids.push(a.id)
    }
    return { x: p.x, y: p.y, ids }
  }
  if (scene === "leash") {
    clearNear(sim, p.x, p.y)
    const x = p.x + Math.cos(p.aim) * 4
    const y = p.y + Math.sin(p.aim) * 4
    const a = spawnLab(sim, x, y, p.aim + Math.PI / 2)
    if (!a) return { error: "no free Lab zombie id" }
    for (let k = 0; k < 4000 && !walksEmptyLeash(a.seed, a.id); k++) a.seed = seedForCalling((a.seed * 31 + k) >>> 0, a.id, CALLING_IDS.indexOf("robe"))
    a.perceptionScale = 0
    return { x: p.x, y: p.y, ids: [a.id] }
  }
  const kinds: HabitKind[] = scene === "wedding" ? ["bride", "groom"] : [scene]
  if (scene === "wedding" && !habitSites(sim.town).some((s) => s.kind === "bride")) {
    // The church is rarely in the start chunks: find the nearest one and walk there first.
    const church = nearestChurch(sim, p.x, p.y)
    if (!church) return { error: "no church within 12 chunks" }
    host.pose(church.x, church.y, 0)
    sim.syncWorldChunks()
  }
  const sites = habitSites(sim.town)
  const first = sites
    .filter((s) => s.kind === kinds[0] && sim.ai.nav.walkable({ x: s.x, y: s.y }))
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]
  if (!first) return { error: `no ${scene} site in the active town` }
  const st = sim.getFeatureState<CharactersState>("characters")
  if (!st) return { error: "characters feature not registered" }
  clearNear(sim, first.x, first.y)
  const ids: number[] = []
  for (const kind of kinds) {
    const s = kind === first.kind ? first : sites.find((o) => o.kind === kind && o.key.split(":")[1] === first.key.split(":")[1])
    if (!s) continue
    const a = spawnLab(sim, s.x, s.y, s.aim)
    if (!a) continue
    startHabit(sim, st, a, s)
    a.perceptionScale = 0
    ids.push(a.id)
  }
  // Behind the zombie, in the room, for those indoors; off to one side outdoors.
  const indoor = first.kind === "knock" || first.kind === "stove" || first.kind === "bed"
  const ang = indoor ? first.aim + Math.PI + 0.5 : first.aim + Math.PI / 2
  const d = indoor ? 2.2 : 3
  let sx = first.x + Math.cos(ang) * d
  let sy = first.y + Math.sin(ang) * d
  if (!sim.ai.nav.walkable({ x: sx, y: sy })) {
    sx = first.x - Math.cos(first.aim) * 1.8
    sy = first.y - Math.sin(first.aim) * 1.8
  }
  host.pose(sx, sy, Math.atan2(first.y - sy, first.x - sx))
  return { x: sx, y: sy, ids }
}

/** A point in front of the nearest church, from the streaming world's chunks (generated on demand, deterministic). */
function nearestChurch(sim: OutbreakSim, x: number, y: number): { x: number; y: number } | null {
  const c0 = worldToChunk(x, y)
  let best: { x: number; y: number; d: number } | null = null
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const chunk = sim.worldStream.getOrGenerateChunk(c0.cx + dx, c0.cy + dy)
      for (const b of chunk.buildings) {
        if (b.archetype !== "church") continue
        const door = chunk.doors.find((d) => d.id === `${b.id}-front`)
        const cx = door ? (door.rect[0] + door.rect[2]) / 2 : (b.rect[0] + b.rect[2]) / 2
        const cy = door ? (door.rect[1] + door.rect[3]) / 2 : b.rect[3] + 1
        const d = Math.hypot(cx - x, cy - y)
        if (!best || d < best.d) best = { x: cx, y: cy + (cy > (b.rect[1] + b.rect[3]) / 2 ? 5 : -5), d }
      }
    }
  return best
}

export { HABIT_KINDS }
