// Downloads the realistic prop/vehicle library into public/models/<name>.glb, normalised and web-optimised, and
// writes public/models/CREDITS.md, public/models/manifest.json and the generated block in src/render/models.ts.
//
//   bun scripts/fetch-models.ts                 # fetch/convert missing models
//   bun scripts/fetch-models.ts --force         # rebuild everything (sources are cached in $TMPDIR)
//   bun scripts/fetch-models.ts car_wagon dumpster   # rebuild only these (implies --force for them)
//
// Sources (licence per asset in MODEL_SOURCES and CREDITS.md):
//   - Poly Haven (CC0): glTF + textures from https://api.polyhaven.com/files/<id>.
//   - Sketchfab models under CC0 or CC-BY 4.0, fetched from the Objaverse 1.0 mirror on Hugging Face
//     (allenai/objaverse, a redistribution of the Sketchfab-generated GLB under each model's own licence), so no
//     Sketchfab login is needed. CC-BY assets need the credit line in CREDITS.md shipped with the game.
//
// Every output is one .glb: transforms baked, metres (1 unit = 1 m), Y up, pivot at the centre of the footprint on
// the ground (min Y = 0), front facing -Z, at most two materials (opaque + glass) over one baked KTX2 texture atlas
// (see "Material atlas" below), geometry quantised + meshopt-compressed (EXT_meshopt_compression). Load with
// GLTFLoader + MeshoptDecoder + KTX2Loader (src/render/models.ts). Needs basisu on PATH.
//
// The conversion uses the @gltf-transform library (what @gltf-transform/cli wraps) plus meshoptimizer and sharp,
// installed on demand into $TMPDIR/afterhours-gltf-tools so the game's package.json stays untouched.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

type Licence = "CC0-1.0" | "CC-BY-4.0"
type Source =
  | { site: "polyhaven"; id: string; res?: "1k" | "2k" }
  | { site: "sketchfab"; uid: string; path: string; title: string; author: string; licence: Licence }

export type ModelSource = {
  src: Source
  /** Real-world size to scale to (metres) along one measured axis after rotation; omit to keep the source scale. */
  size?: { axis: "x" | "y" | "z"; m: number }
  /** Degrees about +Y applied after baking so the model's front faces -Z. */
  yaw?: number
  /** Extra rotation about +X (degrees), for sources that are not Y-up. */
  pitch?: number
  /** Keep only mesh nodes whose path (ancestor names joined by "/") matches. */
  keep?: RegExp
  /** Drop mesh nodes whose path matches. */
  drop?: RegExp
  /** Simplify (meshopt) when the source has more triangles than this. */
  maxTris?: number
  /** Atlas (base colour) edge in px; default from the model's size: 2048 vehicles, 1024 ≥ 0.5 m, else 512. */
  atlas?: 512 | 1024 | 2048
  /** Who should place it and what it is. */
  note: string
}

const objaverse = (uid: string, shard: string, title: string, author: string, licence: Licence = "CC-BY-4.0"): Source => ({
  site: "sketchfab",
  uid,
  path: `glbs/${shard}/${uid}.glb`,
  title,
  author,
  licence,
})

