import {
  BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Mesh, Sphere, Vector3, type Material,
} from "three"
import { TILE_SIZE, WORLD_HALF, tileHasTerrain } from "../../sim/geography"
import type { WorldQualitySettings } from "./settings"
import {
  SHORE_SIZE, TREE_KINDS, buildTileIndex, generateShoreRows, generateTile, generateTrees,
  type TileData, type TreeData,
} from "./tile-gen"
import type { WorkerRequest } from "./terrain-worker"
import type { TreeResources } from "./trees"

type WorkerResult =
  | { type: "tile"; id: number; data: TileData }
  | { type: "trees"; id: number; data: TreeData }
  | { type: "shore"; id: number; z0: number; z1: number; rows: Uint8Array }

interface Backend {
  post(req: WorkerRequest): void
  /** Main-thread fallback runs queued work here; worker backend does nothing. */
  pump(deadline: number): void
  dispose(): void
}

function createBackend(onResult: (r: WorkerResult) => void): Backend {
  try {
    if (typeof Worker === "undefined") throw new Error("no worker")
    const worker = new Worker(new URL("./terrain-worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<WorkerResult>) => onResult(e.data)
    return { post: req => worker.postMessage(req), pump() {}, dispose: () => worker.terminate() }
  } catch {
    // Main-thread fallback: same generators, run inside the per-frame budget.
    const queue: WorkerRequest[] = []
    return {
      post: req => queue.push(req),
      pump(deadline) {
        while (queue.length && performance.now() < deadline) {
          const req = queue.shift()!
          if (req.type === "tile") onResult({ type: "tile", id: req.id, data: generateTile(req.tx, req.tz, req.segments) })
          else if (req.type === "trees") onResult({ type: "trees", id: req.id, data: generateTrees(req.tx, req.tz, req.max) })
          else onResult({ type: "shore", id: req.id, z0: req.z0, z1: req.z1, rows: generateShoreRows(req.z0, req.z1) })
        }
      },
      dispose() { queue.length = 0 },
    }
  }
}

interface Tile {
  tx: number; tz: number
  mesh: Mesh | null
  segments: number
  pending: number // segments requested, 0 = none
  wantSeg: number
  visible: boolean
  dist: number
  lastWanted: number
  trees: InstancedMesh[] | null
  treesPending: boolean
  wantTrees: boolean
  treeDetail: boolean
}

const SEGMENT_LEVELS = [64, 32, 16, 8]
const SHORE_CHUNK = 64

export interface StreamerStats {
  tiles: number; visibleTiles: number; pending: number; trees: number; triangles: number; lastWorkMs: number; maxWorkMs: number
}

export class TerrainStreamer {
  readonly terrainRoot = new Group()
  readonly treeRoot = new Group()
  private tiles: Tile[] = []
  private indices = new Map<number, BufferAttribute>()
  private backend: Backend
  private jobs = new Map<number, { tile: Tile | null; kind: WorkerRequest["type"] }>()
  private results: WorkerResult[] = []
  private nextId = 1
  private planPos = new Vector3(Infinity, 0, Infinity)
  private planTime = -Infinity
  private camera = new Vector3()
  private elapsed = 0
  private shoreNext = 0
  private shoreDone = 0
  private disposed = false
  stats: StreamerStats = { tiles: 0, visibleTiles: 0, pending: 0, trees: 0, triangles: 0, lastWorkMs: 0, maxWorkMs: 0 }

  constructor(
    private settings: WorldQualitySettings,
    private material: Material,
    private treeRes: TreeResources,
    private onShoreRows: (z0: number, z1: number, rows: Uint8Array) => void,
  ) {
    this.terrainRoot.name = "World · terrain tiles"
    this.treeRoot.name = "World · trees"
    const n = WORLD_HALF / TILE_SIZE
    for (let tz = -n; tz < n; tz++) for (let tx = -n; tx < n; tx++) {
      if (!tileHasTerrain(tx, tz)) continue
      this.tiles.push({ tx, tz, mesh: null, segments: 0, pending: 0, wantSeg: 8, visible: false, dist: Infinity, lastWanted: 0,
        trees: null, treesPending: false, wantTrees: false, treeDetail: false })
    }
    for (const s of SEGMENT_LEVELS) this.indices.set(s, new BufferAttribute(buildTileIndex(s), 1))
    this.backend = createBackend(r => this.results.push(r))
  }

  setSettings(settings: WorldQualitySettings) {
    this.settings = settings
    // Tree density changed: rebuild trees lazily.
    for (const t of this.tiles) this.dropTrees(t)
    this.planTime = -Infinity
  }

  get shoreProgress() { return this.shoreDone / (SHORE_SIZE / SHORE_CHUNK) }

  ready(): boolean {
    let ok = this.tiles.length > 0
    for (const t of this.tiles) if (t.dist < 3000 && (t.segments === 0 || t.segments < t.wantSeg)) { ok = false; break }
    return ok
  }

  update(cam: Vector3, dt: number) {
    if (this.disposed) return
    this.elapsed += dt
    this.camera.copy(cam)
    const start = performance.now()
    const moved = Math.hypot(cam.x - this.planPos.x, cam.z - this.planPos.z, (cam.y - this.planPos.y) * 0.5)
    if (moved > 90 || this.elapsed - this.planTime > 0.75) this.plan()
    this.dispatch()
    const deadline = start + this.settings.budgetMs
    this.backend.pump(deadline)
    while (this.results.length && performance.now() < deadline) this.apply(this.results.shift()!)
    const ms = performance.now() - start
    this.stats.lastWorkMs = ms
    this.stats.maxWorkMs = Math.max(this.stats.maxWorkMs * 0.995, ms)
  }

  private lodFor(eff: number): number {
    const [a, b, c] = this.settings.lod
    return eff < a ? 64 : eff < b ? 32 : eff < c ? 16 : 8
  }

  private plan() {
    this.planPos.copy(this.camera)
    this.planTime = this.elapsed
    const cam = this.camera, s = this.settings
    const alt = Math.max(0, cam.y - 150) * 0.6
    let visibleTiles = 0, trees = 0, triangles = 0
    for (const t of this.tiles) {
      const x0 = t.tx * TILE_SIZE, z0 = t.tz * TILE_SIZE
      const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - TILE_SIZE)
      const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - TILE_SIZE)
      const d = Math.hypot(dx, dz)
      t.dist = d
      const eff = Math.hypot(d, alt)
      let want = this.lodFor(eff)
      // Hysteresis: keep a finer mesh until we're clearly past its threshold.
      if (t.segments > want && this.lodFor(Math.max(0, eff - 180)) >= t.segments) want = t.segments
      t.wantSeg = want
      t.visible = d < s.viewRadius
      if (t.visible) t.lastWanted = this.elapsed
      if (t.mesh) { t.mesh.visible = t.visible; if (t.visible) { visibleTiles++; triangles += t.segments * t.segments * 2 } }
      t.wantTrees = d < s.treeRadius && cam.y < 5000
      if (!t.wantTrees && t.trees && d > s.treeRadius + 300) this.dropTrees(t)
      if (t.trees) {
        const detail = d < s.treeDetailRadius
        if (detail !== t.treeDetail) {
          t.treeDetail = detail
          for (const m of t.trees) m.geometry = (detail ? this.treeRes.detailed : this.treeRes.simple)[m.userData.kind as number]
        }
        for (const m of t.trees) { m.visible = t.wantTrees || d < s.treeRadius + 300; trees += m.count }
      }
      // Evict long-unwanted meshes.
      if (t.mesh && !t.visible && this.elapsed - t.lastWanted > 20) {
        this.terrainRoot.remove(t.mesh)
        t.mesh.geometry.dispose()
        t.mesh = null
        t.segments = 0
      }
    }
    this.treeRes.fade.value = [Math.max(0, s.treeRadius - 450), s.treeRadius - 40]
    this.stats.tiles = this.tiles.filter(t => t.mesh).length
    this.stats.visibleTiles = visibleTiles
    this.stats.trees = trees
    this.stats.triangles = triangles
  }

  private dispatch() {
    const cap = this.settings.inflight
    while (this.jobs.size < cap) {
      let best: Tile | null = null, bestKind: "tile" | "trees" = "tile", score = Infinity
      for (const t of this.tiles) {
        if (!t.visible) continue
        if (!t.pending && t.segments !== t.wantSeg) {
          const p = t.dist + (t.mesh ? 2500 : 0)
          if (p < score) { score = p; best = t; bestKind = "tile" }
        } else if (t.wantTrees && !t.trees && !t.treesPending && t.segments > 0) {
          const p = t.dist + 900
          if (p < score) { score = p; best = t; bestKind = "trees" }
        }
      }
      const shoreScore = 2200 + this.shoreNext * 250
      if (this.shoreNext * SHORE_CHUNK < SHORE_SIZE && shoreScore < score) {
        const id = this.nextId++
        const z0 = this.shoreNext * SHORE_CHUNK
        this.shoreNext++
        this.jobs.set(id, { tile: null, kind: "shore" })
        this.backend.post({ type: "shore", id, z0, z1: z0 + SHORE_CHUNK })
        continue
      }
      if (!best) break
      const id = this.nextId++
      if (bestKind === "tile") {
        // Fresh tiles first get a cheap silhouette so the area fills quickly.
        const seg = !best.mesh && best.wantSeg > 16 && best.dist > 1500 ? 16 : best.wantSeg
        best.pending = seg
        this.jobs.set(id, { tile: best, kind: "tile" })
        this.backend.post({ type: "tile", id, tx: best.tx, tz: best.tz, segments: seg })
      } else {
        best.treesPending = true
        this.jobs.set(id, { tile: best, kind: "trees" })
        this.backend.post({ type: "trees", id, tx: best.tx, tz: best.tz, max: this.settings.treesPerTile })
      }
    }
    this.stats.pending = this.jobs.size
  }

  private apply(r: WorkerResult) {
    const job = this.jobs.get(r.id)
    this.jobs.delete(r.id)
    if (r.type === "shore") {
      this.shoreDone++
      this.onShoreRows(r.z0, r.z1, r.rows)
      return
    }
    const t = job?.tile
    if (!t) return
    if (r.type === "tile") {
      t.pending = 0
      const data = r.data
      const geometry = new BufferGeometry()
      geometry.setAttribute("position", new BufferAttribute(data.positions, 3))
      geometry.setAttribute("normal", new BufferAttribute(data.normals, 3, true))
      geometry.setAttribute("forest", new BufferAttribute(data.forest, 1, true))
      geometry.setIndex(this.indices.get(data.segments)!)
      const half = TILE_SIZE / 2, cy = (data.minY + data.maxY) / 2
      geometry.boundingSphere = new Sphere(new Vector3(half, cy, half), Math.hypot(half * Math.SQRT2, (data.maxY - data.minY) / 2))
      if (t.mesh) {
        t.mesh.geometry.dispose()
        t.mesh.geometry = geometry
      } else {
        t.mesh = new Mesh(geometry, this.material)
        t.mesh.name = `tile ${t.tx},${t.tz}`
        t.mesh.position.set(t.tx * TILE_SIZE, 0, t.tz * TILE_SIZE)
        t.mesh.matrixAutoUpdate = false
        t.mesh.updateMatrix()
        this.terrainRoot.add(t.mesh)
      }
      t.mesh.visible = t.visible
      t.segments = data.segments
    } else {
      t.treesPending = false
      if (!t.wantTrees || this.disposed) return
      this.dropTrees(t)
      const meshes: InstancedMesh[] = []
      t.treeDetail = t.dist < this.settings.treeDetailRadius
      for (let k = 0; k < TREE_KINDS; k++) {
        const count = r.data.counts[k]
        if (!count) continue
        const geo = (t.treeDetail ? this.treeRes.detailed : this.treeRes.simple)[k]
        const mesh = new InstancedMesh(geo, this.treeRes.material, count)
        mesh.instanceMatrix = new InstancedBufferAttribute(r.data.matrices[k], 16)
        mesh.instanceColor = new InstancedBufferAttribute(r.data.colors[k], 3)
        mesh.userData.kind = k
        mesh.position.set(t.tx * TILE_SIZE, 0, t.tz * TILE_SIZE)
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        mesh.computeBoundingSphere()
        if (mesh.boundingSphere) mesh.boundingSphere.radius += 12
        this.treeRoot.add(mesh)
        meshes.push(mesh)
      }
      t.trees = meshes
    }
  }

  private dropTrees(t: Tile) {
    if (!t.trees) return
    for (const m of t.trees) { this.treeRoot.remove(m); m.dispose() }
    t.trees = null
  }

  debugJobs() {
    return [...this.jobs.entries()].map(([id, j]) => ({ id, kind: j.kind, tile: j.tile && { tx: j.tile.tx, tz: j.tile.tz, seg: j.tile.segments, want: j.tile.wantSeg, pending: j.tile.pending, vis: j.tile.visible } }))
  }

  /** For tests/diagnostics. */
  tileSummary() {
    return this.tiles.filter(t => t.mesh).map(t => ({ tx: t.tx, tz: t.tz, segments: t.segments, visible: t.visible }))
  }

  dispose() {
    this.disposed = true
    this.backend.dispose()
    for (const t of this.tiles) {
      if (t.mesh) { this.terrainRoot.remove(t.mesh); t.mesh.geometry.dispose() }
      this.dropTrees(t)
    }
    this.results.length = 0
  }
}
