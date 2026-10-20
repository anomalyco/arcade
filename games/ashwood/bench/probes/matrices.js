// Objects that still compose their local matrix every frame (matrixAutoUpdate), by top-level group and type.
async () => {
  const { scene } = globalThis.__afterhoursDebug
  const by = {}
  let total = 0, auto = 0
  scene.traverse((o) => {
    total++
    if (!o.matrixAutoUpdate) return
    auto++
    let root = o
    while (root.parent && root.parent !== scene) root = root.parent
    const k = `${root.name || root.type} | ${o.type}`
    by[k] = (by[k] ?? 0) + 1
  })
  return { total, auto, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 30) }
}
