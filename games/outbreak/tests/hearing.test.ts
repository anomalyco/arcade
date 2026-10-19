import { describe, expect, test } from "bun:test"
import { DEFAULT_AI_CONFIG } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { PISTOL_NOISE } from "../shared/combat"
import { CoopSim } from "../shared/coop-sim"
import { buildingShells, DEFAULT_HEARING_TUNING, hearAcrossShells, shellRadius, type BuildingShell } from "../shared/hearing"
import { WALK_NOISE } from "../shared/stamina"

const T = DEFAULT_HEARING_TUNING
const SHUT: BuildingShell = { openings: [] }
const CONFIG = { hearingScale: DEFAULT_AI_CONFIG.hearingScale, wallAttenuation: 0.52, doorAttenuation: 0.72 }
/** Night: the crowd hears √1.4 further. */
const NIGHT = Math.sqrt(1.4)

/** Ash (rect 22,24 → 37,35.5): a spot in the living room by the south-west window, and the lawn just outside it. */
const INSIDE = { x: 24.5, y: 34.4 }
const LAWN = { x: 24.5, y: 36.3 }

describe("shell rule", () => {
  test("a shut shell keeps walking, crouching and doors in, and lets gunfire out about half as far", () => {
    expect(shellRadius(WALK_NOISE, false, T)).toBe(0)
    expect(shellRadius(5.5, false, T)).toBeLessThan(0.5)
    expect(shellRadius(PISTOL_NOISE, false, T)).toBeCloseTo(PISTOL_NOISE * 0.6 - 3)
    expect(shellRadius(PISTOL_NOISE, false, T)).toBeGreaterThan(PISTOL_NOISE * 0.45)
  })

  test("an open door or window lets most of it through", () => {
    expect(shellRadius(WALK_NOISE, true, T)).toBeCloseTo(WALK_NOISE * 0.9 - 0.25)
    expect(shellRadius(PISTOL_NOISE, true, T)).toBeGreaterThan(shellRadius(PISTOL_NOISE, false, T))
  })

  test("footsteps inside a shut house are not heard on the lawn a couple of metres away; a gunshot is, far off", () => {
    const step = hearAcrossShells(INSIDE.x, INSIDE.y, WALK_NOISE, 0.4, LAWN.x, LAWN.y, SHUT, null, CONFIG, NIGHT, T)
    expect(step.audible).toBe(false)
    const shot = hearAcrossShells(INSIDE.x, INSIDE.y, PISTOL_NOISE, 2.2, LAWN.x, LAWN.y + 9, SHUT, null, CONFIG, NIGHT, T)
    expect(shot.audible).toBe(true)
    const farShot = hearAcrossShells(INSIDE.x, INSIDE.y, PISTOL_NOISE, 2.2, LAWN.x, LAWN.y + 20, SHUT, null, CONFIG, NIGHT, T)
    expect(farShot.audible).toBe(false)
  })

  test("through an open window footsteps carry, measured out through the window", () => {
    const window: BuildingShell = { openings: [{ id: "w", x: 24.5, y: 35.39 }] }
    const near = hearAcrossShells(INSIDE.x, INSIDE.y, WALK_NOISE, 0.4, LAWN.x, LAWN.y, window, null, CONFIG, NIGHT, T)
    expect(near.audible).toBe(true)
    // The same distance round a corner of the house, far from the only opening, stays quiet.
    const far: BuildingShell = { openings: [{ id: "w", x: 36.9, y: 29 }] }
    expect(hearAcrossShells(INSIDE.x, INSIDE.y, WALK_NOISE, 0.4, LAWN.x, LAWN.y, far, null, CONFIG, NIGHT, T).audible).toBe(false)
  })

  test("one of the dead inside a shut house barely hears the street, as the street barely hears the house", () => {
    const outIn = hearAcrossShells(LAWN.x, LAWN.y, WALK_NOISE * 3, 1, INSIDE.x, INSIDE.y, null, SHUT, CONFIG, NIGHT, T)
    const inOut = hearAcrossShells(INSIDE.x, INSIDE.y, WALK_NOISE * 3, 1, LAWN.x, LAWN.y, SHUT, null, CONFIG, NIGHT, T)
    expect(outIn.audible).toBe(inOut.audible)
    expect(outIn.perceivedLoudness).toBeCloseTo(inOut.perceivedLoudness)
  })
})

describe("building shells", () => {
  test("open outer doors and windows count; doors between rooms and boarded windows do not", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const town = sim.town
    const ash = town.buildings.findIndex((b) => b.id === "ash")
    for (const id of ["ash-front", "ash-room"]) town.doors.find((d) => d.id === id)!.open = true
    for (const w of town.windows) if (w.buildingId === "ash") w.open = true
    const boarded = new Set(["ash-east"])
    const shells = buildingShells(town, (id) => (boarded.has(id) ? 1 : 0))
    expect(shells[ash]!.openings.map((o) => o.id).sort()).toEqual(["ash-front", "ash-south-east", "ash-south-west"])
  })
})

describe("the crowd", () => {
  /** One of the dead standing on Ash's lawn while a survivor walks to and fro in the living room for two seconds. */
  function walkInside(hearingModel: number, openWindow = false) {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, hearingModel })
    sim.hour = 23
    const slot = sim.addSurvivor("p", 0)
    Object.assign(slot.survivor, { x: INSIDE.x, y: INSIDE.y, aim: 0 })
    if (openWindow) sim.town.windows.find((w) => w.id === "ash-south-west")!.open = true
    sim.rebuildSolids()
    sim.ai.rebuildTopology(sim.town)
    const z = sim.ai.spawnZombie(sim.town, LAWN.x, LAWN.y, "wander", Math.PI / 2)
    z.aim = Math.PI / 2
    const settings = {} as never
    let peak = 0
    let heard = false
    for (let i = 0; i < Math.round(2 / TICK_DT); i++) {
      const dir = Math.floor(i / 20) % 2 === 0 ? 1 : -1
      sim.stepSurvivor(slot, { mx: dir, my: 0, aim: 0, interact: false }, TICK_DT, settings)
      sim.stepWorld(TICK_DT, 0, settings)
      peak = Math.max(peak, z.awareness)
      heard ||= z.lastHeardNoiseId > 0
    }
    return { zombie: z, peak, heard }
  }

  test("walking in a shut house does not reach the dead on the lawn; Today it did", () => {
    const now = walkInside(1)
    expect(now.heard).toBe(false)
    expect(now.zombie.state).toBe("wander")
    const today = walkInside(0)
    expect(today.heard).toBe(true)
    expect(today.peak).toBeGreaterThan(now.peak)
  })

  test("with the window open beside them, they hear the footsteps", () => {
    const open = walkInside(1, true)
    expect(open.heard).toBe(true)
    expect(open.peak).toBeGreaterThan(0)
  })
})
