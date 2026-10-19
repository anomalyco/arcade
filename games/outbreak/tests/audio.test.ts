import { describe, expect, test } from "bun:test"
import { SFX_BY_ID } from "@arcade/kit/audio"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { LocalSession } from "../shared/session"
import { PISTOL_RELOAD_TIME, type CombatShotEvent } from "../shared/combat"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression"
import { SoundDirector, type SoundEvent, type SoundWorld, type SoundZombie } from "../src/audio/director"
import { meleeImpact, shotImpacts } from "../src/audio/impacts"
import { PICKUP_SOUND } from "../src/audio/inventory"
import { RELOAD_EVENTS, RELOAD_STARTS } from "../src/audio/reload"
import { ZombieFootsteps } from "../src/audio/zombie-steps"
import { audioControls, DEFAULT_AUDIO_SETTINGS, SURFACE_STEP_SETTING_KEYS } from "../src/audio/settings"
import { FOOT_SURFACES, footstepEvent, SoundOcclusion, stepMovementMode, surfaceAt, zombieStepEvent } from "../src/audio/space"
import { planInterior } from "../src/interiors/plan"
import { pursuers, soundWorld } from "../src/audio/world"
import { createOutbreakSettings, resolveWorldMode } from "../src/settings"

const ids = (events: readonly SoundEvent[]) => events.map((e) => e.id)
const idle = { mx: 0, my: 0, aim: 0, interact: false }

