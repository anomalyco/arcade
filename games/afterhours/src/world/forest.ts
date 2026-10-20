import * as THREE from "three/webgpu"
import type { Box, WorldContext, WorldModule } from "./context"
import { WORLD_HALF, northTrackDistance } from "./layout"
import { material } from "../render/materials"
import { forestBase, forestImpostors } from "./forest/textures"
import { buildTree, impostorInput, impostorSize, type Kind, type TreeModel } from "./forest/species"
import { VARIANTS, type Trees } from "./forest/placement"
import { InstLayer, ROADSIDE, band, foliageMaterial, forestUniforms, impostorMaterial, lodDistanceCpu, solidMaterial } from "./forest/render"
import { roadEdgeDistance } from "./height"
import { buildUndergrowth } from "./forest/undergrowth"
import { yieldToMain } from "../boot/schedule"

// Dense Douglas-fir / lodgepole forest from the world edge to the road verges. Near trees are full card models,
// mid trees a lighter version of the same limbs, far trees one impostor quad each; near and mid instance lists are
// rebuilt on the CPU when the player has moved a few metres, the far layer is static and culled in its shader.

const FOLIAGE_COLOR: Record<Kind, THREE.Color> = {
  fir: new THREE.Color(0.95, 1.0, 0.95),
  firEdge: new THREE.Color(0.95, 1.0, 0.95),
  pine: new THREE.Color(1.08, 1.05, 0.85),
  young: new THREE.Color(1.0, 1.05, 0.95),
  sapling: new THREE.Color(1.05, 1.08, 0.95),
  snag: new THREE.Color(0.9, 0.85, 0.8),
}

/** Trees within this many metres of a road edge count as roadside (see `forest.roadReach`). */
const ROADSIDE_BAND = 14
const COLLIDER_SLOTS = 320
const COLLIDER_RADIUS = 26

