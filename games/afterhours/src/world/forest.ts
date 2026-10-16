import * as THREE from "three/webgpu"
import type { Box, WorldContext, WorldModule } from "./context"
import { WORLD_HALF } from "./layout"
import { material } from "../render/materials"
import { foliageAtlas } from "./forest/textures"
import { buildTree, impostorSize, paintImpostors, IMPOSTOR, type Kind, type TreeModel } from "./forest/species"
import { placeTrees, VARIANTS, type Trees } from "./forest/placement"
import { InstLayer, band, foliageMaterial, forestUniforms, impostorMaterial, trunkMaterial } from "./forest/render"
import { alphaTexture } from "./forest/textures"
import { buildUndergrowth } from "./forest/undergrowth"

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

const COLLIDER_SLOTS = 320
const COLLIDER_RADIUS = 26

export function build(ctx: WorldContext): WorldModule | void {
  const s = ctx.settings
  const defaults: Record<string, number> = {
    "forest.lod0": 34,
    "forest.lod1": 110,
    "forest.far": 650,
    "forest.fade": 5,
    "forest.wind": 0.35,
    "forest.shadows": 2,
  }
  for (const [k, v] of Object.entries(defaults)) if (s[k] === undefined) s[k] = v
  ctx.controls.push(
    { key: "forest.lod0", label: "Full-detail tree distance", group: "Forest", unit: "m", min: 10, max: 80, step: 1 },
    { key: "forest.lod1", label: "Mid-detail tree distance", group: "Forest", unit: "m", min: 40, max: 300, step: 5 },
    { key: "forest.far", label: "Far tree cull distance", group: "Forest", unit: "m", min: 150, max: 1000, step: 10 },
    { key: "forest.fade", label: "LOD cross-fade width", group: "Forest", unit: "m", min: 1, max: 20, step: 0.5 },
    { key: "forest.wind", label: "Wind", group: "Forest", min: 0, max: 1.5, step: 0.05 },
    { key: "forest.shadows", label: "Near tree shadows (0 off, 1 trunks, 2 trunks + crowns)", group: "Forest", min: 0, max: 2, step: 1 },
  )
  const num = (k: string) => Number(s[k] ?? defaults[k])

  const t0 = performance.now()
  const atlas = foliageAtlas()
  const models: TreeModel[] = VARIANTS.map((v) => buildTree(v.kind, v.seed))
  const impostorCanvas = paintImpostors(models, atlas.canvas)
  const impostorTex = alphaTexture(impostorCanvas)
  const trees = placeTrees({ density: 1, seed: 1984 })
  const tGen = performance.now() - t0

  const bands = {
    lod0: band(-1e5, num("forest.lod0") - num("forest.fade")),
    lod1: band(num("forest.lod0") - num("forest.fade"), num("forest.lod1") - num("forest.fade")),
    lod2: band(num("forest.lod1") - num("forest.fade"), num("forest.far")),
  }
  const bark = material("bark")
  const mats = new Map<string, THREE.Material>()
  const matFor = (kind: Kind, lod: 0 | 1, part: "trunk" | "foliage") => {
    const key = `${kind}:${lod}:${part}`
    let m = mats.get(key)
    if (!m) {
      const b = lod === 0 ? bands.lod0 : bands.lod1
      m = part === "trunk" ? trunkMaterial(bark, b) : foliageMaterial(atlas.texture, FOLIAGE_COLOR[kind], b)
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
        { geometry: m.lod0.trunk, material: matFor(m.kind, 0, "trunk"), castShadow: true, name: `tree-${vi}-lod0-trunk` },
        { geometry: m.lod0.foliage, material: matFor(m.kind, 0, "foliage"), castShadow: true, name: `tree-${vi}-lod0-foliage` },
      ]),
    )
    mid.push(
      new InstLayer(6000, [
        { geometry: m.lod1.trunk, material: matFor(m.kind, 1, "trunk"), name: `tree-${vi}-lod1-trunk` },
        { geometry: m.lod1.foliage, material: matFor(m.kind, 1, "foliage"), name: `tree-${vi}-lod1-foliage` },
      ]),
    )
  })
  for (const l of [...near, ...mid]) for (const mesh of l.meshes) ctx.scene.add(mesh)

  // Far layer: every tree but saplings, static.
  const quad = new THREE.BufferGeometry()
  quad.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
  quad.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  quad.setIndex([0, 1, 2, 0, 2, 3])
  const sizes = models.map(impostorSize)
  const farCount = countWhere(trees, (k) => models[trees.variant[k]!]!.kind !== "sapling")
  const far = new InstLayer(farCount, [{ geometry: quad, material: impostorMaterial(impostorTex, new THREE.Color(1, 1, 1), bands.lod2), name: "tree-impostors" }])
  {
    let n = 0
    // Write far-to-near from the centre so rings closest to the facility draw last (cheap, stable ordering).
    for (let k = 0; k < trees.count; k++) {
      const vi = trees.variant[k]!
      if (models[vi]!.kind === "sapling") continue
      const sc = trees.scale[k]!
      far.set(n++, trees.x[k]!, trees.y[k]!, trees.z[k]!, sc, vi, trees.tint[k]!, sizes[vi]!.w * sc, sizes[vi]!.h * sc)
    }
    far.commit(n)
  }
  for (const mesh of far.meshes) ctx.scene.add(mesh)

  // Trunk colliders: a fixed pool of boxes refilled around the player.
  const pool: { min: [number, number, number]; max: [number, number, number] }[] = []
  for (let i = 0; i < COLLIDER_SLOTS; i++) {
    const b = { min: [0, -1e4, 0] as [number, number, number], max: [0, -1e4, 0] as [number, number, number] }
    pool.push(b)
    ctx.colliders.push(b as Box)
  }

  const undergrowth = buildUndergrowth(ctx, trees)

  const last = new THREE.Vector3(1e9, 0, 1e9)
  let lastLod0 = 0
  let lastLod1 = 0
  const counts0 = new Int32Array(models.length)
  const counts1 = new Int32Array(models.length)

  const rebuild = (cx: number, cz: number) => {
    const d0 = num("forest.lod0")
    const d1 = num("forest.lod1")
    const F = num("forest.fade")
    const margin = 6
    counts0.fill(0)
    counts1.fill(0)
    let slot = 0
    const g = trees.grid
    const reach = d1 + margin
    const i0 = Math.max(0, Math.floor((cx - reach + WORLD_HALF) / g.size))
    const i1 = Math.min(g.n - 1, Math.floor((cx + reach + WORLD_HALF) / g.size))
    const j0 = Math.max(0, Math.floor((cz - reach + WORLD_HALF) / g.size))
    const j1 = Math.min(g.n - 1, Math.floor((cz + reach + WORLD_HALF) / g.size))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * g.n + i
        for (let o = g.cellStart[c]!; o < g.cellStart[c + 1]!; o++) {
          const k = g.order[o]!
          const x = trees.x[k]!
          const z = trees.z[k]!
          const d = Math.hypot(x - cx, z - cz)
          if (d > reach) continue
          const vi = trees.variant[k]!
          const m = models[vi]!
          const sc = trees.scale[k]!
          const yaw = trees.yaw[k]!
          const cy = Math.cos(yaw)
          const sy = Math.sin(yaw)
          const y = trees.y[k]!
          if (d < d0 + margin && counts0[vi]! < near[vi]!.capacity) near[vi]!.set(counts0[vi]!++, x, y, z, sc, cy, sy, trees.tint[k]!, trees.phase[k]!)
          if (d > d0 - F - margin && counts1[vi]! < mid[vi]!.capacity) mid[vi]!.set(counts1[vi]!++, x, y, z, sc, cy, sy, trees.tint[k]!, trees.phase[k]!)
          if (d < COLLIDER_RADIUS && slot < COLLIDER_SLOTS && m.kind !== "sapling") {
            const r = Math.max(0.12, m.baseRadius * sc * 0.9)
            const b = pool[slot++]!
            b.min[0] = x - r
            b.min[1] = y - 1
            b.min[2] = z - r
            b.max[0] = x + r
            b.max[1] = y + Math.min(6, m.trunkTop * sc)
            b.max[2] = z + r
          }
        }
      }
    }
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
    // Nothing past the point where the ground fog leaves under 1 % of a silhouette's contrast.
    const fog = Number(s["fog.density"] ?? 0)
    bands.lod2.hi.value = fog > 0 ? Math.min(num("forest.far"), 4.5 / fog) : num("forest.far")
    const sh = num("forest.shadows")
    for (const l of near) {
      l.meshes[0]!.castShadow = sh >= 1
      l.meshes[1]!.castShadow = sh >= 2
    }
  }
  applySettings()
  const sig = () => ["forest.lod0", "forest.lod1", "forest.fade", "forest.wind", "forest.far", "forest.shadows"].map(num).join(",") + s["fog.density"]
  let lastSig = sig()

  ;(globalThis as { __forest?: unknown }).__forest = {
    trees: trees.count,
    genMs: +tGen.toFixed(1),
    stats: () => ({ lod0: lastLod0, lod1: lastLod1, far: far.count }),
  }
  void IMPOSTOR
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
      if (Math.hypot(p.x - last.x, p.z - last.z) > 3) {
        last.copy(p)
        rebuild(p.x, p.z)
      }
      undergrowth.update(dt, time, camera)
    },
  }
}

function countWhere(trees: Trees, f: (k: number) => boolean) {
  let n = 0
  for (let k = 0; k < trees.count; k++) if (f(k)) n++
  return n
}