describe("Outbreak sound director", () => {
  test("every id it can emit exists in the shared library", () => {
    const source = Bun.file(new URL("../src/audio/director.ts", import.meta.url).pathname)
    return source.text().then((text) => {
      const emitted = [...text.matchAll(/id: "([a-z.-]+)"/g)].map((m) => m[1]!)
      expect(emitted.length).toBeGreaterThan(15)
      for (const id of emitted) expect(SFX_BY_ID.has(id), id).toBe(true)
      for (const s of ["concrete", "grass", "wood"]) for (const g of ["walk", "run"]) expect(SFX_BY_ID.has(`foot.${s}.${g}`)).toBe(true)
      for (const s of ["concrete", "grass", "wood"]) for (const k of ["step", "shuffle", "drag"]) expect(SFX_BY_ID.has(`zombie.foot.${k}.${s}`)).toBe(true)
      for (const s of ["wood", "plaster", "concrete", "metal", "glass"]) expect(SFX_BY_ID.has(`impact.bullet.${s}`)).toBe(true)
      for (const id of Object.values(PICKUP_SOUND)) expect(SFX_BY_ID.has(id), id).toBe(true)
      for (const k of ["medical", "tinker", "wood"]) for (const p of ["loop", "done"]) expect(SFX_BY_ID.has(`craft.${k}.${p}`)).toBe(true)
      for (const e of RELOAD_EVENTS) expect(SFX_BY_ID.has(e.id)).toBe(true)
    })
  })

  test("first frame is silent; shots, kills, reloads and doors sound from the live simulation", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = new SoundDirector()
    const p = session.view.player
    Object.assign(p, { x: 30, y: 44, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
    const target = session.ai.spawnZombie(session.view.town, 34, 44, "wander", Math.PI)
    const hear = () => director.observe(soundWorld(session.sim), p)
    expect(hear()).toEqual([])

    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const shot = hear()
    expect(ids(shot)).toContain("gun.pistol.shot")
    expect(ids(shot)).toContain("gun.casing")
    expect(ids(shot)).toContain("zombie.hit")
    expect(shot.find((e) => e.id === "gun.casing")!.delay).toBeGreaterThan(0.3)
    for (let i = 0; i < 18; i++) session.update(TICK_DT, idle, 0), hear()
    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const kill = hear()
    expect(target.state).toBe("dead")
    expect(ids(kill).filter((id) => id === "zombie.death")).toHaveLength(1)
    // The death is not repeated when the state change is seen on a later frame.
    session.update(TICK_DT, idle, 0)
    expect(ids(hear())).not.toContain("zombie.death")

    for (let i = 0; i < 18; i++) session.update(TICK_DT, idle, 0), hear()
    session.update(TICK_DT, { ...idle, reload: true }, 0)
    const reload = ids(hear())
    for (let i = 0; i < 10; i++) session.update(TICK_DT, idle, 0), reload.push(...ids(hear()))
    expect(reload).toContain("gun.pistol.mag-release")

    const door = session.view.town.doors[0]!
    door.open = !door.open
    const opened = hear()
    expect(ids(opened)).toEqual([door.open ? "door.wood.open" : "door.wood.close"])
    expect(opened[0]!.x).toBeCloseTo((door.rect[0] + door.rect[2]) / 2)
  })

  test("a shove that connects thuds; a whiff is only a whoosh", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = new SoundDirector()
    const p = session.view.player
    Object.assign(p, { x: 44, y: 44, vx: 0, vy: 0, aim: 0 })
    const hear = () => director.observe(soundWorld(session.sim), p)
    hear()
    session.update(TICK_DT, { ...idle, melee: true }, 0)
    const whiff = ids(hear())
    expect(whiff).toContain("melee.swing.light")
    expect(whiff).not.toContain("melee.shove")

    for (let i = 0; i < 90; i++) session.update(TICK_DT, idle, 0), hear()
    const z = session.ai.spawnZombie(session.view.town, 45.1, 44, "wander", Math.PI)
    session.update(TICK_DT, idle, 0), hear()
    session.update(TICK_DT, { ...idle, melee: true }, 0)
    const landed = ids(hear())
    expect(z.state).toBe("stagger")
    expect(landed).toContain("melee.shove")
    expect(landed).not.toContain("melee.swing.light")
  })

  test("co-op peers sound at their own position from their replicated state", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const a = sim.addSurvivor("a", 0)
    const b = sim.addSurvivor("b", 1)
    Object.assign(b.survivor, { x: 40, y: 30 })
    const director = new SoundDirector()
    director.observe(soundWorld(sim), a.survivor)
    b.survivor.flashlightOn = !b.survivor.flashlightOn
    b.survivor.health -= 10
    const events = director.observe(soundWorld(sim), a.survivor)
    expect(events.find((e) => e.id === "flashlight.click")).toMatchObject({ x: 40, y: 30, source: "b" })
    expect(ids(events)).toContain("body.hurt")
  })

  test("the reload plays in four parts at the reload pose's events, for local and remote survivors", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = new SoundDirector()
    const p = session.view.player
    Object.assign(p, { x: 30, y: 44, aim: 0 })
    session.sim.progression.ledger.apply({ kind: "useCharge", actor: "player", item: "pistol", amount: 3 })
    const hear = () => director.observe(soundWorld(session.sim), p)
    hear()
    session.update(TICK_DT, { ...idle, reload: true }, 0)
    const start = session.view.time - TICK_DT
    const heard: { id: string; at: number }[] = []
    for (let i = 0; i < 90; i++) {
      for (const e of hear()) if (e.id.startsWith("gun.pistol.")) heard.push({ id: e.id, at: session.view.time + (e.delay ?? 0) - start })
      session.update(TICK_DT, idle, 0)
    }
    expect(heard.map((h) => h.id)).toEqual(RELOAD_STARTS.map((r) => r.id))
    // Each lands within a tick of its pose time, in order, inside the 1.15 s reload.
    heard.forEach((h, i) => expect(Math.abs(h.at - RELOAD_STARTS[i]!.start)).toBeLessThan(TICK_DT * 1.5))
    expect(heard.at(-1)!.at).toBeLessThan(PISTOL_RELOAD_TIME)

    // A co-op peer only replicates "reloading" (0.5 held): the parts follow the time since it was first seen.
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const me = sim.addSurvivor("a", 0)
    const peer = sim.addSurvivor("b", 1)
    const remote = new SoundDirector()
    remote.observe(soundWorld(sim), me.survivor)
    const parts: number[] = []
    peer.survivor.reloadRemaining = 0.5
    for (let f = 0; f < 80; f++) {
      sim.time += TICK_DT
      for (const e of remote.observe(soundWorld(sim), me.survivor)) if (e.id.startsWith("gun.pistol.")) parts.push(f * TICK_DT + (e.delay ?? 0))
    }
    expect(parts).toHaveLength(4)
    parts.forEach((at, i) => expect(Math.abs(at - RELOAD_STARTS[i]!.start)).toBeLessThan(TICK_DT * 1.5))
  })

  test("missed shots strike the surface they stopped on, seen from the shooter, and ring off what they passed", () => {
    const town = new LocalSession(7).view.town
    const shot = (fromX: number, fromY: number, toX: number, toY: number): CombatShotEvent => ({ id: 1, time: 0, fromX, fromY, toX, toY, aim: 0, hitZombieId: null, killed: false, detachBone: null, seed: 1 })
    const house = town.buildings.find((b) => b.id === "ash")!
    const shop = town.buildings.find((b) => b.kind === "hardware")!
    const surfaces = (s: CombatShotEvent) => shotImpacts(town, s).map((h) => `${h.through ? "through " : ""}${h.surface}`)
    // Ash's west wall at x 22–22.22, from the yard (behind its fence, which the round passes) and from the living room.
    expect(surfaces(shot(19, 31, house.rect[0], 31))).toEqual(["wood"])
    expect(surfaces(shot(16, 31, house.rect[0], 31))).toEqual(["through wood", "wood"])
    expect(surfaces(shot(26, 31, house.rect[0] + 0.22, 31))).toEqual(["plaster"])
    // The hardware store's west wall from the street is brick and concrete.
    expect(surfaces(shot(48, 28, shop.rect[0], 28))).toEqual(["concrete"])
    // Through Ash's south-west window pane (closed) into the far wall; boarded, it is a plank.
    const win = town.windows.find((w) => w.id === "ash-south-west")!
    const wx = (win.rect[0] + win.rect[2]) / 2
    expect(surfaces(shot(wx, 40, wx, house.rect[1] + 5.7))).toEqual(["through glass", "plaster"])
    expect(shotImpacts(town, shot(wx, 40, wx, house.rect[1] + 5.7), (id) => (id === win.id ? 2 : 0))[0]!.surface).toBe("wood")
    // Through the abandoned sedan on the west street, out of range: metal only.
    expect(surfaces(shot(6, 46.2, 6 + 26, 46.2))).toEqual(["through metal"])
    // Hits on zombies are flesh (`zombie.hit`), not a wall.
    expect(shotImpacts(town, { ...shot(16, 31, 22, 31), hitZombieId: 3 })).toEqual([])
  })

  test("pickups sound like their item class; drops, deposits, pings and noisemakers sound where they happen", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const progression = session.sim.progression
    const ledger = progression.ledger
    const p = session.view.player
    const director = new SoundDirector()
    const hear = () => director.observe(soundWorld(session.sim), p)
    hear()
    const grant = (item: string, count = 1) => ledger.apply({ kind: "grant", actor: "player", item, count })
    grant("crowbar")
    expect(ids(hear())).toEqual(["pickup.tool"])
    grant("key")
    expect(ids(hear())).toEqual(["pickup.key"])
    grant("toolbox")
    grant("medkit")
    const two = hear()
    expect(ids(two).sort()).toEqual(["pickup.medical", "pickup.part"])
    expect(two[1]!.delay).toBeGreaterThan(0.1)
    grant("battery")
    expect(ids(hear())).toEqual(["pickup.battery"])
    // A dropped stack lands where it was dropped.
    ledger.apply({ kind: "drop", actor: "player", at: { x: 31, y: 41 }, items: { ammo: 2 } })
    expect(hear().find((e) => e.id === "item.drop")).toMatchObject({ x: 31, y: 41 })
    // Supplies deposited at a bench sound at the bench.
    const bench = progression.benches[0]!
    ledger.apply({ kind: "deposit", actor: "player", to: bench.id, items: { plank: 1 } })
    expect(hear().find((e) => e.id === "bench.deposit")).toMatchObject({ x: bench.bench.x, y: bench.bench.y })
    progression.pings.push({ id: 9, by: 0, x: 40, y: 40, label: "Zombie", until: 99 })
    expect(ids(hear())).toEqual(["ui.ping"])
    progression.lures.push({ id: 4, x: 45, y: 42, until: 99, next: 1 })
    expect(ids(hear())).toEqual(["lure.land"])
    expect(director.holds).toEqual([{ key: "lure:4", id: "lure.loop", x: 45, y: 42 }])
    progression.lures.length = 0
    hear()
    expect(director.holds).toEqual([])
    // The generator runs at night once a car battery is wired into the bench.
    ledger.apply({ kind: "grant", actor: "player", item: "car-battery", store: bench.id })
    session.sim.hour = 23
    hear()
    expect(director.holds.map((h) => h.id)).toEqual(["generator.loop"])
  })

  test("crafting holds its kind's loop while the channel runs and finishes with its own sound, without a pickup", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const ledger = sim.progression.ledger
    const mate = sim.addSurvivor("mate", 0)
    Object.assign(mate.survivor, { x: 60, y: 45 })
    ledger.apply({ kind: "grant", actor: "mate", item: "learned:bandage", store: "team/known" })
    ledger.apply({ kind: "grant", actor: "mate", item: "chem", count: 1 })
    const director = new SoundDirector()
    const cmd = { mx: 0, my: 0, aim: 0, interact: false }
    const heard: string[] = []
    const holds = new Set<string>()
    const tick = (c = cmd) => {
      sim.stepSurvivor(mate, c, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
      heard.push(...ids(director.observe(soundWorld(sim), mate.survivor)))
      for (const h of director.holds) holds.add(h.id)
    }
    director.observe(soundWorld(sim), mate.survivor)
    tick({ ...cmd, pick: { mode: "craft", index: 0 } } as typeof cmd)
    for (let i = 0; i < Math.ceil(DEFAULT_PROGRESSION_TUNING.craftTime / TICK_DT) + 2; i++) tick()
    expect(ledger.count("mate", "bandage")).toBe(1)
    expect([...holds]).toEqual(["craft.medical.loop"])
    expect(director.holds).toEqual([])
    expect(heard.filter((id) => id.startsWith("craft.") || id.startsWith("pickup."))).toEqual(["craft.medical.done"])
  })

  test("zombie feet: only the nearest few step, within the crowd budget; the rest of a horde is the bed", () => {
    const steps = new ZombieFootsteps()
    const listener = { x: 0, y: 0 }
    const zombies: SoundZombie[] = Array.from({ length: 100 }, (_, i) => {
      const a = i * 2.399
      const r = 1.5 + (i % 25) * 0.8
      return { id: i + 1, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0.9, vy: 0, state: "chase", seed: i * 0.37 + 0.1, drag: 0.9 }
    })
    const nearest = new Set([...zombies].sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).slice(0, steps.tuning.voices).map((z) => z.id))
    const kinds = new Set<string>()
    let played = 0
    const seconds = 10
    for (let f = 0; f < seconds * 60; f++) {
      // The rig reports contacts for every animated zombie: far more than the budget allows.
      for (const z of zombies.slice(0, 30)) if ((f + z.id) % 24 === 0) steps.contact(z.id, z.x, z.y, 0.9, z.id % 3 ? 0 : 0.8, z.id % 2 ? "limper" : "reacher")
      for (const s of steps.update(zombies, listener, f / 60, 1 / 60, () => "concrete")) {
        played++
        kinds.add(s.id)
        expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(steps.tuning.hearing)
      }
    }
    expect(played / seconds).toBeLessThanOrEqual(steps.tuning.rate + steps.tuning.burst / seconds)
    expect(played / seconds).toBeGreaterThan(2)
    expect(steps.counts.skipped).toBeGreaterThan(steps.counts.played)
    expect(steps.horde.level).toBeGreaterThan(0.8)
    expect([...kinds].every((id) => /^zombie\.foot\.(step|shuffle|drag)\.concrete$/.test(id))).toBe(true)
    void nearest
  })

  function crowd(n: number): { world: SoundWorld; zombies: SoundZombie[] } {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const zombies = Array.from({ length: n }, (_, i): SoundZombie => ({ id: i + 1, x: 30 + (i % 10) * 1.5, y: 30 + Math.floor(i / 10) * 1.5, state: "wander" }))
    return { world: { ...soundWorld(sim), zombies, survivors: [] }, zombies }
  }

  test("idle groans are spaced and capped however big the crowd; alerts are rate-limited", () => {
    const { world, zombies } = crowd(100)
    const director = new SoundDirector(3)
    const times = new Map<number, number[]>()
    let groans = 0
    const listener = { x: 37, y: 37 }
    for (let f = 0; f <= 60 * 60; f++) {
      const t = f / 60
      for (const e of director.observe({ ...world, time: t }, listener)) {
        if (e.id !== "zombie.groan.idle") continue
        groans++
        const z = zombies.find((z) => z.x === e.x && z.y === e.y)!
        times.set(z.id, [...(times.get(z.id) ?? []), t])
      }
    }
    // One minute with 100 zombies in earshot: no closer than the minimum gap, so at most ~86, and no zombie repeats
    // within its own spacing.
    expect(groans).toBeGreaterThan(20)
    expect(groans).toBeLessThanOrEqual(Math.ceil(60 / director.tuning.groanMinGap) + 1)
    for (const list of times.values()) for (let i = 1; i < list.length; i++) expect(list[i]! - list[i - 1]!).toBeGreaterThanOrEqual(director.tuning.groanPerZombie - 1e-9)

    // The whole crowd notices at once: one snarl, then at most one per alertGap.
    for (const z of zombies) z.state = "chase"
    const burst = director.observe({ ...world, time: 61 }, listener)
    expect(ids(burst).filter((id) => id === "zombie.alert")).toHaveLength(1)
    expect(pursuers(zombies, listener.x, listener.y)).toBe(100)
  })

  test("director cost with 100 zombies stays far under a frame", () => {
    const { world, zombies } = crowd(100)
    const director = new SoundDirector()
    let t = 0
    for (let i = 0; i < 120; i++) director.observe({ ...world, time: (t += 1 / 60) }, { x: 37, y: 37 })
    const start = performance.now()
    const frames = 600
    for (let i = 0; i < frames; i++) {
      zombies[i % 100]!.state = i % 3 ? "wander" : "chase"
      director.observe({ ...world, time: (t += 1 / 60) }, { x: 37, y: 37 })
    }
    const ms = (performance.now() - start) / frames
    console.log(`director.observe with 100 zombies: ${ms.toFixed(3)} ms/frame`)
    expect(ms).toBeLessThan(0.5)
  })
})

