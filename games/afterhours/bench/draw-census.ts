// Draw census: for each view, every draw the renderer actually issues in one frame (after three's frustum culling),
// attributed to its pass (scene G-buffer, shadow maps, mirror, post quads), top-level module group, sub-group,
// mesh and material, with triangles; plus flags for draws that probably shouldn't happen (interior from outside,
// non-adjacent storeys, exact/content duplicates, zero-triangle draws, tiny draws, documents, mirrors).
//
//   bun bench/draw-census.ts --dir $TMP/build [--views lot,gate,road,entrance,s0,s1,s2,s3,s4,mirror] [--out f.json]
//
// One page load (view=road, ?shot so the player doesn't move the camera); the camera is then placed at each view in
// turn (named viewpoints from layout.ts, storey spines at (-12, storeyY+1.65, 1.1) facing -x like the integration
// audit, and 1.6 m in front of the nearest mirror) and left to settle for 60 frames before one frame is recorded.
import { writeFileSync } from "node:fs"
import { VIEWPOINTS, storeyY } from "../src/world/layout"
import { arg, launch, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/build`)!
const views = arg(args, "views", "lot,gate,road,entrance,s0,s1,s2,s3,s4,mirror")!.split(",")
const outFile = arg(args, "out")
const [w, h] = arg(args, "size", "1536x1024")!.split("x").map(Number) as [number, number]

type Cam = { pos: [number, number, number]; yaw: number; pitch: number } | "mirror"
const camFor = (v: string): Cam => {
  const s = /^s(\d)$/.exec(v)
  if (s) return { pos: [-12, storeyY(Number(s[1])) + 1.65, 1.1], yaw: Math.PI / 2, pitch: 0 }
  if (v === "mirror") return "mirror"
  const vp = VIEWPOINTS[v as keyof typeof VIEWPOINTS]
  if (!vp) throw new Error(`unknown view ${v}`)
  return { pos: [...vp.pos] as [number, number, number], yaw: vp.yaw, pitch: vp.pitch }
}

const server = serve(dir, 5225)
const browser = await launch()
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5225/?shot=1&perf=1&view=road`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, undefined, { timeout: 300_000, polling: 200 })
await page.waitForTimeout(1500)

// Install the per-draw hooks once.
await page.evaluate(() => {
  const g = globalThis as any
  const { renderer, scene } = g.__afterhoursDebug
  const backend = renderer.backend
  const st: any = (g.__census = { armed: false, rec: false, draws: [], label: "", frameDone: null })
  const render = renderer.render
  renderer.render = function (sc: any, cam: any) {
    const prev = st.label
    st.label = sc === scene ? (cam?.isCamera && cam !== g.__afterhoursDebug.camera ? (cam.name || "camera:other") : "scene") : sc?.isScene ? `scene:${sc.name || "?"}` : sc?.isMesh ? `quad:${sc.material?.name || "?"}` : "?"
    try { return render.call(this, sc, cam) } finally { st.label = prev }
  }
  // Mirror renders call renderer.render(scene, virtualCam): label them by camera.
  const mir = g.__afterhoursMirrors
  if (mir?.virtualCam) mir.virtualCam.name = "mirror"
  const draw = backend.draw
  backend.draw = function (ro: any, info: any) {
    if (!st.rec) return draw.call(this, ro, info)
    const t0 = renderer.info.render.triangles
    const r = draw.call(this, ro, info)
    const o = ro.object
    const path: string[] = []
    for (let p = o; p && p !== scene; p = p.parent) path.unshift(p.name || p.type)
    const shadow = ro.material?.isShadowPassMaterial || /Shadow/i.test(st.label) || ro.context?.depth && !ro.context?.textures
    const geo = ro.geometry
    if (geo && !geo.boundingBox) geo.computeBoundingBox()
    const bb = geo?.boundingBox
    const e = o.matrixWorld.elements
    st.draws.push({
      pass: st.label,
      path,
      mesh: o.name || o.type,
      type: o.isInstancedMesh ? "InstancedMesh" : o.isBatchedMesh ? "BatchedMesh" : o.isSprite ? "Sprite" : o.isMesh ? "Mesh" : o.type,
      mat: ro.material?.name || ro.material?.type || "?",
      matId: ro.material?.id,
      geoId: geo?.id,
      tris: renderer.info.render.triangles - t0,
      inst: o.count ?? geo?.instanceCount ?? 1,
      transparent: !!ro.material?.transparent,
      shadowPassMat: !!shadow,
      key: `${geo?.id}|${ro.material?.id}|${e.map((x: number) => x.toFixed(3)).join(",")}`,
      contentKey: bb ? `${ro.material?.name}|${geo.attributes.position?.count}|${[bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map((x: number) => x.toFixed(2)).join(",")}|${e.map((x: number) => x.toFixed(2)).join(",")}` : "",
      wy: e[13],
    })
    return r
  }
  const anim = renderer._animation
  const loop = anim._animationLoop
  anim._animationLoop = function (t: number, xr: any) {
    if (st.armed) {
      st.armed = false
      st.rec = true
      st.draws = []
      st.info0 = renderer.info.render.calls
    }
    loop.call(this, t, xr)
    if (st.rec) {
      st.rec = false
      st.infoDraws = renderer.info.render.drawCalls
      st.infoTris = renderer.info.render.triangles
      st.frameDone?.()
    }
  }
})

