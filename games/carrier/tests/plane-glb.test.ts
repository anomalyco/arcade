import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseGlb } from "../src/dev/glb"
import { FLOATS_PER_VERT } from "../src/render/mesh"
import { ACCENT, ACCENT_FIN_Y, ACCENT_RAIL_X, MODEL_SPECS, type PlaneModel, buildPlaneModel } from "../src/render/plane-glb"
import { NO_TEAM, teamColor } from "../src/render/team"
import { TEAM_COLORS, teamCss } from "../shared/crew"
import { VEHICLES, VEHICLE_KINDS, type VehicleKind } from "../shared/vehicles"

const load = (name: string) => {
  const file = readFileSync(join(import.meta.dir, `../art/${name}.glb`))
  return parseGlb(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer)
}
const glb = load("hornet")
const model = buildPlaneModel(glb, "hornet")
const models = Object.fromEntries(VEHICLE_KINDS.map((k) => [k, k === "hornet" ? model : buildPlaneModel(load(k), k)])) as Record<VehicleKind, PlaneModel>
const f35 = models.f35
const verts = (v: number[]) => Array.from({ length: v.length / FLOATS_PER_VERT }, (_, i) => v.slice(i * FLOATS_PER_VERT, (i + 1) * FLOATS_PER_VERT))

/** Triangle area sum, for checking the accent split changes no geometry. */
function area(v: number[]): number {
  let s = 0
  for (let i = 0; i + 3 * FLOATS_PER_VERT <= v.length; i += 3 * FLOATS_PER_VERT) {
    const a = v.slice(i, i + 3)
    const b = v.slice(i + FLOATS_PER_VERT, i + FLOATS_PER_VERT + 3)
    const c = v.slice(i + 2 * FLOATS_PER_VERT, i + 2 * FLOATS_PER_VERT + 3)
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
    s += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2
  }
  return s
}

describe("GLB hornet with team accents", () => {
  test("loads the Blender jet unchanged: its size, its surface area, its stabiliser pivots", () => {
    let x = 0
    let y = 0
    for (const v of verts(model.body)) {
      x = Math.max(x, Math.abs(v[0]!))
      y = Math.max(y, v[1]!)
    }
    expect(x).toBeCloseTo(7, 1)
    expect(y).toBeCloseTo(4.71, 1)
    let raw = 0
    for (const n of glb.nodes)
      if (!/stab|canopy|tailhook/i.test(n.name))
        for (const p of n.prims) {
          const v: number[] = []
          for (let i = 0; i < p.positions.length; i += 3) v.push(p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!, 0, 0, 0, 0, 0, 0, 0, 0)
          raw += area(v)
        }
    expect(area(model.body)).toBeCloseTo(raw, 3)
    expect(model.stabL.pivot).toEqual([1.28, 1.069, -6.354].map((v) => expect.closeTo(v, 3)) as never)
  })

  test("accent faces sit on both fin tops and both rails, symmetric left and right", () => {
    const accent = verts(model.body).filter((v) => Math.round(v[9]!) === ACCENT)
    expect(accent.length).toBeGreaterThan(20)
    for (const v of accent) expect(v[1]! >= ACCENT_FIN_Y - 1e-4 || Math.abs(v[0]!) > ACCENT_RAIL_X).toBe(true)
    const fin = (s: number) => accent.filter((v) => v[1]! > ACCENT_FIN_Y - 1e-4 && Math.sign(v[0]!) === s).length
    const rail = (s: number) => accent.filter((v) => Math.abs(v[0]!) > ACCENT_RAIL_X && Math.sign(v[0]!) === s).length
    expect(fin(1)).toBeGreaterThan(0)
    expect(fin(1)).toBe(fin(-1))
    expect(rail(1)).toBeGreaterThan(0)
    expect(rail(1)).toBe(rail(-1))
    expect(verts(model.canopy).some((v) => Math.round(v[9]!) === ACCENT)).toBe(false)
  })

  test("team colours come from TEAM_COLORS, one per carrier, linear, with a neutral fallback", () => {
    const h = Number.parseInt(teamCss(0).slice(1), 16)
    expect(teamColor(0)[0]).toBeCloseTo((((h >> 16) & 255) / 255) ** 2.2, 6)
    expect(new Set(TEAM_COLORS.map((_, t) => teamColor(t).join())).size).toBe(TEAM_COLORS.length)
    expect(teamColor(undefined)).toBe(NO_TEAM)
    expect(teamColor(TEAM_COLORS.length)).toBe(NO_TEAM)
  })
})

