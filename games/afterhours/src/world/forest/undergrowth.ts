import * as THREE from "three/webgpu"
import type { Box, WorldContext } from "../context"
import { LOG_SHAPES, STUMP_SHAPES, deadwoodInCell } from "./deadwood"
import { deadwoodMaterials, logGeometry, stumpGeometry } from "./deadwood-mesh"
import type { Trees } from "./placement"
import { SHOULDER, compoundDistance, fbm, heightAt, roadEdgeDistance } from "../height"
import { hash3, rng, range } from "./rng"
import { CELL, UNDER, cellRect } from "./paint"
import { InstLayer, band, foliageMaterial } from "./render"

// Forest floor detail near the player: sword-fern clumps, salal, verge grass, fallen twigs, logs and stumps.
// Generated deterministically per 8 m cell on first approach, cached, and gathered into instance lists whenever the
// player has moved a couple of metres. Everything fades out by `REACH` metres.

const CELL_M = 8
const REACH = 46
const LOG_REACH = 90

const PLANTS = ["fernA", "fernB", "grass", "salal", "twigs"] as const
type Plant = (typeof PLANTS)[number]
/** Part index: plants first, then one per log shape, then one per stump shape. */
const LOG0 = PLANTS.length
const STUMP0 = LOG0 + LOG_SHAPES.length
const PART_COUNT = STUMP0 + STUMP_SHAPES

type Buf = { pos: number[]; nor: number[]; uv: number[]; flex: number[]; idx: number[] }

function card(b: Buf, cell: number, pts: THREE.Vector3[], across: THREE.Vector3, width: number, flip = false) {
  const [u0, v0, u1, v1] = cellRect(cell)
  const pad = 4 / (CELL * 2)
  const base = b.pos.length / 3
  pts.forEach((p, k) => {
    const u = k / (pts.length - 1)
    for (let side = 0; side < 2; side++) {
      const q = p.clone().addScaledVector(across, (side - 0.5) * width)
      b.pos.push(q.x, q.y, q.z)
      b.nor.push(q.x * 0.3, 1, q.z * 0.3)
      const uu = flip ? 1 - side : u
      const vv = flip ? 1 - u : side
      b.uv.push(THREE.MathUtils.lerp(u0 + pad, u1 - pad, uu), THREE.MathUtils.lerp(v0 + pad, v1 - pad, vv))
      b.flex.push(p.y)
    }
  })
  for (let k = 0; k < pts.length - 1; k++) {
    const a = base + k * 2
    b.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
}

function geometry(b: Buf) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3))
  const n = new THREE.Float32BufferAttribute(b.nor, 3)
  for (let i = 0; i < n.count; i++) {
    const v = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)).normalize()
    n.setXYZ(i, v.x, v.y, v.z)
  }
  g.setAttribute("normal", n)
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(b.flex, 1))
  g.setIndex(b.idx)
  return g
}

function fernClump(seed: number) {
  const r = rng(seed)
  const b: Buf = { pos: [], nor: [], uv: [], flex: [], idx: [] }
  const fronds = 11 + Math.floor(r() * 5)
  for (let f = 0; f < fronds; f++) {
    const az = (f / fronds) * Math.PI * 2 + range(r, -0.25, 0.25)
    const len = range(r, 0.65, 1.05)
    const rise = range(r, 0.9, 1.25)
    const h = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
    const pts: THREE.Vector3[] = []
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      // Arching frond: rises steeply, then curves over.
      const out = len * t * 0.85
      const up = len * (Math.sin(t * rise * 1.4) * 0.75 - t * t * 0.35)
      pts.push(h.clone().multiplyScalar(out + 0.04).setY(Math.max(0.02, up)))
    }
    const across = new THREE.Vector3(-h.z, 0, h.x).applyAxisAngle(h, range(r, -0.5, 0.5))
    card(b, UNDER.fern, pts, across, range(r, 0.22, 0.3))
  }
  return geometry(b)
}

function crossed(cell: number, w: number, h: number, n: number, seed: number) {
  const r = rng(seed)
  const b: Buf = { pos: [], nor: [], uv: [], flex: [], idx: [] }
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI + range(r, -0.2, 0.2)
    const across = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
    // Card runs bottom (root) to top; texture's root is at v = 1 of the cell, so map u -> v.
    const pts = [0, 0.5, 1].map((t) => new THREE.Vector3(0, t * h - 0.03, 0))
    card(b, cell, pts, across, w, true)
  }
  return geometry(b)
}