describe("Outbreak acoustic space", () => {
  const town = new LocalSession(7).view.town
  test("surfaces follow the town layout across all 11 floor and ground materials", () => {
    const house = town.buildings.find((b) => b.kind === "house")!
    const pharmacy = town.buildings.find((b) => b.kind === "pharmacy")!
    // Wood floor in living room, front porch deck, and NW garden shed
    expect(surfaceAt(town, (house.rect[0] + house.rect[2]) / 2, house.rect[3] - 1)).toBe("wood")
    expect(surfaceAt(town, house.rect[0] + 5.7, house.rect[3] + 0.6)).toBe("wood")
    expect(surfaceAt(town, house.rect[0] - 2.0, house.rect[1] + 1.4)).toBe("wood")
    // Tile in house SE kitchen, NE washroom wing, and pharmacy interior
    expect(surfaceAt(town, house.rect[2] - 2.0, house.rect[3] - 1.5)).toBe("tile")
    expect(surfaceAt(town, house.rect[0] + 10.5, house.rect[1] + 3.0)).toBe("tile")
    expect(surfaceAt(town, (pharmacy.rect[0] + pharmacy.rect[2]) / 2, (pharmacy.rect[1] + pharmacy.rect[3]) / 2)).toBe("tile")
    // Woven rug / carpet inside residential rooms
    const rug = planInterior(house, town.houseSeed).rugs[0]!
    expect(surfaceAt(town, (rug.rect[0] + rug.rect[2]) / 2, (rug.rect[1] + rug.rect[3]) / 2)).toBe("carpet")
    // Gravel driveway along the west side of the lot
    expect(surfaceAt(town, house.rect[0] - 1.5, house.rect[1] + 5.0)).toBe("gravel")
    // Street asphalt/concrete and front walkway
    expect(surfaceAt(town, 10, 44)).toBe("concrete")
    expect(surfaceAt(town, house.rect[0] + 5.7, house.rect[3] + 1.8)).toBe("concrete")
    // Curb-verge dirt/moss strip and tree root ring
    expect(surfaceAt(town, 14, 39.5)).toBe("dirt")
    const tree = town.props.find((p) => p.kind === "tree")!
    expect(surfaceAt(town, tree.x, tree.y)).toBe("dirt")
    // Standing rainwater puddle in street pothole
    expect(surfaceAt(town, 25.6, 42.15)).toBe("puddle")
    // Metal manhole cover, storm drain grate, and parked car body
    expect(surfaceAt(town, 33.45, 43.85)).toBe("metal")
    expect(surfaceAt(town, 24.65, 40.12)).toBe("metal")
    expect(surfaceAt(town, 12.2, 46.2)).toBe("metal")
    // Open yard lawn grass
    expect(surfaceAt(town, 4, 20)).toBe("grass")
    // Broken glass and blood pool overlays
    expect(surfaceAt(town, 28, 33, { glass: [{ x: 28, y: 33 }] })).toBe("glass")
    expect(surfaceAt(town, 28, 33, { blood: [{ x: 28, y: 33, r: 0.6 }] })).toBe("blood")
    expect(FOOT_SURFACES).toHaveLength(11)
  })

  test("footstep loudness and cadence follow crouch/walk/run movement mode, local attenuation, and surface character", () => {
    const house = town.buildings.find((b) => b.kind === "house")!
    const rug = planInterior(house, town.houseSeed).rugs[0]!
    const rugX = (rug.rect[0] + rug.rect[2]) / 2
    const rugY = (rug.rect[1] + rug.rect[3]) / 2

    // Stationary pivot / aim turn (< 0.25 m/s) stays silent
    expect(stepMovementMode(0.1)).toBe("idle")
    expect(footstepEvent(town, 10, 44, 0.1, { local: true })).toBeNull()

    // Crouch vs walk vs sprint on concrete
    const crouch = footstepEvent(town, 10, 44, 1.9, { local: true, crouching: true })!
    const walk = footstepEvent(town, 10, 44, 3.4, { local: true })!
    const run = footstepEvent(town, 10, 44, 5.6, { local: true })!
    const peerWalk = footstepEvent(town, 10, 44, 3.4, { local: false })!
    expect(crouch.mode).toBe("crouch")
    expect(walk.mode).toBe("walk")
    expect(run.mode).toBe("run")
    expect(crouch.event.gain!).toBeLessThan(walk.event.gain! * 0.55)
    expect(walk.event.gain!).toBeLessThan(run.event.gain! * 0.7)
    expect(walk.event.gain!).toBeLessThan(peerWalk.event.gain!)

    // Crouching over broken glass steps carefully without crunching it
    const woodX = (house.rect[0] + house.rect[2]) / 2
    const woodY = house.rect[3] - 1
    const walkGlass = footstepEvent(town, woodX, woodY, 3.4, { extra: { glass: [{ x: woodX, y: woodY }] } })!
    const crouchGlass = footstepEvent(town, woodX, woodY, 1.9, { crouching: true, extra: { glass: [{ x: woodX, y: woodY }] } })!
    expect(walkGlass.surface).toBe("glass")
    expect(crouchGlass.surface).toBe("wood")

    // Carpet is softer and more low-passed than gravel or puddle
    const carpetStep = footstepEvent(town, rugX, rugY, 3.4, { local: true })!
    const gravelStep = footstepEvent(town, house.rect[0] - 1.5, house.rect[1] + 5.0, 3.4, { local: true })!
    const puddleStep = footstepEvent(town, 25.6, 42.15, 3.4, { local: true })!
    expect(carpetStep.event.gain!).toBeLessThan(gravelStep.event.gain!)
    expect(carpetStep.event.cutoffHz!).toBeLessThan(gravelStep.event.cutoffHz!)
    expect(puddleStep.surface).toBe("puddle")

    // Zombie and Brute footsteps adapt to surface
    for (const s of FOOT_SURFACES) {
      const zEv = zombieStepEvent(s, "shuffle", 10, 44, 1.2)
      const bEv = zombieStepEvent(s, "brute", 10, 44, 1.5)
      expect(SFX_BY_ID.has(zEv.id), zEv.id).toBe(true)
      expect(SFX_BY_ID.has(bEv.id), bEv.id).toBe(true)
    }
  })

  test("bullet and melee impacts distinguish car body, metal, wood, glass, concrete/plaster and dirt/grass", () => {
    const house = town.buildings.find((b) => b.id === "ash")!
    const shop = town.buildings.find((b) => b.kind === "hardware")!
    const win = town.windows.find((w) => w.id === "ash-south-west")!
    const wx = (win.rect[0] + win.rect[2]) / 2

    // Bullet stopping in open lawn/dirt vs car body
    const dirtShot = shotImpacts(town, { id: 9, time: 0, fromX: 4, fromY: 20, toX: 8, toY: 20, aim: 0, hitZombieId: null, killed: false, detachBone: null, seed: 1 })
    expect(dirtShot[0]?.material).toBe("dirt")
    expect(dirtShot[0]?.cutoffHz).toBeLessThanOrEqual(2000)
    const carShot = shotImpacts(town, { id: 10, time: 0, fromX: 10, fromY: 46.2, toX: 13.7, toY: 46.2, aim: 0, hitZombieId: null, killed: false, detachBone: null, seed: 1 })
    expect(carShot[0]?.material).toBe("car")

    // Melee swings into world surfaces when no zombie is struck
    expect(meleeImpact(town, { x: 20.5, y: 31, aim: 0, reach: 2.0 })?.material).toBe("wood")
    expect(meleeImpact(town, { x: 51.5, y: 28, aim: 0, reach: 2.0 })?.material).toBe("concrete")
    expect(meleeImpact(town, { x: wx, y: house.rect[3] + 1.0, aim: -Math.PI / 2, reach: 1.5 })?.material).toBe("glass")
    expect(meleeImpact(town, { x: 12.8, y: 46.2, aim: 0, reach: 1.8 })?.material).toBe("car")
    expect(meleeImpact(town, { x: 4, y: 20, aim: 0, reach: 1.6, groundStrike: true })?.material).toBe("dirt")
    void shop
  })

  test("walls and closed doors muffle, open air does not", () => {
    const occlusion = new SoundOcclusion()
    occlusion.sync(town, 0)
    const house = town.buildings[0]!
    const inside = { x: (house.rect[0] + house.rect[2]) / 2, y: (house.rect[1] + house.rect[3]) / 2 }
    expect(occlusion.query(10, 44, 14, 44)).toBe(0)
    expect(occlusion.query(10, 44, inside.x, inside.y)).toBeGreaterThan(0.5)
    occlusion.strength = 0
    expect(occlusion.query(10, 44, inside.x, inside.y)).toBe(0)
  })

  test("mix hierarchy and priority voice stealing keep gunshots and zombie vocals above footsteps", () => {
    const shotGain = SFX_BY_ID.get("gun.pistol.shot")!.gain
    const bombGain = SFX_BY_ID.get("bomb.explode")!.gain
    const alertGain = SFX_BY_ID.get("zombie.alert")!.gain
    const impactGain = SFX_BY_ID.get("impact.bullet.concrete")!.gain
    const walkGain = SFX_BY_ID.get("foot.concrete.walk")!.gain
    const zombieFootGain = SFX_BY_ID.get("zombie.foot.shuffle.concrete")!.gain
    expect(shotGain).toBeGreaterThan(alertGain)
    expect(bombGain).toBeGreaterThan(alertGain)
    expect(alertGain).toBeGreaterThan(impactGain)
    expect(impactGain).toBeGreaterThan(walkGain)
    expect(zombieFootGain).toBeLessThan(alertGain)
  })

  test("dedicated samples play for downed heartbeat, car alarms, broken glass steps, puddle/gravel/tile footsteps, and crows", () => {
    for (const id of [
      "foot.puddle.walk",
      "foot.gravel.walk",
      "foot.tile.walk",
      "foot.glass.step",
      "body.heartbeat",
      "creature.crow.caw",
      "vehicle.alarm.loop",
    ]) {
      expect(SFX_BY_ID.has(id), id).toBe(true)
    }

    // Puddle, gravel, tile and glass steps resolve to their dedicated library cues
    const house = town.buildings.find((b) => b.kind === "house")!
    expect(footstepEvent(town, 25.6, 42.15, 3.4)?.event.id).toBe("foot.puddle.walk")
    expect(footstepEvent(town, house.rect[0] - 1.5, house.rect[1] + 5.0, 3.4)?.event.id).toBe("foot.gravel.walk")
    expect(footstepEvent(town, house.rect[2] - 2.0, house.rect[3] - 1.5, 3.4)?.event.id).toBe("foot.tile.walk")
    expect(footstepEvent(town, 10, 44, 3.4, { extra: { glass: [{ x: 10, y: 44 }] } })?.event.id).toBe("foot.glass.step")

    // Downed survivor emits body.heartbeat rather than pitched-down foot.grass.run
    const director = new SoundDirector()
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const a = sim.addSurvivor("a", 0)
    director.observe(
      { ...soundWorld(sim), death: { runOver: false, survivors: [{ index: 0, x: a.survivor.x, y: a.survivor.y, state: "alive", bleed: 10, bleedMax: 10 }] } },
      a.survivor,
    )
    const downEvents = director.observe(
      { ...soundWorld(sim), time: 1.0, death: { runOver: false, survivors: [{ index: 0, x: a.survivor.x, y: a.survivor.y, state: "down", bleed: 8, bleedMax: 10 }] } },
      a.survivor,
    )
    const beatEvents = director.observe(
      { ...soundWorld(sim), time: 2.0, death: { runOver: false, survivors: [{ index: 0, x: a.survivor.x, y: a.survivor.y, state: "down", bleed: 7, bleedMax: 10 }] } },
      a.survivor,
    )
    expect(ids(downEvents)).toContain("body.hurt")
    expect(ids(downEvents)).not.toContain("body.vault")
    expect(ids(beatEvents)).toContain("body.heartbeat")
    expect(ids(beatEvents)).not.toContain("foot.grass.run")

    // Triggering a fresh car alarm holds vehicle.alarm.loop instead of lure.loop
    const car = sim.progression.verbs.cars[0]!
    sim.progression.ledger.createStore({
      id: `car:${car.key}`,
      mode: "counters",
      scope: "shared",
      at: { x: car.x, y: car.y },
      initial: { smashed: 1, alarm: 1, until: 100 },
    })
    director.observe({ ...soundWorld(sim), time: 2.5 }, a.survivor)
    expect(director.holds.find((h) => h.key.startsWith("alarm:"))?.id).toBe("vehicle.alarm.loop")
  })
})