/** Output name → source. Names are the keys of `MODELS` in src/render/models.ts. */
export const MODEL_SOURCES: Record<string, ModelSource> = {
  // Vehicles: no CC0 period car of usable quality exists, so these are Daniel Zhabotinsky's unbranded, invented-marque
  // early-80s American cars (CC-BY 4.0, "use it at your discretion"), real proportions, ~20K tris with interiors.
  car_wagon: {
    src: objaverse("aa0becb6e854422596cac6b21bf79787", "000-124", "Fairheaven SW '84 - Low poly model", "Daniel Zhabotinsky"),
    yaw: -90,
    size: { axis: "z", m: 5.05 },
    note: "hero: early-80s mid-size station wagon (compound lot)",
  },
  car_sedan: {
    src: objaverse("e2678da920cc4be68dbc193727919ffb", "000-031", "Fairheaven LT '80 - Low poly model", "Daniel Zhabotinsky"),
    yaw: -90,
    size: { axis: "z", m: 5.2 },
    note: "1980 full-size four-door sedan",
  },
  car_sedan_b: {
    src: objaverse("892b2684fb37442299bfad9222cf331c", "000-078", "Negotiator '80 - Low poly model", "Daniel Zhabotinsky"),
    yaw: 90,
    size: { axis: "z", m: 5.1 },
    note: "late-70s/1980 four-door sedan (detective green)",
  },
  car_pickup: {
    src: objaverse("6c48c94be8974dc7a5932f697c0ba68f", "000-089", "Conquer '89 Pickup - Low poly model", "Daniel Zhabotinsky"),
    yaw: -90,
    size: { axis: "z", m: 4.5 },
    note: "compact two-door pickup (80s body)",
  },
  van: {
    src: objaverse("09d718c9cf72401b8534d265a06a803f", "000-087", "Shvan '92 - Low poly model", "Daniel Zhabotinsky"),
    yaw: -90,
    size: { axis: "z", m: 5.0 },
    note: "full-size cargo van (body style 1971–96)",
  },
  box_truck: {
    src: objaverse("663a0953c038434a918cb85725c88ffa", "000-119", "LCT 3000 '95 - Low poly model", "Daniel Zhabotinsky"),
    yaw: 90,
    size: { axis: "z", m: 6.6 },
    note: "cab-over box truck (loading dock)",
  },
  covered_car: { src: { site: "polyhaven", id: "covered_car" }, note: "car under a dusty cover (creepy, compound/dock)" },

  // Exterior props
  dumpster: {
    src: objaverse("e8b38df736994cf8b4f7a3a9d2980f6b", "000-159", "Dumpster", "adjective.george"),
    size: { axis: "x", m: 1.9 },
    note: "front-load steel dumpster",
  },
  fire_hydrant: { src: { site: "polyhaven", id: "fire_hydrant" }, keep: /_aged$/, maxTris: 12000, note: "cast-iron fire hydrant" },
  bench: {
    src: objaverse("01a5b64427984632bb44242da3813bb1", "000-016", "Classic Park Bench (Low Poly)", "berkgedik"),
    size: { axis: "x", m: 1.8 },
    note: "slatted park bench with cast legs",
  },
  trash_can: { src: { site: "polyhaven", id: "metal_trash_can" }, keep: /_rust/, note: "rusted galvanised trash can, lid propped against it" },
  traffic_cone: {
    src: objaverse("1cbffb4169684e5a84ba186882bd55d7", "000-047", "Worn Traffic Cone", "kuuttisiitonen"),
    size: { axis: "y", m: 0.71 },
    note: "worn 28\" traffic cone",
  },
  drum_steel: { src: { site: "polyhaven", id: "barrel_03" }, note: "blue steel 55-gal drum" },
  drum_hazard: { src: { site: "polyhaven", id: "Barrel_01" }, note: "red drum with hazard label" },
  pallet: {
    src: objaverse("d30bd5cc3eeb4052904fd85988402868", "000-142", "Pallet", "maestronoov"),
    size: { axis: "x", m: 1.2 },
    note: "wooden shipping pallet",
  },
  crate_wood: { src: { site: "polyhaven", id: "wooden_crate_02" }, yaw: 90, note: "wooden crate" },
  milk_crate: { src: { site: "polyhaven", id: "plastic_crate_03" }, maxTris: 10000, note: "red plastic milk crate" },
  cardboard_box: { src: { site: "polyhaven", id: "cardboard_box_01" }, note: "taped cardboard box" },
  utility_box: { src: { site: "polyhaven", id: "utility_box_01" }, note: "grey electrical cabinet" },
  utility_box_b: { src: { site: "polyhaven", id: "utility_box_02" }, note: "green double-door electrical cabinet" },
  ac_unit: { src: { site: "polyhaven", id: "exterior_aircon_unit" }, keep: /_rusted$/, note: "wall-mounted condenser unit" },
  security_light: { src: { site: "polyhaven", id: "security_light" }, yaw: 180, note: "caged wall/pole flood light head" },
  tyre: { src: { site: "polyhaven", id: "old_tyre" }, note: "old car tyre" },
  trashbag: { src: { site: "polyhaven", id: "trashbag" }, note: "full black bin bag" },
  hand_truck: { src: { site: "polyhaven", id: "hand_truck" }, note: "two-wheel hand truck (dock)" },

  // Interior
  office_desk: { src: { site: "polyhaven", id: "metal_office_desk" }, yaw: 180, note: "steel tanker desk" },
  office_chair: {
    src: objaverse("b228a29fa84544c2be501c295653ffe7", "000-140", "Office Chair", "nokillnando"),
    yaw: 180,
    size: { axis: "y", m: 0.98 },
    note: "fabric swivel task chair",
  },
  stack_chair: { src: { site: "polyhaven", id: "SchoolChair_01" }, yaw: 180, note: "moulded stacking chair" },
  filing_cabinet: {
    src: objaverse("f0742791a0ea432db1f432c24de83867", "000-108", "File Cabinet", "LtxxwSibeRia"),
    yaw: 180,
    size: { axis: "y", m: 1.32 },
    note: "four-drawer steel filing cabinet",
  },
  filing_cabinet_open: {
    src: objaverse("e7fec8b453ef4105ace383dde017485c", "000-109", "File Cabinet", "Shorty_Digitan"),
    yaw: 90,
    size: { axis: "y", m: 1.32 },
    note: "dark filing cabinet, one drawer pulled open",
  },
  crt_terminal: {
    src: objaverse("847c174b86e24d868d25217ca2297886", "000-061", "Vintage Terminal", "NoMoreFeelings"),
    atlas: 1024,
    yaw: 180,
    size: { axis: "x", m: 0.46 },
    note: "beige CRT terminal + keyboard",
  },
  television: { src: { site: "polyhaven", id: "television_02" }, yaw: 180, note: "80s CRT television" },
  telephone: {
    src: objaverse("5b5d2f1ece3745279f2129fff13933d5", "000-130", "Vintage Telephone", "mvrc.art"),
    size: { axis: "x", m: 0.22 },
    note: "black rotary desk telephone",
  },
  metal_rack: { src: { site: "polyhaven", id: "worn_metal_rack" }, note: "worn steel shelving unit" },
  steel_shelves: { src: { site: "polyhaven", id: "steel_frame_shelves_03" }, note: "steel-frame shelves" },
  chemistry_set: { src: { site: "polyhaven", id: "chemistry_set" }, maxTris: 30000, note: "lab glassware on stands" },
  glassware: {
    src: objaverse("b8594f7dc7e8442dbaaae7a11da4a962", "000-054", "Chemistry Glassware", "maxdragon"),
    size: { axis: "y", m: 0.33 },
    note: "beakers, flask, graduated cylinders",
  },
  microscope: { src: { site: "polyhaven", id: "industrial_microscope" }, note: "lab microscope" },
  wet_floor_sign: { src: { site: "polyhaven", id: "WetFloorSign_01" }, note: "yellow wet-floor sign" },
  fluorescent_light: { src: { site: "polyhaven", id: "mounted_fluorescent_lights" }, keep: /_d$/, note: "surface-mount fluorescent tube fixture" },
  security_camera: { src: { site: "polyhaven", id: "security_camera_01" }, yaw: 180, note: "housed CCTV camera on bracket" },
}