describe("the jet model registry", () => {
  test("has a model for every vehicle type, with its own engines, gear and anchors", () => {
    for (const k of VEHICLE_KINDS) {
      const m = models[k]
      expect(m.kind).toBe(k)
      expect(m.body.length).toBeGreaterThan(1000 * FLOATS_PER_VERT)
      expect(m.canopy.length).toBeGreaterThan(0)
      expect(m.stabL.verts.length).toBeGreaterThan(0)
      expect(m.stabR.verts.length).toBeGreaterThan(0)
      expect(m.hook.verts.length).toBeGreaterThan(0)
      expect(m.nozzles).toHaveLength(VEHICLES[k].engines)
      expect(m.centre).toBe(VEHICLES[k].flight.centre)
      expect(m.tips).toHaveLength(2)
      expect(m.fins).toHaveLength(2)
      expect(m.fins[0]![0]).toBeGreaterThan(0)
      expect(m.fins[0]![0]).toBeCloseTo(-m.fins[1]![0], 2)
      expect(m.fins[0]![1]).toBeCloseTo(m.fins[1]![1], 2)
      // The gear reaches the deck: its lowest point is the belly height below the model origin.
      let low = Infinity
      for (const v of verts(m.gear)) low = Math.min(low, v[1]!)
      expect(low).toBeCloseTo(-VEHICLES[k].gear, 2)
    }
    expect(models.hornet.stores).toHaveLength(0)
    expect(models.hornet.doorL).toBeNull()
  })

  test("the F-35C: its real size, a bay with two doors and four bombs in release order", () => {
    let x = 0
    let y = 0
    for (const v of verts(f35.body)) {
      x = Math.max(x, Math.abs(v[0]!))
      y = Math.max(y, v[1]!)
    }
    expect(x).toBeCloseTo(6.55, 1)
    expect(y).toBeCloseTo(3.51, 1)
    expect(f35.doorL && f35.doorR).toBeTruthy()
    expect(f35.doorL!.pivot[0]).toBeCloseTo(0.653, 3)
    expect(f35.doorR!.pivot[0]).toBeCloseTo(-0.653, 3)
    expect(f35.stores.map((s) => s.pivot.map((v) => Math.round(v * 100) / 100))).toEqual([
      [0.36, 0.46, 0.02],
      [-0.36, 0.46, 0.02],
      [3.45, 0.94, -1.83],
      [-3.45, 0.94, -1.83],
    ])
    // The weapons' bomb stations are these nodes, in the jet's body frame (from its centre).
    VEHICLES.f35.bombs.forEach((b, i) => {
      const p = f35.stores[i]!.pivot
      expect(b[0]).toBeCloseTo(p[0], 3)
      expect(b[1] + f35.centre).toBeCloseTo(p[1], 3)
      expect(b[2]).toBeCloseTo(p[2], 3)
    })
  })

  test("opened, the bay doors swing their inner edges down; lowered, each hook swings down below the belly", () => {
    const rotZ = (p: number[], a: number) => [p[0]! * Math.cos(a) - p[1]! * Math.sin(a), p[0]! * Math.sin(a) + p[1]! * Math.cos(a)]
    for (const [d, a] of [[f35.doorL!, f35.doorOpen], [f35.doorR!, -f35.doorOpen]] as const) {
      let lowest = 0
      for (const v of verts(d.verts)) lowest = Math.min(lowest, rotZ(v, a)[1]! + d.pivot[1])
      expect(lowest).toBeLessThan(-0.4)
    }
    for (const m of Object.values(models)) {
      let lowest = Infinity
      // Rotation about +X by the down angle: y' = y cos a − z sin a.
      for (const v of verts(m.hook.verts)) lowest = Math.min(lowest, v[1]! * Math.cos(m.hookDown) - v[2]! * Math.sin(m.hookDown) + m.hook.pivot[1])
      expect(lowest).toBeLessThan(-0.5)
    }
  })

  test("the F-35C's team accent is its own accent material: fin caps and wingtip strips, mirror-symmetric", () => {
    expect(MODEL_SPECS.f35.accent).toBe("F35_accent")
    const accent = verts(f35.body).filter((v) => Math.round(v[9]!) === ACCENT)
    expect(accent.length).toBeGreaterThan(20)
    const key = (v: number[], s: number) => [s * v[0]!, v[1]!, v[2]!].map((c) => Math.round(c * 1000)).join(",")
    const right = new Set(accent.filter((v) => v[0]! < 0).map((v) => key(v, -1)))
    const left = accent.filter((v) => v[0]! > 0)
    expect(left.length).toBe(accent.length - left.length)
    for (const v of left) expect(right.has(key(v, 1))).toBe(true)
    // Fin tops and wingtips only.
    for (const v of accent) expect(v[1]! > 2.6 || Math.abs(v[0]!) > 5.8).toBe(true)
    expect(verts(f35.canopy).some((v) => Math.round(v[9]!) === ACCENT)).toBe(false)
  })
})
