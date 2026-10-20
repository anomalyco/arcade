// Builds the moving-part map for the intro's car (src/game/intro/car-parts.json) from the original source model.
//
//   bun scripts/intro/car-parts.ts            # needs the cached source and tools from `bun scripts/fetch-models.ts`
//
// The shipped `public/models/car_sedan_b.glb` is one baked mesh (opaque + glass over one atlas, shared shaders with every
// other model), so its doors, wheels and steering wheel can't move. The source GLB (cached by fetch-models.ts in
// $TMPDIR/ashwood-models) still has them as named nodes. This script bakes the source exactly as fetch-models.ts does
// (yaw, real-world scale, footprint pivot), labels every triangle of the shipped LOD0 by the source part it lies on
// (nearest source triangle to its centroid; the atlas bake clips and reorders triangles, so indices can't be matched),
// and writes run-length label lists per primitive plus each part's pivot data. At runtime (car.ts) the shipped mesh is
// split by these labels: same material, same shaders, no extra download. Re-run after re-fetching car_sedan_b.
import { existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Per model: the source (must match MODEL_SOURCES in scripts/fetch-models.ts; importing that script would run it),
 *  the driver's-door / steering / lamp source nodes, and where the map goes. `bun scripts/intro/car-parts.ts [model]`. */
const MODELS: Record<string, { uid: string; yaw: number; size: { axis: "x" | "y" | "z"; m: number }; parts: [string, RegExp][]; extra: RegExp; out: string }> = {
  car_sedan_b: {
    uid: "892b2684fb37442299bfad9222cf331c",
    yaw: 90,
    size: { axis: "z", m: 5.1 },
    parts: [
      ["door_fl", /^(Door_FL|Door_FL_Inner|Glass_Door_FL|Doorcard_FL|Sidemirror_Left)$/],
      ["steering", /^Steering_wheel$/],
      ["wheel_fl", /^Wheel_FL$/],
      ["wheel_fr", /^Wheel_FR$/],
      ["wheel_rl", /^Wheel_RL$/],
      ["wheel_rr", /^Wheel_RR$/],
      ["headlight", /^Headlight_glass$/],
      ["stoplight", /^Stoplight_glass$/],
      ["turnsignal", /^Turnsignals_glass$/],
      ["reverse", /^Reverselights$/],
      ["dashboard", /^Dashboard$/],
    ],
    extra: /^(Doorcard_FL|Seats|Glass_Door_FL|Door_FL_Inner)$/,
    out: "src/game/intro/car-parts.json",
  },
  car_pickup: {
    uid: "6c48c94be8974dc7a5932f697c0ba68f",
    yaw: -90,
    size: { axis: "z", m: 4.5 },
    parts: [
      ["door_fl", /^(Door_left|Door_innerl_left|Door_glass_left|Doorcard_left)$/],
      ["steering", /^Steering_wheel$/],
      ["wheel_fl", /^Wheel_FL$/],
      ["wheel_fr", /^Wheel_FR$/],
      ["wheel_rl", /^Wheel_RL$/],
      ["wheel_rr", /^Wheel_RR$/],
      ["headlight", /^Headlights_Riverside88_lights_0$/],
      ["stoplight", /^Stioplights_glass$/],
      ["turnsignal", /^Turnsignal_glass_(front|rear)$/],
      ["reverse", /^Reverselights_glass$/],
      ["dashboard", /^Dashboard$/],
    ],
    extra: /^(Doorcard_left|Seats|Door_glass_left|Door_innerl_left)$/,
    out: "src/game/escape/truck-parts.json",
  },
}
const NAME = process.argv[2] ?? "car_sedan_b"
const spec = MODELS[NAME]
if (!spec) throw new Error(`unknown model ${NAME}: ${Object.keys(MODELS).join(", ")}`)
const tools = join(tmpdir(), "ashwood-gltf-tools")
const work = join(tmpdir(), "ashwood-models")
if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) throw new Error("run `bun scripts/fetch-models.ts` first (installs the glTF tools)")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": mo.MeshoptDecoder })

const srcFile = join(work, `${spec.uid}.glb`)
if (!existsSync(srcFile)) throw new Error(`${srcFile} missing: run \`bun scripts/fetch-models.ts ${NAME} \``)

/** Part label per source node name (first match wins); everything else is the body (0). */
const PARTS = spec.parts
const labelOf = (name: string) => {
  const i = PARTS.findIndex(([, re]) => re.test(name))
  return i < 0 ? 0 : i + 1
}

type M = number[]
const mul = (a: M, b: M): M => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!
  return o
}
const rotY = (deg: number): M => {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}
const apply = (m: M, p: number[]) => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function triangles(prim: any, m: M, out: number[][]) {
  const pos = prim.getAttribute("POSITION")
  const idx = prim.getIndices()
  const n = idx ? idx.getCount() : pos.getCount()
  const v = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    pos.getElement(idx ? idx.getScalar(i) : i, v)
    out.push(apply(m, v))
  }
}

