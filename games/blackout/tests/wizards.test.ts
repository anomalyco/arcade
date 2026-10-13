import { expect, test } from "bun:test"
import { getMap } from "../shared/maps"
import { castleMap } from "../src/render/castle"
import { wizardModels } from "../src/render/wizard"
import { deskMonitorLights } from "../src/render/models"
import { Mesh } from "../src/render/mesh"

test("castle presentation preserves collision footprints and the source map", () => {
  const office = getMap("office", 1), saved = JSON.stringify(office)
  const castle = castleMap(office)
  expect(castle.walls).toBe(office.walls)
  expect(castle.spawns).toBe(office.spawns)
  expect(castle.props.map(({ rect, solid }) => ({ rect, solid }))).toEqual(office.props.map(({ rect, solid }) => ({ rect, solid })))
  expect(castle.lights.map((l) => l.id)).toEqual(office.lights.map((l) => l.id))
  expect(deskMonitorLights(castle)).toHaveLength(0)
  expect(JSON.stringify(office)).toBe(saved)
  const downtown = getMap("downtown", 1)
  expect(castleMap(downtown)).toBe(downtown)
})

test("wizard rig and pointed hat have finite nondegenerate surface normals", () => {
  const p = wizardModels()
  const meshes = Object.values(p).flatMap((m) => m instanceof Mesh ? [m] : Object.values(m))
  for (const m of meshes) for (let i = 0; i < m.v.length; i += 11) {
    expect(m.v.slice(i, i + 11).every(Number.isFinite)).toBe(true)
    expect(Math.hypot(m.v[i + 3]!, m.v[i + 4]!, m.v[i + 5]!)).toBeGreaterThan(0.9)
  }
})
