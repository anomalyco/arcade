// Browser microbenchmarks (bundled by bench/browser-bench.ts, run headless):
//   __bench.gen()      generator suite in V8 (JS vs Rust/WASM vs WASM SIMD)
//   __bench.worker()   the same JS terrain bake in a module Worker: startup + bake + transfer back
//   __bench.draws(cfg) CPU cost per frame of N draws through three r186 (Mesh, BundleGroup, InstancedMesh,
//                      BatchedMesh) vs a raw WebGPU loop and a raw WebGPU render bundle
import * as THREE from "three/webgpu"
import { attribute, color, positionLocal, uniform } from "three/tsl"
import { runSuite, terrainInput } from "../kernels/gen-suite"
import { createTerrain, GRID_N } from "../kernels/terrain-js"

const canvas = document.querySelector("canvas")!
const W = 1536
const H = 1024
canvas.width = W
canvas.height = H
const now = () => performance.now()
const med = (a: number[]) => +[...a].sort((x, y) => x - y)[a.length >> 1]!.toFixed(4)

async function gen() {
  const [scalar, simd] = await Promise.all(["terrain.wasm", "terrain-simd.wasm"].map((f) => fetch(f).then((r) => r.arrayBuffer())))
  // Network + compile of the module the way a page would load it.
  const t = now()
  await WebAssembly.compileStreaming(fetch("terrain.wasm"))
  const compileStreamingMs = now() - t
  return { runtime: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0], compileStreamingMs: +compileStreamingMs.toFixed(2), ...(await runSuite({ scalar: scalar!, simd: simd! })) }
}

/** First (cold, unoptimised) run of each on the main thread: what a one-shot boot-time bake actually costs. */
async function cold() {
  const inp = terrainInput()
  let t = now()
  createTerrain(inp).bake()
  const jsMs = now() - t
  t = now()
  const { instance } = await WebAssembly.instantiateStreaming(fetch("terrain-simd.wasm"), {})
  const w = instance.exports as any
  const setup = now() - t
  const v = new Float64Array(w.memory.buffer, w.input_ptr(), 8192)
  const na = inp.access.length / 2
  v.set([inp.worldHalf, inp.accessHalfWidth, inp.countyHalfWidth, ...inp.fence, ...inp.apron, na, inp.county.length / 2])
  v.set(inp.access, 13)
  v.set(inp.county, 13 + na * 2)
  w.bake()
  new Float32Array(w.memory.buffer, w.coarse_ptr(), GRID_N * GRID_N).slice()
  return { jsColdBakeMs: +jsMs.toFixed(2), wasmColdInstantiateMs: +setup.toFixed(2), wasmColdTotalMs: +(now() - t).toFixed(2) }
}

async function worker() {
  const runs: { mode: string; totalMs: number; startupMs: number; setupMs: number; bakeMs: number; transferBackMs: number }[] = []
  // Cold main-thread bake for comparison (first call in this page, before gen() warmed anything up is not
  // guaranteed; run worker() first for a cold number).
  for (let i = 0; i < 6; i++) {
    const mode = i % 2 ? "wasm" : "js"
    const abs = () => performance.timeOrigin + now()
    const t0 = abs()
    const w = new Worker("gen-worker.js", { type: "module" })
    const r = await new Promise<any>((res) => {
      w.onmessage = (e) => res({ ...e.data, recv: abs() })
      w.postMessage({ input: terrainInput(), mode })
    })
    runs.push({ mode, setupMs: +r.setupMs.toFixed(2), totalMs: +(r.recv - t0).toFixed(2), startupMs: +(r.started - t0).toFixed(2), bakeMs: +r.bakeMs.toFixed(2), transferBackMs: +(r.recv - r.posted).toFixed(3) })
    w.terminate()
  }
  return runs
}

// ------------------------------------------------------------------------------------------------- draws

type Mode = "three-mesh" | "three-bundle" | "three-instanced" | "three-batched" | "raw" | "raw-bundle"

let renderer: THREE.WebGPURenderer | null = null
async function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
    await renderer.init()
    renderer.setSize(W, H, false)
  }
  return renderer
}

const MATS = 16
const GEOS = 8
function layout(n: number, i: number) {
  const side = Math.ceil(Math.sqrt(n))
  return [((i % side) / side - 0.5) * 40, ((Math.floor(i / side) / side) - 0.5) * 26, -30] as const
}

