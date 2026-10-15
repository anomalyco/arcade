import { describe, expect, test } from "bun:test"
import { DEEP, MAX_ISLANDS, MIN_ISLANDS, SPAWN_CLEAR, archBlobs, archipelagoFor, coralAt, islandFootprint, makeArchipelago, terrainHeight, type Archipelago, type IslandKind } from "../shared/islands"
import { bakeSeabed, seabedAt } from "../shared/seabed"
import { Rng } from "../shared/rng"
import { buildIslandMesh, buildIslandProps, countTriangles, INSTANCE_FLOATS, TRI_BUDGET } from "../src/render/island-mesh"
import { VERT_BYTES } from "../src/render/mesh"

const SEEDS = [1, 7, 42, 95028, 0xdeadbeef]
const KINDS: IslandKind[] = ["cay", "jungle", "atoll", "stacks", "cliff", "volcanic"]

function hashBytes(buf: ArrayBuffer): number {
  const u = new Uint32Array(buf, 0, buf.byteLength >> 2)
  let h = 2166136261
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 16777619)
  return h >>> 0
}

function samplePoints(arch: Archipelago, n: number, seed: number): [number, number][] {
  const r = new Rng(seed)
  const [x0, z0, x1, z1] = arch.bounds
  return Array.from({ length: n }, () => [r.range(x0, x1), r.range(z0, z1)])
}

