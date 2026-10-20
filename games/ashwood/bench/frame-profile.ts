// Steady-state frame profile of a frozen build: scene/draw/pipeline counts, per-frame main-thread CPU split by
// renderer stage, per-pass GPU time (timestamp queries), and optionally a sampled CPU profile bucketed by stage.
//
//   bunx vite build --outDir $TMP/build-dev --minify false        (readable names for the CPU profile)
//   bun bench/frame-profile.ts --dir $TMP/build-dev --view road --frames 300 [--profile out.cpuprofile] [--size 1536x1024]
//
// Runs one headless-shell page (Metal, muted). Prints a JSON report.
import { writeFileSync } from "node:fs"
import { arg, launch, median, pct, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/build`)!
const views = (arg(args, "view", "road")!).split(",")
const frames = Number(arg(args, "frames", "300"))
const extra = arg(args, "q", "")
const profileOut = arg(args, "profile")
const [w, h] = arg(args, "size", "1536x1024")!.split("x").map(Number) as [number, number]
const dprs = arg(args, "dpr", "1")!.split(",").map(Number)
const ablate = args.includes("--ablate")
const cpuRate = Number(arg(args, "cpu", "1"))
const port = 5221
const server = serve(dir, port)
const browser = await launch()

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string }; children?: number[] }[]
  samples: number[]
  timeDeltas: number[]
}

/** Buckets each sample by the innermost matching frame on its stack (ordered most specific first). */
function bucket(p: CpuProfile, totalFrames: number) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const RULES: [string, RegExp][] = [
    ["gpu: writeBuffer (uniform/attr upload)", /^writeBuffer$|^updateBinding$|^_writeBuffer/],
    ["gpu: encode setPipeline/setBindGroup/draw", /^(setPipeline|setBindGroup|setVertexBuffer|setIndexBuffer|drawIndexed|drawIndirect|drawIndexedIndirect|draw)$/],
    ["gpu: submit/finish/begin pass", /^(submit|finish|beginRenderPass|end|createCommandEncoder|getCurrentTexture|createView)$/],
    ["three: backend.draw (other)", /^draw$/],
    ["three: uniforms/bindings update", /^(updateForRender|_updateBindings|updateBindings|_update|updateGroup|updateUniform|updateByType|updateBefore|updateAfter|updateNode|updateReference|updateBinding|updateAttribute|update)$/],
    ["three: getRenderObject / pipelines check", /^get$|getRenderObject|getForRender|_needsUpdate|needsUpdate|getCacheKey|getDynamicCacheKey|getMonitor/],
    ["three: _renderObjectDirect (other)", /_renderObjectDirect|renderObject$|_renderObjects/],
    ["three: cull/project + list", /_projectObject|intersectsObject|intersectsSphere|push$|sort$|finish$|painterSort|reversePainterSort|getRenderList/],
    ["three: updateMatrixWorld", /updateMatrixWorld|updateWorldMatrix|compose$|multiplyMatrices/],
    ["three: shadows", /_renderShadow|ShadowNode|updateShadow|renderShadow/],
    ["three: other render", /_renderScene|render$|_renderOutput|RenderPipeline|PassNode|QuadMesh/],
  ]
  const self = new Map<string, number>()
  const stage = new Map<string, number>()
  const world = new Map<string, number>()
  const name = (id: number) => byId.get(id)!.callFrame.functionName || "(anon)"
  const file = (id: number) => byId.get(id)!.callFrame.url.split("/").pop() ?? ""
  let total = 0
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
    const leaf = p.samples[i]!
    const ln = name(leaf)
    if (ln === "(idle)") continue
    total += dt
    self.set(`${ln} ${file(leaf)}`, (self.get(`${ln} ${file(leaf)}`) ?? 0) + dt)
    const stack: number[] = []
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) stack.push(id)
    let b = ln.startsWith("(") ? ln : "other JS"
    if (b === "other JS")
      outer: for (const id of stack)
        for (const [label, re] of RULES) {
          if (re.test(name(id))) {
            b = label
            break outer
          }
        }
    stage.set(b, (stage.get(b) ?? 0) + dt)
    // Which world/render module owns the work outside three's render call (per-frame updates).
    const names = stack.map((id) => `${name(id)}@${file(id)}`)
    const inRender = names.some((n) => /^(render|_renderScene)@/.test(n))
    if (!inRender) {
      const own = stack.map(file).find((f) => /^(forest|terrain|lighting|atmosphere|post|roads|compound|facility|interior|clustered|warmup|player|main)/.test(f))
      world.set(own ?? "(other)", (world.get(own ?? "(other)") ?? 0) + dt)
    }
  }
  const per = (m: Map<string, number>) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, +(v / totalFrames).toFixed(3)]))
  return { busyMsPerFrame: +(total / totalFrames).toFixed(3), stage: per(stage), outsideRender: per(world), selfTop: per(self) }
}

const reports: unknown[] = []
for (const dpr of dprs) for (const view of views) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  if (cpuRate > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: cpuRate })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  const t0 = performance.now()
  await page.goto(`http://localhost:${port}/?shot=1&perf=1&view=${view}${extra ? `&${extra}` : ""}`)
  await page.waitForFunction(() => (globalThis as any).__ashwood?.complete, undefined, { timeout: 180_000, polling: 100 })
  const bootS = (performance.now() - t0) / 1000
  await page.waitForTimeout(2500)

  const scene = await page.evaluate(() => {
    const { renderer, scene } = (globalThis as any).__ashwoodDebug
    const s = { objects: 0, meshes: 0, visibleMeshes: 0, instanced: 0, instances: 0, batched: 0, lines: 0, points: 0, lights: 0, shadowLights: 0, materials: new Set<unknown>(), geometries: new Set<unknown>(), triangles: 0 }
    scene.traverse((o: any) => {
      s.objects++
      if (o.isLight) {
        s.lights++
        if (o.castShadow) s.shadowLights++
      }
      if (o.isLine) s.lines++
      if (o.isPoints) s.points++
      if (!o.isMesh) return
      s.meshes++
      let vis = true
      for (let p = o; p; p = p.parent) if (!p.visible) vis = false
      if (vis) s.visibleMeshes++
      if (o.isInstancedMesh) {
        s.instanced++
        s.instances += o.count
      }
      if (o.isBatchedMesh) s.batched++
      for (const m of [o.material].flat()) s.materials.add(m)
      s.geometries.add(o.geometry)
    })
    const p = renderer._pipelines
    return {
      ...s,
      materials: s.materials.size,
      geometries: s.geometries.size,
      pipelines: p.caches.size,
      programs: { vertex: p.programs.vertex.size, fragment: p.programs.fragment.size, compute: p.programs.compute.size },
      renderObjects: renderer._objects?.chainMaps ? Object.keys(renderer._objects.chainMaps).length : null,
      canvas: [renderer.domElement.width, renderer.domElement.height],
      pixelRatio: renderer.getPixelRatio(),
      isolated: crossOriginIsolated,
    }
  })

  const cdp = profileOut ? await page.context().newCDPSession(page) : null
  if (cdp) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
    await cdp.send("Profiler.start")
  }

  const run = await page.evaluate(async (N) => {
    const { renderer, scene } = (globalThis as any).__ashwoodDebug
    const backend = renderer.backend
    const now = () => performance.now()
    const acc = { frame: [] as number[], interval: [] as number[], render: new Map<string, { ms: number; n: number; draws: number }>(), umw: 0, project: 0, renderObjects: 0, finish: 0, draws: 0, computeCalls: 0, passes: 0 }
    let depthProject = 0
    const wrap = (obj: any, key: string, fn: (orig: any) => any) => {
      const orig = obj[key]
      obj[key] = fn(orig)
      return () => (obj[key] = orig)
    }
    let label = ""
    let childMs = 0
    const undo: (() => void)[] = []
    undo.push(
      wrap(renderer, "render", (o: any) => function (this: any, sc: any, cam: any) {
        const prev = label
        label = sc?.isScene ? `scene:${sc.name || "main"}` : sc?.isMesh ? `quad:${sc.material?.name || sc.material?.type}` : String(sc?.type)
        const t = now()
        const outerChild = childMs
        childMs = 0
        try {
          return o.call(this, sc, cam)
        } finally {
          const e = acc.render.get(label) ?? { ms: 0, n: 0, draws: 0 }
          const dur = now() - t
          e.ms += dur - childMs
          childMs = outerChild + dur
          e.n++

          acc.render.set(label, e)
          label = prev
        }
      }),
      wrap(scene, "updateMatrixWorld", (o: any) => function (this: any, ...a: any[]) {
        const t = now()
        try { return o.apply(this, a) } finally { acc.umw += now() - t }
      }),
      wrap(renderer, "_projectObject", (o: any) => function (this: any, ...a: any[]) {
        if (depthProject++) { try { return o.apply(this, a) } finally { depthProject-- } }
        const t = now()
        try { return o.apply(this, a) } finally { depthProject--; acc.project += now() - t }
      }),
      wrap(renderer, "_renderObjects", (o: any) => function (this: any, ...a: any[]) {
        const t = now()
        try { return o.apply(this, a) } finally { acc.renderObjects += now() - t }
      }),
      wrap(backend, "draw", (o: any) => function (this: any, ...a: any[]) {
        acc.draws++
        const e = acc.render.get(label) ?? { ms: 0, n: 0, draws: 0 }
        e.draws++
        acc.render.set(label, e)
        return o.apply(this, a)
      }),
      wrap(backend, "finishRender", (o: any) => function (this: any, ...a: any[]) {
        const t = now()
        try { return o.apply(this, a) } finally { acc.finish += now() - t }
      }),
    )
    // Map timestamp uids to pass labels.
    const passLabel = new Map<string, string>()
    undo.push(
      wrap(backend, "beginRender", (o: any) => function (this: any, rc: any) {
        const r = o.call(this, rc)
        acc.passes++
        const uid = backend.get(rc).timestampUID
        if (uid) {
          const tex = rc.textures?.[0]?.name || rc.renderTarget?.texture?.name || (rc.renderTarget ? "rt" : "canvas")
          passLabel.set(uid, `${label} → ${tex} ${rc.width}x${rc.height}`)
        }
        return r
      }),
      wrap(backend, "beginCompute", (o: any) => function (this: any, cg: any) {
        acc.computeCalls++
        const r = o.call(this, cg)
        const uid = backend.get(cg)?.timestampUID
        if (uid) passLabel.set(uid, `compute:${cg?.name || cg?.constructor?.name || "?"}`)
        return r
      }),
    )
    const gpuByPass = new Map<string, number[]>()
    const gpuFrame: number[] = []
    const harvest = async () => {
      for (const type of ["render", "compute"]) {
        await renderer.resolveTimestampsAsync(type)
        const pool = backend.timestampQueryPool?.[type]
        if (!pool) continue
        const byFrame = new Map<string, number>()
        for (const [uid, ms] of pool.timestamps as Map<string, number>) {
          const lab = (passLabel.get(uid) ?? uid.replace(/:f\d+$/, "")).replace(/:\d+$/, "")
          const key = lab
          const arr = gpuByPass.get(key) ?? []
          arr.push(ms)
          gpuByPass.set(key, arr)
          const f = uid.match(/:f(\d+)$/)?.[1] ?? "?"
          byFrame.set(f, (byFrame.get(f) ?? 0) + ms)
        }
        if (type === "render") for (const v of byFrame.values()) gpuFrame.push(v)
      }
    }
    const anim = renderer._animation
    const origLoop = anim._animationLoop
    let n = 0
    let last = 0
    let done: () => void
    const finished = new Promise<void>((r) => (done = r))
    anim._animationLoop = function (this: any, time: number, xr: any) {
      const t = now()
      origLoop.call(this, time, xr)
      const dt = now() - t
      if (n > 0) acc.interval.push(time - last)
      last = time
      acc.frame.push(dt)
      if (++n >= N) done()
    }
    // Harvest timestamps periodically (the pool holds 2048 queries).
    const iv = setInterval(() => void harvest(), 250)
    const info0 = { calls: renderer.info.render.calls }
    await finished
    clearInterval(iv)
    await harvest()
    anim._animationLoop = origLoop
    for (const u of undo.reverse()) u()
    const avg = (x: number) => +(x / N).toFixed(3)
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? NaN
    const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? NaN
    return {
      frames: N,
      cpuFrameMs: { median: +med(acc.frame).toFixed(3), p95: +p95(acc.frame).toFixed(3), mean: avg(acc.frame.reduce((a, b) => a + b, 0)) },
      rafIntervalMs: { median: +med(acc.interval).toFixed(2), p95: +p95(acc.interval).toFixed(2) },
      perFrame: {
        renderCalls: avg(renderer.info.render.calls - info0.calls),
        passes: avg(acc.passes),
        drawCalls: avg(acc.draws),
        computeDispatches: avg(acc.computeCalls),
        updateMatrixWorldMs: avg(acc.umw),
        projectCullMs: avg(acc.project),
        renderObjectsMs: avg(acc.renderObjects),
        finishRenderMs: avg(acc.finish),
      },
      renderByCaller: Object.fromEntries([...acc.render].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => [k, { msPerFrame: avg(v.ms), callsPerFrame: avg(v.n), drawsPerFrame: avg(v.draws) }])),
      gpu: {
        frameMs: { median: +med(gpuFrame).toFixed(3), p95: +p95(gpuFrame).toFixed(3), samples: gpuFrame.length },
        byPassMedianMs: Object.fromEntries(
          [...gpuByPass].map(([k, v]) => [k, +med(v).toFixed(3)] as const).sort((a, b) => b[1] - a[1]),
        ),
      },
      info: { triangles: renderer.info.render.triangles, drawCallsLast: renderer.info.render.drawCalls },
    }
  }, frames)

  let cpu: unknown = null
  if (cdp) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
    writeFileSync(profileOut!.replace(/(\.\w+)?$/, `-${view}$1`), JSON.stringify(profile))
    cpu = bucket(profile, frames)
  }
  // GPU time without timestamp queries (per-pass timestamps on Apple/Dawn read ~5 ms for every pass, even a 48×32
  // blur, so they measure queueing, not work): pause the loop, drain the queue, then per frame time CPU submit and
  // the wait until the GPU is done; and throughput of K back-to-back frames. Repeat with the bare scene pass straight
  // to the canvas (no post) to split scene vs post.
  const gpu = await page.evaluate(async (doAblate: boolean) => {
    const { renderer, scene, camera } = (globalThis as any).__ashwoodDebug
    const device: GPUDevice = renderer.backend.device
    const anim = renderer._animation
    const loop = anim._animationLoop
    anim._animationLoop = null
    const now = () => performance.now()
    const med = (a: number[]) => +([...a].sort((x, y) => x - y)[a.length >> 1] ?? NaN).toFixed(3)
    await device.queue.onSubmittedWorkDone()
    const mc = new MessageChannel()
    const yieldTask = () => new Promise<void>((r) => {
      mc.port1.onmessage = () => r()
      mc.port2.postMessage(0)
    })
    // Latency of onSubmittedWorkDone itself with an idle GPU (empty submit): subtract from the tails below.
    const idle: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = now()
      device.queue.submit([device.createCommandEncoder().finish()])
      await device.queue.onSubmittedWorkDone()
      idle.push(now() - t)
    }
    const measure = async (frame: () => void, n: number) => {
      const cpu: number[] = []
      const tail: number[] = []
      const total: number[] = []
      for (let i = 0; i < n; i++) {
        const t0 = now()
        frame()
        const t1 = now()
        await device.queue.onSubmittedWorkDone()
        const t2 = now()
        cpu.push(t1 - t0)
        tail.push(t2 - t1)
        total.push(t2 - t0)
      }
      // Throughput: frames issued back to back with only a macrotask yield between them (a synchronous loop lets
      // the game's frame skip work), GPU drained at the end. ≈ max(CPU, GPU) per frame once the GPU queue fills.
      const K = n
      const tb = now()
      for (let i = 0; i < K; i++) {
        frame()
        await yieldTask()
      }
      await device.queue.onSubmittedWorkDone()
      const throughput = (now() - tb) / K
      const tc = now()
      for (let i = 0; i < K; i++) await yieldTask()
      const yieldCost = (now() - tc) / K
      return { cpuSubmitMs: med(cpu), gpuTailAfterSubmitMs: med(tail), serialFrameMs: med(total), pipelinedMsPerFrame: +throughput.toFixed(3), yieldOverheadMs: +yieldCost.toFixed(3) }
    }
    let t = performance.now()
    // Animation.update advances three's NodeFrame (FRAME-type node updates such as the scene PassNode) each rAF; do
    // the same so every manual frame does the full work.
    const full = await measure(() => {
      if (anim.info.autoReset === true) anim.info.reset()
      anim.nodes.nodeFrame.update()
      anim.info.frame = anim.nodes.nodeFrame.frameId
      loop.call(anim, (t += 16.7))
    }, 40)
    // Sprites' node materials fail to build for a plain (non-MRT) canvas pass; hide them for the bare scene pass.
    const hidden: any[] = []
    scene.traverse((o: any) => {
      if (o.isSprite && o.visible) {
        o.visible = false
        hidden.push(o)
      }
    })
    const sceneOnly = () => {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
    }
    for (let i = 0; i < 5; i++) {
      sceneOnly()
      await device.queue.onSubmittedWorkDone()
    }
    const bare = await measure(sceneOnly, 40)
    for (const o of hidden) o.visible = true
    // Ablation through the post rig's live settings (exposed with ?perf): pipelined ms/frame per feature off.
    const ablation: Record<string, unknown> = {}
    const rig = (globalThis as any).__ashwoodRender
    if (doAblate && rig?.settings) {
      const S = rig.settings
      const frame = () => {
        if (anim.info.autoReset === true) anim.info.reset()
        anim.nodes.nodeFrame.update()
        anim.info.frame = anim.nodes.nodeFrame.frameId
        loop.call(anim, (t += 16.7))
      }
      const cases: [string, Record<string, unknown>][] = [
        ["baseline", {}],
        ["no SSR", { "post.ssr": false }],
        ["no GTAO", { "post.ao": false }],
        ["no fog scattering", { "scatter.lights": 0, "scatter.lightsIndoor": 0 }],
        ["no TAAU", { "post.taa": false }],
        ["no bloom", { "post.bloom": 0 }],
        ["renderScale 0.5", { "post.renderScale": 0.5 }],
      ]
      for (const [name, patch] of cases) {
        const saved: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(patch)) (saved[k] = S[k]), (S[k] = v)
        for (let i = 0; i < 20; i++) {
          frame()
          await device.queue.onSubmittedWorkDone()
        }
        ablation[name] = await measure(frame, 40)
        for (const [k, v] of Object.entries(saved)) S[k] = v
      }
    }
    anim._animationLoop = loop
    return { idleDoneLatencyMs: med(idle), fullFrame: full, sceneOnlyToCanvas: bare, ablation }
  }, ablate)

  reports.push({ view, size: `${w}x${h}@${dpr}x`, cpuRate, bootS: +bootS.toFixed(1), scene, ...run, gpuSerial: gpu, cpuProfile: cpu, errors: errors.slice(0, 5) })
  await page.close()
}
console.log(JSON.stringify(reports, null, 1))
await browser.close()
server.stop(true)
process.exit(0)