async function drawsThree(mode: Mode, n: number, frames: number) {
  const r = await getRenderer()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200)
  scene.add(new THREE.DirectionalLight(0xffffff, 2), new THREE.AmbientLight(0x404040))
  const geos = Array.from({ length: GEOS }, (_, g) => new THREE.BoxGeometry(0.3, 0.3, 0.3, 1 + g, 1, 1))
  const mats = Array.from({ length: MATS }, (_, m) => {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 })
    mat.colorNode = color(new THREE.Color().setHSL(m / MATS, 0.6, 0.5))
    return mat
  })
  const root = mode === "three-bundle" ? new THREE.BundleGroup() : new THREE.Group()
  scene.add(root)
  const m4 = new THREE.Matrix4()
  if (mode === "three-mesh" || mode === "three-bundle") {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(geos[i % GEOS], mats[i % MATS])
      mesh.position.set(...layout(n, i))
      root.add(mesh)
    }
  } else if (mode === "three-instanced") {
    for (let m = 0; m < MATS; m++) {
      const count = Math.ceil(n / MATS)
      const im = new THREE.InstancedMesh(geos[m % GEOS]!, mats[m]!, count)
      for (let k = 0; k < count; k++) im.setMatrixAt(k, m4.makeTranslation(...layout(n, k * MATS + m)))
      root.add(im)
    }
  } else if (mode === "three-batched") {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 })
    const bm = new THREE.BatchedMesh(n, n * 200, n * 400, mat)
    const ids = geos.map((g) => bm.addGeometry(g))
    const c = new THREE.Color()
    for (let i = 0; i < n; i++) {
      const id = bm.addInstance(ids[i % GEOS]!)
      bm.setMatrixAt(id, m4.makeTranslation(...layout(n, i)))
      bm.setColorAt(id, c.setHSL((i % MATS) / MATS, 0.6, 0.5))
    }
    root.add(bm)
  }
  await r.compileAsync(scene, camera)
  const device: GPUDevice = (r.backend as any).device
  for (let i = 0; i < 20; i++) r.render(scene, camera)
  await device.queue.onSubmittedWorkDone()
  const cpu: number[] = []
  for (let f = 0; f < frames; f++) {
    // Something moves every frame like in the game (a uniform-only change).
    const t = now()
    r.render(scene, camera)
    cpu.push(now() - t)
    if (f % 8 === 7) await device.queue.onSubmittedWorkDone()
  }
  const t0 = now()
  r.render(scene, camera)
  await device.queue.onSubmittedWorkDone()
  const serial = now() - t0
  const draws = r.info.render.drawCalls
  scene.traverse((o: any) => o.dispose?.())
  for (const g of geos) g.dispose()
  for (const m of mats) m.dispose()
  return { cpuMsPerFrame: med(cpu), drawCalls: draws, serialFrameMs: +serial.toFixed(3) }
}

const WGSL = /* wgsl */ `
struct Cam { viewProj: mat4x4f, lightDir: vec4f };
struct Obj { model: mat4x4f, color: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<uniform> obj: Obj;
struct VOut { @builtin(position) pos: vec4f, @location(0) n: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  o.pos = cam.viewProj * obj.model * vec4f(p, 1.0);
  o.n = (obj.model * vec4f(n, 0.0)).xyz;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let l = max(dot(normalize(i.n), cam.lightDir.xyz), 0.0) * 0.8 + 0.2;
  return vec4f(obj.color.rgb * l, 1.0);
}`

