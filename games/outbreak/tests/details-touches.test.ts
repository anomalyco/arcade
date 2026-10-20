import { describe, expect, test } from "bun:test"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { inBuildingFootprint, type Town } from "../shared/map"
import { LocalSession } from "../shared/session"
import { Breath, BREATH_LIFE } from "../src/details/breath"
import { AnimalEyes, BOLT_TIME, DEN_RETURN, placeDens, SPECIES, type AnimalDen, type EyeFrame } from "../src/details/eyeshine"
import { BeamProbe } from "../src/details/light-probe"
import { DEFAULT_DETAIL_SETTINGS } from "../src/details/settings"
import { mothLamps, writeFlies, writeMoths, type FlySite } from "../src/details/swarms"
import { LifeTouches, type TouchFrame } from "../src/details/touches"

const session = () => {
  const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
  s.view.player.x = 44
  s.view.player.y = 150
  s.rebuildCollision()
  return s
}

/** One torch at (x, z) pointing along `aim`, in slot 1 of a light array. */
function torch(x: number, z: number, aim: number, range = 14): Float32Array {
  const L = new Float32Array(4 * LIGHT_FLOATS)
  const k = LIGHT_FLOATS
  L.set([x, 1.3, z, range, 1, 0.86, 0.68, 1, Math.cos(aim), Math.sin(aim), Math.cos((56 * Math.PI) / 360), 2], k)
  return L
}

const sprites = (n = 256) => new Float32Array(n * SPRITE_FLOATS)
const view = [-100, -100, 400, 400] as const

describe("beam probe", () => {
  test("lights the cone out to its range and nothing beside, behind or past it", () => {
    const p = new BeamProbe()
    p.set(torch(0, 0, 0), 1, 2)
    expect(p.at(4, 0, 0)).toBeGreaterThan(0.4)
    expect(p.at(12, 0, 0)).toBeGreaterThan(0.05)
    expect(p.at(4, 0, 0)).toBeGreaterThan(p.at(12, 0, 0))
    expect(p.at(0, 0, 4)).toBe(0)
    expect(p.at(-4, 0, 0)).toBe(0)
    expect(p.at(15, 0, 0)).toBe(0)
    p.set(torch(0, 0, 0), 1, 1)
    expect(p.at(4, 0, 0)).toBe(0)
  })
})

describe("moths and flies", () => {
  test("moths gather at street lamps, porch lanterns and lit windows, never room lamps, seeded from the town", () => {
    const t = session().view.town
    const a = mothLamps(t.lamps, t.seed, 1)
    expect(a).toEqual(mothLamps(t.lamps, t.seed, 1))
    expect(a.length).toBeGreaterThan(0)
    for (const m of a) expect(t.lamps[m.lamp]!.kind).not.toBe("room")
    expect(mothLamps(t.lamps, t.seed, 0)).toEqual([])
  })

  test("they only fly while their lamp is lit, close round the fixture, and glow without darkening the colour mask", () => {
    const t = session().view.town
    const lamps = mothLamps(t.lamps, t.seed, 1)
    const power = new Float32Array(256)
    const buf = sprites(512)
    expect(writeMoths(lamps, power, 10, view, buf, 0, 1)).toBe(0)
    power.fill(1)
    const n = writeMoths(lamps, power, 10, view, buf, 0, 1)
    expect(n).toBe(lamps.reduce((s, m) => s + m.n, 0))
    for (let i = 0, j = 0; i < lamps.length; i++) {
      for (let k = 0; k < lamps[i]!.n; k++, j++) {
        const o = j * SPRITE_FLOATS
        expect(Math.hypot(buf[o]! - lamps[i]!.x, buf[o + 2]! - lamps[i]!.z)).toBeLessThan(0.8)
        expect(Math.abs(buf[o + 1]! - lamps[i]!.y)).toBeLessThan(0.4)
        expect(buf[o + 7]!).toBeLessThanOrEqual(0.25)
      }
    }
  })

  test("flies show only where something lights them", () => {
    const site: FlySite = { key: "b", store: "", x: 5, y: 0, z: 5, n: 6, seed: 3, spread: 0.4 }
    const buf = sprites()
    expect(writeFlies([site], () => 0, 1, view, buf, 0)).toBe(0)
    const n = writeFlies([site], () => 1, 1, view, buf, 0)
    expect(n).toBe(6)
    for (let i = 0; i < n; i++) {
      const o = i * SPRITE_FLOATS
      expect(Math.hypot(buf[o]! - 5, buf[o + 2]! - 5)).toBeLessThan(0.6)
      expect(buf[o + 4]!).toBeLessThan(0.05)
    }
  })
})

