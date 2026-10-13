// Injected into an isolated Playwright page before application startup.
(() => {
  let seed = 1337
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  let callback, now = 1000
  window.requestAnimationFrame = (cb) => { callback = cb; return 1 }
  const p = window.__measure = { samples: [], uploads: [], enabled: false, pending: Promise.resolve(), variant: 'baseline' }
  const currentTexture = GPUCanvasContext.prototype.getCurrentTexture
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    if (p.variant !== 'isolated') return currentTexture.call(this)
    // Canvas textures expire at presentation; serialized diagnostics need a persistent equivalent target.
    if (!p.offscreen || p.offscreen.width !== this.canvas.width || p.offscreen.height !== this.canvas.height) {
      p.offscreen?.destroy()
      p.offscreen = p.device.createTexture({size:[this.canvas.width,this.canvas.height],format:navigator.gpu.getPreferredCanvasFormat(),usage:GPUTextureUsage.RENDER_ATTACHMENT})
    }
    return p.offscreen
  }
  p.raf = () => { now += 1000 / 60; callback?.(now) }
  const request = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (desc) {
    p.adapter = { ...this.info.toJSON?.(), vendor: this.info.vendor, architecture: this.info.architecture, description: this.info.description, fallback: this.info.isFallbackAdapter, timestamps: this.features.has('timestamp-query') }
    if (p.adapter.fallback || /swiftshader/i.test(JSON.stringify(p.adapter)) || !p.adapter.timestamps) throw Error('Hardware timestamps required')
    const d = await request.call(this, desc)
    d.addEventListener('uncapturederror', e => console.error('Benchmark GPU validation:', e.error.message))
    p.device = d
    const qs = d.createQuerySet({ type: 'timestamp', count: 64 })
    const resolve = d.createBuffer({ size: 512, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const read = d.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const pipes = new WeakMap(), views = new WeakMap()
    const texture = d.createTexture.bind(d)
    d.createTexture = (desc) => {
      const tex = texture(p.variant === 'msaa1' && desc.sampleCount === 4 ? { ...desc, sampleCount: 1 } : desc)
      const createView = tex.createView.bind(tex)
      tex.createView = (...args) => { const v = createView(...args); views.set(v, { width: tex.width, height: tex.height, samples: tex.sampleCount, format: tex.format }); return v }
      return tex
    }
    const pipeline = d.createRenderPipeline.bind(d)
    d.createRenderPipeline = (desc) => {
      const pipe = pipeline(p.variant === 'msaa1' && desc.multisample?.count === 4 ? { ...desc, multisample: { ...desc.multisample, count: 1 } } : desc)
      pipes.set(pipe, { blend: !!desc.fragment?.targets?.[0]?.blend, vertex: desc.vertex.entryPoint, fragment: desc.fragment?.entryPoint })
      return pipe
    }
    const write = d.queue.writeBuffer.bind(d.queue)
    d.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
      const bytes = size === undefined ? data.byteLength - (dataOffset ?? 0) * (data.BYTES_PER_ELEMENT ?? 1) : size * (data.BYTES_PER_ELEMENT ?? 1)
      if (p.enabled) p.uploads.push(bytes)
      return write(buffer, offset, data, dataOffset, size)
    }
    const create = d.createCommandEncoder.bind(d), submit = d.queue.submit.bind(d.queue)
    const commands = new WeakMap()
    const normalize = desc => {
      const a = desc?.colorAttachments?.[0]
      return p.variant === 'msaa1' && a?.resolveTarget ? { ...desc, colorAttachments: [{ ...a, view: a.resolveTarget, resolveTarget: undefined, storeOp: 'store' }] } : desc
    }
    let busy = false
    d.createCommandEncoder = (...args) => {
      const enc = create(...args)
      if (p.enabled && p.packStart !== undefined) { (p.calls['packing-upload-cull'] ??= []).push(performance.now() - p.packStart); p.packStart = undefined }
      if (!p.enabled || busy) {
        const render = enc.beginRenderPass.bind(enc)
        enc.beginRenderPass = desc => render(normalize(desc))
        return enc
      }
      busy = true
      const passes = []
      let inner = enc
      const isolated = []
      const begin = (kind, desc = {}) => {
        const i = passes.length
        if (i >= 32) throw Error('Query capacity exceeded')
        const a = desc.colorAttachments?.[0]
        const meta = { kind, depthOnly: kind === 'render' && !a, draws: 0, vertices: 0, blendDraws: 0, blendVertices: 0, sprites: 0, resolve: !!a?.resolveTarget, target: views.get(a?.view), pipelines: {} }
        passes.push(meta)
        desc = normalize(desc)
        const beginPass = inner === enc ? (kind === 'compute' ? compute : render) : inner[kind === 'compute' ? 'beginComputePass' : 'beginRenderPass'].bind(inner)
        const pass = beginPass({ ...desc, timestampWrites: { querySet: qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } })
        if (p.variant === 'serial' || p.variant === 'isolated') {
          const end = pass.end.bind(pass)
          pass.end = () => { end(); const cb = inner === enc ? finish() : inner.finish(); if (p.variant === 'isolated') isolated.push(cb); else submit([cb]); inner = create() }
        }
        if (kind === 'render') {
          let current = {}
          const set = pass.setPipeline.bind(pass)
          pass.setPipeline = (pipe) => { current = pipes.get(pipe) ?? {}; set(pipe) }
          for (const name of ['draw', 'drawIndexed']) {
            const draw = pass[name].bind(pass)
            pass[name] = (vertices, instances = 1, ...args) => {
              meta.draws++; meta.vertices += vertices * instances
              const key = `${current.vertex}/${current.fragment}`
              const row = meta.pipelines[key] ??= { draws: 0, vertices: 0 }
              row.draws++; row.vertices += vertices * instances
              if (current.blend) { meta.blendDraws++; meta.blendVertices += vertices * instances }
              if (vertices === 6 && current.blend) meta.sprites += instances
              if (p.variant === 'no-sprites' && vertices === 6 && current.blend) return
              return draw(vertices, instances, ...args)
            }
          }
        }
        return pass
      }
      const render = enc.beginRenderPass.bind(enc), compute = enc.beginComputePass.bind(enc)
      enc.beginRenderPass = (desc) => begin('render', desc)
      enc.beginComputePass = (desc) => begin('compute', desc)
      const finish = enc.finish.bind(enc)
      enc.finish = (...args) => {
        inner.resolveQuerySet(qs, 0, passes.length * 2, resolve, 0)
        inner.copyBufferToBuffer(resolve, 0, read, 0, passes.length * 16)
        const cb = inner === enc ? finish(...args) : inner.finish(...args); commands.set(cb, { passes, isolated }); return cb
      }
      return enc
    }
    d.queue.submit = (buffers) => {
      const list = [...buffers]
      const sample = list.map(x => commands.get(x)).find(Boolean)
      if (!sample) { submit(list); return }
      const { passes, isolated } = sample
      if (!isolated.length) submit(list)
      p.pending = (async () => {
        if (isolated.length) { for (const cb of isolated) { submit([cb]); await d.queue.onSubmittedWorkDone() }; submit(list) }
        await read.mapAsync(GPUMapMode.READ)
        const times = new BigUint64Array(read.getMappedRange(0, passes.length * 16))
        const origin = times[0]
        for (let i = 0; i < passes.length; i++) passes[i].range = [Number(times[i*2] - origin) / 1e6, Number(times[i*2+1] - origin) / 1e6]
        read.unmap()
        // Preserve raw spans. Analysis partitions their union; it never adds overlapping pass durations.
        p.samples.push(passes)
        busy = false
      })()
    }
    return d
  }
})()