async function drawsRaw(mode: Mode, n: number, frames: number) {
  const r = await getRenderer()
  const device: GPUDevice = (r.backend as any).device
  const ctx = (r.backend as any).context as GPUCanvasContext
  const format = navigator.gpu.getPreferredCanvasFormat()
  const module = device.createShaderModule({ code: WGSL })
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  })
  // Same geometries as the three path (GEOS boxes), interleaved position+normal.
  const geos = Array.from({ length: GEOS }, (_, g) => {
    const bg = new THREE.BoxGeometry(0.3, 0.3, 0.3, 1 + g, 1, 1)
    const p = bg.attributes.position!.array as Float32Array
    const nn = bg.attributes.normal!.array as Float32Array
    const v = new Float32Array((p.length / 3) * 6)
    for (let i = 0; i < p.length / 3; i++) v.set([p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, nn[i * 3]!, nn[i * 3 + 1]!, nn[i * 3 + 2]!], i * 6)
    const idx = new Uint32Array(bg.index!.array)
    const vb = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vb, 0, v)
    const ib = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(ib, 0, idx)
    return { vb, ib, count: idx.length }
  })
  const camBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200)
  camera.updateMatrixWorld()
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const camData = new Float32Array(20)
  camData.set(vp.elements)
  camData.set([0.3, 0.8, 0.5, 0], 16)
  const STRIDE = 256
  const objBuf = device.createBuffer({ size: n * STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const objData = new Float32Array((n * STRIDE) / 4)
  const m4 = new THREE.Matrix4()
  const c = new THREE.Color()
  for (let i = 0; i < n; i++) {
    objData.set(m4.makeTranslation(...layout(n, i)).elements, (i * STRIDE) / 4)
    c.setHSL((i % MATS) / MATS, 0.6, 0.5)
    objData.set([c.r, c.g, c.b, 1], (i * STRIDE) / 4 + 16)
  }
  const bg0 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: camBuf } }] })
  // One bind group per object (like three: each object has its own uniform group binding), not dynamic offsets.
  const objGroups = Array.from({ length: n }, (_, i) =>
    device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: objBuf, offset: i * STRIDE, size: 80 } }] }),
  )
  const depth = device.createTexture({ size: [W, H], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT })
  const depthView = depth.createView()
  const encodeDraws = (pass: GPURenderPassEncoder | GPURenderBundleEncoder) => {
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bg0)
    let lastGeo = -1
    for (let i = 0; i < n; i++) {
      const g = i % GEOS
      if (g !== lastGeo) {
        pass.setVertexBuffer(0, geos[g]!.vb)
        pass.setIndexBuffer(geos[g]!.ib, "uint32")
        lastGeo = g
      }
      pass.setBindGroup(1, objGroups[i]!)
      pass.drawIndexed(geos[g]!.count)
    }
  }
  let bundle: GPURenderBundle | null = null
  if (mode === "raw-bundle") {
    const be = device.createRenderBundleEncoder({ colorFormats: [format], depthStencilFormat: "depth24plus" })
    encodeDraws(be)
    bundle = be.finish()
  }
  const frame = () => {
    // Per frame: camera uniform + every object's uniform block (what three re-uploads for moving/ticking objects).
    device.queue.writeBuffer(camBuf, 0, camData)
    device.queue.writeBuffer(objBuf, 0, objData)
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      depthStencilAttachment: { view: depthView, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 },
    })
    if (bundle) pass.executeBundles([bundle])
    else encodeDraws(pass)
    pass.end()
    device.queue.submit([enc.finish()])
  }
  for (let i = 0; i < 20; i++) frame()
  await device.queue.onSubmittedWorkDone()
  const cpu: number[] = []
  for (let f = 0; f < frames; f++) {
    const t = now()
    frame()
    cpu.push(now() - t)
    if (f % 8 === 7) await device.queue.onSubmittedWorkDone()
  }
  const t0 = now()
  frame()
  await device.queue.onSubmittedWorkDone()
  const serial = now() - t0
  objBuf.destroy()
  depth.destroy()
  return { cpuMsPerFrame: med(cpu), drawCalls: n, serialFrameMs: +serial.toFixed(3) }
}

async function draws(cfg: { modes: Mode[]; ns: number[]; frames: number }) {
  const out: Record<string, Record<number, unknown>> = {}
  for (const mode of cfg.modes) {
    out[mode] = {}
    for (const n of cfg.ns) out[mode]![n] = mode.startsWith("raw") ? await drawsRaw(mode, n, cfg.frames) : await drawsThree(mode, n, cfg.frames)
  }
  return out
}

