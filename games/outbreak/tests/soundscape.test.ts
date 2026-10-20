import { describe, expect, test } from "bun:test"
import { makeTown, type Town } from "../shared/map"
import { DEFAULT_AUDIO_SETTINGS } from "../src/audio/settings"
import { SCAPE_LAYERS, SCAPE_SAMPLE_RATE, SCAPE_SOUNDS, scapeSound } from "../src/audio/soundscape/catalog"
import { ALARM_CHANCE, GUNFIRE_CHANCE, nightOf, RADIO_CHANCE, ScapeDirector, ScapeHours, SIREN_CHANCE, type ScapeInput, type ScapeLevels } from "../src/audio/soundscape/director"
import { drainAmbientCalls, holdAmbientSound, playAmbientSound } from "../src/audio/soundscape/hooks"
import { housePlan, housePowered } from "../src/audio/soundscape/houses"
import { LifeSounds } from "../src/audio/soundscape/life"
import { scapeCue, scapeLevels } from "../src/audio/soundscape/soundscape"
import { placeLaundry } from "../src/details/leftovers"
import { DEFAULT_DETAIL_SETTINGS } from "../src/details/settings"
import { placeSprinklers } from "../src/details/sprinkler"

const levels = (over: Partial<typeof DEFAULT_AUDIO_SETTINGS> = {}) => scapeLevels({ ...DEFAULT_AUDIO_SETTINGS, ...over }, {} as ScapeLevels)

function input(town: Town, over: Partial<ScapeInput> = {}): ScapeInput {
  const listener = over.listener ?? { x: 30, y: 30 }
  return { town, time: 0, dt: 0.25, hour: 23, absHour: 23, listener, survivors: [listener], rain: 0, wetness: 0, storm: 0, glass: [], indoor: 0, ...over }
}

/** Steps a director over `seconds` (coarse steps are fine: every layer finds its events in (prev, now]). */
function run(d: ScapeDirector, town: Town, from: number, seconds: number, over: Partial<ScapeInput> = {}, L = levels(), dt = 0.25) {
  const shots: { t: number; id: string; x: number; y: number; far: boolean }[] = []
  const holds = new Set<string>()
  for (let t = from; t < from + seconds; t += dt) {
    d.step(input(town, { ...over, time: t, dt }), L)
    for (let i = 0; i < d.shotCount; i++) shots.push({ t, id: d.shots[i]!.id, x: d.shots[i]!.x, y: d.shots[i]!.y, far: d.shots[i]!.far })
    for (let i = 0; i < d.holdCount; i++) holds.add(d.holds[i]!.id)
  }
  return { shots, holds }
}

describe("soundscape sounds (procedural, AR-86)", () => {
  test("every sound bakes finite, audible, unclipped PCM; loops are seamless at the wrap", () => {
    for (const def of SCAPE_SOUNDS) {
      const pcm = def.bake(SCAPE_SAMPLE_RATE)
      let peak = 0
      let energy = 0
      for (const v of pcm) {
        expect(Number.isFinite(v)).toBe(true)
        peak = Math.max(peak, Math.abs(v))
        energy += v * v
      }
      expect(peak).toBeGreaterThan(0.05)
      expect(peak).toBeLessThanOrEqual(0.9)
      expect(energy).toBeGreaterThan(0)
      if (def.loop) {
        // No step at the seam: the jump from last to first sample is no bigger than the sound's own movement.
        let maxStep = 0
        for (let i = 1; i < pcm.length; i++) maxStep = Math.max(maxStep, Math.abs(pcm[i]! - pcm[i - 1]!))
        expect(Math.abs(pcm[0]! - pcm[pcm.length - 1]!)).toBeLessThanOrEqual(maxStep * 1.01)
      }
    }
  })

  test("baking is deterministic and the whole catalogue stays small", () => {
    let samples = 0
    for (const def of SCAPE_SOUNDS) {
      const a = def.bake(SCAPE_SAMPLE_RATE)
      const b = def.bake(SCAPE_SAMPLE_RATE)
      expect(a.length).toBe(b.length)
      expect(a.every((v, i) => v === b[i])).toBe(true)
      if (!def.perRun || def.id.endsWith(".1")) samples += a.length
    }
    // Under 190 s of mono audio (≈18 MB at 24 kHz) if every sound were baked at once (one 3 AM message per run); each bakes on first use.
    expect(samples / SCAPE_SAMPLE_RATE).toBeLessThan(190)
  })

  test("cues play on the Ambience bus below the game's own sounds", () => {
    for (const def of SCAPE_SOUNDS) {
      const cue = scapeCue(def)
      expect(cue.category).toBe("ambience")
      expect(cue.priority!).toBeLessThan(50)
      expect(scapeSound(def.id)).toBe(def)
    }
  })
})