export async function build(ctx: WorldContext): Promise<WorldModule | void> {
  const s = ctx.settings
  const defaults: Record<string, number> = {
    "forest.lod0": 34,
    "forest.lod1": 110,
    "forest.far": 1000,
    "forest.fade": 5,
    "forest.wind": 0.35,
    "forest.shadows": 2,
    "forest.roadReach": 2.2,
  }
  for (const [k, v] of Object.entries(defaults)) if (s[k] === undefined) s[k] = v
  ctx.controls.push(
    { key: "forest.lod0", label: "Full-detail tree distance", group: "Forest", unit: "m", min: 10, max: 80, step: 1 },
    { key: "forest.lod1", label: "Mid-detail tree distance", group: "Forest", unit: "m", min: 40, max: 300, step: 5 },
    { key: "forest.far", label: "Far tree cull distance", group: "Forest", unit: "m", min: 150, max: 1400, step: 10 },
    { key: "forest.fade", label: "LOD cross-fade width", group: "Forest", unit: "m", min: 1, max: 20, step: 0.5 },
    { key: "forest.roadReach", label: "Roadside full-detail reach (headlights)", group: "Forest", unit: "×", min: 1, max: 3, step: 0.1 },
    { key: "forest.wind", label: "Wind", group: "Forest", min: 0, max: 1.5, step: 0.05 },
    { key: "forest.shadows", label: "Near tree shadows (0 off, 1 trunks, 2 trunks + crowns)", group: "Forest", min: 0, max: 2, step: 1 },
  )
  const num = (k: string) => Number(s[k] ?? defaults[k])

  // Tree models are built here (a few ms each, yielding between them); the textures and placement run in a Worker
  // meanwhile, so the main thread stays free.
  const t0 = performance.now()
  const models: TreeModel[] = []
  for (const v of VARIANTS) {
    models.push(buildTree(v.kind, v.seed))
    await yieldToMain()
  }
  const [assets, impostorTex] = await Promise.all([forestBase(), forestImpostors(models.map(impostorInput))])
  const trees = assets.trees
  const atlas = { texture: assets.foliage }
  const tGen = performance.now() - t0

  const bands = {
    lod0: band(-1e5, num("forest.lod0") - num("forest.fade")),
    lod1: band(num("forest.lod0") - num("forest.fade"), num("forest.lod1") - num("forest.fade")),
    lod2: band(num("forest.lod1") - num("forest.fade"), num("forest.far")),
  }
  const bark = material("bark")
  const mats = new Map<string, THREE.Material>()
  const matFor = (kind: Kind, lod: 0 | 1, part: "trunk" | "foliage") => {
    const key = part === "trunk" ? "trunk" : `${kind}:${lod}:${part}`
    let m = mats.get(key)
    if (!m) {
      const b = lod === 0 ? bands.lod0 : bands.lod1
      m = part === "trunk" ? solidMaterial(bark) : foliageMaterial(atlas.texture, FOLIAGE_COLOR[kind], b)
      mats.set(key, m)
    }
    return m
  }

  // Near and mid layers per variant (capacity sized for the densest stands within range).
  const near: InstLayer[] = []
  const mid: InstLayer[] = []
  models.forEach((m, vi) => {
    near.push(
      new InstLayer(1500, [
        { geometry: m.lod0.trunk, material: matFor(m.kind, 0, "trunk"), castShadow: true, name: `tree-${vi}-lod0-trunk`, band: bands.lod0 },
        { geometry: m.lod0.foliage, material: matFor(m.kind, 0, "foliage"), castShadow: true, name: `tree-${vi}-lod0-foliage` },
      ]),
    )
    mid.push(
      new InstLayer(6000, [
        { geometry: m.lod1.trunk, material: matFor(m.kind, 1, "trunk"), name: `tree-${vi}-lod1-trunk`, band: bands.lod1 },
        { geometry: m.lod1.foliage, material: matFor(m.kind, 1, "foliage"), name: `tree-${vi}-lod1-foliage` },
      ]),
    )
  })
  for (const l of [...near, ...mid]) for (const mesh of l.meshes) ctx.scene.add(mesh)

  // Grid cell offsets sorted by distance, so instance lists are written nearest first: drawn front to back, the
  // alpha-tested cards behind nearer trees fail the depth test instead of being shaded.
  const g = trees.grid
  const ring: number[] = []
  {
    const R = g.n
    const offs: [number, number, number][] = []
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) offs.push([di, dj, di * di + dj * dj])
    offs.sort((a, b) => a[2] - b[2])
    for (const o of offs) ring.push(o[0], o[1], o[2])
  }
  /** Calls `f` for every tree in cells within `reach` metres of (cx, cz), nearest cells first. */
  const forNear = (cx: number, cz: number, reach: number, f: (k: number) => void) => {
    const ci = Math.floor((cx + WORLD_HALF) / g.size)
    const cj = Math.floor((cz + WORLD_HALF) / g.size)
    const maxD2 = (reach / g.size + 1.5) ** 2
    for (let r = 0; r < ring.length; r += 3) {
      if (ring[r + 2]! > maxD2) break
      const i = ci + ring[r]!
      const j = cj + ring[r + 1]!
      if (i < 0 || j < 0 || i >= g.n || j >= g.n) continue
      const c = j * g.n + i
      for (let o = g.cellStart[c]!; o < g.cellStart[c + 1]!; o++) f(g.order[o]!)
    }
  }

  // Far layer: every tree but saplings, re-sorted front to back when the player has moved a long way.
  const quad = new THREE.BufferGeometry()
  quad.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
  quad.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  quad.setIndex([0, 1, 2, 0, 2, 3])
  const sizes = models.map(impostorSize)
  const farCount = countWhere(trees, (k) => models[trees.variant[k]!]!.kind !== "sapling")
  const far = new InstLayer(farCount, [{ geometry: quad, material: impostorMaterial(impostorTex, new THREE.Color(1, 1, 1), bands.lod2), name: "tree-impostors" }])
  const farAt = new THREE.Vector3(1e9, 0, 1e9)
  const sortFar = (cx: number, cz: number) => {
    let n = 0
    forNear(cx, cz, WORLD_HALF * 3, (k) => {
      const vi = trees.variant[k]!
      if (models[vi]!.kind === "sapling") return
      const sc = trees.scale[k]!
      far.set(n++, trees.x[k]!, trees.y[k]!, trees.z[k]!, sc, vi, trees.tint[k]!, sizes[vi]!.w * sc, sizes[vi]!.h * sc)
    })
    far.commit(n)
    farAt.set(cx, 0, cz)
  }
  sortFar(ctx.camera.position.x, ctx.camera.position.z)
  for (const mesh of far.meshes) ctx.scene.add(mesh)

  // Trunk colliders: a fixed pool of boxes refilled around the player.
  const pool: { min: [number, number, number]; max: [number, number, number] }[] = []
  for (let i = 0; i < COLLIDER_SLOTS; i++) {
    const b = { min: [0, -1e4, 0] as [number, number, number], max: [0, -1e4, 0] as [number, number, number] }
    pool.push(b)
    ctx.colliders.push(b as Box)
  }

  const undergrowth = buildUndergrowth(ctx, assets.undergrowth, trees)

  const last = new THREE.Vector3(1e9, 0, 1e9)
  let lastLod0 = 0
  let lastLod1 = 0
  const counts0 = new Int32Array(models.length)
  const counts1 = new Int32Array(models.length)

  // Trees lining the roads stay full-detail further: headlights (and a flashlight from the road) light them side-on,
  // where the mid model's wide cards would read as flat planes.
  const roadside = new Uint8Array(trees.count)
  for (let k = 0; k < trees.count; k++) {
    const x = trees.x[k]!
    const z = trees.z[k]!
    // The north track and logging road are measured from their centre lines, so add half a lane.
    roadside[k] = roadEdgeDistance(x, z) < ROADSIDE_BAND || northTrackDistance(x, z) < ROADSIDE_BAND + 1.5 ? 1 : 0
  }

  const lastFwd = new THREE.Vector2(0, -1)
  const fwd = new THREE.Vector3()
  const rebuild = (cx: number, cz: number, fx: number, fz: number) => {
    const d0 = num("forest.lod0")
    const d1 = num("forest.lod1")
    const F = num("forest.fade")
    const margin = 6
    counts0.fill(0)
    counts1.fill(0)
    let slot = 0
    const reach = d1 + margin
    const nearHi = d0 - F
    const midHi = Math.max(d1, d0 + 10) - F
    const K = num("forest.roadReach")
    forNear(cx, cz, reach, (k) => {
      const x = trees.x[k]!
      const z = trees.z[k]!
      const dx = x - cx
      const dz = z - cz
      const dist = Math.hypot(dx, dz)
      if (dist > reach) return
      const road = roadside[k] === 1
      // Same remapped distance as the shaders, so lists and bands agree.
      const d = lodDistanceCpu(dist, road, nearHi, midHi, K)
      const phase = trees.phase[k]! + (road ? ROADSIDE : 0)
      const vi = trees.variant[k]!
      const m = models[vi]!
      const sc = trees.scale[k]!
      const yaw = trees.yaw[k]!
      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      const y = trees.y[k]!
      if (d < d0 + margin && counts0[vi]! < near[vi]!.capacity) near[vi]!.set(counts0[vi]!++, x, y, z, sc, cy, sy, trees.tint[k]!, phase)
      // Mid trees cast no shadows, so the ones well behind the camera can be skipped (refreshed on turning).
      const behind = dist > 14 && (dx * fx + dz * fz) / dist < -0.3
      // Saplings (1-3 m) are lost in the undergrowth and fog past the full-detail range: no mid-detail draw for them.
      if (!behind && m.kind !== "sapling" && d > d0 - F - margin && counts1[vi]! < mid[vi]!.capacity) mid[vi]!.set(counts1[vi]!++, x, y, z, sc, cy, sy, trees.tint[k]!, phase)
      if (dist < COLLIDER_RADIUS && slot < COLLIDER_SLOTS && m.kind !== "sapling") {
        const r = Math.max(0.12, m.baseRadius * sc * 0.9)
        const b = pool[slot++]!
        b.min[0] = x - r
        b.min[1] = y - 1
        b.min[2] = z - r
        b.max[0] = x + r
        b.max[1] = y + Math.min(6, m.trunkTop * sc)
        b.max[2] = z + r
      }
    })
    for (; slot < COLLIDER_SLOTS; slot++) {
      pool[slot]!.min[1] = -1e4
      pool[slot]!.max[1] = -1e4
    }
    let n0 = 0
    let n1 = 0
    near.forEach((l, vi) => {
      l.commit(counts0[vi]!)
      n0 += counts0[vi]!
    })
    mid.forEach((l, vi) => {
      l.commit(counts1[vi]!)
      n1 += counts1[vi]!
    })
    lastLod0 = n0
    lastLod1 = n1
  }

  const applySettings = () => {
    const d0 = num("forest.lod0")
    const d1 = Math.max(num("forest.lod1"), d0 + 10)
    const F = num("forest.fade")
    forestUniforms.fade.value = F
    forestUniforms.wind.value = num("forest.wind")
    bands.lod0.hi.value = d0 - F
    bands.lod1.lo.value = d0 - F
    bands.lod1.hi.value = d1 - F
    bands.lod2.lo.value = d1 - F
    forestUniforms.nearHi.value = d0 - F
    forestUniforms.midHi.value = d1 - F
    forestUniforms.roadK.value = num("forest.roadReach")
    // Nothing past the point where the fog leaves ~1 % of a silhouette's contrast, judged at mid-crown height (the
    // fog thins with height, so crowns against the sky carry further than trunks).
    const fog = Number(s["fog.density"] ?? 0) * Math.exp(-12 / Math.max(1, Number(s["fog.height"] ?? 30)))
    bands.lod2.hi.value = fog > 0 ? Math.min(num("forest.far"), 4.5 / fog) : num("forest.far")
    const sh = num("forest.shadows")
    for (const l of near) {
      l.meshes[0]!.castShadow = sh >= 1
      l.meshes[1]!.castShadow = sh >= 2
    }
  }
  applySettings()
  const sig = () => ["forest.lod0", "forest.lod1", "forest.fade", "forest.wind", "forest.far", "forest.shadows", "forest.roadReach"].map(num).join(",") + s["fog.density"] + s["fog.height"]
  let lastSig = sig()

  ;(globalThis as { __forest?: unknown }).__forest = {
    trees: trees.count,
    genMs: +tGen.toFixed(1),
    workerMs: assets.workerMs,
    stats: () => ({ lod0: lastLod0, lod1: lastLod1, far: far.count }),
  }
  // Automation hook for per-group GPU ablations.
  if (ctx.params.has("perf")) (globalThis as { __fctx?: unknown }).__fctx = ctx

  return {
    update(dt, time, camera) {
      const p = camera.position
      forestUniforms.view.value.copy(p)
      const cur = sig()
      if (cur !== lastSig) {
        lastSig = cur
        applySettings()
        last.set(1e9, 0, 1e9)
      }
      camera.getWorldDirection(fwd)
      const fl = Math.hypot(fwd.x, fwd.z) || 1
      const fx = fwd.x / fl
      const fz = fwd.z / fl
      // Rebuild after moving 3 m or turning ~25 degrees.
      if (Math.hypot(p.x - last.x, p.z - last.z) > 3 || fx * lastFwd.x + fz * lastFwd.y < 0.9) {
        last.copy(p)
        lastFwd.set(fx, fz)
        rebuild(p.x, p.z, fx, fz)
      }
      if (Math.hypot(p.x - farAt.x, p.z - farAt.z) > 40) sortFar(p.x, p.z)
      undergrowth.update(dt, time, camera)
    },
  }
}

function countWhere(trees: Trees, f: (k: number) => boolean) {
  let n = 0
  for (let k = 0; k < trees.count; k++) if (f(k)) n++
  return n
}