const den = (kind: AnimalDen["kind"]): AnimalDen => ({ key: kind, kind, x: 10, z: 0, seed: 1234 })

function eyeFrame(over: Partial<EyeFrame> & { probe?: BeamProbe } = {}): EyeFrame {
  const probe = over.probe ?? new BeamProbe()
  return {
    dt: 1 / 60,
    time: 0,
    darkness: 1,
    night: 1,
    survivors: [{ x: 0, y: 0 }],
    noises: [],
    beam: (x, y, z) => probe.at(x, y, z),
    beamFrom: { x: 0, z: 0 },
    ...over,
  }
}

const flat = { buildings: [], props: [], seed: 7, houseSeed: 7, terrain: 0, foliageDensity: 0, chunks: [], barriers: [], doors: [], windows: [], lamps: [] } as unknown as Town

describe("eyes under the trees", () => {
  test("dens sit at yard trees away from buildings and roads, the same every time; off places none", () => {
    const t = session().view.town
    const s = { ...DEFAULT_DETAIL_SETTINGS, lfEyeshine: 2 }
    const a = placeDens(t, s)
    expect(a).toEqual(placeDens(t, s))
    for (const d of a) for (const b of t.buildings) expect(inBuildingFootprint(b, d.x, d.z)).toBe(false)
    expect(a.filter((d) => d.kind === "watcher").length).toBeLessThanOrEqual(1)
    expect(placeDens(t, { ...s, lifeTouches: false })).toEqual([])
  })

  test("caught in the beam the eyes shine, hold a moment, then the animal bolts and is gone until nobody is near", () => {
    const eyes = new AnimalEyes()
    let bolts = 0
    eyes.onBolt = () => bolts++
    eyes.setDens("k", [den("fox")])
    const probe = new BeamProbe()
    const lit = torch(0, 0, 0)
    const dark = torch(0, 0, Math.PI)
    probe.set(dark, 1, 2)
    let f = eyeFrame({ probe })
    expect(eyes.write(f, flat, view, sprites(), 0, 1)).toBe(0)
    probe.set(lit, 1, 2)
    let t = 0
    // A blink can land on any frame, so look over a short window.
    let drawn = 0
    for (let i = 0; i < 6; i++) drawn = Math.max(drawn, eyes.write(eyeFrame({ probe, time: (t += 0.05) }), flat, view, sprites(), 0, 1))
    expect(drawn).toBe(2)
    for (; t < SPECIES.fox.holdMax + BOLT_TIME + 0.5; t += 1 / 60) eyes.step(eyeFrame({ probe, time: t }))
    expect(bolts).toBe(1)
    expect(eyes.modeOf("fox")).toBe("gone")
    expect(eyes.write(eyeFrame({ probe, time: t }), flat, view, sprites(), 0, 1)).toBe(0)
    f = eyeFrame({ probe: new BeamProbe(), time: t + DEN_RETURN * 2.1, survivors: [{ x: 9, y: 0 }] })
    eyes.step(f)
    expect(eyes.modeOf("fox")).toBe("gone")
    eyes.step({ ...f, survivors: [{ x: 60, y: 0 }] })
    expect(eyes.modeOf("fox")).toBe("here")
  })

  test("someone walking up or a gunshot sends them off without the light", () => {
    const a = new AnimalEyes()
    a.setDens("k", [den("raccoon")])
    a.step(eyeFrame({ survivors: [{ x: 7, y: 0 }] }))
    expect(a.modeOf("raccoon")).toBe("bolting")
    const b = new AnimalEyes()
    b.setDens("k", [den("deer")])
    b.step(eyeFrame({ survivors: [{ x: 40, y: 0 }], noises: [{ x: 20, y: 0, radius: 30, kind: "gunshot" }] }))
    expect(b.modeOf("deer")).toBe("bolting")
  })

  test("the watcher waits for the second night, does not run from the light, and is gone when you get close", () => {
    const eyes = new AnimalEyes()
    eyes.setDens("k", [den("watcher")])
    const probe = new BeamProbe()
    probe.set(torch(0, 0, 0), 1, 2)
    const at = (time: number, night: number, survivors = [{ x: 0, y: 0 }]) => eyeFrame({ probe, time, night, survivors })
    expect(eyes.write(at(1, 1), flat, view, sprites(), 0, 1)).toBe(0)
    let shown = 0
    for (let t = 0; t < 30; t += 1 / 30) {
      eyes.step(at(t, 2))
      shown = Math.max(shown, eyes.write(at(t, 2), flat, view, sprites(), 0, 1))
    }
    expect(shown).toBe(2)
    expect(eyes.modeOf("watcher")).toBe("here")
    eyes.step(at(31, 2, [{ x: 2, y: 0 }]))
    expect(eyes.modeOf("watcher")).toBe("gone")
    eyes.step(at(400, 2, [{ x: 60, y: 0 }]))
    expect(eyes.modeOf("watcher")).toBe("gone")
    eyes.newNight()
    eyes.step(at(401, 3, [{ x: 60, y: 0 }]))
    expect(eyes.modeOf("watcher")).toBe("here")
  })
})

