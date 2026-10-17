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
// the ground (min Y = 0), front facing -Z, primitives joined per material, textures resized (≤1K, 2K for hero
// vehicles) and re-encoded as WebP, geometry quantised + meshopt-compressed (EXT_meshopt_compression). Load with
// GLTFLoader + MeshoptDecoder (src/render/models.ts).
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
  /** Max texture edge in px (default 1024). */
  tex?: 1024 | 2048
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
    tex: 2048,
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
  const tex = spec.tex ?? 1024
  await doc.transform(
    fn.textureCompress({ encoder: sharpMod.default, targetFormat: "webp", resize: [tex, tex], quality: 82 }),
    fn.prune(),
    fn.dedup(),
    fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }),
  )
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
(meshopt + quantised geometry, WebP textures ≤1K, 2K for the hero wagon), normalised to metres with the pivot at the
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
