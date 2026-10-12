import {
  BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Mesh, Sphere, Vector3, type Material,
} from "three"
import type { WorldQualitySettings } from "./settings"
import {
  CLUSTER_N, CLUSTER_SIZE, SHORE_SIZE, TREE_KINDS, clusterOrigin, generateCluster, generateShoreRows,
  generateTrees, type ClusterData, type TreeData,
} from "./tile-gen"
import type { WorkerRequest } from "./terrain-worker"
import type { TreeResources } from "./trees"

type WorkerResult =
  | { type: "cluster"; id: number; data: ClusterData }
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
          if (req.type === "cluster") onResult({ type: "cluster", id: req.id, data: generateCluster(req.cx, req.cz, req.lod) })
          else if (req.type === "trees") onResult({ type: "trees", id: req.id, data: generateTrees(req.cx, req.cz, req.max) })
          else onResult({ type: "shore", id: req.id, z0: req.z0, z1: req.z1, rows: generateShoreRows(req.z0, req.z1) })
        }
      },
      dispose() { queue.length = 0 },
    }
  }
}

interface Cluster {
  cx: number; cz: number
  mesh: Mesh | null
  lod: number // -1 = none
  pending: number // lod requested, -1 = none
  wantLod: number
  visible: boolean
  dist: number
  lastWanted: number
  trees: InstancedMesh[] | null
  treesPending: boolean
  wantTrees: boolean
}

const SHORE_CHUNK = 64

export interface StreamerStats {
  clusters: number; visibleClusters: number; pending: number; trees: number; triangles: number; lastWorkMs: number; maxWorkMs: number
}

export class TerrainStreamer {
  readonly terrainRoot = new Group()
  readonly treeRoot = new Group()
  private clusters: Cluster[] = []
  private backend: Backend
  private jobs = new Map<number, { cluster: Cluster | null; kind: WorkerRequest["type"] }>()
  private results: WorkerResult[] = []
  private nextId = 1
  private planPos = new Vector3(Infinity, 0, Infinity)
  private planTime = -Infinity
  private camera = new Vector3()
  private elapsed = 0
  private shoreNext = 0
  private shoreDone = 0
  private disposed = false
  stats: StreamerStats = { clusters: 0, visibleClusters: 0, pending: 0, trees: 0, triangles: 0, lastWorkMs: 0, maxWorkMs: 0 }

  constructor(
    private settings: WorldQualitySettings,
    private material: Material,
    private treeRes: TreeResources,
    private onShoreRows: (z0: number, z1: number, rows: Uint8Array) => void,
  ) {
    this.terrainRoot.name = "World · terrain clusters"
    this.treeRoot.name = "World · trees"
    for (let cz = 0; cz < CLUSTER_N; cz++) for (let cx = 0; cx < CLUSTER_N; cx++) {
      this.clusters.push({ cx, cz, mesh: null, lod: -1, pending: -1, wantLod: 3, visible: false, dist: Infinity, lastWanted: 0,
        trees: null, treesPending: false, wantTrees: false })
    }
    this.backend = createBackend(r => this.results.push(r))
  }

  setSettings(settings: WorldQualitySettings) {
    this.settings = settings
    for (const c of this.clusters) this.dropTrees(c)
    this.planTime = -Infinity
  }

  get shoreProgress() { return this.shoreDone / (SHORE_SIZE / SHORE_CHUNK) }

  ready(): boolean {
    if (this.clusters.length === 0) return false
    for (const c of this.clusters) if (c.dist < 2500 && (c.lod < 0 || c.lod > c.wantLod)) return false
    return true
  }

  update(cam: Vector3, dt: number) {
    if (this.disposed) return
    this.elapsed += dt
    this.camera.copy(cam)
    const start = performance.now()
    const moved = Math.hypot(cam.x - this.planPos.x, cam.z - this.planPos.z, (cam.y - this.planPos.y) * 0.5)
    if (moved > 120 || this.elapsed - this.planTime > 1) this.plan()
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
    return eff < a ? 0 : eff < b ? 1 : eff < c ? 2 : 3
  }