function twigs(seed: number) {
  const r = rng(seed)
  const b: Buf = { pos: [], nor: [], uv: [], flex: [], idx: [] }
  for (let i = 0; i < 3; i++) {
    const az = r() * Math.PI
    const d = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
    const len = range(r, 0.6, 1.1)
    const pts = [-0.5, 0, 0.5].map((t) => d.clone().multiplyScalar(t * len).setY(0.03 + i * 0.01))
    card(b, UNDER.twigs, pts, new THREE.Vector3(-d.z, 0, d.x), len * 0.45)
  }
  const g = geometry(b)
  return g
}

type CellData = { part: Uint8Array; data: Float32Array; n: number }

export function buildUndergrowth(ctx: WorldContext, atlas: THREE.Texture, trees: Trees) {
  const near = band(-1e5, REACH - 8)
  const logBand = band(-1e5, LOG_REACH - 8)
  const plant = (c: THREE.Color) => foliageMaterial(atlas, c, near)
  const bark = deadwoodMaterials()
  const fernMat = plant(new THREE.Color(0.9, 1.05, 0.85))
  const plants: Record<Plant, { geometry: THREE.BufferGeometry; material: THREE.Material; cap: number }> = {
    fernA: { geometry: fernClump(7), material: fernMat, cap: 2500 },
    fernB: { geometry: fernClump(8), material: fernMat, cap: 2500 },
    grass: { geometry: crossed(UNDER.grass, 0.75, 0.7, 3, 9), material: plant(new THREE.Color(1, 1, 0.9)), cap: 6000 },
    salal: { geometry: crossed(UNDER.salal, 0.7, 0.6, 3, 10), material: plant(new THREE.Color(0.9, 1, 0.9)), cap: 3000 },
    twigs: { geometry: twigs(11), material: plant(new THREE.Color(1, 1, 1)), cap: 2000 },
  }
  const parts = [
    ...PLANTS.map((p) => ({ ...plants[p], shadow: false, name: p })),
    ...LOG_SHAPES.map((L, i) => ({ geometry: logGeometry(L.len, L.r, 300 + i), material: bark, cap: 120, shadow: true, name: `log${i}`, band: logBand })),
    ...Array.from({ length: STUMP_SHAPES }, (_, i) => ({ geometry: stumpGeometry(i, 400 + i), material: bark, cap: 160, shadow: true, name: `stump${i}`, band: logBand })),
  ]
  const layers = parts.map((g) => {
    const l = new InstLayer(g.cap, [{ geometry: g.geometry, material: g.material, castShadow: g.shadow, name: `undergrowth-${g.name}`, band: "band" in g ? g.band : undefined }])
    for (const m of l.meshes) ctx.scene.add(m)
    return l
  })

  const logPool: { min: [number, number, number]; max: [number, number, number] }[] = []
  for (let i = 0; i < 96; i++) {
    const b = { min: [0, -1e4, 0] as [number, number, number], max: [0, -1e4, 0] as [number, number, number] }
    logPool.push(b)
    ctx.colliders.push(b as Box)
  }

  const cache = new Map<number, CellData>()
  const STRIDE = 7
  const generate = (ci: number, cj: number): CellData => {
    const part: number[] = []
    const data: number[] = []
    const put = (p: Plant | number, x: number, y: number, z: number, s: number, yaw: number, tint: number) => {
      part.push(typeof p === "number" ? p : PLANTS.indexOf(p))
      data.push(x, y, z, s, Math.cos(yaw), Math.sin(yaw), tint)
    }
    const x0 = ci * CELL_M
    const z0 = cj * CELL_M
    const SUB = 1.6
    const n = CELL_M / SUB
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = hash3(ci * 16 + i, cj * 16 + j, 77)
        const x = x0 + (i + hash3(ci * 16 + i, cj * 16 + j, 78)) * SUB
        const z = z0 + (j + hash3(ci * 16 + i, cj * 16 + j, 79)) * SUB
        const road = roadEdgeDistance(x, z)
        const comp = compoundDistance(x, z)
        if (road < SHOULDER + 0.4 || comp < 0.8) continue
        const yaw = h * 40
        const tint = 0.75 + hash3(ci * 16 + i, cj * 16 + j, 80) * 0.45
        const verge = road < 7.5 || comp < 6
        if (verge) {
          if (h < 0.75) put("grass", x, heightAt(x, z), z, 0.7 + h * 0.6, yaw, tint)
          continue
        }
        const fernD = fbm(x, z, 2, 1 / 22, 41)
        const salD = fbm(x, z, 2, 1 / 17, 43)
        if (fernD > -0.05 && h < 0.24 + fernD * 1.1) put(h < 0.5 ? "fernA" : "fernB", x, heightAt(x, z), z, 0.7 + hash3(i, j, ci + cj) * 0.6, yaw, tint)
        else if (salD > 0.15 && h < 0.5) put("salal", x, heightAt(x, z), z, 0.6 + h, yaw, tint)
        else if (h > 0.95) put("twigs", x, heightAt(x, z), z, 0.8 + h * 0.4, yaw, tint)
        else if (road < 14 && h < 0.3) put("grass", x, heightAt(x, z), z, 0.5 + h, yaw, tint * 0.9)
      }
    }
    // Logs and stumps: placed by the stand (deadwood.ts). Yaw maps local +X to world (cos, sin), as in the shader.
    for (const d of deadwoodInCell(trees, ci, cj, CELL_M)) {
      const p = d.kind === "log" ? LOG0 + d.shape : STUMP0 + d.shape
      put(p, d.x, d.y, d.z, d.scale, d.yaw, 0.75 + hash3(ci, cj, 85) * 0.5)
    }
    return { part: Uint8Array.from(part), data: Float32Array.from(data), n: part.length }
  }

  const counts = new Int32Array(PART_COUNT)
  const last = new THREE.Vector3(1e9, 0, 1e9)
  const rebuild = (cx: number, cz: number) => {
    counts.fill(0)
    let slot = 0
    const ci0 = Math.floor((cx - LOG_REACH) / CELL_M)
    const ci1 = Math.floor((cx + LOG_REACH) / CELL_M)
    const cj0 = Math.floor((cz - LOG_REACH) / CELL_M)
    const cj1 = Math.floor((cz + LOG_REACH) / CELL_M)
    for (let cj = cj0; cj <= cj1; cj++) {
      for (let ci = ci0; ci <= ci1; ci++) {
        const ccx = (ci + 0.5) * CELL_M
        const ccz = (cj + 0.5) * CELL_M
        const dc = Math.hypot(ccx - cx, ccz - cz)
        if (dc > LOG_REACH + CELL_M) continue
        const key = (ci + 1000) * 4096 + (cj + 1000)
        let cell = cache.get(key)
        if (!cell) {
          // Plants are only generated where they can show; far cells get logs only on demand below.
          cell = generate(ci, cj)
          cache.set(key, cell)
        }
        for (let k = 0; k < cell.n; k++) {
          const p = cell.part[k]!
          const o = k * STRIDE
          const x = cell.data[o]!
          const z = cell.data[o + 2]!
          const d = Math.hypot(x - cx, z - cz)
          const isLog = p >= LOG0
          if (d > (isLog ? LOG_REACH : REACH) + 4) continue
          const l = layers[p]!
          if (counts[p]! >= l.capacity) continue
          const y = cell.data[o + 1]!
          const s = cell.data[o + 3]!
          l.set(counts[p]!++, x, y, z, s, cell.data[o + 4]!, cell.data[o + 5]!, cell.data[o + 6]!, x * 0.37 + z * 0.11)
          if (isLog && d < 24 && slot < logPool.length) slot = colliderFor(p, x, y, z, s, cell.data[o + 4]!, cell.data[o + 5]!, slot)
        }
      }
    }
    for (let i = slot; i < logPool.length; i++) {
      logPool[i]!.min[1] = -1e4
      logPool[i]!.max[1] = -1e4
    }
    layers.forEach((l, i) => l.commit(counts[i]!))
  }

  const colliderFor = (p: number, x: number, y: number, z: number, s: number, c: number, sn: number, slot: number) => {
    if (p >= STUMP0) {
      const b = logPool[slot++]!
      const r = 0.45 * s
      b.min[0] = x - r; b.min[1] = y - 0.3; b.min[2] = z - r
      b.max[0] = x + r; b.max[1] = y + (p === STUMP0 ? 1.1 : 0.55) * s; b.max[2] = z + r
      return slot
    }
    const L = LOG_SHAPES[p - LOG0]!
    // Local +X maps to world (cos, sin), matching the instance yaw rotation in the shader.
    const ax = c
    const az = sn
    const len = L.len * s
    const r = L.r * s
    for (let t = -len / 2 + 0.5; t < len / 2 && slot < logPool.length; t += 1.2) {
      const b = logPool[slot++]!
      const px = x + ax * t
      const pz = z + az * t
      b.min[0] = px - r; b.min[1] = y - r; b.min[2] = pz - r
      b.max[0] = px + r; b.max[1] = y + r; b.max[2] = pz + r
    }
    return slot
  }

  return {
    update(_dt: number, _time: number, camera: THREE.Camera) {
      const p = camera.position
      if (Math.hypot(p.x - last.x, p.z - last.z) > 2.5) {
        last.copy(p)
        rebuild(p.x, p.z)
      }
    },
  }
}
