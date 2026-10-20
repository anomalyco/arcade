// Which render objects recompute their full cache key every frame, and why (material.version bump vs needsUpdate).
async () => {
  const { renderer } = globalThis.__afterhoursDebug
  const objects = renderer._objects
  let proto = null
  const counts = new Map()
  const versionBumps = new Map()
  const wrapProto = (ro) => {
    proto = Object.getPrototypeOf(ro)
    const orig = proto.getMaterialCacheKey
    proto.getMaterialCacheKey = function () {
      const m = this.material
      const why = this.version !== m.version ? "version" : "needsUpdate"
      const k = `${why} | ${m.name || m.type} | ${this.object.name || this.object.type}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
      return orig.call(this)
    }
    const nu = Object.getOwnPropertyDescriptor(proto, "needsUpdate")
    void nu
  }
  const get = objects.get
  objects.get = function (...a) {
    const ro = get.apply(this, a)
    if (!proto && ro) wrapProto(ro)
    return ro
  }
  // Track material.version per frame.
  const mats = new Set()
  globalThis.__afterhoursDebug.scene.traverse((o) => { if (o.material) for (const m of [o.material].flat()) mats.add(m) })
  const v0 = new Map([...mats].map((m) => [m, m.version]))
  const frames = 60
  await new Promise((r) => { let n = 0; const t = () => (++n >= frames ? r() : requestAnimationFrame(t)); requestAnimationFrame(t) })
  objects.get = get
  for (const m of mats) if (m.version !== v0.get(m)) versionBumps.set(m.name || m.type, m.version - v0.get(m))
  const per = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, +(v / frames).toFixed(1)])
  // needsUpdate cause breakdown for one sample
  return { callsPerFrame: per, totalPerFrame: +([...counts.values()].reduce((a, b) => a + b, 0) / frames).toFixed(1), materialVersionBumpsOver60Frames: Object.fromEntries([...versionBumps].sort((a, b) => b[1] - a[1]).slice(0, 30)) }
}