describe("breath", () => {
  const me = (x = 0, inside = false) => [{ id: "a", x, y: 0, aim: 0, inside, driving: false, ground: 0 }]

  test("in the cold, outdoors, survivors breathe out puffs that are seen only in light and gone after their life", () => {
    const b = new Breath()
    for (let t = 0; t < 8; t += 1 / 60) b.step(1 / 60, t, 1, me())
    const probe = new BeamProbe()
    probe.set(torch(-0.1, 0, 0), 1, 2)
    expect(b.write(probe, sprites(), 0, 1)).toBeGreaterThan(0)
    const dark = new BeamProbe()
    expect(b.write(dark, sprites(), 0, 1)).toBe(0)
    for (let t = 8; t < 8 + BREATH_LIFE + 0.1; t += 1 / 60) b.step(1 / 60, t, 0, me())
    expect(b.write(probe, sprites(), 0, 1)).toBe(0)
  })

  test("no breath when it is warm or indoors, and quicker breaths when running", () => {
    const warm = new Breath()
    for (let t = 0; t < 10; t += 1 / 60) warm.step(1 / 60, t, 0, me())
    expect(warm.alive).toBe(0)
    const indoors = new Breath()
    const probe = new BeamProbe()
    probe.set(torch(-0.1, 0, 0), 1, 2)
    for (let t = 0; t < 10; t += 1 / 60) indoors.step(1 / 60, t, 1, me(0, true))
    expect(indoors.write(probe, sprites(), 0, 1)).toBe(0)
    const count = (speed: number) => {
      const b = new Breath()
      for (let t = 0, x = 0; t < 30; t += 1 / 60, x += speed / 60) b.step(1 / 60, t, 1, me(x))
      return b.breaths
    }
    expect(count(6)).toBeGreaterThan(count(0))
  })
})

describe("life touches", () => {
  test("off draws nothing and leaves the counts alone; on at night with a torch, the touches draw", () => {
    const s = session()
    const town = s.view.town
    const lampPower = new Float32Array(256).fill(1)
    const frame: TouchFrame = {
      dt: 1 / 60,
      time: 5,
      town,
      darkness: 1,
      sun: 0,
      night: 2,
      view: [0, 96, 96, 192],
      lights: torch(s.view.player.x, s.view.player.y, 0),
      beamFrom: 1,
      beamTo: 2,
      lampPower,
      survivors: s.sim.slots,
      noises: [],
      vision: { visible: () => true },
      ledger: s.sim.progression.ledger,
    }
    const life = new LifeTouches()
    const out = { alpha: 0, add: 0 }
    life.write(frame, { ...DEFAULT_DETAIL_SETTINGS, lifeTouches: false }, [], sprites(), 3, sprites(), 4, out)
    expect(out).toEqual({ alpha: 3, add: 4 })
    life.write(frame, DEFAULT_DETAIL_SETTINGS, [], sprites(1024), 3, sprites(1024), 4, out)
    expect(out.add).toBeGreaterThan(4)
    expect(life.shown.moths).toBeGreaterThan(0)
  })
})
