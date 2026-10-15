import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright-core"

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    return new Response("<!doctype html><canvas id='c' width='1280' height='720'></canvas>", {
      headers: {
        "content-type": "text/html",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
    })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--enable-features=Vulkan,SharedArrayBuffer",
    "--mute-audio",
  ],
})

const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
await page.goto(`http://127.0.0.1:${server.port}/`)

const benchResult = await page.evaluate(async () => {
  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]!
  }
  const p95 = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
  }

  // ==========================================================================
  // PART 1: MULTITHREADING & WORKER HANDOFF BENCHMARK (2,000 Zombies = 768 KB Instance Buffer)
  // ==========================================================================
  const PAYLOAD_FLOATS = 2000 * 8 * 12 // 192,000 floats = 768 KB
  const PAYLOAD_BYTES = PAYLOAD_FLOATS * 4

  // 1A. Worker structuredClone (copies 768 KB each way)
  const cloneWorkerCode = `
    onmessage = (e) => {
      const arr = e.data;
      arr[0] += 1;
      postMessage(arr);
    };
  `
  const cloneWorker = new Worker(URL.createObjectURL(new Blob([cloneWorkerCode], { type: "application/javascript" })))
  const cloneSrc = new Float32Array(PAYLOAD_FLOATS)
  const cloneTimes: number[] = []
  for (let i = 0; i < 45; i++) {
    const t0 = performance.now()
    await new Promise<void>((resolve) => {
      cloneWorker.onmessage = () => resolve()
      cloneWorker.postMessage(cloneSrc)
    })
    if (i >= 5) cloneTimes.push(performance.now() - t0)
  }
  cloneWorker.terminate()

  // 1B. Worker Transferable ArrayBuffer Ping-Pong (zero-copy ownership transfer, NO COOP/COEP needed!)
  const transferWorkerCode = `
    onmessage = (e) => {
      const arr = new Float32Array(e.data);
      arr[0] += 1;
      postMessage(arr.buffer, [arr.buffer]);
    };
  `
  const transferWorker = new Worker(URL.createObjectURL(new Blob([transferWorkerCode], { type: "application/javascript" })))
  let pingBuf = new ArrayBuffer(PAYLOAD_BYTES)
  const transferTimes: number[] = []
  for (let i = 0; i < 45; i++) {
    const t0 = performance.now()
    pingBuf = await new Promise<ArrayBuffer>((resolve) => {
      transferWorker.onmessage = (e) => resolve(e.data as ArrayBuffer)
      transferWorker.postMessage(pingBuf, [pingBuf])
    })
    if (i >= 5) transferTimes.push(performance.now() - t0)
  }
  transferWorker.terminate()

  // 1C. SharedArrayBuffer + Atomics across Worker (zero-copy shared memory with COOP/COEP)
  const crossOriginIsolatedFlag = window.crossOriginIsolated
  let sabAvailable = typeof SharedArrayBuffer !== "undefined"
  let sabWorkerRoundTripMedianUs = -1
  let sabWorkerRoundTripP95Us = -1
  if (sabAvailable) {
    try {
      const sab = new SharedArrayBuffer(PAYLOAD_BYTES + 64)
      const ctrl = new Int32Array(sab, 0, 16)
      const data = new Float32Array(sab, 64, PAYLOAD_FLOATS)
      const sabWorkerCode = `
        onmessage = (e) => {
          const sab = e.data;
          const ctrl = new Int32Array(sab, 0, 16);
          const data = new Float32Array(sab, 64);
          while (true) {
            const val = Atomics.load(ctrl, 0);
            if (val === -1) break;
            if (val > 0) {
              data[0] += 1;
              Atomics.store(ctrl, 0, 0);
              Atomics.store(ctrl, 1, val);
              Atomics.notify(ctrl, 1, 1);
            } else {
              Atomics.wait(ctrl, 0, 0, 10);
            }
          }
        };
      `
      const sabWorker = new Worker(URL.createObjectURL(new Blob([sabWorkerCode], { type: "application/javascript" })))
      sabWorker.postMessage(sab)
      // Warmup
      await new Promise((r) => setTimeout(r, 15))
      const sabSamplesUs: number[] = []
      for (let i = 1; i <= 50; i++) {
        const t0 = performance.now()
        data[0] = i
        Atomics.store(ctrl, 1, 0)
        Atomics.store(ctrl, 0, i)
        Atomics.notify(ctrl, 0, 1)
        while (Atomics.load(ctrl, 1) !== i) {
          // spin-poll completion
        }
        if (i > 10) sabSamplesUs.push((performance.now() - t0) * 1000)
      }
      Atomics.store(ctrl, 0, -1)
      Atomics.notify(ctrl, 0, 1)
      sabWorker.terminate()
      sabWorkerRoundTripMedianUs = Number(median(sabSamplesUs).toFixed(2))
      sabWorkerRoundTripP95Us = Number(p95(sabSamplesUs).toFixed(2))
    } catch {
      sabAvailable = false
    }
  }

  // ==========================================================================
  // PART 2: WEBGPU GPU-DRIVEN RENDERING (CPU Instanced vs GPU Compute Culling + drawIndirect)
  // ==========================================================================
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) throw new Error("No WebGPU adapter")
  const hasTimestamps = adapter.features.has("timestamp-query")
  const device = await adapter.requestDevice({
    requiredFeatures: hasTimestamps ? ["timestamp-query"] : [],
  })

  const W = 2592, H = 1420 // Balanced 1.5x Retina resolution
  const colorTex = device.createTexture({
    size: [W, H],
    sampleCount: 4,
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const resolveTex = device.createTexture({
    size: [W, H],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  const depthTex = device.createTexture({
    size: [W, H],
    sampleCount: 4,
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const colorView = colorTex.createView()
  const resolveView = resolveTex.createView()
  const depthView = depthTex.createView()

  // Create a 36-vertex (12-triangle) 24-byte packed box mesh representing a character body part
  const VERT_COUNT = 36
  const meshData = new Float32Array(VERT_COUNT * 6)
  for (let i = 0; i < VERT_COUNT; i++) {
    const tri = (i / 3) | 0
    const corner = i % 3
    meshData[i * 6] = (corner === 1 ? 0.15 : -0.15)
    meshData[i * 6 + 1] = (tri & 1 ? 0.45 : 0.0)
    meshData[i * 6 + 2] = (corner === 2 ? 0.15 : -0.15)
    meshData[i * 6 + 3] = 0.8
    meshData[i * 6 + 4] = 0.75
    meshData[i * 6 + 5] = 0.7
  }
  const meshBuf = device.createBuffer({
    size: meshData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(meshBuf, 0, meshData)

  // Shader for Path A (Standard Vertex-Buffer Instancing) & Path B (Storage-Buffer Pulled Compute-Culled drawIndirect)
  const renderWgsl = `
    struct Instance {
      posYaw: vec4f,
      tint: vec4f,
    };
    @group(0) @binding(0) var<storage, read> instances: array<Instance>;
    @group(0) @binding(1) var<storage, read> visibleIndices: array<u32>;

    struct VsOut {
      @builtin(position) pos: vec4f,
      @location(0) col: vec3f,
    };

    @vertex fn vsAttr(
      @location(0) vPos: vec3f,
      @location(1) vCol: vec3f,
      @location(2) iPosYaw: vec4f,
      @location(3) iTint: vec4f,
    ) -> VsOut {
      var out: VsOut;
      let world = vPos + iPosYaw.xyz;
      // Top-down orthographic-like projection covering [0..96] with camera viewing frustum [20..68] (~25% visible)
      let ndcX = (world.x - 44.0) / 24.0;
      let ndcY = (world.z - 44.0) / 24.0;
      let ndcZ = clamp(0.5 - world.y * 0.05, 0.01, 0.99);
      out.pos = vec4f(ndcX, ndcY, ndcZ, 1.0);
      out.col = vCol * iTint.rgb;
      return out;
    }

    @vertex fn vsPulled(
      @builtin(instance_index) instIdx: u32,
      @location(0) vPos: vec3f,
      @location(1) vCol: vec3f,
    ) -> VsOut {
      let realIdx = visibleIndices[instIdx];
      let inst = instances[realIdx];
      var out: VsOut;
      let world = vPos + inst.posYaw.xyz;
      let ndcX = (world.x - 44.0) / 24.0;
      let ndcY = (world.z - 44.0) / 24.0;
      let ndcZ = clamp(0.5 - world.y * 0.05, 0.01, 0.99);
      out.pos = vec4f(ndcX, ndcY, ndcZ, 1.0);
      out.col = vCol * inst.tint.rgb;
      return out;
    }

    @fragment fn fsSolid(in: VsOut) -> @location(0) vec4f {
      return vec4f(in.col, 1.0);
    }
  `

  const cullComputeWgsl = `
    struct Instance {
      posYaw: vec4f,
      tint: vec4f,
    };
    struct IndirectArgs {
      vertexCount: u32,
      instanceCount: atomic<u32>,
      firstVertex: u32,
      firstInstance: u32,
    };
    @group(0) @binding(0) var<storage, read> instances: array<Instance>;
    @group(0) @binding(1) var<storage, read_write> visibleIndices: array<u32>;
    @group(0) @binding(2) var<storage, read_write> indirect: IndirectArgs;

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3u) {
      let idx = gid.x;
      if (idx >= arrayLength(&instances)) { return; }
      let p = instances[idx].posYaw.xyz;
      // Frustum test against camera view [20..68, 20..68]
      if (p.x >= 19.0 && p.x <= 69.0 && p.z >= 19.0 && p.z <= 69.0) {
        let outSlot = atomicAdd(&indirect.instanceCount, 1u);
        visibleIndices[outSlot] = idx;
      }
    }
  `

  const renderMod = device.createShaderModule({ code: renderWgsl })
  const cullMod = device.createShaderModule({ code: cullComputeWgsl })

  const pipeAttr = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: renderMod,
      entryPoint: "vsAttr",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        },
        {
          arrayStride: 32,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 2, offset: 0, format: "float32x4" },
            { shaderLocation: 3, offset: 16, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: { module: renderMod, entryPoint: "fsSolid", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const pipePulled = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: renderMod,
      entryPoint: "vsPulled",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: { module: renderMod, entryPoint: "fsSolid", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const pipeCull = device.createComputePipeline({
    layout: "auto",
    compute: { module: cullMod, entryPoint: "main" },
  })

  const querySet = hasTimestamps ? device.createQuerySet({ type: "timestamp", count: 4 }) : null
  const queryResolve = hasTimestamps
    ? device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    : null
  const queryRead = hasTimestamps
    ? device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    : null

  const gpuDrivenComparison: Record<string, unknown> = {}

  for (const zombies of [500, 2000, 10000] as const) {
    const instCount = zombies * 8 // 8 body parts per zombie (4,000 / 16,000 / 80,000 instances)
    const instData = new Float32Array(instCount * 8)
    for (let i = 0; i < instCount; i++) {
      const z = (i / 8) | 0
      const part = i & 7
      instData[i * 8] = 4 + ((z * 17) % 88)
      instData[i * 8 + 1] = part * 0.18
      instData[i * 8 + 2] = 4 + ((z * 29) % 88)
      instData[i * 8 + 3] = 0
      instData[i * 8 + 4] = 0.85
      instData[i * 8 + 5] = 0.82
      instData[i * 8 + 6] = 0.78
      instData[i * 8 + 7] = 1
    }

    const instBuf = device.createBuffer({
      size: instData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(instBuf, 0, instData)

    const visIndicesBuf = device.createBuffer({
      size: instCount * 4,
      usage: GPUBufferUsage.STORAGE,
    })
    const indirectBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    const indirectReset = new Uint32Array([VERT_COUNT, 0, 0, 0])

    const cullGroup = device.createBindGroup({
      layout: pipeCull.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: instBuf } },
        { binding: 1, resource: { buffer: visIndicesBuf } },
        { binding: 2, resource: { buffer: indirectBuf } },
      ],
    })
    const pulledGroup = device.createBindGroup({
      layout: pipePulled.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: instBuf } },
        { binding: 1, resource: { buffer: visIndicesBuf } },
      ],
    })

    // Measure Path A: Unculled CPU pass.draw(36, instCount)
    const cpuDrawGpuMs: number[] = []
    for (let r = 0; r < 15; r++) {
      const enc = device.createCommandEncoder()
      const pass = enc.beginRenderPass({
        timestampWrites: querySet ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
        colorAttachments: [{ view: colorView, resolveTarget: resolveView, loadOp: "clear", storeOp: "discard", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        depthStencilAttachment: { view: depthView, depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1 },
      })
      pass.setPipeline(pipeAttr)
      pass.setVertexBuffer(0, meshBuf)
      pass.setVertexBuffer(1, instBuf)
      pass.draw(VERT_COUNT, instCount)
      pass.end()
      if (querySet && queryResolve && queryRead) {
        enc.resolveQuerySet(querySet, 0, 2, queryResolve, 0)
        enc.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 16)
      }
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      if (queryRead && r >= 3) {
        await queryRead.mapAsync(GPUMapMode.READ)
        const stamps = new BigUint64Array(queryRead.getMappedRange(0, 16))
        cpuDrawGpuMs.push(Number(stamps[1]! - stamps[0]!) / 1e6)
        queryRead.unmap()
      }
    }

    // Measure Path B: GPU Compute Frustum Culling + Storage-Buffer Pulled drawIndirect
    const gpuIndirectMs: number[] = []
    for (let r = 0; r < 15; r++) {
      device.queue.writeBuffer(indirectBuf, 0, indirectReset)
      const enc = device.createCommandEncoder()
      const cp = enc.beginComputePass({
        timestampWrites: querySet ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
      })
      cp.setPipeline(pipeCull)
      cp.setBindGroup(0, cullGroup)
      cp.dispatchWorkgroups(Math.ceil(instCount / 64))
      cp.end()

      const pass = enc.beginRenderPass({
        timestampWrites: querySet ? { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } : undefined,
        colorAttachments: [{ view: colorView, resolveTarget: resolveView, loadOp: "clear", storeOp: "discard", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        depthStencilAttachment: { view: depthView, depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1 },
      })
      pass.setPipeline(pipePulled)
      pass.setBindGroup(0, pulledGroup)
      pass.setVertexBuffer(0, meshBuf)
      pass.drawIndirect(indirectBuf, 0)
      pass.end()

      if (querySet && queryResolve && queryRead) {
        enc.resolveQuerySet(querySet, 0, 4, queryResolve, 0)
        enc.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 32)
      }
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      if (queryRead && r >= 3) {
        await queryRead.mapAsync(GPUMapMode.READ)
        const stamps = new BigUint64Array(queryRead.getMappedRange(0, 32))
        const minT = stamps[0]! < stamps[2]! ? stamps[0]! : stamps[2]!
        const maxT = stamps[3]! > stamps[1]! ? stamps[3]! : stamps[1]!
        gpuIndirectMs.push(Number(maxT - minT) / 1e6)
        queryRead.unmap()
      }
    }

    instBuf.destroy()
    visIndicesBuf.destroy()
    indirectBuf.destroy()

    gpuDrivenComparison[`zombies_${zombies}_${instCount}insts`] = {
      unculledDirectDrawGpuMedianMs: Number(median(cpuDrawGpuMs).toFixed(4)),
      computeCulledDrawIndirectGpuMedianMs: Number(median(gpuIndirectMs).toFixed(4)),
      deltaMs: Number((median(gpuIndirectMs) - median(cpuDrawGpuMs)).toFixed(4)),
    }
  }

  return {
    adapterInfo: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      description: adapter.info.description,
    },
    multithreading768KBPayload: {
      crossOriginIsolated: crossOriginIsolatedFlag,
      workerStructuredCloneRoundTripMedianMs: Number(median(cloneTimes).toFixed(3)),
      workerStructuredCloneRoundTripP95Ms: Number(p95(cloneTimes).toFixed(3)),
      workerTransferablePingPongRoundTripMedianMs: Number(median(transferTimes).toFixed(3)),
      workerTransferablePingPongRoundTripP95Ms: Number(p95(transferTimes).toFixed(3)),
      sharedArrayBufferWorkerRoundTripMedianUs: sabWorkerRoundTripMedianUs,
      sharedArrayBufferWorkerRoundTripP95Us: sabWorkerRoundTripP95Us,
      transferableSpeedupOverCloneX: Number((median(cloneTimes) / median(transferTimes)).toFixed(1)),
    },
    gpuDrivenDrawIndirectVsDirectInstanced: gpuDrivenComparison,
  }
})

await browser.close()
server.stop()

writeFileSync(join(import.meta.dir, "results-metal.json"), JSON.stringify(benchResult, null, 2) + "\n")
console.log(JSON.stringify(benchResult, null, 2))