const root = join(import.meta.dir, "..")
const outDir = join(root, "public/models")
const work = join(tmpdir(), "afterhours-models")
const tools = join(tmpdir(), "afterhours-gltf-tools")
const args = process.argv.slice(2)
const force = args.includes("--force")
/** Print every mesh node path with its source-space bounds (to write keep/drop filters). */
const list = args.includes("--list")
const only = args.filter((a) => !a.startsWith("--"))
mkdirSync(outDir, { recursive: true })
mkdirSync(work, { recursive: true })

const run = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" })
  const err = await new Response(p.stderr).text()
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed: ${err.slice(-600)}`)
}

if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) {
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, "package.json"), '{ "name": "afterhours-gltf-tools", "private": true }\n')
  await run(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer", "sharp"], tools)
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo, sharpMod] = await Promise.all([
  mod("@gltf-transform/core"),
  mod("@gltf-transform/extensions"),
  mod("@gltf-transform/functions"),
  mod("meshoptimizer"),
  mod("sharp"),
])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready, mo.MeshoptSimplifier.ready])
const logger = new core.Logger(core.Logger.Verbosity.WARN)
const io = new core.NodeIO()
  .setLogger(logger)
  .registerExtensions(ext.ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })

const download = async (url: string, file: string) => {
  if (existsSync(file) && statSync(file).size > 0) return file
  mkdirSync(dirname(file), { recursive: true })
  const res = await fetch(url, { headers: { "User-Agent": "afterhours-model-fetch" } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}

async function fetchSource(name: string, src: Source): Promise<string> {
  if (src.site === "sketchfab") {
    return download(`https://huggingface.co/datasets/allenai/objaverse/resolve/main/${src.path}`, join(work, `${src.uid}.glb`))
  }
  const files = (await (await fetch(`https://api.polyhaven.com/files/${src.id}`)).json()) as {
    gltf: Record<string, { gltf: { url: string; include?: Record<string, { url: string }> } }>
  }
  const res = src.res ?? "1k"
  const entry = files.gltf[res]?.gltf
  if (!entry) throw new Error(`${name}: polyhaven ${src.id} has no ${res} glTF`)
  const dir = join(work, `ph-${src.id}-${res}`)
  const main = await download(entry.url, join(dir, `${src.id}.gltf`))
  await Promise.all(Object.entries(entry.include ?? {}).map(([rel, f]) => download(f.url, join(dir, rel))))
  return main
}

type Mat4 = number[]
const mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!
  return o
}
const rotY = (deg: number): Mat4 => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}
const rotX = (deg: number): Mat4 => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}
const scaleM = (k: number): Mat4 => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1]
const translateM = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

const triCount = (doc: any) =>
  doc
    .getRoot()
    .listMeshes()
    .reduce((a: number, m: any) => a + m.listPrimitives().reduce((b: number, p: any) => b + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3, 0), 0)

const nodePath = (n: any): string => {
  const names: string[] = []
  for (let p = n; p && p.propertyType === "Node"; p = p.getParentNode()) names.unshift(p.getName())
  return names.join("/")
}

// ---------------------------------------------------------------------------------------------------------------
// Material atlas: every model ends up with at most two materials (opaque + alpha-blended glass) sharing one texture
// set, so it is at most two draws and every model compiles the same two shaders (src/render/models.ts).
//
//   base.ktx2      RGB base colour (sRGB, factor and colour baked in) + A opacity (glass tiles only)    ETC1S
//   normal.ktx2    tangent-space normal, OpenGL (normal scale baked)                         half size   UASTC
//   orm.ktx2       R occlusion (strength baked), G roughness, B metalness (factors baked)   half size   ETC1S
//   emissive.ktx2  only for models that glow (CRT screen, tube); glowing tiles keep source resolution     ETC1S
//
// Each source material becomes a power-of-two square tile, sized from its source resolution and its share of the
// model's surface area, packed by a quadtree, padded by wrapping (repeating materials) or edge copies so mips don't
// bleed. Repeating UVs (tyre treads, rims, interiors) are made atlas-safe without any shader trick: triangles are
// clipped at integer UV lines and each piece shifted into [0, 1] before the remap into its tile.
// Dropped in the bake: clear-coat (car paint), KHR specular/ior; they are re-checked in the model sheet.

