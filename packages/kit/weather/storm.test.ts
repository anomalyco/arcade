import { expect, test } from "bun:test"
import { SPEED_OF_SOUND, STORM_STRIKE_DEFAULTS, StormStrikes, type ThunderEvent } from "./storm"

const eye = [0, 1.7, 0]

test("thunder arrives after the slant distance at the speed of sound", () => {
  const storm = new StormStrikes(3)
  storm.request({ kind: "ground", distance: 1000, bearing: 0.4 })
  const f = storm.step(1 / 60, STORM_STRIKE_DEFAULTS, eye, 0, 0)
  expect(f.thunder).toHaveLength(1)
  const t = f.thunder[0]!
  const [x, y, z] = t.position
  expect(Math.hypot(x - eye[0]!, y - 0, z - eye[2]!)).toBeCloseTo(t.distance, 0)
  expect(t.distance).toBeGreaterThan(1000)
  expect(t.arrives - t.emitted).toBeCloseTo(t.distance / SPEED_OF_SOUND, 6)
  // Nothing new on the next step: each thunder is emitted once.
  expect(storm.step(1 / 60, STORM_STRIKE_DEFAULTS, eye, 0, 0).thunder).toHaveLength(0)
})

test("a dark strike sends thunder but never lights the scene", () => {
  const storm = new StormStrikes(5)
  storm.request({ kind: "ground", distance: 400, dark: true })
  const heard: ThunderEvent[] = []
  let scene = 0
  for (let i = 0; i < 120; i++) {
    const f = storm.step(1 / 60, STORM_STRIKE_DEFAULTS, eye, 0, 0)
    heard.push(...f.thunder)
    scene = Math.max(scene, f.scene)
  }
  expect(heard).toHaveLength(1)
  expect(scene).toBe(0)
})

test("a near strike lights the scene from its direction; flashes off keeps only the thunder", () => {
  const lit = new StormStrikes(9), off = new StormStrikes(9)
  lit.request({ kind: "ground", distance: 350, bearing: 0 })
  off.request({ kind: "ground", distance: 350, bearing: 0 })
  let peak = 0, dir = [0, 0, 0], offScene = 0, offBolt = false, offThunder = 0
  for (let i = 0; i < 60; i++) {
    const a = lit.step(1 / 60, STORM_STRIKE_DEFAULTS, eye, 0, 0)
    if (a.scene > peak) { peak = a.scene; dir = [...a.dir] }
    const b = off.step(1 / 60, { ...STORM_STRIKE_DEFAULTS, flashes: "off" }, eye, 0, 0)
    offScene = Math.max(offScene, b.scene); offBolt ||= !!b.bolt; offThunder += b.thunder.length
  }
  expect(peak).toBeGreaterThan(0.3)
  // Bearing 0 is north (−z) and the light comes from above the horizon.
  expect(dir[2]).toBeLessThan(0)
  expect(dir[1]).toBeGreaterThan(0)
  expect(offScene).toBe(0)
  expect(offBolt).toBe(false)
  expect(offThunder).toBe(1)
})

test("on a shared clock two listeners see the same strikes from the same place, each hearing it after its own travel", () => {
  const settings = { ...STORM_STRIKE_DEFAULTS, rate: 6, near: 400, far: 3000 }
  const a = new StormStrikes(42), b = new StormStrikes(42)
  const eyeA = [0, 1.7, 0], eyeB = [120, 1.7, -60]
  const seen = (s: StormStrikes, eye: number[], start: number, view: number) => {
    const out: { at: number; position: number[]; arrives: number; distance: number }[] = []
    // Different frame rates, different start times and view directions: only the shared clock matters.
    let t = start
    const dt = start ? 1 / 45 : 1 / 60
    while (t < 300) {
      t += dt
      const f = s.step(dt, settings, eye, view, 0, { time: t, anchor: [10, 20] })
      for (const e of f.thunder) out.push({ at: Math.round(t - (f.time - e.emitted)), position: e.position.map((v) => Math.round(v)), arrives: e.arrives - f.time + t, distance: e.distance })
    }
    return out
  }
  const ha = seen(a, eyeA, 0, 0), hb = seen(b, eyeB, 0.01, 2).filter((h) => h.at > 1)
  expect(ha.length).toBeGreaterThan(10)
  expect(hb.map((h) => [h.at, h.position])).toEqual(ha.filter((h) => h.at > 1).map((h) => [h.at, h.position]))
  // Each hears it from its own place: thunder arrival differs by the difference in slant distance / 343.
  const [x, y] = [ha.find((h) => h.at > 1)!, hb[0]!]
  expect(y.arrives - x.arrives).toBeCloseTo((y.distance - x.distance) / SPEED_OF_SOUND, 1)
  // Never two within the gap.
  for (let i = 1; i < ha.length; i++) expect(ha[i]!.at - ha[i - 1]!.at).toBeGreaterThanOrEqual(6)
})
