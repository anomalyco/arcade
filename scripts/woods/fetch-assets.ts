/**
 * Downloads the woods look's CC0 scans and models from Poly Haven, converts them for the kit forest renderer
 * (`@arcade/kit/forest`) and writes credits. Run once; outputs are checked in under games/lab/public/woods/.
 *
 *   bun scripts/woods/fetch-assets.ts [--only <id,id>]
 *
 * Textures become WebP: base colour (sRGB, alpha for cut-outs), OpenGL normal and ORM (Poly Haven's `arm`: AO,
 * roughness, metalness). Models go through Blender (scripts/woods/blender-export.py: decimated to a triangle budget)
 * and are packed as the kit's 32-byte textured vertices (`packTexturedVerts`), gzipped.
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { join, dirname } from "node:path"
import { packTexturedVerts } from "../../packages/kit/gpu/textured-mesh"

const ROOT = join(import.meta.dir, "../..")
const OUT = join(ROOT, "packages/kit/forest/assets")
const CACHE = join(process.env.TMPDIR ?? "/tmp", "woods-assets-cache")
mkdirSync(join(OUT, "tex"), { recursive: true })
mkdirSync(join(OUT, "models"), { recursive: true })
mkdirSync(CACHE, { recursive: true })

type TextureJob = { id: string; name: string; res: "1k" | "2k"; size: number; alpha?: boolean; use: string }
/** `lods`: extra triangle budgets, each written as `<name>-lod<i>` (geometry only; same textures and parts). */
type ModelJob = { id: string; name: string; res: "1k" | "2k"; budget: number; lods?: number[]; split?: boolean; texSize: number; alpha?: boolean; use: string }

export const TEXTURES: TextureJob[] = [
  { id: "bark_brown_02", name: "bark-mossy", res: "2k", size: 1024, use: "old-growth conifer trunks (moss streaks)" },
  { id: "knotted_pine_bark", name: "bark-spruce", res: "1k", size: 1024, use: "spruce and snag trunks" },
  { id: "pine_bark", name: "bark-pine", res: "1k", size: 1024, use: "red pine plates by the camp" },
  { id: "forest_leaves_04", name: "ground-needles", res: "2k", size: 2048, use: "needle litter, the forest floor" },
  { id: "forest_ground_04", name: "ground-moss", res: "1k", size: 1024, use: "mossy floor patches" },
  { id: "mud_forest", name: "ground-trail", res: "1k", size: 1024, use: "worn trails, shore mud" },
  { id: "mossy_rock", name: "rock-moss", res: "1k", size: 1024, use: "boulder tops" },
  { id: "lichen_rock", name: "rock-lichen", res: "1k", size: 1024, use: "granite outcrops" },
  { id: "old_planks_02", name: "planks", res: "1k", size: 1024, use: "camp buildings, dock boards" },
  { id: "grey_roof_01", name: "roof", res: "1k", size: 1024, use: "camp roofs" },
]

export const MODELS: ModelJob[] = [
  { id: "fern_02", name: "fern", res: "2k", budget: 2400, lods: [640], split: true, texSize: 1024, alpha: true, use: "bracken/sword fern clumps" },
  { id: "rock_moss_set_01", name: "rocks-a", res: "1k", budget: 1400, split: true, texSize: 1024, use: "mossy boulders" },
  { id: "rock_moss_set_02", name: "rocks-b", res: "1k", budget: 900, split: true, texSize: 1024, use: "small mossy stones" },
  { id: "dead_tree_trunk", name: "log", res: "1k", budget: 3000, texSize: 1024, use: "fallen logs" },
  { id: "tree_stump_01", name: "stump", res: "1k", budget: 1600, texSize: 1024, use: "stumps" },
  { id: "dry_branches_medium_01", name: "branches", res: "1k", budget: 600, split: true, texSize: 512, use: "deadfall twigs" },
  { id: "pine_roots", name: "roots", res: "1k", budget: 1800, split: true, texSize: 1024, use: "surface roots at trunk bases" },
  { id: "wooden_picnic_table", name: "picnic-table", res: "1k", budget: 1500, texSize: 512, use: "camp tables" },
]

/** Scanned needle twig atlases from Poly Haven's tree models: the crowns' cards. */
type TwigJob = { id: string; name: string; size: number; use: string }
export const TWIGS: TwigJob[] = [
  { id: "pine_tree_01", name: "twig-pine", size: 1024, use: "pine crown needle sprays (twig atlas only)" },
  { id: "fir_tree_01", name: "twig-fir", size: 1024, use: "spruce crown sprays (twig atlas only)" },
]