describe("archipelago", () => {
  test("is deterministic", () => {
    for (const seed of SEEDS) {
      const a = makeArchipelago(seed)
      const b = makeArchipelago(seed)
      expect(b).toEqual(a)
      for (const [x, z] of samplePoints(a, 2000, seed)) {
        expect(terrainHeight(b, x, z)).toBe(terrainHeight(a, x, z))
        expect(coralAt(b, x, z)).toBe(coralAt(a, x, z))
      }
    }
  })

  test("a shared archipelago is the generated one, reused per seed", () => {
    expect(archipelagoFor(7)).toEqual(makeArchipelago(7))
    expect(archipelagoFor(7)).toBe(archipelagoFor(7))
  })

  test("different seeds give different worlds", () => {
    const worlds = SEEDS.map((s) => archipelagoFor(s))
    for (let i = 0; i < worlds.length; i++) {
      for (let j = i + 1; j < worlds.length; j++) {
        expect(worlds[i]!.islands.map((k) => [k.x, k.z])).not.toEqual(worlds[j]!.islands.map((k) => [k.x, k.z]))
      }
    }
  })

  test("24-36 islands of all six kinds with a centrepiece, inside the bounds, not overlapping, in tight groups", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const arch = makeArchipelago(seed * 2654435761)
      expect(arch.islands.length).toBeGreaterThanOrEqual(MIN_ISLANDS)
      expect(arch.islands.length).toBeLessThanOrEqual(MAX_ISLANDS)
      expect(new Set(arch.islands.map((i) => i.kind))).toEqual(new Set(KINDS))
      // The first island is the centrepiece: a big volcano or jungle island, north of the spawn.
      const c = arch.islands[0]!
      expect(c.kind === "volcanic" || c.kind === "jungle").toBe(true)
      expect(c.radius).toBeGreaterThanOrEqual(c.kind === "volcanic" ? 380 : 300)
      expect(c.z).toBeLessThan(0)
      const [x0, z0, x1, z1] = arch.bounds
      expect((x0 + x1) / 2).toBe(0)
      expect((z0 + z1) / 2).toBe(0)
      const fps = arch.islands.map((i) => ({ i, ...islandFootprint(i, arch.seed) }))
      for (const { i, reach } of fps) {
        expect(i.x - reach).toBeGreaterThanOrEqual(x0)
        expect(i.x + reach).toBeLessThanOrEqual(x1)
        expect(i.z - reach).toBeGreaterThanOrEqual(z0)
        expect(i.z + reach).toBeLessThanOrEqual(z1)
        expect(i.peak).toBeLessThanOrEqual(570)
        if (i.kind === "volcanic") expect(i.peak).toBeGreaterThan(150)
        if (i.kind === "cay" || i.kind === "atoll") expect(i.peak).toBeLessThan(6)
      }
      let close = 0
      for (let a = 0; a < fps.length; a++) {
        let nearest = Infinity
        for (let b = 0; b < fps.length; b++) {
          if (a === b) continue
          const p = fps[a]!
          const q = fps[b]!
          const gap = Math.hypot(p.i.x - q.i.x, p.i.z - q.i.z) - p.extent - q.extent
          // At least 300 m of open water between coasts.
          if (b > a) expect(gap).toBeGreaterThan(299)
          nearest = Math.min(nearest, gap)
        }
        if (nearest < 1300) close++
      }
      // Islands come in groups: most have a neighbour within about 1.2 km of open water.
      expect(close / fps.length).toBeGreaterThan(0.8)
      // The centrepiece has company: at least five islands within 3 km of its coast.
      expect(fps.filter((f) => f.i !== c && Math.hypot(f.i.x - c.x, f.i.z - c.z) - f.extent - fps[0]!.extent < 3000).length).toBeGreaterThanOrEqual(5)
    }
  })

  test("the spawn area is open, deep water", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const arch = makeArchipelago(seed * 40503)
      for (let r = 0; r <= SPAWN_CLEAR; r += 50) {
        for (let a = 0; a < 32; a++) {
          const t = (a / 32) * Math.PI * 2
          expect(terrainHeight(arch, Math.cos(t) * r, Math.sin(t) * r)).toBe(DEEP)
        }
      }
    }
  })

  test("height range is sane and land only appears on islands", () => {
    for (const seed of SEEDS) {
      const arch = archipelagoFor(seed)
      const fps = arch.islands.map((i) => ({ i, ...islandFootprint(i, arch.seed) }))
      let lo = Infinity
      let hi = -Infinity
      let land = 0
      for (const [x, z] of samplePoints(arch, 200000, seed ^ 99)) {
        const h = terrainHeight(arch, x, z)
        expect(Number.isFinite(h)).toBe(true)
        lo = Math.min(lo, h)
        hi = Math.max(hi, h)
        if (h > 0) {
          land++
          expect(fps.some((f) => Math.hypot(x - f.i.x, z - f.i.z) < f.extent + 1)).toBe(true)
        }
      }
      expect(lo).toBeGreaterThanOrEqual(DEEP)
      // Static geometry is culled against a 600 m slab (src/render/camera.ts STATIC_Y1).
      expect(hi).toBeLessThan(580)
      expect(land).toBeGreaterThan(0)
      expect(terrainHeight(arch, 1e5, 1e5)).toBe(DEEP)
      for (const i of arch.islands) {
        const h = terrainHeight(arch, i.x, i.z)
        if (i.kind === "atoll") {
          // The lagoon: shallow water.
          expect(h).toBeLessThan(0)
          expect(h).toBeGreaterThan(-12)
        } else if (i.kind !== "stacks") expect(h).toBeGreaterThan(i.kind === "cay" ? 1 : 10)
      }
    }
  })

  test("islands sit in a shallow reef shelf with coral that ends before the drop", () => {
    const arch = archipelagoFor(42)
    for (const i of arch.islands) {
      if (i.kind === "stacks") continue
      // Walk outward from the centre in a few directions. Shelf width varies a lot around an island (almost none on
      // steep sides), so it must be wide in some directions and present in all.
      const widths: number[] = []
      for (let a = 0; a < 4; a++) {
        const dx = Math.cos(a * 1.57 + 0.3)
        const dz = Math.sin(a * 1.57 + 0.3)
        let shelf = 0
        let coral = 0
        let wasLand = i.kind === "atoll"
        for (let d = 0; d < 2500; d += 4) {
          const x = i.x + dx * d
          const z = i.z + dz * d
          const h = terrainHeight(arch, x, z)
          if (h > 0) wasLand = true
          if (!wasLand) continue
          if (h < -0.5 && h > -10) shelf += 4
          if (h < -25) {
            expect(coralAt(arch, x, z)).toBe(0)
            break
          }
          if (coralAt(arch, x, z) > 0.5) coral++
        }
        widths.push(shelf)
        void coral
      }
      widths.sort((p, q) => q - p)
      expect(widths[0]!).toBeGreaterThan(i.kind === "cliff" ? 30 : 60)
      expect(widths[1]!).toBeGreaterThan(i.kind === "cliff" ? 15 : 40)
      expect(widths[3]!).toBeGreaterThan(4)
    }
    // Coral exists somewhere on the shelves.
    let any = 0
    for (const [x, z] of samplePoints(arch, 40000, 3)) if (coralAt(arch, x, z) > 0.5) any++
    expect(any).toBeGreaterThan(20)
  })

  test("every kind builds blobs whose land is above water", () => {
    for (const kind of KINDS) {
      const arch: Archipelago = { seed: 1, islands: [{ x: 0, z: 0, radius: kind === "atoll" ? 450 : kind === "volcanic" ? 400 : kind === "cay" ? 70 : kind === "stacks" ? 90 : 200, peak: kind === "cay" || kind === "atoll" ? 4 : 100, kind, seed: 5 }], bounds: [-3000, -3000, 3000, 3000] }
      expect(archBlobs(arch).length).toBeGreaterThan(0)
      let land = 0
      for (const [x, z] of samplePoints(arch, 40000, 9)) if (terrainHeight(arch, x, z) > 0) land++
      expect(land).toBeGreaterThan(0)
    }
  })
})

