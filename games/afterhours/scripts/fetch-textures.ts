// Downloads the CC0 PBR texture sets the material library uses into public/textures/<set>/ and writes CREDITS.md.
//
//   bun scripts/fetch-textures.ts            # fetch missing sets
//   bun scripts/fetch-textures.ts --force    # refetch everything
//
// Every set is normalised to three JPEGs so materials.ts loads them the same way:
//   color.jpg   base colour (sRGB)
//   normal.jpg  OpenGL-convention tangent-space normal (+Y up)
//   arm.jpg     R = ambient occlusion, G = roughness, B = metalness (linear)
// Sources are CC0 only: Poly Haven (api.polyhaven.com) and ambientCG (ambientcg.com). Needs ffmpeg and unzip.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Source = { site: "polyhaven" | "ambientcg"; id: string; res: "1k" | "2k"; size?: number; note: string; roughMap?: string }

/** Set name (folder) → CC0 source. `size` downscales the output (px). */
export const TEXTURE_SETS: Record<string, Source> = {
  asphalt: { site: "polyhaven", id: "asphalt_02", res: "2k", note: "road surface with hairline cracks" },
  asphalt_lot: { site: "polyhaven", id: "worn_asphalt", res: "2k", note: "worn parking-lot asphalt" },
  gravel: { site: "ambientcg", id: "Gravel022", res: "1k", note: "grey gravel shoulders" },
  forest_floor: { site: "ambientcg", id: "Ground072", res: "1k", note: "forest duff with pine needles" },
  forest_moss: { site: "polyhaven", id: "forrest_ground_01", res: "1k", note: "mossy needle ground, blended into the forest floor" },
  grass: { site: "polyhaven", id: "withered_grass", res: "1k", note: "dry withered grass" },
  dirt: { site: "ambientcg", id: "Ground048", res: "1k", note: "dark soil" },
  concrete_wall: { site: "polyhaven", id: "wood_textured_concrete", res: "2k", note: "board-formed concrete" },
  concrete_dark: { site: "ambientcg", id: "Concrete033", res: "1k", note: "dark bunker concrete" },
  concrete_floor: { site: "polyhaven", id: "concrete_floor_worn_001", res: "1k", note: "worn concrete slab" },
  bark: { site: "ambientcg", id: "Bark014", res: "1k", note: "fir bark" },
  wood_pole: { site: "polyhaven", id: "rough_wood", res: "1k", note: "weathered wood grain (utility poles)" },
  metal_painted: { site: "ambientcg", id: "PaintedMetal001", res: "1k", note: "scratched paint (normal/roughness only; colour is tinted)" },
  metal_galvanized: { site: "ambientcg", id: "Metal032", res: "1k", note: "plain grey steel" },
  metal_dark: { site: "ambientcg", id: "Metal046B", res: "1k", note: "dark dirty steel" },
  ceiling_tile: { site: "ambientcg", id: "OfficeCeiling001", res: "1k", note: "fissured acoustic ceiling tiles" },
  terrazzo: { site: "ambientcg", id: "Terrazzo019S", res: "1k", note: "beige terrazzo" },
  plaster: { site: "ambientcg", id: "Plaster001", res: "1k", note: "smooth plaster (painted wall)" },
  imperfections: { site: "ambientcg", id: "SurfaceImperfections003", res: "1k", roughMap: "Color", note: "smudges for glossy roughness variation (its colour map is packed as roughness)" },
}

const root = join(import.meta.dir, "../public/textures")
const force = process.argv.includes("--force")
const work = join(tmpdir(), "afterhours-textures")
mkdirSync(work, { recursive: true })

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
  const err = await new Response(p.stderr).text()
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-600)}`)
}
const download = async (url: string, file: string) => {
  const res = await fetch(url, { headers: { "User-Agent": "afterhours-texture-fetch" } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}

/** Re-encodes a map as a full-range 4:4:4 JPEG (no chroma subsampling, which would smear normal maps). */
const encode = (input: string, out: string, size: number, gray = false) =>
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", input, "-vf", `scale=${size}:${size}:flags=lanczos${gray ? ",format=gray" : ""}`,
    "-pix_fmt", gray ? "gray" : "yuvj444p", "-q:v", "3", out])

/** Packs AO/roughness/metalness into one RGB JPEG; missing inputs become constant white (AO) or black (metal). */
const packArm = (ao: string | null, rough: string, metal: string | null, out: string, size: number) => {
  const input = (f: string | null, fill: string) => (f ? ["-i", f] : ["-f", "lavfi", "-i", `color=${fill}:s=${size}x${size}`])
  const s = `scale=${size}:${size}:flags=lanczos,setsar=1,format=gray`
  return run(["ffmpeg", "-y", "-loglevel", "error", ...input(rough, "gray"), ...input(metal, "black"), ...input(ao, "white"),
    "-filter_complex", `[0:v]${s}[g];[1:v]${s}[b];[2:v]${s}[r];[g][b][r]mergeplanes=0x001020:gbrp,format=yuvj444p`,
    "-frames:v", "1", "-q:v", "3", out])
}

type Maps = { color: string; normal: string; rough: string; ao: string | null; metal: string | null; arm?: string }

async function fetchPolyHaven(src: Source, dir: string): Promise<Maps> {
  const files = (await (await fetch(`https://api.polyhaven.com/files/${src.id}`)).json()) as Record<string, Record<string, Record<string, { url: string }>>>
  const url = (map: string) => files[map]?.[src.res]?.jpg?.url ?? files[map]?.[src.res]?.png?.url
  const get = async (map: string) => {
    const u = url(map)
    return u ? download(u, join(dir, `${map}.${u.split(".").pop()}`)) : null
  }
  const [color, normal, rough, ao, arm] = await Promise.all([get("Diffuse"), get("nor_gl"), get("Rough"), get("AO"), get("arm")])
  if (!color || !normal || !rough) throw new Error(`${src.id}: missing maps`)
  return { color, normal, rough, ao, metal: null, arm: arm ?? undefined }
}