  private plan() {
    this.planPos.copy(this.camera)
    this.planTime = this.elapsed
    const cam = this.camera, s = this.settings
    const alt = Math.max(0, cam.y - 300) * 0.5
    let visible = 0, trees = 0, triangles = 0, resident = 0
    for (const c of this.clusters) {
      const [x0, z0] = clusterOrigin(c.cx, c.cz)
      const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - CLUSTER_SIZE)
      const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - CLUSTER_SIZE)
      const d = Math.hypot(dx, dz)
      c.dist = d
      const eff = Math.hypot(d, alt)
      let want = this.lodFor(eff)
      // Hysteresis: keep a finer mesh until clearly past its threshold.
      if (c.lod >= 0 && c.lod < want && this.lodFor(Math.max(0, eff - 250)) <= c.lod) want = c.lod
      c.wantLod = want
      c.visible = d < s.viewRadius
      if (c.visible) c.lastWanted = this.elapsed
      if (c.mesh) {
        resident++
        c.mesh.visible = c.visible
        if (c.visible) { visible++; triangles += (c.mesh.geometry.index?.count ?? 0) / 3 }
      }
      c.wantTrees = d < s.treeRadius && cam.y < 4500
      if (!c.wantTrees && c.trees && d > s.treeRadius + 400) this.dropTrees(c)
      if (c.trees) for (const m of c.trees) { m.visible = c.wantTrees || d < s.treeRadius + 400; trees += m.count }
      if (c.mesh && !c.visible && this.elapsed - c.lastWanted > 30) {
        this.terrainRoot.remove(c.mesh)
        c.mesh.geometry.dispose()
        c.mesh = null
        c.lod = -1
      }
    }
    this.treeRes.fade.value = [Math.max(0, s.treeRadius - 600), s.treeRadius - 60]
    this.stats.clusters = resident
    this.stats.visibleClusters = visible
    this.stats.trees = trees
    this.stats.triangles = triangles
  }

  private dispatch() {
    const cap = this.settings.inflight
    while (this.jobs.size < cap) {
      let best: Cluster | null = null, bestKind: "cluster" | "trees" = "cluster", score = Infinity
      for (const c of this.clusters) {
        if (!c.visible) continue
        if (c.pending < 0 && c.lod !== c.wantLod) {
          const p = c.dist + (c.mesh ? 3000 : 0)
          if (p < score) { score = p; best = c; bestKind = "cluster" }
        } else if (c.wantTrees && !c.trees && !c.treesPending && c.lod === 0) {
          const p = c.dist + 1200
          if (p < score) { score = p; best = c; bestKind = "trees" }
        }
      }
      const shoreScore = 2500 + this.shoreNext * 300
      if (this.shoreNext * SHORE_CHUNK < SHORE_SIZE && shoreScore < score) {
        const id = this.nextId++
        const z0 = this.shoreNext * SHORE_CHUNK
        this.shoreNext++
        this.jobs.set(id, { cluster: null, kind: "shore" })
        this.backend.post({ type: "shore", id, z0, z1: z0 + SHORE_CHUNK })
        continue
      }
      if (!best) break
      const id = this.nextId++
      if (bestKind === "cluster") {
        // Fresh distant clusters first get a cheap silhouette so the horizon fills quickly.
        const lod = !best.mesh && best.wantLod < 2 && best.dist > 1000 ? 2 : best.wantLod
        best.pending = lod
        this.jobs.set(id, { cluster: best, kind: "cluster" })
        this.backend.post({ type: "cluster", id, cx: best.cx, cz: best.cz, lod })
      } else {
        best.treesPending = true
        this.jobs.set(id, { cluster: best, kind: "trees" })
        this.backend.post({ type: "trees", id, cx: best.cx, cz: best.cz, max: this.settings.treesPerCluster })
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
    const c = job?.cluster
    if (!c || this.disposed) return
    const [x0, z0] = clusterOrigin(c.cx, c.cz)
    if (r.type === "cluster") {
      c.pending = -1
      const data = r.data
      const geometry = new BufferGeometry()
      geometry.setAttribute("position", new BufferAttribute(data.positions, 3))
      geometry.setAttribute("normal", new BufferAttribute(data.normals, 3, true))
      geometry.setAttribute("color", new BufferAttribute(data.colors, 3, true))
      geometry.setIndex(new BufferAttribute(data.index, 1))
      const half = CLUSTER_SIZE / 2, cy = (data.minY + data.maxY) / 2
      geometry.boundingSphere = new Sphere(new Vector3(x0 + half, cy, z0 + half), Math.hypot(half * Math.SQRT2, (data.maxY - data.minY) / 2))
      if (c.mesh) {
        c.mesh.geometry.dispose()
        c.mesh.geometry = geometry
      } else {
        c.mesh = new Mesh(geometry, this.material)
        c.mesh.name = `cluster ${c.cx},${c.cz}`
        c.mesh.matrixAutoUpdate = false
        c.mesh.updateMatrix()
        c.mesh.receiveShadow = true
        this.terrainRoot.add(c.mesh)
      }
      c.mesh.visible = c.visible
      c.lod = data.lod
    } else {
      c.treesPending = false
      if (!c.wantTrees) return
      this.dropTrees(c)
      const meshes: InstancedMesh[] = []
      for (let k = 0; k < TREE_KINDS; k++) {
        const count = r.data.counts[k]
        if (!count) continue
        const mesh = new InstancedMesh(this.treeRes.geometries[k], this.treeRes.material, count)
        mesh.instanceMatrix = new InstancedBufferAttribute(r.data.matrices[k], 16)
        mesh.instanceColor = new InstancedBufferAttribute(r.data.colors[k], 3)
        mesh.position.set(x0, 0, z0)
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        mesh.computeBoundingSphere()
        if (mesh.boundingSphere) mesh.boundingSphere.radius += 20
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.treeRoot.add(mesh)
        meshes.push(mesh)
      }
      c.trees = meshes
    }
  }

  private dropTrees(c: Cluster) {
    if (!c.trees) return
    for (const m of c.trees) { this.treeRoot.remove(m); m.dispose() }
    c.trees = null
  }

  debugJobs() {
    return [...this.jobs.entries()].map(([id, j]) => ({ id, kind: j.kind, cluster: j.cluster && { cx: j.cluster.cx, cz: j.cluster.cz, lod: j.cluster.lod, want: j.cluster.wantLod } }))
  }

  dispose() {
    this.disposed = true
    this.backend.dispose()
    for (const c of this.clusters) {
      if (c.mesh) { this.terrainRoot.remove(c.mesh); c.mesh.geometry.dispose() }
      this.dropTrees(c)
    }
    this.results.length = 0
  }
}
