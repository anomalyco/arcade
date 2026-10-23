/**
 * Runs the kit finishing pass (`@arcade/kit/gpu/finish`) over generated `.prop` meshes and reports what it found:
 * the baked AO, curvature and sky exposure, how the bake's AO compares with the Cycles AO the prop shipped with, and
 * whether the prop's albedo sits inside its look's measured range, as generated and as drawn (`DEFAULT_PROP_LOOK`
 * brightness). It never rewrites the props; `.prop` v1 has no spare bytes for curvature (a v2 would add two).
 *
 *   bun scripts/finish-prop.ts [file.prop | dir ...] [--look old-wood] [--lod 0] [--out report.json] [--strict]
 *
 * With no paths it checks every prop in `packages/kit/props/assets/`. `--look` overrides the per-prop guess.
 * `--strict` exits 1 when more than 10% of a prop's vertices fall outside the range as drawn.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { finish, type FinishReport } from "../packages/kit/gpu/finish"
import { Mesh, type Mat } from "../packages/kit/gpu/mesh"
import { ALBEDO_RANGES, checkAlbedo, FINISH_LOOK_IDS, finishLook, srgbToLinear, type AlbedoClass, type FinishLookId } from "../packages/kit/gpu/materials/wear"
import { decodeProp, type PropLod } from "../packages/kit/props/format"
import { DEFAULT_PROP_LOOK } from "../packages/kit/props/mesh"

const ASSETS = join(import.meta.dir, "../packages/kit/props/assets")
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const valued = new Set(["--look", "--lod", "--out"])
const paths = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""))
const lookArg = flag("--look") as FinishLookId | undefined
if (lookArg && !FINISH_LOOK_IDS.includes(lookArg)) throw Error(`unknown look ${lookArg} (${FINISH_LOOK_IDS.join(", ")})`)
const lodIndex = Number(flag("--lod") ?? 0)
const strict = args.includes("--strict")

/** A first guess at each catalogue prop's look; anything else is old wood. */
const GUESS: Record<string, FinishLookId> = {
  "fridge-1970s": "painted-steel", stove: "painted-steel", radiator: "painted-steel", "tv-set": "painted-steel",
  typewriter: "painted-steel", "rotary-phone": "painted-steel", "table-lamp": "worn-lab-metal",
}

const files = (paths.length ? paths : [ASSETS]).flatMap(p => statSync(p).isDirectory()
  ? readdirSync(p).filter(f => f.endsWith(".prop")).sort().map(f => join(p, f))
  : [p])

/** Expands an indexed LOD into a kit Mesh with the generated colours, as `propMesh` does before its own smoothing. */
function lodMesh(lod: PropLod): Mesh {
  const m = new Mesh()
  const { positions: p, normals: n, colors: c, mats, indices } = lod
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!
    m.vert([p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!], [n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!], [c[v * 3]! / 255, c[v * 3 + 1]! / 255, c[v * 3 + 2]! / 255], mats[v]! as Mat)
  }
  return m
}

type Albedo = { dark: number; bright: number; meanSrgb: number }
function albedoShare(lod: PropLod, gain: number, cls: AlbedoClass): Albedo {
  const n = lod.colors.length / 3
  let dark = 0, bright = 0, mean = 0
  for (let v = 0; v < n; v++) {
    const rgb = [0, 1, 2].map(k => srgbToLinear(Math.min(1, (lod.colors[v * 3 + k]! / 255) * gain))) as [number, number, number]
    const c = checkAlbedo(rgb, cls)
    if (c.verdict === "dark") dark++
    else if (c.verdict === "bright") bright++
    mean += c.luminance
  }
  const srgb = (l: number) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055))
  return { dark: dark / n, bright: bright / n, meanSrgb: srgb(mean / n) }
}

/** Pearson correlation of the bake's AO with the prop's Cycles AO, per corner. */
function aoAgreement(lod: PropLod, bytes: Uint8Array): number {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  const n = lod.indices.length
  for (let i = 0; i < n; i++) {
    const x = lod.ao[lod.indices[i]!]! / 255, y = (bytes[i * 2 + 1]! >> 4) / 15
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
  }
  const cov = sxy / n - (sx / n) * (sy / n), vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0
}

type Row = Omit<FinishReport, "albedo"> & { prop: string; generated: Albedo; drawn: Albedo; cls: AlbedoClass; aoVsCycles: number }
const rows: Row[] = []
for (const file of files) {
  const prop = basename(file, ".prop")
  const asset = decodeProp(readFileSync(file).buffer as ArrayBuffer)
  const lod = asset.lods[Math.min(lodIndex, asset.lods.length - 1)]!
  const look = lookArg ?? GUESS[prop] ?? "old-wood"
  // Props stand indoors: sheltered, so no sky rays.
  const { mesh, report } = finish(lodMesh(lod), { look, bake: { exposure: 0, ground: asset.min[1] } })
  const cls = finishLook(look).albedoClass
  const { albedo: _, ...rest } = report
  rows.push({
    ...rest, prop, cls,
    generated: albedoShare(lod, 1, cls),
    drawn: albedoShare(lod, DEFAULT_PROP_LOOK.brightness, cls),
    aoVsCycles: aoAgreement(lod, mesh.finishBytes!),
  })
}

const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4)
console.log(`prop                 look            tris   ms   AO mean/min  edges  AO≈Cycles  albedo (${"generated → drawn"}, sRGB mean, dark/bright)`)
for (const r of rows) {
  console.log([
    r.prop.padEnd(20), r.look.padEnd(15), String(r.triangles).padStart(5), String(Math.round(r.ms)).padStart(4),
    `  ${r.ao.mean.toFixed(2)}/${r.ao.min.toFixed(2)}`, `   ${pct(r.edges)}`, `   ${r.aoVsCycles.toFixed(2).padStart(5)}`,
    `     ${r.generated.meanSrgb} → ${r.drawn.meanSrgb}  ${pct(r.drawn.dark)}/${pct(r.drawn.bright)}`,
  ].join(" "))
}
const range = (cls: AlbedoClass) => ALBEDO_RANGES[cls].label
console.log(`\nRanges: ${[...new Set(rows.map(r => r.cls))].map(range).join("; ")}. "Drawn" is ×${DEFAULT_PROP_LOOK.brightness} (DEFAULT_PROP_LOOK).`)
const out = flag("--out")
if (out) writeFileSync(out, JSON.stringify({ lod: lodIndex, rows }, null, 1) + "\n")
const failing = rows.filter(r => r.drawn.dark + r.drawn.bright > 0.1)
if (strict && failing.length) {
  console.error(`${failing.length} prop(s) have over 10% of vertices outside the range as drawn: ${failing.map(r => r.prop).join(", ")}`)
  process.exit(1)
}
