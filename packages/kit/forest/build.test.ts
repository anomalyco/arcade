import { expect, test } from "bun:test"
import { demoForestWorld } from "../sim/forest-demo"
import { loadForestModels } from "./assets"
import { buildForest, clampedGridHeight, forestHeightGrid, INSTANCE_FLOATS, MAT, type ForestBuild } from "./build"
import { buildTransfers } from "./build-worker"
import { toHalf } from "./mesh"

const root = new URL("./assets/", import.meta.url).pathname
async function models() {
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try { return await loadForestModels(root) } finally { globalThis.fetch = fetch0 }
}

test("the build worker's world (the height grid, no height function) builds byte for byte the page's forest", async () => {
  const world = demoForestWorld(7, 60)
  const m = await models()
  const opts = { scatter: 1, fernDensity: 1, litter: 1, campDetail: true }
  const page = buildForest(world, m, opts)
  const ground = forestHeightGrid(world)
  const { height: _height, ...data } = world
  const worker = buildForest({ ...structuredClone(data), height: clampedGridHeight(ground) }, m, opts, structuredClone(ground))
  const bytes = (b: ForestBuild) => buildTransfers(b).map((x) => Buffer.from(x).toString("base64"))
  expect(bytes(worker)).toEqual(bytes(page))
  expect(worker.stats).toEqual(page.stats)
  expect(worker.logs).toEqual(page.logs)
  expect(worker.campLights).toEqual(page.campLights)
}, 30_000)

test("each chunk's cull box holds all of its static geometry, the dock and buildings that run past the cell included", async () => {
  const world = demoForestWorld(7, 20)
  const build = buildForest(world, await models(), { scatter: 0, fernDensity: 0, litter: 0, campDetail: true })
  const outside: string[] = []
  for (const c of build.chunks) for (const mesh of [c.near.opaque, c.near.masked, c.far.opaque, c.far.masked]) {
    const data = new DataView(mesh)
    for (let o = 0; o < data.byteLength; o += 32) {
      const p = [0, 4, 8].map(k => data.getFloat32(o + k, true))
      if (p.some((v, i) => v < c.bakedBox[i]! - 1e-3 || v > c.bakedBox[i + 3]! + 1e-3)) { outside.push(`${c.key}: ${p.map(v => v.toFixed(1))}`); break }
    }
  }
  expect(outside).toEqual([])
  for (const c of build.chunks) for (let i = 0; i < 3; i++) {
    expect(c.box[i]!).toBeLessThanOrEqual(c.bakedBox[i]!)
    expect(c.box[i + 3]!).toBeGreaterThanOrEqual(c.bakedBox[i + 3]!)
  }
}, 30_000)

test("each chunk's cull box holds its instances as vsTree places them: crowns, saplings and rocks past the cell", async () => {
  const world = demoForestWorld(7, 20)
  const build = buildForest(world, await models(), { scatter: 1, fernDensity: 1, litter: 1, campDetail: true })
  // Up to ~300 vertices of each template, trunk vertices flagged (bark at branch share 0 take the packed trunk scale).
  const samples = build.templates.map(t => {
    const out: { x: number; y: number; z: number; trunk: boolean }[] = []
    for (const m of [t.near, t.far]) if (m) for (const mesh of [m.opaque, m.masked]) {
      const data = new DataView(mesh), n = data.byteLength / 32, step = Math.max(1, Math.floor(n / 150))
      for (let v = 0; v < n; v += step) {
        const o = v * 32
        out.push({ x: data.getFloat32(o, true), y: data.getFloat32(o + 4, true), z: data.getFloat32(o + 8, true), trunk: data.getUint16(o + 20, true) === toHalf(MAT.bark) && data.getUint8(o + 18) === 0 })
      }
    }
    return out
  })
  const outside: string[] = []
  let past = 0, checked = 0
  for (const c of build.chunks) for (const g of c.groups) {
    const t = build.templates[g.template]!, grow = t.kind === "fern" ? 1.25 : 1
    for (let i = 0; i < g.data.length; i += INSTANCE_FLOATS) {
      const [x, y, z, yaw, sx, sy, , param] = g.data.subarray(i, i + INSTANCE_FLOATS)
      const co = Math.cos(yaw!), si = Math.sin(yaw!)
      for (const v of samples[g.template]!) {
        const s = (v.trunk && param! >= 1 ? Math.floor(param!) / 256 : sx!) * grow
        const p = [x! + v.x * s * co - v.z * s * si, y! + v.y * sy! * grow, z! + v.x * s * si + v.z * s * co]
        checked++
        if (p[0]! < c.x || p[0]! > c.x + 16 || p[2]! < c.z || p[2]! > c.z + 16) past++
        if (p.some((q, k) => q < c.box[k]! - 1e-3 || q > c.box[k + 3]! + 1e-3)) { outside.push(`${c.key} ${t.name}: ${p.map(q => q.toFixed(1))}`); break }
      }
    }
  }
  expect(outside.slice(0, 5)).toEqual([])
  // The case it covers: instance geometry reaching out of its cell.
  expect(past).toBeGreaterThan(checked * 0.01)
}, 60_000)

test("smooth trunk rings share normals across adjacent bands and the UV seam", async () => {
  const world = demoForestWorld(7, 20)
  const build = buildForest(world, await models(), { scatter: 0, fernDensity: 0, litter: 0, smoothTrunks: true })
  let checked = 0
  for (const template of build.templates.filter(t => t.kind === "tree")) {
    const data = new DataView(template.near.opaque), normals = new Map<string, string>()
    for (let o = 0; o < data.byteLength; o += 32) {
      if (data.getUint16(o + 20, true) !== toHalf(41) || data.getUint8(o + 18) !== 0) continue
      const key = [0, 4, 8].map(k => data.getFloat32(o + k, true).toFixed(5)).join(",")
      const normal = [12, 13, 14].map(k => data.getInt8(o + k)).join(",")
      if (normals.has(key)) { expect(normal).toBe(normals.get(key)!); checked++ }
      normals.set(key, normal)
    }
  }
  expect(checked).toBeGreaterThan(1000)
}, 30_000)