const reports: Record<string, unknown> = {}
for (const v of views) {
  const cam = camFor(v)
  const res = await page.evaluate(async ({ cam, v }) => {
    const g = globalThis as any
    const { camera, scene } = g.__afterhoursDebug
    const st = g.__census
    if (cam === "mirror") {
      const mirrors = g.__afterhoursMirrors?.mirrors ?? []
      if (!mirrors.length) return { error: "no mirrors" }
      // Lowest storey's first mirror.
      const m = [...mirrors].sort((a: any, b: any) => a.center.y - b.center.y)[0]
      const p = m.center.clone().addScaledVector(m.normal, 1.6)
      camera.position.set(p.x, m.center.y, p.z)
      camera.rotation.set(0, Math.atan2(m.normal.x, m.normal.z), 0, "YXZ")
    } else {
      camera.position.set(...cam.pos)
      camera.rotation.set(cam.pitch, cam.yaw, 0, "YXZ")
    }
    camera.updateMatrixWorld()
    await new Promise<void>((r) => {
      let n = 0
      const tick = () => (++n >= 60 ? r() : requestAnimationFrame(tick))
      requestAnimationFrame(tick)
    })
    const done = new Promise<void>((r) => (st.frameDone = r))
    st.armed = true
    await done
    const draws = st.draws as any[]
    const B = (rows: any[], key: (d: any) => string) => {
      const m = new Map<string, { draws: number; tris: number }>()
      for (const d of rows) {
        const k = key(d)
        const e = m.get(k) ?? { draws: 0, tris: 0 }
        e.draws++
        e.tris += d.tris
        m.set(k, e)
      }
      return Object.fromEntries([...m].sort((a, b) => b[1].draws - a[1].draws))
    }
    const top = (o: Record<string, any>, n: number) => Object.fromEntries(Object.entries(o).slice(0, n))
    const passOf = (d: any) => (d.pass === "scene" ? "scene" : d.pass === "mirror" ? "mirror" : /Shadow/i.test(d.pass) ? "shadow" : d.pass.startsWith("quad:") ? "post" : d.pass)
    const sceneDraws = draws.filter((d) => passOf(d) === "scene")
    const p = camera.position
    const inside = p.x > -55 && p.x < 35 && p.z > -22 && p.z < 25.2 && p.y < 19.15
    const camStorey = inside ? Math.max(0, Math.min(4, Math.floor((p.y - 0.15) / 3.8))) : -1
    const storeyOf = (d: any) => {
      const s = d.path.find((x: string) => /^storey-\d/.test(x))
      return s ? Number(s.split("-")[1]) : null
    }
    // Flags.
    const dupExact = new Map<string, any[]>()
    const dupContent = new Map<string, any[]>()
    for (const d of sceneDraws) {
      if (d.type === "InstancedMesh") continue
      dupExact.set(d.key, [...(dupExact.get(d.key) ?? []), d])
      if (d.contentKey) dupContent.set(d.contentKey, [...(dupContent.get(d.contentKey) ?? []), d])
    }
    const dupList = (m: Map<string, any[]>) =>
      [...m.values()].filter((l) => l.length > 1).map((l) => ({ n: l.length, path: l[0].path.slice(0, 3).join("/"), mesh: l[0].mesh, mat: l[0].mat, tris: l[0].tris, meshes: [...new Set(l.map((d: any) => d.path.join("/")))].slice(0, 3) }))
    const interiorOutside = !inside ? sceneDraws.filter((d) => d.path[0] === "interior") : []
    const nonAdjacent = inside ? sceneDraws.filter((d) => { const s = storeyOf(d); return s !== null && Math.abs(s - camStorey) > 1 }) : []
    const sub = (d: any) => d.path.slice(0, d.path[0] === "interior" ? 3 : 2).join("/")
    return {
      raw: draws.map((d) => ({ pass: passOf(d), path: d.path.join("/"), mat: d.mat, tris: d.tris, type: d.type, tr: d.transparent ? 1 : 0, wy: +d.wy.toFixed(1) })),
      camera: [p.x, p.y, p.z].map((x: number) => +x.toFixed(2)),
      inside,
      camStorey,
      infoDrawCalls: st.infoDraws,
      infoTriangles: st.infoTris,
      recordedDraws: draws.length,
      byPass: B(draws, passOf),
      sceneByModule: B(sceneDraws, (d) => d.path[0] ?? "(scene)"),
      sceneBySubgroup: top(B(sceneDraws, sub), 30),
      sceneByMaterial: top(B(sceneDraws, (d) => d.mat), 30),
      sceneByType: B(sceneDraws, (d) => d.type),
      shadowByModule: B(draws.filter((d) => passOf(d) === "shadow"), (d) => d.path[0] ?? "(scene)"),
      mirrorByModule: B(draws.filter((d) => passOf(d) === "mirror"), (d) => d.path[0] ?? "(scene)"),
      flags: {
        interiorFromOutside: { draws: interiorOutside.length, tris: interiorOutside.reduce((a, d) => a + d.tris, 0), by: top(B(interiorOutside, (d) => d.path.slice(0, 3).join("/")), 20) },
        nonAdjacentStoreys: { draws: nonAdjacent.length, tris: nonAdjacent.reduce((a, d) => a + d.tris, 0), by: top(B(nonAdjacent, (d) => d.path.slice(0, 3).join("/")), 12) },
        exactDuplicates: dupList(dupExact).slice(0, 15),
        contentDuplicates: dupList(dupContent).slice(0, 15),
        zeroTriangleDraws: { draws: sceneDraws.filter((d) => d.tris === 0).length, by: top(B(sceneDraws.filter((d) => d.tris === 0), sub), 10) },
        tinyDraws: { draws: sceneDraws.filter((d) => d.tris > 0 && d.tris < 64).length, tris: sceneDraws.filter((d) => d.tris > 0 && d.tris < 64).reduce((a, d) => a + d.tris, 0), by: top(B(sceneDraws.filter((d) => d.tris > 0 && d.tris < 64), sub), 12) },
        documents: B(sceneDraws.filter((d) => /^documents/.test(d.mesh)), sub),
        mirrors: B(sceneDraws.filter((d) => /mirror/i.test(d.mat) || /mirror/i.test(d.mesh)), sub),
        transparent: { draws: sceneDraws.filter((d) => d.transparent).length },
      },
    }
  }, { cam, v })
  reports[v] = res
  console.error(`${v}: ${(res as any).recordedDraws ?? (res as any).error} draws`)
}

// Whole-scene inventory (not just what's drawn): meshes and triangles per module/sub-group, hidden vs shown.
const inventory = await page.evaluate(() => {
  const { scene } = (globalThis as any).__afterhoursDebug
  const out: Record<string, { meshes: number; materials: Set<number>; tris: number }> = {}
  scene.traverse((o: any) => {
    if (!o.isMesh) return
    const path: string[] = []
    for (let p = o; p && p !== scene; p = p.parent) path.unshift(p.name || p.type)
    const k = path.slice(0, path[0] === "interior" ? 3 : 2).join("/")
    const e = (out[k] ??= { meshes: 0, materials: new Set(), tris: 0 })
    e.meshes++
    e.materials.add(o.material?.id)
    const g = o.geometry
    e.tris += ((g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3) * (o.count ?? 1)
  })
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].meshes - a[1].meshes).map(([k, v]) => [k, { meshes: v.meshes, materials: v.materials.size, tris: Math.round(v.tris) }]))
})

const result = { size: `${w}x${h}`, views: reports, inventory, errors: errors.slice(0, 5) }
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ ...result, views: Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, { ...(v as any), raw: undefined }])) }, null, 1))
await browser.close()
server.stop(true)
process.exit(0)