describe("a fresh start is quiet", () => {
  test("no car alarm or other alarm wails at spawn, idle or walking into streamed lots, unless the player sets one off", () => {
    const settings = createOutbreakSettings(new URLSearchParams())
    for (const seed of [1, 2, 3, 7, 11]) {
      const session = new LocalSession(seed, settings.world.houseSeed, settings.world.terrain, settings.ai, settings.progression, resolveWorldMode(settings.world.worldMode))
      const director = new SoundDirector()
      const p = session.view.player
      const alarms: string[] = []
      for (let f = 0; f < 40 / TICK_DT; f++) {
        // Idle for 5 s, then sprint east out of the origin block.
        const moving = f * TICK_DT > 5
        if (f > 0) session.update(TICK_DT, { ...idle, mx: moving ? 1 : 0, sprint: moving }, settings.dayCycle.timeScale, settings)
        director.observe(soundWorld(session.sim), p)
        for (const h of director.holds) if (h.key.startsWith("alarm:")) alarms.push(`${seed}: ${h.key} at ${(f * TICK_DT).toFixed(1)} s`)
        for (const n of session.sim.ai.noiseBus.events) if (n.kind === "alarm") alarms.push(`${seed}: alarm noise at ${(f * TICK_DT).toFixed(1)} s`)
      }
      expect(alarms).toEqual([])
    }
  })

  test("a vignette's long-dead car alarm never sounds, even at time zero", () => {
    const director = new SoundDirector()
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const a = sim.addSurvivor("a", 0)
    const car = sim.progression.verbs.cars[0]!
    sim.progression.ledger.createStore({ id: `car:${car.key}`, mode: "counters", scope: "shared", at: { x: car.x, y: car.y }, initial: { smashed: 1, alarm: 1, until: 1, old: 1 } })
    director.observe({ ...soundWorld(sim), time: 0 }, a.survivor)
    expect(director.holds.filter((h) => h.key.startsWith("alarm:"))).toEqual([])
  })
})