// ------------------------------------------------------------------------------------------------- compile
// What a boot pays per object kind: node builds (TSL → WGSL, main thread), shader modules and pipelines, for K props
// of 5 copies each drawn as InstancedMesh (count 5: three bakes a per-mesh uniform array into the vertex shader),
// InstancedMesh with capacity > 1024 (vertex-attribute path), plain merged Meshes, and per-prop material clones.
type Variant = "geom-instanced" | "instanced" | "instanced-1025" | "instanced-storage" | "merged-mesh" | "merged-mesh-cloned-mats" | "instanced-cloned-mats"
async function compile(cfg: { k: number; variants: Variant[] }) {
  const out: Record<string, unknown> = {}
  const tex = new THREE.DataTexture(new Uint8Array(64 * 64 * 4).fill(180), 64, 64)
  tex.needsUpdate = true
  for (const v of cfg.variants) {
    const c = document.createElement("canvas")
    c.width = 256
    c.height = 256
    const r = new THREE.WebGPURenderer({ canvas: c, antialias: false })
    await r.init()
    let builds = 0
    let buildMs = 0
    const nodes = (r as any)._nodes
    const create = nodes._createNodeBuilder
    nodes._createNodeBuilder = function (...a: any[]) {
      const b = create.apply(this, a)
      builds++
      for (const key of ["build", "buildAsync"]) {
        const f = b[key]
        if (!f) continue
        b[key] = function (...x: any[]) {
          const t = now()
          const res = f.apply(this, x)
          if (res?.then) return res.then((y: any) => ((buildMs += now() - t), y))
          buildMs += now() - t
          return res
        }
      }
      return b
    }
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
    camera.position.set(0, 0, 60)
    const base = new THREE.MeshStandardNodeMaterial({ map: tex, normalMap: tex, roughness: 0.7 })
    // Instancing done in the material from a named per-instance geometry attribute, on a plain Mesh: three's
    // render-object cache key then has no object uuid, so meshes sharing the material share one node build.
    if (v === "geom-instanced") base.positionNode = positionLocal.add(attribute("iOffset", "vec3"))
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const m4 = new THREE.Matrix4()
    for (let i = 0; i < cfg.k; i++) {
      const mat = v.includes("cloned") ? base.clone() : base
      const x = (i % 8) * 3 - 12
      const y = Math.floor(i / 8) * 3 - 8
      if (v === "geom-instanced") {
        const g = new THREE.InstancedBufferGeometry()
        g.index = geo.index
        for (const n of ["position", "normal", "uv"]) g.setAttribute(n, geo.attributes[n]!)
        const off = new Float32Array(15)
        for (let j = 0; j < 5; j++) off.set([x + j * 0.2, y, 0], j * 3)
        g.setAttribute("iOffset", new THREE.InstancedBufferAttribute(off, 3))
        g.instanceCount = 5
        scene.add(new THREE.Mesh(g, mat))
      } else if (v.startsWith("instanced")) {
        const cap = v === "instanced-1025" ? 1025 : 5
        const im = new THREE.InstancedMesh(geo, mat, cap)
        if (v === "instanced-storage") im.instanceMatrix = new THREE.StorageInstancedBufferAttribute(new Float32Array(cap * 16), 16) as any
        for (let j = 0; j < 5; j++) im.setMatrixAt(j, m4.makeTranslation(x + j * 0.2, y, 0))
        im.count = 5
        scene.add(im)
      } else {
        const parts = Array.from({ length: 5 }, (_, j) => geo.clone().translate(x + j * 0.2, y, 0))
        const merged = mergeBoxes(parts)
        scene.add(new THREE.Mesh(merged, mat))
      }
    }
    const t = now()
    await r.compileAsync(scene, camera)
    r.render(scene, camera)
    await (r.backend as any).device.queue.onSubmittedWorkDone()
    const wall = now() - t
    const P = (r as any)._pipelines
    out[v] = {
      objects: cfg.k,
      nodeBuilds: builds,
      nodeBuildMs: +buildMs.toFixed(1),
      vertexPrograms: P.programs.vertex.size,
      fragmentPrograms: P.programs.fragment.size,
      pipelines: P.caches.size,
      compileWallMs: +wall.toFixed(0),
    }
    r.dispose()
  }
  return out
}
function mergeBoxes(parts: THREE.BufferGeometry[]) {
  const out = new THREE.BufferGeometry()
  for (const name of ["position", "normal", "uv"]) {
    const arrays = parts.map((p) => p.attributes[name]!.array as Float32Array)
    const total = arrays.reduce((a, x) => a + x.length, 0)
    const merged = new Float32Array(total)
    let o = 0
    for (const a of arrays) merged.set(a, o), (o += a.length)
    out.setAttribute(name, new THREE.BufferAttribute(merged, parts[0]!.attributes[name]!.itemSize))
  }
  const idx: number[] = []
  let vo = 0
  for (const p of parts) {
    for (const i of p.index!.array) idx.push(i + vo)
    vo += p.attributes.position!.count
  }
  out.setIndex(idx)
  return out
}

;(globalThis as any).__bench = { cold, gen, worker, draws, compile, ready: true }
void uniform