async function fetchAmbientCG(src: Source, dir: string): Promise<Maps> {
  const zip = await download(`https://ambientcg.com/get?file=${src.id}_${src.res.toUpperCase()}-JPG.zip`, join(dir, "set.zip"))
  await run(["unzip", "-o", "-q", zip, "-d", dir])
  const names = readdirSync(dir)
  const find = (suffix: string) => names.find((n) => n.endsWith(`_${suffix}.jpg`) || n.endsWith(`_${suffix}.png`))
  const at = (n: string | undefined) => (n ? join(dir, n) : null)
  const color = at(find("Color"))
  const normal = at(find("NormalGL"))
  const rough = at(find(src.roughMap ?? "Roughness"))
  if (!color || !normal || !rough) throw new Error(`${src.id}: missing maps in ${names.join(", ")}`)
  return { color, normal, rough, ao: at(find("AmbientOcclusion")), metal: at(find("Metalness")) }
}

const credits: string[] = []
let total = 0
for (const [name, src] of Object.entries(TEXTURE_SETS)) {
  const out = join(root, name)
  const page = src.site === "polyhaven" ? `https://polyhaven.com/a/${src.id}` : `https://ambientcg.com/view?id=${src.id}`
  credits.push(`| \`${name}/\` | ${src.site === "polyhaven" ? "Poly Haven" : "ambientCG"} | [${src.id}](${page}) | ${src.res} | CC0 1.0 | ${src.note} |`)
  if (!force && ["color.jpg", "normal.jpg", "arm.jpg"].every((f) => existsSync(join(out, f)))) {
    console.log(`${name}: present`)
  } else {
    const tmp = join(work, name)
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    mkdirSync(out, { recursive: true })
    const maps = src.site === "polyhaven" ? await fetchPolyHaven(src, tmp) : await fetchAmbientCG(src, tmp)
    const size = src.size ?? (src.res === "2k" ? 2048 : 1024)
    await encode(maps.color, join(out, "color.jpg"), size)
    await encode(maps.normal, join(out, "normal.jpg"), size)
    await packArm(maps.ao, maps.rough, maps.metal, join(out, "arm.jpg"), size)
    rmSync(tmp, { recursive: true, force: true })
    console.log(`${name}: ${src.site}/${src.id} ${src.res}`)
  }
  for (const f of readdirSync(out)) total += statSync(join(out, f)).size
}

writeFileSync(
  join(root, "CREDITS.md"),
  `# Texture credits

Every texture here is **CC0 1.0 (public domain)**; no attribution is required, but sources are recorded so the set is
reproducible. Regenerate with \`bun scripts/fetch-textures.ts\` (\`--force\` to refetch). Each folder holds
\`color.jpg\` (sRGB), \`normal.jpg\` (OpenGL) and \`arm.jpg\` (R AO, G roughness, B metalness), re-encoded from the
originals with ffmpeg.

- Poly Haven licence: https://polyhaven.com/license
- ambientCG licence: https://docs.ambientcg.com/license/

| Folder | Site | Asset | Res | Licence | Use |
| --- | --- | --- | --- | --- | --- |
${credits.join("\n")}

Procedural (generated at runtime in \`src/render/materials.ts\`, no external source): chain-link mesh, barbed wire,
pine branch card, ceramic wall tile, linoleum, window glass, rubber, emissive lenses.
`,
)
console.log(`total ${(total / 1e6).toFixed(1)} MB in ${root}`)