describe("fire & explosives sounds (AR-62)", () => {
  test("every sound they use is in Outbreak's slice of the shared library", () => {
    return Bun.file(new URL("../src/audio/inventory.ts", import.meta.url).pathname)
      .text()
      .then((text) => {
        const body = text.slice(text.indexOf("private fireSound"))
        const used = [...body.matchAll(/id: "([a-z.-]+)"/g)].map((m) => m[1]!)
        expect(used.length).toBeGreaterThan(6)
        for (const id of used) expect(SFX_BY_ID.get(id)?.usedBy, id).toContain("outbreak")
      })
  })

  test("a thrown stick of dynamite hisses on its fuse and blows once", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = new SoundDirector()
    const p = session.view.player
    Object.assign(p, { x: 30, y: 44, vx: 0, vy: 0, aim: 0 })
    const ledger = session.sim.progression.ledger
    ledger.apply({ kind: "grant", actor: "player", item: "dynamite", count: 1 })
    const slot = session.sim.progression.hotbar("player")!.slots.findIndex((s) => s?.item === "dynamite")
    ledger.apply({ kind: "select", actor: "player", slot })
    const hear = () => ids(director.observe(soundWorld(session.sim), p))
    hear()
    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const heard = hear()
    let fuse = director.holds.some((h) => h.key.startsWith("dyn:"))
    for (let i = 0; i < 4 / TICK_DT; i++) {
      session.update(TICK_DT, idle, 0)
      heard.push(...hear())
      fuse ||= director.holds.some((h) => h.key.startsWith("dyn:"))
    }
    expect(heard).toContain("flare.ignite")
    expect(fuse).toBe(true)
    expect(heard.filter((id) => id === "bomb.explode")).toHaveLength(1)
    expect(director.holds.some((h) => h.key.startsWith("dyn:"))).toBe(false)
  })
})

