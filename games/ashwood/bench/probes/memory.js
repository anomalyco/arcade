// CPU-side copies of GPU data still held by JS: geometry attribute arrays and texture images, by module and largest.
async () => {
  const { scene, renderer } = globalThis.__ashwoodDebug
  const seen = new Set()
  const byMod = {}
  const big = []
  let total = 0
  const add = (mod, what, arr) => {
    if (!arr || seen.has(arr.buffer ?? arr)) return
    seen.add(arr.buffer ?? arr)
    const b = arr.buffer?.byteLength ?? arr.byteLength ?? 0
    total += b
    byMod[mod] = (byMod[mod] ?? 0) + b
    big.push([b, what])
  }
  scene.traverse((o) => {
    let root = o
    while (root.parent && root.parent !== scene) root = root.parent
    const mod = root.name || root.type
    const g = o.geometry
    if (g) {
      for (const [k, a] of Object.entries(g.attributes)) add(mod, `${o.name}.${k} ${a.count}x${a.itemSize}`, a.array)
      if (g.index) add(mod, `${o.name}.index ${g.index.count}`, g.index.array)
    }
    if (o.instanceMatrix) add(mod, `${o.name}.instanceMatrix`, o.instanceMatrix.array)
    for (const m of [o.material].flat()) {
      if (!m) continue
      for (const v of Object.values(m)) if (v && v.isTexture && v.image && v.image.data) add(mod + ":tex", `${m.name}.${v.name}`, v.image.data)
    }
  })
  big.sort((a, b) => b[0] - a[0])
  const mb = (x) => +(x / 1e6).toFixed(1)
  return { totalMB: mb(total), byModuleMB: Object.fromEntries(Object.entries(byMod).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, mb(v)])), largest: big.slice(0, 25).map(([b, w]) => [mb(b), w]), info: renderer.info.memory }
}
