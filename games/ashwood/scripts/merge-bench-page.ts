// Standalone bench (scripts/merge-bench.html), not part of the game: places 41 groups of 5 props three ways and
// counts the node builds / pipelines WebGPURenderer creates for them.
//   ?mode=small   InstancedMesh with count 5 (the old instanceModel)
//   ?mode=inst    instanceModel (capacity ≥ 1025)
//   ?mode=merge   mergeModels (plain meshes per shared material)
// Driven by scripts/merge-bench.ts.
import * as THREE from "three/webgpu"
import { MODELS, initModels, instanceModel, loadModel, mergeModels, type ModelName } from "../src/render/models"

const mode = new URLSearchParams(location.search).get("mode") ?? "merge"
const status = { ready: false, errors: [] as string[], stats: null as unknown }
;(globalThis as { __bench?: typeof status }).__bench = status
addEventListener("error", (e) => status.errors.push(String((e as ErrorEvent).message)))
addEventListener("unhandledrejection", (e) => status.errors.push(String((e as PromiseRejectionEvent).reason)))

const renderer = new THREE.WebGPURenderer({ canvas: document.querySelector<HTMLCanvasElement>("#c")!, antialias: false })
await renderer.init()
initModels(renderer)
renderer.setSize(640, 400, false)
const scene = new THREE.Scene()
scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1))
const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500)
camera.position.set(0, 25, 45)
camera.lookAt(0, 0, 0)
type Internals = { _nodes: { nodeBuilderCache: Map<unknown, unknown> }; _pipelines: { caches: Map<unknown, unknown>; programs: { vertex: Map<unknown, unknown>; fragment: Map<unknown, unknown> } } }
const r = renderer as unknown as Internals
const counts = () => ({ nodeBuilds: r._nodes.nodeBuilderCache.size, vertex: r._pipelines.programs.vertex.size, fragment: r._pipelines.programs.fragment.size, pipelines: r._pipelines.caches.size })
renderer.render(scene, camera)
const base = counts()

const names: ModelName[] = ["pallet", "drum_steel", "drum_hazard", "crate_wood", "milk_crate", "cardboard_box", "traffic_cone", "trashbag", "tyre", "stack_chair", "filing_cabinet"]
const groups = Array.from({ length: 41 }, (_, g) => ({
  name: names[g % names.length]!,
  placements: Array.from({ length: 5 }, (_, k) => ({ position: [((g % 7) - 3) * 6 + k * 1.1, 0, (Math.floor(g / 7) - 3) * 6] as const, yaw: k })),
}))
const t0 = performance.now()
if (mode === "merge") {
  const all = groups.flatMap((g) => g.placements.map((p) => ({ ...p, name: g.name })))
  const m = mergeModels(all)
  await m.userData.ready
  scene.add(m)
} else if (mode === "inst") {
  for (const g of groups) scene.add(await instanceModel(g.name, g.placements))
} else {
  for (const g of groups) {
    const t = await loadModel(g.name)
    t.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, g.placements.length)
      g.placements.forEach((p, i) => inst.setMatrixAt(i, new THREE.Matrix4().makeRotationY(p.yaw).setPosition(p.position[0], p.position[1], p.position[2])))
      scene.add(inst)
    })
  }
}
let draws = 0
scene.traverse((o) => (draws += (o as THREE.Mesh).isMesh ? 1 : 0))
renderer.render(scene, camera)
const after = counts()
status.stats = {
  mode,
  meshes: draws,
  nodeBuilds: after.nodeBuilds - base.nodeBuilds,
  vertexPrograms: after.vertex - base.vertex,
  fragmentPrograms: after.fragment - base.fragment,
  pipelines: after.pipelines - base.pipelines,
  ms: Math.round(performance.now() - t0),
  models: Object.keys(MODELS).length,
}
status.ready = true