describe("Lab Sound controls & settings", () => {
  test("exposes Today vs Sound pass, bus volumes, per-surface footstep sliders, falloff and voice cap in the Sound group", () => {
    const soundGroup = audioControls.filter((c) => c.group === "Sound")
    const keys = new Set(soundGroup.map((c) => c.key))

    // Today vs Sound pass profile selector is first in Sound group
    const modeCtrl = soundGroup.find((c) => c.key === "audioMode")
    expect(modeCtrl).toBeDefined()
    expect(modeCtrl && "options" in modeCtrl ? modeCtrl.options.map((o) => o.label) : []).toContain("Today")
    expect(DEFAULT_AUDIO_SETTINGS.audioMode).toBe(1)

    // Mix bus sliders
    for (const k of ["audioWeapons", "audioZombies", "audioImpacts", "audioMovement", "audioAmbience", "audioUi"]) {
      expect(keys.has(k), k).toBe(true)
    }

    // Player self-step and every FootSurface has a dedicated loudness slider in Sound
    expect(keys.has("audioSelfStep")).toBe(true)
    for (const surf of FOOT_SURFACES) {
      const settingKey = SURFACE_STEP_SETTING_KEYS[surf]
      expect(keys.has(settingKey), `${surf} -> ${settingKey}`).toBe(true)
      expect(DEFAULT_AUDIO_SETTINGS[settingKey]).toBe(100)
    }

    // Spatial & engine controls
    for (const k of ["audioOcclusion", "audioFalloff", "audioReverb", "audioVoiceCap"]) {
      expect(keys.has(k), k).toBe(true)
    }

    // Forwarding on OutbreakSettings works for all new keys
    const settings = createOutbreakSettings(new URLSearchParams())
    expect(settings.audio.audioMode).toBe(1)
    expect(settings.audio.audioStepPuddle).toBe(100)
    expect(settings.audio.audioVoiceCap).toBe(32)

    // footstepEvent honours selfScale and surfaceScale function
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const base = footstepEvent(sim.town, 38, 44, 3.4, { local: true })!
    const boosted = footstepEvent(sim.town, 38, 44, 3.4, {
      local: true,
      selfScale: 0.5,
      surfaceScale: (surf) => (surf === "concrete" ? 1.5 : 1.0),
    })!
    expect(boosted.surface).toBe("concrete")
    expect(boosted.event.gain).toBeCloseTo(base.event.gain! * 0.5 * 1.5, 2)
  })
})