describe("soundscape director", () => {
  const town = makeTown(7)

  test("Today (audioScape 0) and every toggle off make no sound at all", () => {
    for (const L of [levels({ audioScape: 0 }), levels({ audioScapeLevel: 0 })]) {
      for (const layer of SCAPE_LAYERS) expect(L[layer]).toBe(0)
      const d = new ScapeDirector()
      const { shots, holds } = run(d, town, 1000, 300, { listener: { x: 29, y: 30 } }, L)
      expect(shots.length).toBe(0)
      expect(holds.size).toBe(0)
    }
  })

  test("is a pure function of the shared clock: two clients hear the same events, wherever they stand nearby", () => {
    const a = run(new ScapeDirector(), town, 4000, 400, { listener: { x: 29, y: 30 } })
    const b = run(new ScapeDirector(), town, 4000, 400, { listener: { x: 31, y: 33 } })
    const distant = (s: typeof a.shots) => s.filter((e) => e.far).map((e) => `${e.t}:${e.id}`)
    expect(distant(a.shots).length).toBeGreaterThan(0)
    expect(distant(a.shots)).toEqual(distant(b.shots))
    const again = run(new ScapeDirector(), town, 4000, 400, { listener: { x: 29, y: 30 } })
    expect(again.shots).toEqual(a.shots)
  })

  test("sirens and other survivors' gunfire thin out night by night, then stop", () => {
    const perNight = (night: number) => {
      const d = new ScapeDirector()
      const absHour = 24 * (night - 1) + 23
      expect(nightOf(absHour)).toBe(night)
      let sirens = 0
      let shots = 0
      for (let t = 0; t < 6000; t += 0.5) {
        d.step(input(town, { time: 20000 * night + t, dt: 0.5, absHour, hour: 23 }), levels())
        for (let i = 0; i < d.holdCount; i++) if (d.holds[i]!.id === "scape.siren") sirens++
        for (let i = 0; i < d.shotCount; i++) if (d.shots[i]!.id.startsWith("scape.gunshot")) shots++
      }
      return { sirens, shots }
    }
    const n = [1, 2, 3, 4, 5].map(perNight)
    expect(n[0]!.sirens).toBeGreaterThan(n[1]!.sirens)
    expect(n[1]!.sirens).toBeGreaterThan(n[2]!.sirens)
    expect(n[2]!.sirens).toBeGreaterThan(0)
    expect(n[3]!.sirens).toBe(0)
    expect(n[0]!.shots).toBeGreaterThan(n[2]!.shots)
    expect(n[3]!.shots).toBeGreaterThan(0)
    expect(n[4]!.shots).toBe(0)
    expect(SIREN_CHANCE.length).toBe(4)
    expect(GUNFIRE_CHANCE.length).toBe(5)
    expect(ALARM_CHANCE[1]!).toBeGreaterThan(ALARM_CHANCE[4]!)
  })

  test("a house's clocks tick inside it, and the fridge hums until the power fails, with a last shudder", () => {
    const ash = town.buildings.find((b) => b.id === "ash")!
    const plan = housePlan(town, ash)
    const inside = { x: 30, y: 30 }
    const d = new ScapeDirector()
    const { holds } = run(d, town, 100, 2, { listener: inside, absHour: 20 })
    if (plan.clocks.length) expect([...holds].some((id) => id.startsWith("scape.clock"))).toBe(true)
    // A house that loses power: hum before, the shudder at the moment, silence after.
    const fridgeHouse = { ...plan, powerLoss: 30 }
    expect(housePowered(fridgeHouse, 29.9)).toBe(true)
    expect(housePowered(fridgeHouse, 30.1)).toBe(false)
    if (plan.fridge && Number.isFinite(plan.powerLoss) && plan.powerLoss > 0) {
      const e = new ScapeDirector()
      let off = 0
      let humAfter = 0
      for (let k = 0; k < 400; k++) {
        const abs = plan.powerLoss - 0.1 + k * 0.001
        e.step(input(town, { time: 500 + k * 0.1, dt: 0.1, absHour: abs, listener: inside }), levels())
        for (let i = 0; i < e.shotCount; i++) if (e.shots[i]!.id === "scape.fridge.off") off++
        if (abs > plan.powerLoss + 0.01) for (let i = 0; i < e.holdCount; i++) if (e.holds[i]!.id === "scape.fridge.hum") humAfter++
      }
      expect(off).toBe(1)
      expect(humAfter).toBe(0)
    }
  })

  test("the haunted phone rings at three, stops when somebody walks up, and the machine answers", () => {
    // Elm, seed 7, has the haunted phone.
    const elm = town.buildings.find((b) => b.id === "elm")!
    const phone = housePlan(town, elm).phone!
    expect(phone.haunted).toBe(true)
    const d = new ScapeDirector()
    const far = { x: 28.5, y: 57 }
    const log: string[] = []
    let t = 7000
    let hour = 2.98
    for (let k = 0; k < 120; k++, t += 0.25, hour += 0.25 / 120) {
      const me = k < 60 ? far : { x: phone.x + 1, y: phone.y + 1 }
      d.step(input(town, { time: t, hour, absHour: 24 + hour, listener: me, survivors: [me] }), levels())
      for (let i = 0; i < d.shotCount; i++) if (d.shots[i]!.id.startsWith("scape.phone")) log.push(`${k}:${d.shots[i]!.id}`)
    }
    const rings = log.filter((e) => e.endsWith("ring"))
    expect(rings.length).toBeGreaterThanOrEqual(2)
    expect(log.filter((e) => e.endsWith("machine")).length).toBe(1)
    // Nothing rings after somebody reached it.
    const reached = 60
    expect(rings.every((e) => Number(e.split(":")[0]) <= reached)).toBe(true)
    // With the radio man's cellar in the run, the message repeats his number instead.
    const d2 = new ScapeDirector()
    const counted: string[] = []
    t = 7000
    hour = 2.98
    for (let k = 0; k < 120; k++, t += 0.25, hour += 0.25 / 120) {
      const me = k < 60 ? far : { x: phone.x + 1, y: phone.y + 1 }
      d2.step(input(town, { time: t, hour, absHour: 24 + hour, listener: me, survivors: [me], machineCount: 4 }), levels())
      for (let i = 0; i < d2.shotCount; i++) if (d2.shots[i]!.id.startsWith("scape.phone.machine")) counted.push(d2.shots[i]!.id)
    }
    expect(counted).toEqual(["scape.phone.machine.4"])
  })

  test("music boxes play once a night, when somebody first steps inside", () => {
    for (let seed = 1; seed < 300; seed++) {
      const t = makeTown(seed)
      const b = t.buildings.find((x) => housePlan(t, x).musicBox)
      if (!b) continue
      const [x0, y0, x1, y1] = b.rect
      const inside = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
      const outside = { x: x0 - 6, y: y0 - 6 }
      const d = new ScapeDirector()
      const count = (who: { x: number; y: number }, from: number, absHour: number) => {
        let n = 0
        for (let k = 0; k < 40; k++) {
          d.step(input(t, { time: from + k * 0.25, absHour, hour: 23, listener: who, survivors: [who] }), levels())
          for (let i = 0; i < d.shotCount; i++) if (d.shots[i]!.id === "scape.musicbox") n++
        }
        return n
      }
      expect(count(outside, 100, 23)).toBe(0)
      expect(count(inside, 200, 23)).toBe(1)
      expect(count(outside, 300, 23)).toBe(0)
      expect(count(inside, 400, 23)).toBe(0)
      expect(count(inside, 500, 47)).toBe(1)
      return
    }
    throw new Error("no music box in 300 towns")
  })

  test("the church bell strikes the hour, and thirteen at midnight on the third night", () => {
    const t = { ...town, buildings: [...town.buildings, { id: "church-x", kind: "house" as const, archetype: "church", rect: [60, 80, 72, 96] as const as unknown as [number, number, number, number], color: 0 }] }
    const strikes = (absHour: number, from: number, to: number) => {
      const d = new ScapeDirector()
      let n = 0
      let time = 100
      for (let h = from; h < to; h += 0.01, time += 0.25) {
        d.step(input(t, { time, hour: h % 24, absHour: absHour + (h - from), listener: { x: 50, y: 80 } }), levels())
        for (let i = 0; i < d.shotCount; i++) if (d.shots[i]!.id === "scape.church.bell") n++
      }
      // Deferred strikes keep coming after the hour; flush them.
      for (let k = 0; k < 200; k++, time += 0.25) {
        d.step(input(t, { time, hour: to % 24, absHour: absHour + (to - from), listener: { x: 50, y: 80 } }), levels())
        for (let i = 0; i < d.shotCount; i++) if (d.shots[i]!.id === "scape.church.bell") n++
      }
      return n
    }
    expect(strikes(21.9, 21.9, 22.1)).toBe(10)
    expect(strikes(23.9, 23.9, 24.1)).toBe(12)
    expect(strikes(71.9, 23.9, 24.1)).toBe(13)
  })

  test("smoke alarms chirp for three nights, then their batteries are dead; dispatch stops calling after it", () => {
    const chirps = (absHour: number) => {
      let n = 0
      for (let seed = 1; seed < 40; seed++) {
        const t = makeTown(seed)
        const b = t.buildings.find((x) => housePlan(t, x).smoke)
        if (!b) continue
        const p = housePlan(t, b).smoke!
        n += run(new ScapeDirector(), t, 100, 150, { listener: { x: p.x, y: p.y }, absHour, hour: absHour % 24 }, levels(), 0.5).shots.filter((s) => s.id === "scape.smoke.chirp").length
      }
      return n
    }
    expect(chirps(23)).toBeGreaterThan(0)
    expect(chirps(100)).toBe(0)
    expect(RADIO_CHANCE[1]!).toBeGreaterThan(RADIO_CHANCE[2]!)
    expect(RADIO_CHANCE[2]!).toBeGreaterThan(RADIO_CHANCE[3]!)
    expect(RADIO_CHANCE.length).toBe(4)
  })

  test("insects by day only, birds at dawn (more each night), an owl only after the first night, gutters only after rain", () => {
    const day = run(new ScapeDirector(), town, 100, 30, { hour: 13, absHour: 37 })
    const night = run(new ScapeDirector(), town, 100, 30, { hour: 23, absHour: 23 })
    if (day.holds.size) expect(night.holds.has("scape.insects")).toBe(false)
    const owls = (absHour: number) => run(new ScapeDirector(), town, 9000, 1200, { hour: 1, absHour }, levels(), 1).shots.filter((s) => s.id === "scape.owl").length
    expect(owls(25)).toBe(0)
    expect(owls(49)).toBeGreaterThan(0)
    const birds = (absHour: number) => run(new ScapeDirector(), town, 100, 300, { hour: 6, absHour, listener: { x: 30, y: 44 } }, levels(), 0.5).shots.filter((s) => s.id.startsWith("scape.bird")).length
    expect(birds(30)).toBeGreaterThan(0)
    expect(birds(102)).toBeGreaterThan(birds(30))
    expect(run(new ScapeDirector(), town, 100, 300, { hour: 23, absHour: 23, listener: { x: 30, y: 44 } }, levels(), 0.5).shots.filter((s) => s.id.startsWith("scape.bird")).length).toBe(0)
    const dry = run(new ScapeDirector(), town, 100, 60, { listener: { x: 21, y: 37 }, wetness: 0 }).shots.filter((s) => s.id === "scape.gutter.drip")
    const after = run(new ScapeDirector(), town, 100, 60, { listener: { x: 21, y: 37 }, wetness: 0.8, rain: 0 }).shots.filter((s) => s.id === "scape.gutter.drip")
    expect(dry.length).toBe(0)
    expect(after.length).toBeGreaterThan(0)
  })

  test("the clock that keeps the night: game hours count on a co-op client that only sees the hour", () => {
    const h = new ScapeHours()
    let abs = 0
    for (let hour = 17.5, k = 0; k < 2000; k++, hour = (hour + 0.02) % 24) abs = h.update(hour, 0, 17.5)
    expect(abs).toBeCloseTo(17.5 + 0.02 * 1999, 1)
    expect(nightOf(abs)).toBe(2)
    expect(new ScapeHours().update(5, 30, 17.5)).toBe(47.5)
  })
})