type Px = { w: number; h: number; data: Uint8Array }
const srgbToLin = new Float32Array(256).map((_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
const linToSrgb = (v: number) => {
  const c = Math.min(1, Math.max(0, v))
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
}

const decode = async (tex: any, size: number): Promise<Px> => {
  const { data } = await sharpMod
    .default(Buffer.from(tex.getImage()))
    .resize(size, size, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { w: size, h: size, data: new Uint8Array(data) }
}

type TileMat = {
  mat: any
  glass: boolean
  prims: any[]
  textured: boolean
  srcSize: number
  area: number
  wrap: boolean
  size: number
  x: number
  y: number
}

/** Area of triangles (m²) and UV range for every primitive using a material. */
function measure(prims: any[]) {
  let area = 0
  let wrap = false
  for (const p of prims) {
    const pos = p.getAttribute("POSITION"), uv = p.getAttribute("TEXCOORD_0")
    const idx = p.getIndices()
    const n = idx ? idx.getCount() : pos.getCount()
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], t = [0, 0]
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getScalar(i) : i, i1 = idx ? idx.getScalar(i + 1) : i + 1, i2 = idx ? idx.getScalar(i + 2) : i + 2
      pos.getElement(i0, a), pos.getElement(i1, b), pos.getElement(i2, c)
      const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!, vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    }
    for (let i = 0; i < uv.getCount(); i++) {
      uv.getElement(i, t)
      if (t[0]! < -1e-3 || t[0]! > 1.001 || t[1]! < -1e-3 || t[1]! > 1.001) wrap = true
    }
  }
  return { area, wrap }
}

const EPS = 1e-5
/** Clips a polygon (vertex rows of `stride` floats, UV at `uvAt`) to `lo <= uv[axis] <= hi`. */
function clipPoly(poly: number[][], axis: number, lo: number, hi: number): number[][] {
  const clip = (pts: number[][], keep: (v: number) => number) => {
    const out: number[][] = []
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!
      const dp = keep(p[axis]!), dq = keep(q[axis]!)
      if (dp >= 0) out.push(p)
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq)
        out.push(p.map((v, k) => v + (q[k]! - v) * t))
      }
    }
    return out
  }
  return clip(clip(poly, (v) => v - lo), (v) => hi - v)
}

/** Rewrites a primitive so every triangle's UVs lie in [0, 1]: split at integer lines, shift each piece by its cell. */
function unwrapPrimitive(doc: any, p: any) {
  const names = p.listSemantics() as string[]
  const accs = names.map((s) => p.getAttribute(s))
  const sizes = accs.map((a: any) => a.getElementSize())
  const offs: number[] = []
  let stride = 0
  for (const s of sizes) offs.push(stride), (stride += s)
  const uvOff = offs[names.indexOf("TEXCOORD_0")]!
  const idx = p.getIndices()
  const n = idx ? idx.getCount() : accs[0].getCount()
  const vert = (i: number) => {
    const row: number[] = []
    const el: number[] = []
    accs.forEach((a: any) => row.push(...a.getElement(i, el)))
    return row
  }
  const out: number[][] = []
  for (let i = 0; i < n; i += 3) {
    const tri = [0, 1, 2].map((k) => vert(idx ? idx.getScalar(i + k) : i + k))
    const us = tri.map((r) => r[uvOff]!), vs = tri.map((r) => r[uvOff + 1]!)
    const u0 = Math.floor(Math.min(...us) + EPS), u1 = Math.ceil(Math.max(...us) - EPS)
    const v0 = Math.floor(Math.min(...vs) + EPS), v1 = Math.ceil(Math.max(...vs) - EPS)
    for (let cu = u0; cu < Math.max(u1, u0 + 1); cu++) {
      const su = u1 - u0 <= 1 ? tri : clipPoly(tri, uvOff, cu, cu + 1)
      if (su.length < 3) continue
      for (let cv = v0; cv < Math.max(v1, v0 + 1); cv++) {
        const sv = v1 - v0 <= 1 ? su : clipPoly(su, uvOff + 1, cv, cv + 1)
        if (sv.length < 3) continue
        for (let k = 1; k + 1 < sv.length; k++)
          for (const r of [sv[0]!, sv[k]!, sv[k + 1]!]) {
            const c = r.slice()
            c[uvOff] = Math.min(1, Math.max(0, c[uvOff]! - cu))
            c[uvOff + 1] = Math.min(1, Math.max(0, c[uvOff + 1]! - cv))
            out.push(c)
          }
      }
    }
  }
  const buffer = doc.getRoot().listBuffers()[0]
  names.forEach((s, j) => {
    const arr = new Float32Array(out.length * sizes[j]!)
    out.forEach((r, v) => {
      for (let k = 0; k < sizes[j]!; k++) arr[v * sizes[j]! + k] = r[offs[j]! + k]!
    })
    if (s === "NORMAL")
      for (let v = 0; v < out.length; v++) {
        const l = Math.hypot(arr[v * 3]!, arr[v * 3 + 1]!, arr[v * 3 + 2]!) || 1
        for (let k = 0; k < 3; k++) arr[v * 3 + k]! /= l
      }
    p.setAttribute(s, doc.createAccessor().setType(accs[j].getType()).setArray(arr).setBuffer(buffer))
  })
  p.setIndices(null)
}

/** Packs power-of-two squares (largest first) into a power-of-two atlas; false if they don't fit. */
function pack(tiles: TileMat[], atlas: number): boolean {
  const free: { x: number; y: number; s: number }[] = [{ x: 0, y: 0, s: atlas }]
  for (const t of [...tiles].sort((a, b) => b.size - a.size)) {
    free.sort((a, b) => a.s - b.s || a.y - b.y || a.x - b.x)
    const i = free.findIndex((f) => f.s >= t.size)
    if (i < 0) return false
    let f = free.splice(i, 1)[0]!
    while (f.s > t.size) {
      const h = f.s / 2
      free.push({ x: f.x + h, y: f.y, s: h }, { x: f.x, y: f.y + h, s: h }, { x: f.x + h, y: f.y + h, s: h })
      f = { x: f.x, y: f.y, s: h }
    }
    t.x = f.x
    t.y = f.y
  }
  return true
}