// ---- source, baked like fetch-models.ts: world × yaw, then scale along spec.size.axis, then footprint pivot.
const src = await io.read(srcFile)
await src.transform(fn.uninstance())
const orient = rotY(spec.yaw)
const srcTris: { label: number; v: number[][]; node: string }[] = []
/** Source nodes whose bounds are recorded too (rig points: the door card for the inner handle, the seats for the hip). */
const EXTRA = spec.extra
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
scene.traverse((n: any) => {
  const mesh = n.getMesh()
  if (!mesh) return
  const m = mul(orient, n.getWorldMatrix())
  let label = 0
  let named = ""
  for (let p = n; p && p.propertyType === "Node"; p = p.getParentNode()) {
    if (!label) label = labelOf(p.getName())
    if (!named && EXTRA.test(p.getName())) named = p.getName()
  }
  for (const p of mesh.listPrimitives()) {
    const pts: number[][] = []
    triangles(p, m, pts)
    for (let i = 0; i < pts.length; i += 3) srcTris.push({ label, node: named, v: [pts[i]!, pts[i + 1]!, pts[i + 2]!] })
  }
})
const bounds = (tris: number[][][]) => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) for (const p of t) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k]!, p[k]!)), (hi[k] = Math.max(hi[k]!, p[k]!))
  return { lo, hi }
}
let b = bounds(srcTris.map((t) => t.v))
const axis = { x: 0, y: 1, z: 2 }[spec.size.axis]
const k = spec.size.m / (b.hi[axis]! - b.lo[axis]!)
const off = [-((b.lo[0]! + b.hi[0]!) / 2) * k, -b.lo[1]! * k, -((b.lo[2]! + b.hi[2]!) / 2) * k]
for (const t of srcTris) for (const p of t.v) for (let i = 0; i < 3; i++) p[i] = p[i]! * k + off[i]!
b = bounds(srcTris.map((t) => t.v))

