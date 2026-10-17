// Boot trace of a frozen build: where boot time goes (main-thread CPU profile bucketed by activity), what WebGPU work
// it issues (shader modules, pipelines, texture/buffer uploads, with the GPU-process latency of async pipeline
// creation), how long three's TSL → WGSL node builds take, and a replay of every pipeline with fresh shader source
// (cache-busted) to measure the driver/Tint/Metal compile cost on its own.
//
//   bun bench/boot-trace.ts --dir $TMP/build-dev [--view road] [--cpu 4] [--profile out.cpuprofile]
import { writeFileSync } from "node:fs"
import { arg, launch, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/build-dev`)!
const view = arg(args, "view", "road")!
const cpuRate = Number(arg(args, "cpu", "1"))
const profileOut = arg(args, "profile")
const replay = !args.includes("--no-replay")
// A/B emulation of a fix (no game code changed): "attr" forces three's vertex-attribute instancing path for every
// InstancedMesh (≙ allocating ≥1025 instances: shared vertex programs/pipelines). Node builds stay per InstancedMesh
// (three keys them by object uuid); bench/pages/bench.ts `compile` measures the variants that share node builds.
const emulate = arg(args, "emulate", "")!
const port = 5222
const server = serve(dir, port)
const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))

await page.addInitScript((emulate: string) => {
  const g = globalThis as any
  const log = (g.__gpuLog = {
    modules: 0,
    moduleBytes: 0,
    moduleMs: 0,
    pipelinesSync: 0,
    pipelinesSyncMs: 0,
    pipelinesAsync: 0,
    asyncLatency: [] as number[],
    asyncCallMs: 0,
    computePipelines: 0,
    textures: 0,
    textureBytes: 0,
    writeTextureMs: 0,
    copyExternalMs: 0,
    copyExternalCount: 0,
    buffers: 0,
    bufferBytes: 0,
    writeBufferBytes: 0,
    descriptors: [] as any[],
    codeOf: new WeakMap<object, string>(),
    nodeBuilds: 0,
    buildsBy: {} as Record<string, number>,
    pipesBy: {} as Record<string, number>,
    nodeBuildSyncMs: 0,
    nodeBuildAsyncWallMs: 0,
    firstFrameAt: 0,
  })
const snap = (d: any) => ({
    ...d,
    vertex: d.vertex && { ...d.vertex, code: log.codeOf.get(d.vertex.module), buffers: (d.vertex.buffers ?? []).map((b: any) => b && { ...b, attributes: [...b.attributes].map((a: any) => ({ ...a })) }) },
    fragment: d.fragment && { ...d.fragment, code: log.codeOf.get(d.fragment.module), targets: [...d.fragment.targets].map((t: any) => t && { ...t, blend: t.blend && { color: { ...t.blend.color }, alpha: { ...t.blend.alpha } } }) },
    primitive: d.primitive && { ...d.primitive },
    depthStencil: d.depthStencil && { ...d.depthStencil, stencilFront: { ...d.depthStencil.stencilFront }, stencilBack: { ...d.depthStencil.stencilBack } },
    multisample: d.multisample && { ...d.multisample },
  })
  const D = GPUDevice.prototype as any
  const Q = GPUQueue.prototype as any
  const wrap = (proto: any, key: string, f: (orig: any) => any) => {
    const o = proto[key]
    proto[key] = f(o)
  }
  wrap(D, "createShaderModule", (o: any) => function (this: any, d: any) {
    const t = performance.now()
    const m = o.call(this, d)
    log.moduleMs += performance.now() - t
    log.modules++
    log.moduleBytes += d.code.length
    log.codeOf.set(m, d.code)
    return m
  })
  wrap(D, "createRenderPipeline", (o: any) => function (this: any, d: any) {
    const t = performance.now()
    const p = o.call(this, d)
    log.pipelinesSyncMs += performance.now() - t
    log.pipelinesSync++
    log.descriptors.push(snap(d))
    return p
  })
  wrap(D, "createRenderPipelineAsync", (o: any) => function (this: any, d: any) {
    const t = performance.now()
    const p = o.call(this, d)
    log.asyncCallMs += performance.now() - t
    log.pipelinesAsync++
    log.descriptors.push(snap(d))
    p.then(() => log.asyncLatency.push(performance.now() - t))
    return p
  })
  wrap(D, "createComputePipeline", (o: any) => function (this: any, d: any) {
    log.computePipelines++
    return o.call(this, d)
  })
  wrap(D, "createComputePipelineAsync", (o: any) => function (this: any, d: any) {
    log.computePipelines++
    return o.call(this, d)
  })
  wrap(D, "createTexture", (o: any) => function (this: any, d: any) {
    log.textures++
    const s = d.size
    const w = s.width ?? s[0] ?? 1
    const h = s.height ?? s[1] ?? 1
    const l = s.depthOrArrayLayers ?? s[2] ?? 1
    const bpp = /bc|etc|astc/.test(d.format) ? 1 : /32float/.test(d.format) ? 16 : /16float/.test(d.format) ? 8 : 4
    log.textureBytes += w * h * l * bpp * ((d.mipLevelCount ?? 1) > 1 ? 1.33 : 1)
    return o.call(this, d)
  })
  wrap(D, "createBuffer", (o: any) => function (this: any, d: any) {
    log.buffers++
    log.bufferBytes += d.size
    return o.call(this, d)
  })
  wrap(Q, "writeTexture", (o: any) => function (this: any, ...a: any[]) {
    const t = performance.now()
    try { return o.apply(this, a) } finally { log.writeTextureMs += performance.now() - t }
  })
  wrap(Q, "copyExternalImageToTexture", (o: any) => function (this: any, ...a: any[]) {
    const t = performance.now()
    log.copyExternalCount++
    try { return o.apply(this, a) } finally { log.copyExternalMs += performance.now() - t }
  })
  wrap(Q, "writeBuffer", (o: any) => function (this: any, b: any, off: number, data: any, ...rest: any[]) {
    log.writeBufferBytes += data?.byteLength ?? 0
    return o.call(this, b, off, data, ...rest)
  })
  // Hook three's node builder as soon as the renderer exists.
  let dbg: any
  Object.defineProperty(g, "__afterhoursDebug", {
    configurable: true,
    get: () => dbg,
    set(v) {
      dbg = v
      if (emulate === "attr") v.renderer.backend.capabilities.getUniformBufferLimit = () => 0
      // New render pipelines per module (pipelines.getForRender creates and caches them).
      const pipes = v.renderer._pipelines
      const gfr = pipes.getForRender
      pipes.getForRender = function (ro: any, ...rest: any[]) {
        const before = pipes.caches.size
        const r = gfr.call(this, ro, ...rest)
        if (pipes.caches.size > before) {
          let root = ro.object
          while (root?.parent && root.parent.type !== "Scene") root = root.parent
          const mod = root?.name || ro.object?.type || "?"
          log.pipesBy[mod] = (log.pipesBy[mod] ?? 0) + (pipes.caches.size - before)
        }
        return r
      }
      const nodes = v.renderer._nodes
      const create = nodes._createNodeBuilder
      nodes._createNodeBuilder = function (...a: any[]) {
        const b = create.apply(this, a)
        // Attribute the build to its module root (the staged group names: forest, roads, …) and object kind.
        const obj = a[0]?.object
        let root = obj
        while (root?.parent && root.parent.type !== "Scene") root = root.parent
        const mod = root?.name || obj?.type || "?"
        const kind = obj?.isInstancedMesh ? (obj.instanceMatrix.count * 64 <= 65536 ? "InstancedMesh(uniform path)" : "InstancedMesh(attribute path)") : obj?.isMesh ? (a[0]?.material?.isShadowPassMaterial || a[0]?.context?.depth ? "Mesh" : "Mesh") : obj?.type ?? "?"
        const key = `${mod} | ${kind}`
        log.buildsBy[key] = (log.buildsBy[key] ?? 0) + 1
        const build = b.build
        const buildAsync = b.buildAsync
        b.build = function (...x: any[]) {
          const t = performance.now()
          log.nodeBuilds++
          try { return build.apply(this, x) } finally { log.nodeBuildSyncMs += performance.now() - t }
        }
        if (buildAsync)
          b.buildAsync = async function (...x: any[]) {
            const t = performance.now()
            log.nodeBuilds++
            try { return await buildAsync.apply(this, x) } finally { log.nodeBuildAsyncWallMs += performance.now() - t }
          }
        return b
      }
    },
  })
}, emulate)

if (cpuRate > 1) {
  const c = await context.newCDPSession(page)
  await c.send("Emulation.setCPUThrottlingRate", { rate: cpuRate })
}
const cdp = await context.newCDPSession(page)
await cdp.send("Profiler.enable")
await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
await cdp.send("Profiler.start")
const t0 = performance.now()
await page.goto(`http://localhost:${port}/?shot=1&view=${view}`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, undefined, { timeout: 240_000, polling: 100 })
const { profile } = (await cdp.send("Profiler.stop")) as { profile: any }
const wallS = (performance.now() - t0) / 1000
if (profileOut) writeFileSync(profileOut, JSON.stringify(profile))

// --------------------------------------------------------------------------------------------- profile buckets
const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const nm = (id: number) => {
  const f = byId.get(id).callFrame
  return `${f.functionName || "(anon)"} ${f.url.split("/").pop()?.split("?")[0] ?? ""}`
}
const BUCKETS: [string, RegExp][] = [
  ["texture upload/decode", /^(copyExternalImageToTexture|writeTexture|_copyImageToTexture|generateMipmaps|createImageBitmap|decode) /],
  ["KTX2/basis transcode", /KTX2|transcode|basis/i],
  ["GLB load/parse", /GLTFLoader|GLTFParser|meshopt|MeshoptDecoder|loadModel/],
  ["TSL node build (→ WGSL)", /^(build|buildAsync|buildCode|flowNode|flowNodeFromShaderStage|setup|analyze|generate|getNodeBuilderState|_createNodeBuilder|buildFunctionCode|flowChildNode) /],
  ["pipeline create calls", /^(createRenderPipelineAsync|createRenderPipeline|createShaderModule|_createObjectPipeline|createProgram) /],
  ["frame loop (render + updates)", /^tick index-|^render world-|^frame /],
  ["world generators (module build)", /^buildModule | (terrain|roads|compound|facility|forest|interior|height|atlas\.worker|world)-[\w-]+\.js$/],
]
const buckets = new Map<string, number>()
const genFiles = new Map<string, number>()
let total = 0
for (let i = 0; i < profile.samples.length; i++) {
  const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
  const stack: string[] = []
  for (let id: number | undefined = profile.samples[i]; id !== undefined; id = parent.get(id)) stack.push(nm(id))
  const leaf = stack[0] ?? ""
  if (leaf.startsWith("(idle)")) continue
  total += dt
  let b = leaf.startsWith("(garbage") ? "GC" : leaf.startsWith("(program)") ? "browser (program)" : "other JS"
  if (b === "other JS")
    for (const [label, re] of BUCKETS)
      if (stack.some((n) => re.test(n))) {
        b = label
        break
      }
  buckets.set(b, (buckets.get(b) ?? 0) + dt)
  if (b === "world generators (module build)") {
    const f = stack.map((s) => s.split(" ")[1] ?? "").find((f) => /^(terrain|roads|compound|facility|forest|interior|height|atlas)/.test(f)) ?? "?"
    genFiles.set(f, (genFiles.get(f) ?? 0) + dt)
  }
}

const result = await page.evaluate(async (doReplay) => {
  const g = globalThis as any
  const log = g.__gpuLog
  const { renderer } = g.__afterhoursDebug
  const device: GPUDevice = renderer.backend.device
  const marks: Record<string, number> = {}
  for (const m of performance.getEntriesByType("mark")) marks[m.name] ??= +m.startTime.toFixed(0)
  const lat = [...log.asyncLatency].sort((a: number, b: number) => a - b)
  const out: any = {
    marks: Object.fromEntries(Object.entries(marks).filter(([k]) => /^(gpu:init:end|materials:end|frame:1:gpu|boot:complete|mod:.*:(build:end|shown))$/.test(k))),
    gpu: {
      shaderModules: log.modules,
      wgslMB: +(log.moduleBytes / 1e6).toFixed(2),
      createShaderModuleMainMs: +log.moduleMs.toFixed(1),
      renderPipelinesSync: log.pipelinesSync,
      renderPipelinesSyncMainMs: +log.pipelinesSyncMs.toFixed(1),
      renderPipelinesAsync: log.pipelinesAsync,
      asyncLatencyMedianMs: +(lat[lat.length >> 1] ?? 0).toFixed(1),
      asyncLatencyP90Ms: +(lat[Math.floor(lat.length * 0.9)] ?? 0).toFixed(1),
      computePipelines: log.computePipelines,
      textures: log.textures,
      textureMBEstimate: +(log.textureBytes / 1e6).toFixed(0),
      copyExternalImageToTexture: { count: log.copyExternalCount, mainMs: +log.copyExternalMs.toFixed(1) },
      writeTextureMainMs: +log.writeTextureMs.toFixed(1),
      buffers: log.buffers,
      bufferMB: +(log.bufferBytes / 1e6).toFixed(1),
      writeBufferMB: +(log.writeBufferBytes / 1e6).toFixed(1),
    },
    pipelinesBy: Object.fromEntries(Object.entries(log.pipesBy as Record<string, number>).sort((a, b) => b[1] - a[1])),
    nodeBuildsBy: Object.fromEntries(Object.entries(log.buildsBy as Record<string, number>).sort((a, b) => b[1] - a[1])),
    nodeBuilds: { count: log.nodeBuilds, syncMs: +log.nodeBuildSyncMs.toFixed(0), asyncWallMs: +log.nodeBuildAsyncWallMs.toFixed(0) },
  }
  if (doReplay) {
    // Recompile every render pipeline with cache-busted WGSL (a nonce comment), one at a time and all at once.
    const freshen = (d: any, nonce: string) => {
      const mod = (stage: any) => {
        if (!stage) return stage
        const code = stage.code
        return { ...stage, module: device.createShaderModule({ code: `${code}\n// ${nonce}` }) }
      }
      return { ...d, vertex: mod(d.vertex), fragment: mod(d.fragment) }
    }
    const descs = log.descriptors.filter((d: any) => d.vertex?.code)
    out.replayInput = { descriptors: log.descriptors.length, withCode: descs.length, sampleKeys: Object.keys(log.descriptors[0] ?? {}) }
    if (!descs.length) return out
    const seq: number[] = []
    let tSeq = performance.now()
    for (let i = 0; i < descs.length; i++) {
      const t = performance.now()
      await device.createRenderPipelineAsync(freshen(descs[i], `seq${i}-${Math.random()}`)).catch(() => null)
      seq.push(performance.now() - t)
    }
    tSeq = performance.now() - tSeq
    const tPar = performance.now()
    await Promise.all(descs.map((d: any, i: number) => device.createRenderPipelineAsync(freshen(d, `par${i}-${Math.random()}`)).catch(() => null)))
    const par = performance.now() - tPar
    // Tint only (WGSL parse/validate, no Metal compile): shader modules + compilation info.
    const tTint = performance.now()
    const codes = [...new Set(descs.flatMap((d: any) => [d.vertex.code, d.fragment?.code]).filter(Boolean))] as string[]
    await Promise.all(codes.map((c, i) => device.createShaderModule({ code: `${c}\n// tint${i}-${Math.random()}` }).getCompilationInfo()))
    const tint = performance.now() - tTint
    seq.sort((a, b) => a - b)
    out.replay = {
      pipelines: descs.length,
      uniqueWgsl: codes.length,
      sequentialTotalMs: +tSeq.toFixed(0),
      sequentialMedianMs: +seq[seq.length >> 1]!.toFixed(1),
      sequentialP90Ms: +seq[Math.floor(seq.length * 0.9)]!.toFixed(1),
      parallelAllMs: +par.toFixed(0),
      tintParseValidateAllMs: +tint.toFixed(0),
    }
  }
  return out
}, replay)

const ms = (x: number) => +x.toFixed(0)
console.log(
  JSON.stringify(
    {
      view,
      cpuRate,
      emulate: emulate || "none",
      wallS: +wallS.toFixed(1),
      mainThreadBusyMs: ms(total),
      buckets: Object.fromEntries([...buckets].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, ms(v)])),
      generatorsByFile: Object.fromEntries([...genFiles].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, ms(v)])),
      ...result,
      errors: errors.slice(0, 3),
    },
    null,
    1,
  ),
)
await browser.close()
server.stop(true)
process.exit(0)
