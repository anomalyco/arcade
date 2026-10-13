import { expect, test } from "bun:test"
import { getMap } from "../shared/maps"
import { MAX_LIGHTS } from "../shared/config"
import { LIGHT_FLOATS, LightCuller } from "../src/render/lighting"
import { buildProp, deskMonitorLights } from "../src/render/models"
import { FLOATS_PER_VERT, MAT, Mesh } from "../src/render/mesh"

test("every monitor light matches an emissive screen in the generated desk geometry", () => {
  const map = getMap("office", 1)
  const screens: { x: number; y: number }[] = []
  map.props.forEach((prop, i) => {
    if (prop.kind !== "desk") return
    const mesh = new Mesh()
    buildProp(mesh, prop, map.seed + i * 17)
    const vertices: { x: number; y: number }[] = []
    for (let j = 0; j < mesh.v.length; j += FLOATS_PER_VERT) {
      if (mesh.v[j + 9] === MAT.glow && mesh.v[j + 10] === 1.4) vertices.push({ x: mesh.v[j]!, y: mesh.v[j + 2]! })
    }
    for (let j = 0; j < vertices.length; j += 30) {
      const box = vertices.slice(j, j + 30) // Five faces; Mesh.box omits the underside.
      screens.push({ x: box.reduce((n, p) => n + p.x, 0) / box.length, y: box.reduce((n, p) => n + p.y, 0) / box.length })
    }
  })
  const lights = deskMonitorLights(map)
  expect(screens).toHaveLength(lights.length)
  for (let i = 0; i < lights.length; i++) expect(Math.hypot(screens[i]!.x - lights[i]!.x, screens[i]!.y - lights[i]!.y)).toBeLessThan(0.025)
})

test("monitors add no occluders or polar rows, including with dynamic lights", () => {
  const map = getMap("office", 1)
  const culler = new LightCuller()
  culler.setMap(map)
  const dyn = [{ x: 45, y: 4, h: 1.2, r: 7, color: [1, 0.7, 0.3] as const, power: 2, size: 0.05 }]
  const view = [38, 0, 53, 15] as const
  culler.update(view, 0, dyn, [{ x: 45, y: 5 }], false)
  const shadowRows = culler.shadowLightCount
  const occluders = culler.occ.slice(0, culler.occCount * 8)
  const base = culler.lights.slice(0, culler.lightCount * LIGHT_FLOATS)
  culler.update(view, 0, dyn, [{ x: 45, y: 5 }], true)
  expect(culler.shadowLightCount).toBe(shadowRows)
  expect(culler.occ.slice(0, culler.occCount * 8)).toEqual(occluders)
  expect(culler.lights.slice(0, base.length)).toEqual(base)
  expect(culler.monitorStart).toBe(base.length / LIGHT_FLOATS)
  expect(culler.lightCount).toBeGreaterThan(base.length / LIGHT_FLOATS)
  for (let i = 0; i < culler.lightCount; i++) {
    const offset = i * LIGHT_FLOATS
    expect(culler.lights[offset + 13]! > 0).toBe(i < shadowRows)
    if (culler.lights[offset + 15]! >= map.lights.length) {
      const x = culler.lights[offset]!, y = culler.lights[offset + 2]!, radius = culler.lights[offset + 3]!
      expect(radius).toBeCloseTo(1.65)
      expect(culler.monitorBounds[0]!).toBeLessThanOrEqual(x - radius)
      expect(culler.monitorBounds[1]!).toBeLessThanOrEqual(y - radius)
      expect(culler.monitorBounds[2]!).toBeGreaterThanOrEqual(x + radius)
      expect(culler.monitorBounds[3]!).toBeGreaterThanOrEqual(y + radius)
    }
  }
})

test("monitor layout is seeded, bounded and broken monitors drop only their direct light", () => {
  const map = getMap("office", 1)
  const monitors = deskMonitorLights(map)
  expect(monitors.length).toBeGreaterThan(0)
  expect(monitors).toEqual(deskMonitorLights(getMap("office", 1)))
  const culler = new LightCuller()
  culler.setMap(map)
  const view = [0, 0, ...map.size] as const
  culler.update(view, 0, [], [], true, monitors)
  for (let i = 0; i < culler.lightCount; i++) expect(culler.lights[i * LIGHT_FLOATS + 15]!).toBeLessThan(map.lights.length)
  culler.update(view, 0, Array.from({ length: MAX_LIGHTS }, () => ({ x: 10, y: 10, h: 1, r: 2, color: [1, 1, 1] as const, power: 1, size: 0.1 })), [])
  expect(culler.lightCount).toBeLessThanOrEqual(MAX_LIGHTS)
  expect(culler.shadowLightCount).toBeLessThanOrEqual(culler.lightCount)
})

test("live chair shadows and monitor intensity do not leak into the shadowless suffix", () => {
  const map = getMap("office", 1)
  const culler = new LightCuller()
  culler.setMap(map)
  const view = [0, 0, ...map.size] as const
  culler.update(view, 0, [], [])
  const withChairs = culler.occCount
  culler.setChairShadows(false)
  culler.update(view, 0, [], [])
  expect(culler.occCount).toBeLessThan(withChairs)
  culler.setChairShadows(true)
  culler.update(view, 0, [], [])
  expect(culler.occCount).toBe(withChairs)
  culler.monitorIntensity = 0
  culler.update(view, 0, [], [])
  expect(culler.lightCount).toBe(culler.monitorStart)
  culler.monitorIntensity = 2
  culler.update(view, 0, [], [])
  expect(culler.lightCount).toBeGreaterThan(culler.monitorStart)
  for (let i = culler.monitorStart; i < culler.lightCount; i++) {
    expect(culler.lights[i * LIGHT_FLOATS + 7]).toBeCloseTo(0.7)
    expect(culler.lights[i * LIGHT_FLOATS + 13]).toBe(0)
    expect(culler.lights[i * LIGHT_FLOATS + 11]).toBe(1)
  }
})