const basisu = (input: string, out: string, mode: "etc1s-srgb" | "etc1s-linear" | "uastc-linear") =>
  run([
    "basisu", "-ktx2", "-mipmap",
    ...(mode === "uastc-linear" ? ["-uastc", "-uastc_level", "2", "-uastc_rdo_l", "1", "-normal_map"] : ["-q", "255"]),
    ...(mode === "etc1s-srgb" ? ["-srgb", "-mip_srgb"] : ["-linear", "-mip_linear"]),
    input, "-output_file", out,
  ])

async function atlasModel(name: string, spec: ModelSource, doc: any) {
  const root = doc.getRoot()
  const byMat = new Map<any, any[]>()
  for (const mesh of root.listMeshes())
    for (const p of mesh.listPrimitives()) {
      const m = p.getMaterial()
      if (!p.getAttribute("TEXCOORD_0"))
        p.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(p.getAttribute("POSITION").getCount() * 2)).setBuffer(root.listBuffers()[0]))
      if (!byMat.has(m)) byMat.set(m, [])
      byMat.get(m)!.push(p)
    }
  const b = fn.getBounds(root.getDefaultScene() ?? root.listScenes()[0])
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
  const atlas = spec.atlas ?? (span >= 3.5 ? 2048 : span >= 0.5 ? 1024 : 512)

  const tiles: TileMat[] = []
  for (const [mat, prims] of byMat) {
    for (const ti of mat ? fn.listTextureInfoByMaterial(mat) : [])
      if (ti.getTexCoord() !== 0 || ti.getExtension?.("KHR_texture_transform")) throw new Error(`${name}: ${mat.getName()} uses texCoord ${ti.getTexCoord()} / texture transform`)
    const texs = mat ? [mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getMetallicRoughnessTexture(), mat.getOcclusionTexture(), mat.getEmissiveTexture()].filter(Boolean) : []
    const srcSize = Math.max(0, ...texs.map((t: any) => Math.max(...(t.getSize() ?? [0, 0]))))
    const { area, wrap } = measure(prims)
    const glass = !!mat && (mat.getAlphaMode() === "BLEND" || mat.getAlphaMode() === "MASK")
    tiles.push({ mat, glass, prims, textured: texs.length > 0, srcSize, area, wrap, size: 0, x: 0, y: 0 })
  }
  // Initial sizes: the source resolution scaled by sqrt of the surface share, then halve the biggest until they fit.
  const maxArea = Math.max(...tiles.map((t) => t.area), 1e-9)
  const pow2 = (v: number) => 2 ** Math.round(Math.log2(Math.max(1, v)))
  // Glowing parts (CRT screen text) keep their source resolution: they are read up close and must stay legible.
  const glowsAt = (m: any) => !!m && m.getEmissiveFactor().some((v: number) => v > 0) && !!m.getEmissiveTexture()
  for (const t of tiles)
    t.size = !t.textured
      ? 16
      : glowsAt(t.mat)
        ? Math.min(atlas / 2, pow2(t.srcSize))
        : Math.min(atlas, pow2(t.srcSize), Math.max(64, pow2(t.srcSize * Math.min(1, 2 * Math.sqrt(t.area / maxArea)))))
  while (!pack(tiles, atlas)) {
    const big = tiles.reduce((a, t) => (t.size > a.size || (t.size === a.size && !glowsAt(t.mat)) ? t : a))
    if (big.size <= 16) throw new Error(`${name}: atlas overflow`)
    big.size /= 2
  }

  const base = new Uint8Array(atlas * atlas * 4)
  const normal = new Uint8Array(atlas * atlas * 4)
  const orm = new Uint8Array(atlas * atlas * 4)
  const emissive = new Uint8Array(atlas * atlas * 4)
  for (let i = 0; i < atlas * atlas; i++) {
    base[i * 4 + 3] = 255
    normal.set([128, 128, 255, 255], i * 4)
    orm.set([255, 255, 0, 255], i * 4)
    emissive[i * 4 + 3] = 255
  }
  let glows = false
  for (const t of tiles) {
    const m = t.mat
    const pad = t.textured ? Math.max(4, t.size / 32) : 4
    const inner = t.size - 2 * pad
    const get = (tex: any) => (tex ? decode(tex, inner) : Promise.resolve(null))
    const [bc, nm, mr, oc, em] = await Promise.all(
      m ? [get(m.getBaseColorTexture()), get(m.getNormalTexture()), get(m.getMetallicRoughnessTexture()), get(m.getOcclusionTexture()), get(m.getEmissiveTexture())] : [null, null, null, null, null],
    )
    const bf: number[] = m ? m.getBaseColorFactor() : [1, 1, 1, 1]
    const rough = m ? m.getRoughnessFactor() : 1
    const metal = m ? m.getMetallicFactor() : 0
    const nScale = m ? m.getNormalScale() : 1
    const occ = m ? m.getOcclusionStrength() : 1
    const strength = m?.getExtension("KHR_materials_emissive_strength")?.getEmissiveStrength() ?? 1
    const ef: number[] = m ? m.getEmissiveFactor().map((v: number) => v * strength) : [0, 0, 0]
    if (ef.some((v) => v > 0)) glows = true
    const tb = new Uint8Array(inner * inner * 4), tn = new Uint8Array(inner * inner * 4), to = new Uint8Array(inner * inner * 4), te = new Uint8Array(inner * inner * 4)
    for (let i = 0; i < inner * inner; i++) {
      const o = i * 4
      for (let k = 0; k < 3; k++) tb[o + k] = linToSrgb((bc ? srgbToLin[bc.data[o + k]!]! : 1) * bf[k]!)
      tb[o + 3] = t.glass ? Math.round((bc ? bc.data[o + 3]! / 255 : 1) * bf[3]! * 255) : 255
      let nx = 0, ny = 0, nz = 1
      if (nm) {
        nx = (nm.data[o]! / 255) * 2 - 1
        ny = (nm.data[o + 1]! / 255) * 2 - 1
        nz = (nm.data[o + 2]! / 255) * 2 - 1
        nx *= nScale
        ny *= nScale
        const l = Math.hypot(nx, ny, nz) || 1
        nx /= l, ny /= l, nz /= l
      }
      tn[o] = Math.round((nx * 0.5 + 0.5) * 255)
      tn[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      tn[o + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      tn[o + 3] = 255
      const ao = oc ? oc.data[o]! / 255 : 1
      to[o] = Math.round((1 + occ * (ao - 1)) * 255)
      to[o + 1] = Math.round(Math.min(1, (mr ? mr.data[o + 1]! / 255 : 1) * rough) * 255)
      to[o + 2] = Math.round(Math.min(1, (mr ? mr.data[o + 2]! / 255 : 1) * metal) * 255)
      to[o + 3] = 255
      for (let k = 0; k < 3; k++) te[o + k] = linToSrgb((em ? srgbToLin[em.data[o + k]!]! : 1) * ef[k]!)
      te[o + 3] = 255
    }
    const extendWith = t.wrap ? "repeat" : "copy"
    const padded = async (px: Uint8Array) =>
      new Uint8Array(
        await sharpMod
          .default(Buffer.from(px), { raw: { width: inner, height: inner, channels: 4 } })
          .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith })
          .raw()
          .toBuffer(),
      )
    const blit = (dst: Uint8Array, src: Uint8Array) => {
      for (let y = 0; y < t.size; y++) dst.set(src.subarray(y * t.size * 4, (y + 1) * t.size * 4), ((t.y + y) * atlas + t.x) * 4)
    }
    blit(base, await padded(tb))
    blit(normal, await padded(tn))
    blit(orm, await padded(to))
    blit(emissive, await padded(te))

    // Geometry: make UVs tile-local, then remap into the tile (factor-only tiles collapse to the tile centre).
    for (const p of t.prims) {
      if (t.wrap && t.textured) unwrapPrimitive(doc, p)
      const uv = p.getAttribute("TEXCOORD_0")
      const arr = new Float32Array(uv.getCount() * 2)
      const e = [0, 0]
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, e)
        const u = t.textured ? Math.min(1, Math.max(0, e[0]!)) : 0.5
        const v = t.textured ? Math.min(1, Math.max(0, e[1]!)) : 0.5
        arr[i * 2] = (t.x + pad + u * inner) / atlas
        arr[i * 2 + 1] = (t.y + pad + v * inner) / atlas
      }
      p.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(arr).setBuffer(root.listBuffers()[0]))
    }
  }

  // Encode: base at atlas size, the rest at half.
  const dir = join(work, "atlas", name)
  mkdirSync(dir, { recursive: true })
  const half = Math.max(256, atlas / 2)
  const png = async (px: Uint8Array, size: number, file: string, keepAlpha: boolean) => {
    let s = sharpMod.default(Buffer.from(px), { raw: { width: atlas, height: atlas, channels: 4 } })
    if (size !== atlas) s = s.resize(size, size, { kernel: "lanczos3" })
    if (!keepAlpha) s = s.removeAlpha()
    await s.png().toFile(join(dir, file))
    return join(dir, file)
  }
  const hasGlass = tiles.some((t) => t.glass)
  const jobs: [string, Promise<void>][] = [
    ["base", png(base, atlas, "base.png", hasGlass).then((f) => basisu(f, join(dir, "base.ktx2"), "etc1s-srgb"))],
    ["normal", png(normal, half, "normal.png", false).then((f) => basisu(f, join(dir, "normal.ktx2"), "uastc-linear"))],
    ["orm", png(orm, half, "orm.png", false).then((f) => basisu(f, join(dir, "orm.ktx2"), "etc1s-linear"))],
  ]
  if (glows) jobs.push(["emissive", png(emissive, atlas, "emissive.png", false).then((f) => basisu(f, join(dir, "emissive.ktx2"), "etc1s-srgb"))])
  await Promise.all(jobs.map((j) => j[1]))

  doc.createExtension(ext.KHRTextureBasisu).setRequired(true)
  const texture = (kind: string) =>
    doc.createTexture(`${name}_${kind}`).setMimeType("image/ktx2").setImage(new Uint8Array(readFileSync(join(dir, `${kind}.ktx2`)))).setURI(`${name}_${kind}.ktx2`)
  const tBase = texture("base"), tNormal = texture("normal"), tOrm = texture("orm"), tEm = glows ? texture("emissive") : null
  const make = (glass: boolean) => {
    const m = doc
      .createMaterial(glass ? "glass" : "opaque")
      .setBaseColorTexture(tBase)
      .setNormalTexture(tNormal)
      .setMetallicRoughnessTexture(tOrm)
      .setOcclusionTexture(tOrm)
      .setRoughnessFactor(1)
      .setMetallicFactor(1)
      .setDoubleSided(true)
      .setAlphaMode(glass ? "BLEND" : "OPAQUE")
    if (tEm) m.setEmissiveTexture(tEm).setEmissiveFactor([1, 1, 1])
    return m
  }
  const opaque = tiles.some((t) => !t.glass) ? make(false) : null
  const glass = hasGlass ? make(true) : null
  for (const t of tiles) for (const p of t.prims) p.setMaterial(t.glass ? glass : opaque)
  console.log(`  atlas ${atlas}: ${tiles.map((t) => `${t.mat?.getName?.() ?? "-"}${t.glass ? "(glass)" : ""}=${t.size}${t.wrap ? "w" : ""}`).join(" ")}`)
  for (const t of tiles) t.mat?.dispose()
  for (const tex of root.listTextures()) if (![tBase, tNormal, tOrm, tEm].includes(tex)) tex.dispose()
}