describe("ambient hooks for other features", () => {
  test("calls reach the soundscape once; holds last while refreshed", () => {
    playAmbientSound("scape.phone.ring", 3, 4, { gain: 0.5 })
    holdAmbientSound("tv:1", "scape.fridge.hum", 1, 2)
    const shots: string[] = []
    const holds: string[] = []
    drainAmbientCalls((c) => shots.push(`${c.id}@${c.x},${c.y}x${c.gain}`), (h) => holds.push(h.key))
    expect(shots).toEqual(["scape.phone.ring@3,4x0.5"])
    expect(holds).toEqual(["tv:1"])
    shots.length = holds.length = 0
    // Not refreshed this frame: still held (the caller may run after the soundscape)…
    drainAmbientCalls((c) => shots.push(c.id), (h) => holds.push(h.key))
    expect(shots).toEqual([])
    expect(holds).toEqual(["tv:1"])
    holds.length = 0
    // …but gone once it has missed two frames.
    drainAmbientCalls(() => {}, (h) => holds.push(h.key))
    drainAmbientCalls(() => {}, (h) => holds.push(h.key))
    expect(holds).toEqual([])
  })
})

describe("life sounds (AR-87 touches through the soundscape hooks)", () => {
  const s = { ...DEFAULT_DETAIL_SETTINGS, lfLaundry: 1, lfSprinkler: true }
  const town = makeTown(7)

  test("the dawn sprinkler ticks while its timer runs, quieter as the pressure falls, and not on night 5", () => {
    // Town 1 has a sprinkler in one of its yards.
    const yard = makeTown(1)
    const k = placeSprinklers(yard, s)[0]
    expect(k).toBeDefined()
    const heard = (night: number, hour: number) => {
      const life = new LifeSounds()
      drainAmbientCalls(() => {}, () => {})
      life.update({ time: 10, town: yard, hour, night }, s, 0, [], { x: k!.x + 3, y: k!.z })
      let gain = 0
      drainAmbientCalls(() => {}, (h) => {
        if (h.id === "scape.sprinkler") gain = Math.max(gain, h.gain)
      })
      return gain
    }
    expect(heard(1, 6.9)).toBeGreaterThan(0.9)
    expect(heard(3, 6.9)).toBeLessThan(heard(1, 6.9))
    expect(heard(3, 6.9)).toBeGreaterThan(0)
    expect(heard(5, 6.9)).toBe(0)
    expect(heard(1, 8)).toBe(0)
  })

  test("washing snaps on gusts, now and then, and only near the line", () => {
    const life = new LifeSounds()
    drainAmbientCalls(() => {}, () => {})
    const line = town.buildings.map((b) => placeLaundry(town, b, s)).find(Boolean)!
    let near = 0
    let far = 0
    for (let t = 0; t < 120; t += 1 / 30) {
      life.update({ time: t, town, hour: 15, night: 1 }, s, 0.3, [], { x: line.x + 2, y: line.z })
      drainAmbientCalls((c) => c.id === "scape.washing.flap" && near++, () => {})
    }
    for (let t = 0; t < 60; t += 1 / 30) {
      life.update({ time: t, town, hour: 15, night: 1 }, { ...s, lfLaundry: 0 }, 0.3, [], { x: line.x + 2, y: line.z })
      drainAmbientCalls((c) => c.id === "scape.washing.flap" && far++, () => {})
    }
    // A snap every few seconds, never more often than the gap allows.
    expect(near).toBeGreaterThan(8)
    expect(near).toBeLessThan(120 / 1.4)
    expect(far).toBe(0)
  })

  test("a car left open chimes until its battery is flat, sagging in pitch; shut or driven off, it stops", () => {
    const car = { id: 4, kind: "sedan", x: 10, y: 10, h: 0, spawnX: 10, spawnY: 10, wreck: false, seats: [""], spec: { length: 4.4, width: 1.8 } }
    const chime = (night: number, over: Partial<typeof car> = {}) => {
      const life = new LifeSounds()
      drainAmbientCalls(() => {}, () => {})
      let rate = 0
      for (let t = 0; t < 20; t += 0.5) {
        life.update({ time: t, town, hour: 22, night }, { ...s, lfOpenDoors: 1 }, 0, [{ ...car, ...over }], { x: 12, y: 10 })
        drainAmbientCalls(() => {}, (h) => {
          if (h.id === "scape.car.chime") rate = h.rate
        })
      }
      return rate
    }
    expect(chime(1)).toBe(1)
    expect(chime(2)).toBeLessThan(1)
    expect(chime(2)).toBeGreaterThan(0)
    expect(chime(4)).toBe(0)
    expect(chime(1, { seats: ["p1"] })).toBe(0)
    expect(chime(1, { x: 14 })).toBe(0)
  })

  test("animals bolting from their dens are heard; the watcher is not", () => {
    const life = new LifeSounds()
    drainAmbientCalls(() => {}, () => {})
    for (const kind of ["raccoon", "cat", "fox", "deer", "watcher"] as const) life.bolt(1, 2, kind)
    const ids: string[] = []
    drainAmbientCalls((c) => ids.push(c.id), () => {})
    expect(ids).toEqual(["scape.life.rustle", "scape.life.rustle", "scape.life.scurry", "scape.life.hooves"])
  })
})