type Credit = { id: string; name: string; kind: "texture" | "model"; url: string; authors: Record<string, string>; licence: string; use: string; files: Record<string, string> }

async function fetchCached(url: string): Promise<string> {
  const path = join(CACHE, url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_"))
  if (!existsSync(path)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  return path
}
const json = async (url: string) => JSON.parse(readFileSync(await fetchCached(url), "utf8"))
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

async function webp(src: string, dst: string, size: number, opts: { alpha?: string; lossless?: boolean; quality?: number } = {}) {
  const tmp = `${dst}.png`
  if (opts.alpha) await $`magick ${src} ${opts.alpha} -alpha off -compose CopyOpacity -composite -resize ${size}x${size}! ${tmp}`.quiet()
  else await $`magick ${src} -resize ${size}x${size}! ${tmp}`.quiet()
  await $`cwebp -quiet ${opts.lossless ? ["-lossless"] : ["-q", String(opts.quality ?? 88)]} -exact -alpha_q 100 ${tmp} -o ${dst}`.quiet()
  await $`rm ${tmp}`.quiet()
}

async function info(id: string) {
  const i = await json(`https://api.polyhaven.com/info/${id}`)
  return { authors: i.authors as Record<string, string> }
}

async function texture(job: TextureJob): Promise<Credit> {
  const files = await json(`https://api.polyhaven.com/files/${job.id}`)
  const get = (key: string) => fetchCached(files[key][job.res].jpg.url)
  const [base, normal, orm] = await Promise.all([get("Diffuse"), get("nor_gl"), get("arm")])
  const out = (s: string) => join(OUT, "tex", `${job.name}-${s}.webp`)
  await webp(base, out("base"), job.size)
  await webp(normal, out("normal"), job.size, { quality: 92 })
  await webp(orm, out("orm"), job.size)
  return { id: job.id, name: job.name, kind: "texture", url: `https://polyhaven.com/a/${job.id}`, ...(await info(job.id)), licence: "CC0 1.0", use: job.use,
    files: { [files.Diffuse[job.res].jpg.url]: sha(base), [files.nor_gl[job.res].jpg.url]: sha(normal), [files.arm[job.res].jpg.url]: sha(orm) } }
}

/** Decimates the glTF to `budget` triangles (per part when split) in Blender and writes `<name>.bin.gz` and its index. */
async function exportModel(job: ModelJob, gltf: string, prefix: string, budget: number, name: string) {
  await $`blender -b --factory-startup --python ${join(import.meta.dir, "blender-export.py")} -- ${gltf} ${prefix} ${JSON.stringify({ budget, split: job.split ?? false })}`.quiet()
  const manifest = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as { name: string; offset: number; corners: number; min: number[]; max: number[] }[]
  const raw = new Float32Array(readFileSync(`${prefix}.f32`).buffer.slice(0))
  // Kit vertices: pos, normal, colour (white), material 0, aux 0, + uv.
  const parts = manifest.map(m => {
    const v: number[] = [], uv: number[] = []
    for (let c = 0; c < m.corners; c++) {
      const o = m.offset / 4 + c * 8
      v.push(raw[o]!, raw[o + 1]!, raw[o + 2]!, raw[o + 3]!, raw[o + 4]!, raw[o + 5]!, 1, 1, 1, 0, 0)
      uv.push(raw[o + 6]!, raw[o + 7]!)
    }
    return { name: m.name, min: m.min, max: m.max, bytes: new Uint8Array(packTexturedVerts(v, uv)) }
  })
  const total = parts.reduce((s, p) => s + p.bytes.byteLength, 0), all = new Uint8Array(total)
  let at = 0
  const index = parts.map(p => { const r = { name: p.name, offset: at, count: p.bytes.byteLength / 32, min: p.min, max: p.max }; all.set(p.bytes, at); at += p.bytes.byteLength; return r })
  writeFileSync(join(OUT, "models", `${name}.bin.gz`), gzipSync(all, { level: 9 }))
  writeFileSync(join(OUT, "models", `${name}.json`), JSON.stringify({ source: job.id, parts: index }, null, 1))
  return index
}

async function model(job: ModelJob): Promise<Credit> {
  const files = await json(`https://api.polyhaven.com/files/${job.id}`)
  const g = files.gltf[job.res].gltf
  const dir = join(CACHE, job.id)
  mkdirSync(join(dir, "textures"), { recursive: true })
  const gltf = join(dir, `${job.id}.gltf`)
  writeFileSync(gltf, readFileSync(await fetchCached(g.url)))
  const sums: Record<string, string> = { [g.url]: sha(gltf) }
  for (const [rel, f] of Object.entries(g.include as Record<string, { url: string }>)) {
    const p = await fetchCached(f.url)
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), readFileSync(p))
    sums[f.url] = sha(p)
  }
  const index = await exportModel(job, gltf, join(dir, "export"), job.budget, job.name)
  for (const [i, budget] of (job.lods ?? []).entries()) await exportModel(job, gltf, join(dir, `export-lod${i + 1}`), budget, `${job.name}-lod${i + 1}`)
  const total = index.reduce((s, p) => s + p.count * 32, 0)
  const tex = (suffix: string) => Object.keys(g.include).find(k => k.includes(`_${suffix}_`))
  const base = tex("diff"), normal = tex("nor_gl"), orm = tex("arm")
  let alpha: string | undefined
  if (job.alpha) alpha = await fetchCached(files.Alpha[job.res].png?.url ?? files.Alpha[job.res].jpg.url)
  const out = (s: string) => join(OUT, "models", `${job.name}-${s}.webp`)
  if (base) await webp(join(dir, base), out("base"), job.texSize, alpha ? { alpha } : {})
  if (normal) await webp(join(dir, normal), out("normal"), job.texSize, { quality: 92 })
  if (orm) await webp(join(dir, orm), out("orm"), job.texSize)
  const tris = index.reduce((s, p) => s + p.count, 0) / 3
  console.log(`${job.id}: ${index.length} parts, ${tris} triangles, ${(total / 1024).toFixed(0)} KiB raw`)
  return { id: job.id, name: job.name, kind: "model", url: `https://polyhaven.com/a/${job.id}`, ...(await info(job.id)), licence: "CC0 1.0", use: job.use, files: sums }
}