// ---- shipped model: LOD0 primitives in file order.
const out = await io.read(join(import.meta.dir, `../../public/models/${NAME}.glb`))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prims: { name: string; tris: number[][][] }[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(out.getRoot().getDefaultScene() ?? out.getRoot().listScenes()[0]).traverse((n: any) => {
  const mesh = n.getMesh()
  if (!mesh || /_lod1$/.test(mesh.getName())) return
  const m = n.getWorldMatrix()
  for (const p of mesh.listPrimitives()) {
    const pts: number[][] = []
    triangles(p, m, pts)
    const tris: number[][][] = []
    for (let i = 0; i < pts.length; i += 3) tris.push([pts[i]!, pts[i + 1]!, pts[i + 2]!])
    prims.push({ name: mesh.getName(), tris })
  }
})
const ob = bounds(prims.flatMap((p) => p.tris))
console.log("source baked bounds", b.lo.map((v) => v.toFixed(3)), b.hi.map((v) => v.toFixed(3)))
console.log("shipped bounds     ", ob.lo.map((v) => v.toFixed(3)), ob.hi.map((v) => v.toFixed(3)))

// ---- nearest source triangle per shipped triangle centroid (uniform grid over source triangle boxes).
const CELL = 0.08
const grid = new Map<string, number[]>()
const key = (x: number, y: number, z: number) => `${x},${y},${z}`
srcTris.forEach((t, i) => {
  const { lo, hi } = bounds([t.v])
  for (let x = Math.floor(lo[0]! / CELL); x <= Math.floor(hi[0]! / CELL); x++)
    for (let y = Math.floor(lo[1]! / CELL); y <= Math.floor(hi[1]! / CELL); y++)
      for (let z = Math.floor(lo[2]! / CELL); z <= Math.floor(hi[2]! / CELL); z++) {
        const kk = key(x, y, z)
        const l = grid.get(kk)
        if (l) l.push(i)
        else grid.set(kk, [i])
      }
})
const sub = (a: number[], c: number[]) => [a[0]! - c[0]!, a[1]! - c[1]!, a[2]! - c[2]!]
const dot = (a: number[], c: number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!
/** Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function distTri(p: number[], a: number[], bb: number[], c: number[]) {
  const ab = sub(bb, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  const at = (u: number, v: number) => [a[0]! + ab[0]! * u + ac[0]! * v, a[1]! + ab[1]! * u + ac[1]! * v, a[2]! + ab[2]! * u + ac[2]! * v]
  let q: number[]
  if (d1 <= 0 && d2 <= 0) q = a
  else {
    const bp = sub(p, bb), d3 = dot(ab, bp), d4 = dot(ac, bp)
    if (d3 >= 0 && d4 <= d3) q = bb
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) q = at(d1 / (d1 - d3), 0)
      else {
        const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
        if (d6 >= 0 && d5 <= d6) q = c
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) q = at(0, d2 / (d2 - d6))
          else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
              q = [bb[0]! + (c[0]! - bb[0]!) * w, bb[1]! + (c[1]! - bb[1]!) * w, bb[2]! + (c[2]! - bb[2]!) * w]
            } else {
              const den = 1 / (va + vb + vc)
              q = at(vb * den, vc * den)
            }
          }
        }
      }
    }
  }
  const d = sub(p, q)
  return dot(d, d)
}
let worst = 0
const labels = prims.map((p) =>
  p.tris.map((t) => {
    const c = [0, 1, 2].map((i) => (t[0]![i]! + t[1]![i]! + t[2]![i]!) / 3)
    let best = Infinity
    let label = 0
    for (let r = 0; r <= 2 && best === Infinity; r++) {
      const cx = Math.floor(c[0]! / CELL), cy = Math.floor(c[1]! / CELL), cz = Math.floor(c[2]! / CELL)
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++)
            for (const i of grid.get(key(x, y, z)) ?? []) {
              const s = srcTris[i]!
              const d = distTri(c, s.v[0]!, s.v[1]!, s.v[2]!)
              if (d < best) {
                best = d
                label = s.label
              }
            }
    }
    worst = Math.max(worst, Math.sqrt(best))
    return label
  }),
)
console.log(`worst centroid distance ${(worst * 1000).toFixed(1)} mm`)

// ---- pivots and bounds per part (shipped space).
const partBounds = PARTS.map((_, pi) => bounds(srcTris.filter((t) => t.label === pi + 1).map((t) => t.v)))
const r3 = (v: number) => Math.round(v * 1000) / 1000
const info: Record<string, { min: number[]; max: number[]; tris: number }> = {}
PARTS.forEach(([name], pi) => {
  const pb = partBounds[pi]!
  info[name] = { min: pb.lo.map(r3), max: pb.hi.map(r3), tris: labels.flat().filter((l) => l === pi + 1).length }
})
const nodes: Record<string, { min: number[]; max: number[] }> = {}
for (const name of new Set(srcTris.map((t) => t.node).filter(Boolean))) {
  const nb = bounds(srcTris.filter((t) => t.node === name).map((t) => t.v))
  nodes[name] = { min: nb.lo.map(r3), max: nb.hi.map(r3) }
}
// Steering wheel plane: least-variance axis of its vertices (the column axis).
const sw = srcTris.filter((t) => t.label === PARTS.findIndex(([n]) => n === "steering") + 1).flatMap((t) => t.v)
const mean = [0, 1, 2].map((i) => sw.reduce((a, p) => a + p[i]!, 0) / sw.length)
const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => sw.reduce((a, p) => a + (p[i]! - mean[i]!) * (p[j]! - mean[j]!), 0) / sw.length))
// Smallest eigenvector by inverse power iteration on (cov + εI).
const solve = (A: number[][], y: number[]) => {
  const m = A.map((row, i) => [...row, y[i]!])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r
    ;[m[c], m[piv]] = [m[piv]!, m[c]!]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k2 = c; k2 < 4; k2++) m[r]![k2]! -= f * m[c]![k2]!
    }
  }
  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!)
}
let ax = [0.3, 0.5, 0.8]
for (let it = 0; it < 40; it++) {
  const A = cov.map((row, i) => row.map((v, j) => v + (i === j ? 1e-9 : 0)))
  ax = solve(A, ax)
  const l = Math.hypot(ax[0]!, ax[1]!, ax[2]!)
  ax = ax.map((v) => v / l)
}
if (ax[2]! > 0) ax = ax.map((v) => -v)
const steering = { centre: [0, 1, 2].map((i) => r3((partBounds[1]!.lo[i]! + partBounds[1]!.hi[i]!) / 2)), axis: ax.map((v) => Math.round(v * 1e4) / 1e4) }

// Run-length labels per primitive: [label, count, label, count, ...].
const rle = (l: number[]) => {
  const o: number[] = []
  for (const v of l) {
    if (o.length && o[o.length - 2] === v) o[o.length - 1]!++
    else o.push(v, 1)
  }
  return o
}
const result = {
  model: NAME,
  note: "generated by scripts/intro/car-parts.ts; labels index `parts` (0 = body)",
  parts: PARTS.map(([n]) => n),
  primitives: prims.map((p, i) => ({ mesh: p.name, tris: p.tris.length, labels: rle(labels[i]!) })),
  bounds: info,
  nodes,
  steering,
}
const file = join(import.meta.dir, "../..", spec.out)
writeFileSync(file, JSON.stringify(result) + "\n")
console.log(`wrote ${file}`)
for (const [n, v] of Object.entries(info)) console.log(n.padEnd(11), v.tris, "tris", "min", v.min, "max", v.max)
console.log("steering", steering)
console.log("nodes", nodes)