describe("seabed", () => {
  test("agrees with terrainHeight and coralAt", () => {
    for (const seed of [7, 42]) {
      const arch = archipelagoFor(seed)
      const bed = bakeSeabed(arch, 1024)
      expect(bed.data.length).toBe(1024 * 1024 * 4)
      const texel = bed.size / bed.res
      let landOk = 0
      let depthOk = 0
      let n = 0
      let deep = 0
      for (const [x, z] of samplePoints(arch, 20000, seed)) {
        const h = terrainHeight(arch, x, z)
        const s = seabedAt(bed, x, z)
        n++
        if (s.land === h > 0) landOk++
        if (Math.abs(s.depth - Math.min(40, Math.max(0, -h))) < 3) depthOk++
        if (h === DEEP) {
          deep++
          expect(s.depth).toBeGreaterThan(39)
          expect(s.land).toBe(false)
          expect(s.coral).toBe(0)
        }
      }
      expect(landOk / n).toBeGreaterThan(0.995)
      expect(depthOk / n).toBeGreaterThan(0.97)
      expect(deep).toBeGreaterThan(n / 3)
      let coralTexels = 0
      for (let k = 0; k < 4000; k++) {
        const i = (k * 7919) % bed.res
        const j = (k * 104729) % bed.res
        const x = bed.x0 + (i + 0.5) * texel
        const z = bed.z0 + (j + 0.5) * texel
        const h = terrainHeight(arch, x, z)
        const o = (j * bed.res + i) * 4
        expect(bed.data[o + 1]).toBe(h > 0 ? 255 : 0)
        if (h <= 0) expect(Math.abs(bed.data[o]! - Math.min(255, Math.round((-h / 40) * 255)))).toBeLessThanOrEqual(1)
        const c = h > 0 || h <= -20 ? 0 : Math.round(coralAt(arch, x, z) * 255)
        expect(bed.data[o + 3]).toBe(c)
        if (c > 128) coralTexels++
      }
      expect(coralTexels).toBeGreaterThan(0)
    }
  })

  test("distance to shore is a true distance", () => {
    const arch = archipelagoFor(42)
    const bed = bakeSeabed(arch, 1024)
    const texel = bed.size / bed.res
    const r = new Rng(5)
    let checked = 0
    for (let k = 0; k < 6000 && checked < 150; k++) {
      const x = r.range(arch.bounds[0], arch.bounds[2])
      const z = r.range(arch.bounds[1], arch.bounds[3])
      const s = seabedAt(bed, x, z)
      if (s.land || s.shore > 250 || terrainHeight(arch, x, z) > 0) continue
      let best = Infinity
      for (let d = 0; d <= 300 && best === Infinity; d += 3) {
        for (let a = 0; a < 96; a++) {
          const t = (a / 96) * Math.PI * 2
          if (terrainHeight(arch, x + Math.cos(t) * d, z + Math.sin(t) * d) > 0) {
            best = d
            break
          }
        }
      }
      if (best === Infinity) continue
      expect(Math.abs(s.shore - best)).toBeLessThan(texel * 1.6 + 4)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  test("outside the bake it is open sea", () => {
    const bed = bakeSeabed(makeArchipelago(3), 256)
    expect(seabedAt(bed, 1e6, 0)).toEqual({ depth: 40, land: false, shore: 300, coral: 0 })
  })
})

describe("island mesh", () => {
  test("is deterministic, chunked, finite and within the triangle budget", () => {
    for (const seed of [42, 95028]) {
      const arch = archipelagoFor(seed)
      const a = buildIslandMesh(arch)
      const b = buildIslandMesh(makeArchipelago(seed))
      expect(a.length).toBe(b.length)
      for (let i = 0; i < a.length; i++) {
        expect(b[i]!.box).toEqual(a[i]!.box)
        expect(hashBytes(b[i]!.data)).toBe(hashBytes(a[i]!.data))
      }
      const tris = countTriangles(a)
      expect(tris).toBeGreaterThan(50000)
      expect(tris).toBeLessThanOrEqual(TRI_BUDGET)
      for (const c of a) {
        expect(c.data.byteLength % (VERT_BYTES * 3)).toBe(0)
        const [x0, z0, x1, z1] = c.box
        // Chunks are 512 m; triangles are binned by centroid, so big volcano facets and props hang over the edge.
        expect(x1 - x0).toBeLessThan(512 + 240)
        expect(z1 - z0).toBeLessThan(512 + 240)
        const f = new Float32Array(c.data)
        for (let v = 0; v < c.data.byteLength / VERT_BYTES; v++) {
          const x = f[v * 6]!
          const y = f[v * 6 + 1]!
          const z = f[v * 6 + 2]!
          expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true)
          expect(x >= x0 && x <= x1 && z >= z0 && z <= z1).toBe(true)
        }
      }
    }
  })

  test("instance lists match the merged mesh", () => {
    const arch = archipelagoFor(42)
    const props = buildIslandProps(arch)
    const terrain = countTriangles(buildIslandMesh(arch, { props: false }))
    let propTris = 0
    let count = 0
    props.instances.forEach((list, k) => {
      expect(list.length % INSTANCE_FLOATS).toBe(0)
      propTris += (list.length / INSTANCE_FLOATS) * props.protos[k]!.tris
      count += list.length / INSTANCE_FLOATS
    })
    expect(count).toBeGreaterThan(5000)
    expect(terrain + propTris).toBe(countTriangles(buildIslandMesh(arch)))
  })

  test("props stand on the ground", () => {
    const arch = archipelagoFor(7)
    const props = buildIslandProps(arch)
    props.instances.forEach((list, k) => {
      const name = props.protos[k]!.name
      for (let i = 0; i < list.length; i += INSTANCE_FLOATS * 7) {
        const x = list[i]!
        const y = list[i + 1]!
        const z = list[i + 2]!
        const s = list[i + 4]!
        const g = terrainHeight(arch, x, z)
        // Palms and crowns sit on dry land; boulders are embedded in the ground and show above the sea.
        if (name.startsWith("palm")) expect(g).toBeGreaterThan(0)
        if (name.startsWith("palm")) expect(Math.abs(y - g)).toBeLessThan(0.5)
        if (name.startsWith("crown")) expect(y - g).toBeLessThan(s * 0.5)
        if (name.startsWith("boulder")) {
          // Shore rocks are embedded 0.18 × scale, hillside outcrops 0.25 × scale.
          expect(Math.min(Math.abs(y - (g + 0.18 * s)), Math.abs(y - (g + 0.25 * s)))).toBeLessThan(0.01)
          expect(y + 0.55 * s).toBeGreaterThan(0)
        }
      }
    })
  })

  test("full generation, bake and mesh build time", () => {
    const rows: string[] = []
    for (const seed of SEEDS) {
      const t0 = performance.now()
      const arch = makeArchipelago(seed)
      const t1 = performance.now()
      bakeSeabed(arch, 1024)
      const t2 = performance.now()
      const chunks = buildIslandMesh(arch)
      const t3 = performance.now()
      rows.push(
        `seed ${seed}: ${arch.islands.length} islands, ${countTriangles(chunks)} tris in ${chunks.length} chunks; ` +
          `gen ${(t1 - t0).toFixed(1)} ms, bake(1024) ${(t2 - t1).toFixed(0)} ms, mesh ${(t3 - t2).toFixed(0)} ms`,
      )
      expect(t2 - t1).toBeLessThan(1000)
      expect(t3 - t0).toBeLessThan(4000)
    }
    console.log(rows.join("\n"))
  })
})