async function twig(job: TwigJob): Promise<Credit> {
  const files = await json(`https://api.polyhaven.com/files/${job.id}`)
  const get = (key: string) => fetchCached(files[key]["1k"].jpg.url)
  const [base, alpha, normal, orm] = await Promise.all([get("twig_diff"), get("twig_alpha"), get("twig_nor_gl"), get("twig_arm")])
  const out = (s: string) => join(OUT, "tex", `${job.name}-${s}.webp`)
  await webp(base, out("base"), job.size, { alpha })
  await webp(normal, out("normal"), job.size, { quality: 90 })
  await webp(orm, out("orm"), job.size)
  return { id: job.id, name: job.name, kind: "texture", url: `https://polyhaven.com/a/${job.id}`, ...(await info(job.id)), licence: "CC0 1.0", use: job.use,
    files: Object.fromEntries(["twig_diff", "twig_alpha", "twig_nor_gl", "twig_arm"].map((k, i) => [files[k]["1k"].jpg.url, sha([base, alpha, normal, orm][i]!)])) }
}

const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : null
const creditsPath = join(OUT, "sources.json")
const previous: Credit[] = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, "utf8")) : []
const credits = new Map(previous.map(c => [c.id, c]))
for (const job of TEXTURES) if (!only || only.has(job.id)) { credits.set(job.id, await texture(job)); console.log("texture", job.id) }
for (const job of TWIGS) if (!only || only.has(job.id)) { credits.set(job.id, await twig(job)); console.log("twig", job.id) }
for (const job of MODELS) if (!only || only.has(job.id)) credits.set(job.id, await model(job))
const list = [...credits.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
writeFileSync(creditsPath, JSON.stringify(list, null, 1))
const md = [
  "# Woods look: asset credits",
  "",
  "Every scan and model here is from [Poly Haven](https://polyhaven.com), released under **CC0 1.0** (public domain,",
  "https://polyhaven.com/license). Downloaded and converted by `scripts/woods/fetch-assets.ts`: textures resized and",
  "re-encoded as WebP (base colour, OpenGL normal, ORM), models decimated in Blender and packed as kit vertices.",
  "Source URLs and SHA-256 of every downloaded file are in `sources.json`. Procedural assets (birch bark, needle",
  "sprays, flagging tape, buildings, terrain) are generated in code (`packages/kit/forest/`).",
  "",
  "| Asset | Kind | Authors | Used for |",
  "| --- | --- | --- | --- |",
  ...list.map(c => `| [${c.id}](${c.url}) | ${c.kind} | ${Object.entries(c.authors).map(([n, r]) => `${n} (${r})`).join(", ")} | ${c.use} |`),
  "",
].join("\n")
writeFileSync(join(OUT, "CREDITS.md"), md)