type Stats = { tris: number; bytes: number; size: [number, number, number]; footprint: [number, number]; meshes: number; materials: number }

async function convert(name: string, spec: ModelSource, input: string, output: string): Promise<Stats> {
  const doc = (await io.read(input)).setLogger(logger)
  const docRoot = doc.getRoot()
  const scene = docRoot.getDefaultScene() ?? docRoot.listScenes()[0]
  for (const s of docRoot.listScenes()) if (s !== scene) s.dispose()
  for (const a of docRoot.listAnimations()) a.dispose()
  await doc.transform(fn.uninstance())
  if (docRoot.listExtensionsUsed().some((e: any) => e.extensionName === "KHR_materials_pbrSpecularGlossiness")) await doc.transform(fn.metalRough())

  // Bake every mesh node's world transform (plus pitch/yaw) into its vertices and hang it off the scene root.
  const orient = mul(rotY(spec.yaw ?? 0), rotX(spec.pitch ?? 0))
  const meshNodes: any[] = []
  scene.traverse((n: any) => n.getMesh() && meshNodes.push(n))
  const baked: any[] = []
  for (const n of meshNodes) {
    const path = nodePath(n)
    if ((spec.keep && !spec.keep.test(path)) || spec.drop?.test(path)) continue
    const world = n.getWorldMatrix()
    if (list) {
      const nb = fn.getBounds(n)
      console.log(`  ${path}: min ${nb.min.map((v: number) => v.toFixed(2))} max ${nb.max.map((v: number) => v.toFixed(2))}`)
    }
    const src = n.getMesh()
    const mesh = doc.createMesh(src.getName())
    for (const p of src.listPrimitives()) mesh.addPrimitive(p.clone())
    fn.transformMesh(mesh, mul(orient, world))
    const flat = doc.createNode(n.getName()).setMesh(mesh)
    baked.push(flat)
  }
  if (!baked.length) throw new Error(`${name}: no meshes left after keep/drop`)
  for (const c of scene.listChildren()) scene.removeChild(c)
  for (const n of docRoot.listNodes()) if (!baked.includes(n)) n.dispose()
  for (const n of baked) scene.addChild(n)
  for (const c of docRoot.listCameras()) c.dispose()

  // Real-world scale, then pivot at the footprint centre on the ground.
  let b = fn.getBounds(scene)
  if (spec.size) {
    const i = { x: 0, y: 1, z: 2 }[spec.size.axis]
    const k = spec.size.m / (b.max[i] - b.min[i])
    for (const n of baked) fn.transformMesh(n.getMesh(), scaleM(k))
    b = fn.getBounds(scene)
  }
  const t = translateM(-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2)
  for (const n of baked) fn.transformMesh(n.getMesh(), t)

  // One vertex layout for every model (position, normal, uv): the renderer's shader cache key includes the attribute
  // set, so stray tangents (normal maps fall back to derivative frames) or UV-less parts would each add a pipeline.
  for (const mesh of docRoot.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      prim.setAttribute("TANGENT", null)
      const mat = prim.getMaterial()
      const texCoords = new Set<number>(mat ? fn.listTextureInfoByMaterial(mat).map((t: any) => t.getTexCoord()) : [])
      for (const sem of prim.listSemantics()) {
        const m = /^TEXCOORD_(\d+)$/.exec(sem)
        if (m && m[1] !== "0" && !texCoords.has(Number(m[1]))) prim.setAttribute(sem, null)
      }
      if (!prim.getAttribute("TEXCOORD_0")) {
        const n = prim.getAttribute("POSITION").getCount()
        prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(n * 2)).setBuffer(docRoot.listBuffers()[0]))
      }
    }
  await doc.transform(fn.prune(), fn.dedup(), fn.join({ keepNamed: false }), fn.weld())
  const before = triCount(doc)
  if (spec.maxTris && before > spec.maxTris) {
    await doc.transform(fn.simplify({ simplifier: mo.MeshoptSimplifier, ratio: spec.maxTris / before, error: 0.002, lockBorder: false }))
  }
  await atlasModel(name, spec, doc)
  await doc.transform(fn.weld(), fn.join({ keepNamed: false }), fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
  await io.write(output, doc)

  const out = await io.read(output)
  const ob = fn.getBounds(out.getRoot().getDefaultScene() ?? out.getRoot().listScenes()[0])
  const r = (v: number) => Math.round(v * 1000) / 1000
  const size: [number, number, number] = [r(ob.max[0] - ob.min[0]), r(ob.max[1] - ob.min[1]), r(ob.max[2] - ob.min[2])]
  return {
    tris: Math.round(triCount(out)),
    bytes: statSync(output).size,
    size,
    footprint: [size[0], size[2]],
    meshes: out.getRoot().listMeshes().reduce((a: number, m: any) => a + m.listPrimitives().length, 0),
    materials: out.getRoot().listMaterials().length,
  }
}

