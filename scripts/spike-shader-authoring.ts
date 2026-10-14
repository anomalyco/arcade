import { existsSync, readdirSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import typegpuPlugin from "unplugin-typegpu/bun"
import typegpuVitePlugin from "unplugin-typegpu/vite"
import { plugin } from "bun"

// Register unplugin-typegpu in Bun so `'use gpu'` functions in typegpu-look.ts get AST metadata
plugin(typegpuPlugin())

const { createLookSettings, packLookUniforms } = await import("../packages/kit/gpu/look")
const { makeLookPostShader, makeLookSceneShader } = await import("../packages/kit/gpu/look-shaders")
const { outbreakPostFinish, outbreakSceneHooks } = await import("../games/outbreak/src/shaders")
const { wgslStruct } = await import("../packages/kit/gpu/wgsl")
const {
  LookUniformsStruct,
  packTypedLookUniforms,
  makeOurTypedLookPostShader,
  makeOurTypedLookSceneShader,
} = await import("../packages/kit/gpu/spike-shader-authoring/our-wgsl")
const {
  makeWeslLookPostShader,
  makeWeslLookSceneShader,
} = await import("../packages/kit/gpu/spike-shader-authoring/wesl-look")
const {
  typegpuLookSize,
  tgpuTonemapACES,
  makeTypeGpuLookPostShader,
  makeTypeGpuLookSceneShader,
} = await import("../packages/kit/gpu/spike-shader-authoring/typegpu-look")

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
const mad = (xs: number[]) => {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

// 1. Verify binary layout parity & vec3f alignment trap handling
const noirSettings = createLookSettings("noir")
const baselinePacked = packLookUniforms(noirSettings)
const ourTypedPacked = packTypedLookUniforms(noirSettings)
let maxFloatDiff = 0
for (let i = 0; i < 64; i++) {
  maxFloatDiff = Math.max(maxFloatDiff, Math.abs(baselinePacked[i]! - ourTypedPacked[i]!))
}

// Demonstrate WGSL alignment trap caught automatically by wgslStruct:
// In WGSL, `{ a: f32, b: vec3f, c: f32 }` puts `a` at byte 0, aligns `b` to byte 16 (inserting 12B padding!),
// puts `c` at byte 28, and has total size 32 bytes (8 floats) instead of 20 bytes (5 floats).
const AlignmentTrapStruct = wgslStruct("AlignmentTrap", {
  a: "f32",
  b: "vec3f",
  c: "f32",
})
const trapPacked = AlignmentTrapStruct.pack({ a: 1, b: [2, 3, 4], c: 5 })

// Verify TypeGPU `'use gpu'` function executes on CPU as well as generating WGSL!
const cpuAcesResult = tgpuTonemapACES(new Float32Array([1.0, 0.5, 0.2]) as any)

// 2. Measure CPU JS shader generation / linking latency
function benchCpuGen(fn: () => { scene: string; post: string }, iters = 30) {
  const warm = fn()
  const times: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  return {
    medianMs: Number(median(times).toFixed(3)),
    sceneChars: warm.scene.length,
    postChars: warm.post.length,
  }
}

const cpuGen = {
  baselineRawString: benchCpuGen(() => ({
    scene: makeLookSceneShader(outbreakSceneHooks),
    post: makeLookPostShader(outbreakPostFinish),
  })),
  ourTypedWgslNoir: benchCpuGen(() => ({
    scene: makeOurTypedLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeOurTypedLookPostShader(outbreakPostFinish, "noir"),
  })),
  typegpuNoir: benchCpuGen(() => ({
    scene: makeTypeGpuLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeTypeGpuLookPostShader(outbreakPostFinish, "noir"),
  })),
  weslNoir: benchCpuGen(() => ({
    scene: makeWeslLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeWeslLookPostShader(outbreakPostFinish, "noir"),
  })),
}

// 3. Measure client bundle size overhead (minified + gzipped)
const rootDir = resolve(import.meta.dir, "..")
async function measureBundleSize(entryCode: string, useTypeGpuPlugin = false) {
  const tmpPath = `${rootDir}/packages/kit/gpu/spike-shader-authoring/.tmp-bundle-${Math.random().toString(36).slice(2)}.ts`
  await Bun.write(tmpPath, entryCode)
  try {
    const out = await Bun.build({
      entrypoints: [tmpPath],
      minify: true,
      target: "browser",
      plugins: useTypeGpuPlugin ? [typegpuPlugin()] : [],
    })
    const text = await out.outputs[0]!.text()
    const gz = gzipSync(Buffer.from(text))
    return { minifiedBytes: text.length, gzipBytes: gz.byteLength }
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  }
}
const bundleSizes = {
  ourWgslRuntimeOnly: await measureBundleSize(
    `import { wgslStruct, wgslSlot, wgslSnippet, resolveWgsl } from "${rootDir}/packages/kit/gpu/wgsl"; console.log(wgslStruct, wgslSlot, wgslSnippet, resolveWgsl);`,
  ),
  typegpuRuntimeOnly: await measureBundleSize(
    `import tgpu from "typegpu"; import * as d from "typegpu/data"; import * as std from "typegpu/std"; console.log(tgpu, d, std);`,
    true,
  ),
  weslRuntimeLinker: await measureBundleSize(
    `import { _linkSync } from "wesl"; console.log(_linkSync);`,
  ),
}

// 4. Headless Metal Benchmark: Pipeline compile time + Outbreak 3456x1894 GPU frame time (Current vs Baseline Noir vs Specialized Noir & Painterly)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)!

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const prebuiltShaders = {
  baseline: {
    scene: makeLookSceneShader(outbreakSceneHooks),
    post: makeLookPostShader(outbreakPostFinish),
  },
  ourNoir: {
    scene: makeOurTypedLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeOurTypedLookPostShader(outbreakPostFinish, "noir"),
  },
  ourPainterly: {
    scene: makeOurTypedLookSceneShader(outbreakSceneHooks, "painterly"),
    post: makeOurTypedLookPostShader(outbreakPostFinish, "painterly"),
  },
  typegpuNoir: {
    scene: makeTypeGpuLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeTypeGpuLookPostShader(outbreakPostFinish, "noir"),
  },
  weslNoir: {
    scene: makeWeslLookSceneShader(outbreakSceneHooks, "noir"),
    post: makeWeslLookPostShader(outbreakPostFinish, "noir"),
  },
}

let metalResults: unknown = null

try {
  const server = await createServer({
    root: resolve(rootDir, "games/outbreak"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      typegpuVitePlugin(),
      {
        name: "expose-outbreak-spike-a",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("games/outbreak/src/main.ts")) {
            return code.replace("const harness = {", "const harness = { renderer, render, session: () => session,")
          }
        },
      },
    ],
  })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    const orig = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return orig.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)

  metalResults = await page.evaluate(async (shaders) => {
    const h = (window as any).__arcadeHarness
    const r = h.renderer
    const d: GPUDevice = r.device

    // A. Measure shader module + async pipeline compilation time on Metal for each system
    const VERT_BYTES = 24
    const INST_FLOATS = 12
    const meshLayout: GPUVertexBufferLayout = {
      arrayStride: VERT_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "snorm8x4" },
        { shaderLocation: 2, offset: 16, format: "unorm8x4" },
        { shaderLocation: 3, offset: 20, format: "float16x2" },
      ],
    }
    const instLayout: GPUVertexBufferLayout = {
      arrayStride: INST_FLOATS * 4,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 5, offset: 0, format: "float32x4" },
        { shaderLocation: 6, offset: 16, format: "float32x4" },
        { shaderLocation: 7, offset: 32, format: "float32x4" },
      ],
    }
    const premul: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    }
    const scenePipeLayout = d.createPipelineLayout({ bindGroupLayouts: [r.sceneLayout] })
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [r.postLayout] })

    async function buildPipeSet(label: string, sCode: string, pCode: string, useFsSolidForInst: boolean) {
      const t0 = performance.now()
      const saltVal = (1 + Math.random() * 1e-6).toFixed(7)
      const sMod = d.createShaderModule({ code: sCode.replace("const GAIN: f32 = 5.0;", `const GAIN: f32 = ${5 * Number(saltVal)};`), label: `${label}-scene` })
      const pMod = d.createShaderModule({ code: pCode.replace("vec4f(64.0)", `vec4f(${(64 * Number(saltVal)).toFixed(5)})`), label: `${label}-post` })
      const [sInfo, pInfo] = await Promise.all([sMod.getCompilationInfo(), pMod.getCompilationInfo()])
      const errors = [...sInfo.messages, ...pInfo.messages].filter((m) => m.type === "error")
      if (errors.length > 0) {
        throw new Error(`WGSL compile error in ${label}: ${errors.map((e) => `${e.lineNum}:${e.message}`).join("; ")}`)
      }
      const makeScenePipe = (vs: string, buffers: GPUVertexBufferLayout[], blend: GPUBlendState | undefined, depthWrite: boolean, fs: string) =>
        d.createRenderPipelineAsync({
          layout: scenePipeLayout,
          vertex: { module: sMod, entryPoint: vs, buffers },
          fragment: { module: sMod, entryPoint: fs, targets: [{ format: "rgba16float", blend }] },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: { format: "depth24plus", depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
          multisample: { count: 4 },
        })
      const [level, levelCut, glass, inst, instAlpha, composite] = await Promise.all([
        makeScenePipe("vsStatic", [meshLayout], undefined, true, "fsSolid"),
        makeScenePipe("vsStatic", [meshLayout], undefined, true, "fs"),
        makeScenePipe("vsStatic", [meshLayout], premul, false, useFsSolidForInst ? "fsSolid" : "fs"),
        makeScenePipe("vsInst", [meshLayout, instLayout], undefined, true, useFsSolidForInst ? "fsSolid" : "fs"),
        makeScenePipe("vsInst", [meshLayout, instLayout], premul, false, "fs"),
        d.createRenderPipelineAsync({
          layout: postPipeLayout,
          vertex: { module: pMod, entryPoint: "vs" },
          fragment: { module: pMod, entryPoint: "composite", targets: [{ format: r.format }] },
          primitive: { topology: "triangle-list" },
        }),
      ])
      const compileMs = Number((performance.now() - t0).toFixed(2))
      return { pipes: { level, levelCut, glass, inst, instAlpha, composite }, compileMs }
    }

    const pipeSets = {
      baseline: await buildPipeSet("baseline", shaders.baseline.scene, shaders.baseline.post, false),
      ourNoir: await buildPipeSet("ourNoir", shaders.ourNoir.scene, shaders.ourNoir.post, true),
      ourPainterly: await buildPipeSet("ourPainterly", shaders.ourPainterly.scene, shaders.ourPainterly.post, true),
      typegpuNoir: await buildPipeSet("typegpuNoir", shaders.typegpuNoir.scene, shaders.typegpuNoir.post, true),
      weslNoir: await buildPipeSet("weslNoir", shaders.weslNoir.scene, shaders.weslNoir.post, true),
    }

    // B. Measure whole-frame GPU time at 3456x1894 (Interior & Street) with 1 warmup + 7 alternating pairs
    const qSet = d.createQuerySet({ type: "timestamp", count: 2 })
    const resBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const readBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })

    async function sampleFrame(): Promise<number> {
      for (let k = 0; k < 3; k++) await h.step(0)
      await d.queue.onSubmittedWorkDone()
      let firstPass = true
      let lastTargetView: GPUTextureView | null = null
      const origCreate = d.createCommandEncoder.bind(d)
      d.createCommandEncoder = (desc) => {
        const enc = origCreate(desc)
        const origCompute = enc.beginComputePass.bind(enc)
        enc.beginComputePass = (cDesc) => {
          const tw = firstPass ? { querySet: qSet, beginningOfPassWriteIndex: 0 } : undefined
          firstPass = false
          return origCompute(tw ? { ...cDesc, timestampWrites: tw } : cDesc)
        }
        const origRender = enc.beginRenderPass.bind(enc)
        enc.beginRenderPass = (rDesc) => {
          const tw = firstPass ? { querySet: qSet, beginningOfPassWriteIndex: 0 } : undefined
          firstPass = false
          const ca = Array.from(rDesc.colorAttachments)
          if (ca[0]?.view) lastTargetView = ca[0].view
          return origRender(tw ? { ...rDesc, timestampWrites: tw } : rDesc)
        }
        const origFinish = enc.finish.bind(enc)
        enc.finish = (fDesc) => {
          if (lastTargetView) {
            enc.beginRenderPass({
              timestampWrites: { querySet: qSet, endOfPassWriteIndex: 1 },
              colorAttachments: [{ view: lastTargetView, loadOp: "load", storeOp: "store" }],
            }).end()
            enc.resolveQuerySet(qSet, 0, 2, resBuf, 0)
            enc.copyBufferToBuffer(resBuf, 0, readBuf, 0, 16)
          }
          return origFinish(fDesc)
        }
        return enc
      }
      await h.step(0)
      d.createCommandEncoder = origCreate
      await d.queue.onSubmittedWorkDone()
      await readBuf.mapAsync(GPUMapMode.READ)
      const stamps = new BigUint64Array(readBuf.getMappedRange())
      const gpuMs = Number(stamps[1]! - stamps[0]!) / 1e6
      readBuf.unmap()
      return gpuMs
    }

    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const madFn = (xs: number[]) => {
      const m = med(xs)
      return med(xs.map((x) => Math.abs(x - m)))
    }

    async function benchmarkPose(poseName: string, x: number, z: number, zoom: number) {
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", 19)
      h.setLab("zoom", zoom)
      h.pose(x, z, -Math.PI / 2)
      await h.step(0)

      const modes = [
        { id: "current", preset: "current", pipes: pipeSets.baseline.pipes },
        { id: "baselineNoir", preset: "noir", pipes: pipeSets.baseline.pipes },
        { id: "ourWgslNoir", preset: "noir", pipes: pipeSets.ourNoir.pipes },
        { id: "typegpuNoir", preset: "noir", pipes: pipeSets.typegpuNoir.pipes },
        { id: "weslNoir", preset: "noir", pipes: pipeSets.weslNoir.pipes },
        { id: "baselinePainterly", preset: "painterly", pipes: pipeSets.baseline.pipes },
        { id: "ourWgslPainterly", preset: "painterly", pipes: pipeSets.ourPainterly.pipes },
      ]
      const samples: Record<string, number[]> = Object.fromEntries(modes.map((m) => [m.id, []]))
      const rounds = 8 // 1 warmup + 7 measured rounds
      for (let round = 0; round < rounds; round++) {
        const order = round % 2 === 0 ? modes : [...modes].reverse()
        for (const m of order) {
          r.lookPipes = m.pipes
          h.setLab("lookPreset", m.preset)
          const t = await sampleFrame()
          if (round > 0) samples[m.id]!.push(t)
        }
      }
      return Object.fromEntries(
        modes.map((m) => [
          m.id,
          {
            medianMs: Number(med(samples[m.id]!).toFixed(3)),
            madMs: Number(madFn(samples[m.id]!).toFixed(3)),
          },
        ]),
      )
    }

    const interior = await benchmarkPose("interior", 27.7, 31, 34)
    const street = await benchmarkPose("street", 27.7, 41, 42)

    return {
      compileMs: {
        baseline: pipeSets.baseline.compileMs,
        ourWgslNoir: pipeSets.ourNoir.compileMs,
        ourWgslPainterly: pipeSets.ourPainterly.compileMs,
        typegpuNoir: pipeSets.typegpuNoir.compileMs,
        weslNoir: pipeSets.weslNoir.compileMs,
      },
      interior3456x1894: interior,
      street3456x1894: street,
    }
  }, prebuiltShaders)

  await page.close()
  await server.close()
} finally {
  await browser.close()
}

console.log(
  JSON.stringify(
    {
      layoutAndTypeSafety: {
        lookUniformsByteSize: LookUniformsStruct.byteSize,
        typegpuLookByteSize: typegpuLookSize,
        maxFloatDiffVsBaselinePacker: maxFloatDiff,
        alignmentTrapStructByteSize: AlignmentTrapStruct.byteSize,
        alignmentTrapOffsets: AlignmentTrapStruct.fields.map((f) => ({ name: f.name, byteOffset: f.byteOffset, floatOffset: f.floatOffset })),
        alignmentTrapPackedFloats: Array.from(trapPacked),
        cpuAcesExecutionCheck: Array.from(cpuAcesResult as unknown as Iterable<number>).map((v) => Number(v.toFixed(4))),
      },
      cpuShaderGenerationMs: cpuGen,
      bundleSizeOverhead: bundleSizes,
      metalBenchmark: metalResults,
    },
    null,
    2,
  ),
)
