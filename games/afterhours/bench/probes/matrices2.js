async () => {
  const { scene } = globalThis.__afterhoursDebug
  const by = {}
  scene.traverse((o) => {
    if (!o.matrixAutoUpdate || o.isLight || o.isBone) return
    const path = []
    for (let p = o; p && p.parent; p = p.parent) path.unshift((p.name || p.type).replace(/[0-9]+/g, "#"))
    const k = path.slice(0, 4).join("/") + " | " + o.type
    by[k] = (by[k] ?? 0) + 1
  })
  return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 30)
}