const manifestFile = join(outDir, "manifest.json")
const manifest: Record<string, Stats & { source: string; licence: Licence }> = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, "utf8"))
  : {}
for (const k of Object.keys(manifest)) if (!(k in MODEL_SOURCES)) delete manifest[k]
for (const f of readdirSync(outDir)) if (f.endsWith(".glb") && !(f.slice(0, -4) in MODEL_SOURCES)) rmSync(join(outDir, f))

const sourceLabel = (s: Source) => (s.site === "polyhaven" ? `polyhaven:${s.id}` : `sketchfab:${s.uid}`)
for (const [name, spec] of Object.entries(MODEL_SOURCES)) {
  const output = join(outDir, `${name}.glb`)
  const rebuild = only.length ? only.includes(name) : force || !existsSync(output) || !manifest[name]
  if (!rebuild) continue
  const t0 = performance.now()
  const input = await fetchSource(name, spec.src)
  const stats = await convert(name, spec, input, output)
  manifest[name] = { ...stats, source: sourceLabel(spec.src), licence: spec.src.site === "polyhaven" ? "CC0-1.0" : spec.src.licence }
  console.log(
    `${name}: ${stats.tris} tris, ${(stats.bytes / 1024).toFixed(0)} KB, ${stats.size.join(" × ")} m, ${stats.meshes} prims (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  )
}

const ordered = Object.fromEntries(Object.keys(MODEL_SOURCES).filter((k) => manifest[k]).map((k) => [k, manifest[k]!]))
writeFileSync(manifestFile, JSON.stringify(ordered, null, 1) + "\n")

// Credits
const rows = Object.entries(MODEL_SOURCES).map(([name, { src, note }]) => {
  const m = ordered[name]
  const stat = m ? `${m.tris.toLocaleString("en")} | ${(m.bytes / 1024).toFixed(0)} KB` : "– | –"
  if (src.site === "polyhaven")
    return `| \`${name}.glb\` | [${src.id}](https://polyhaven.com/a/${src.id}) | Poly Haven | CC0 1.0 | ${stat} | ${note} |`
  const lic = src.licence === "CC0-1.0" ? "CC0 1.0" : "[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)"
  return `| \`${name}.glb\` | [${src.title}](https://sketchfab.com/3d-models/${src.uid}) | ${src.author} | ${lic} | ${stat} | ${note} |`
})
const byLines = Object.values(MODEL_SOURCES)
  .map((s) => s.src)
  .filter((s): s is Extract<Source, { site: "sketchfab" }> => s.site === "sketchfab" && s.licence === "CC-BY-4.0")
  .map((s) => `- "${s.title}" by ${s.author} (https://sketchfab.com/3d-models/${s.uid}), CC BY 4.0, modified (rescaled, re-centred, optimised).`)
const total = Object.values(ordered).reduce((a, m) => a + m.bytes, 0)
writeFileSync(
  join(outDir, "CREDITS.md"),
  `# Model credits

Regenerate with \`bun scripts/fetch-models.ts\` (\`--force\` to rebuild). Every file is a single web-optimised .glb
(meshopt + quantised geometry; at most two materials over one baked KTX2 atlas: base colour ETC1S, normal UASTC, ORM
ETC1S; 2048 vehicles, 1024 ≥ 0.5 m, 512 small props), normalised to metres with the pivot at the
footprint centre on the ground and the front facing -Z. Total ${(total / 1e6).toFixed(1)} MB.

No brands or real logos: vehicles are invented marques ("Fairheaven", "Negotiator", "Conquer", "Shvan", "LCT").

- Poly Haven assets are **CC0 1.0** (https://polyhaven.com/license); no attribution required.
- Sketchfab assets were fetched from the Objaverse 1.0 mirror (https://huggingface.co/datasets/allenai/objaverse),
  which redistributes each model under its original licence. **CC BY 4.0 assets require attribution**: ship the
  credit lines below in the game's credits.

| File | Asset | Author / site | Licence | Tris | Size | Use |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Required attribution (CC BY 4.0)

${byLines.join("\n")}
`,
)

// Generated block in src/render/models.ts
const modelsTs = join(root, "src/render/models.ts")
if (existsSync(modelsTs)) {
  const text = readFileSync(modelsTs, "utf8")
  const begin = "// <generated by scripts/fetch-models.ts>"
  const end = "// </generated>"
  const i = text.indexOf(begin), j = text.indexOf(end)
  if (i >= 0 && j > i) {
    const body = Object.entries(ordered)
      .map(([name, m]) => {
        const note = MODEL_SOURCES[name]!.note.replace(/"/g, '\\"')
        return `  ${name}: { size: [${m.size.join(", ")}], tris: ${m.tris}, kb: ${Math.round(m.bytes / 1024)}, licence: "${m.licence}", note: "${note}" },`
      })
      .join("\n")
    writeFileSync(modelsTs, `${text.slice(0, i)}${begin}\nexport const MODELS = {\n${body}\n} as const satisfies Record<string, ModelInfo>\n${text.slice(j)}`)
  }
}
console.log(`total ${(total / 1e6).toFixed(1)} MB in ${outDir}`)
