// Builds the material library's GPU textures in public/textures/ from CC0 scans, and writes CREDITS.md.
//
//   bun scripts/fetch-textures.ts            # build missing sets (downloads are cached in $TMPDIR)
//   bun scripts/fetch-textures.ts --force    # rebuild everything
//
// Every scanned set becomes two Basis UASTC KTX2 files (GPU-compressed: BC7/ASTC on the GPU, 1 byte per texel, full
// mip chain, transcoded off the main thread by three's KTX2Loader):
//   <set>/albedo.ktx2   RGB base colour (sRGB) + A roughness
//   <set>/surface.ktx2  R,G tangent-space normal X,Y (OpenGL, Z rebuilt in the shader) + B ambient occlusion + A metalness
// Images are flipped vertically at encode time so UVs match three's default flipY for ordinary images.
// Also writes noise.bin (the materials' tiling RGBA noise, precomputed here so the page doesn't spend ~60 ms on it) and
// copies three's Basis transcoder into textures/basis/.
// Sources are CC0 only: Poly Haven (api.polyhaven.com) and ambientCG (ambientcg.com). Needs ffmpeg, unzip and basisu
// (`brew install basis_universal`).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Source = {
  site: "polyhaven" | "ambientcg"
  id: string
  res: "1k" | "2k"
  /** Output size of albedo.ktx2 and surface.ktx2 (px). */
  albedo: number
  surface: number | null
  note: string
  /** ambientCG map packed as roughness (default "Roughness"). */
  roughMap?: string
}

/** Set name (folder) → CC0 source. Must match `SETS` in src/render/materials.ts. */
export const TEXTURE_SETS: Record<string, Source> = {
  asphalt: { site: "polyhaven", id: "asphalt_02", res: "2k", albedo: 2048, surface: 1024, note: "road surface with hairline cracks" },
  asphalt_lot: { site: "polyhaven", id: "worn_asphalt", res: "2k", albedo: 2048, surface: 1024, note: "worn parking-lot asphalt" },
  gravel: { site: "ambientcg", id: "Gravel022", res: "1k", albedo: 1024, surface: 1024, note: "grey gravel shoulders" },
  forest_floor: { site: "ambientcg", id: "Ground072", res: "1k", albedo: 1024, surface: 1024, note: "forest duff with pine needles" },
  forest_moss: { site: "polyhaven", id: "forrest_ground_01", res: "1k", albedo: 1024, surface: 1024, note: "mossy needle ground, blended into the forest floor" },
  grass: { site: "polyhaven", id: "withered_grass", res: "1k", albedo: 1024, surface: 1024, note: "dry withered grass" },
  dirt: { site: "ambientcg", id: "Ground048", res: "1k", albedo: 1024, surface: 1024, note: "dark soil" },
  concrete_wall: { site: "polyhaven", id: "wood_textured_concrete", res: "2k", albedo: 2048, surface: 1024, note: "board-formed concrete" },
  concrete_dark: { site: "ambientcg", id: "Concrete033", res: "1k", albedo: 1024, surface: 1024, note: "dark bunker concrete" },
  concrete_floor: { site: "polyhaven", id: "concrete_floor_worn_001", res: "1k", albedo: 1024, surface: 1024, note: "worn concrete slab" },
  bark: { site: "ambientcg", id: "Bark014", res: "1k", albedo: 1024, surface: 1024, note: "fir bark" },
  wood_pole: { site: "polyhaven", id: "rough_wood", res: "1k", albedo: 1024, surface: 1024, note: "weathered wood grain (utility poles)" },
  metal_painted: { site: "ambientcg", id: "PaintedMetal001", res: "1k", albedo: 1024, surface: 1024, note: "scratched paint (luminance/normal/roughness only; recoloured)" },
  metal_galvanized: { site: "ambientcg", id: "Metal032", res: "1k", albedo: 512, surface: 512, note: "plain grey steel" },
  metal_dark: { site: "ambientcg", id: "Metal046B", res: "1k", albedo: 512, surface: 512, note: "dark dirty steel" },
  ceiling_tile: { site: "ambientcg", id: "OfficeCeiling001", res: "1k", albedo: 1024, surface: 1024, note: "fissured acoustic ceiling tiles" },
  terrazzo: { site: "ambientcg", id: "Terrazzo019S", res: "1k", albedo: 512, surface: 512, note: "beige terrazzo" },
  plaster: { site: "ambientcg", id: "Plaster001", res: "1k", albedo: 512, surface: 512, note: "smooth plaster (painted wall)" },
  imperfections: { site: "ambientcg", id: "SurfaceImperfections003", res: "1k", albedo: 512, surface: null, roughMap: "Color", note: "smudges for glossy roughness variation (only its roughness channel is used)" },
}

const root = join(import.meta.dir, "../public/textures")
const force = process.argv.includes("--force")
const cacheDir = join(tmpdir(), "ashwood-textures")
mkdirSync(cacheDir, { recursive: true })

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${(err || out).slice(-800)}`)
}
const download = async (url: string, file: string) => {
  if (existsSync(file)) return file
  const res = await fetch(url, { headers: { "User-Agent": "ashwood-texture-fetch" } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(`${file}.part`, res)
  await run(["mv", `${file}.part`, file])
  return file
}

type Maps = { color: string; normal: string | null; rough: string; ao: string | null; metal: string | null }

async function fetchPolyHaven(src: Source, dir: string): Promise<Maps> {
  const files = (await (await fetch(`https://api.polyhaven.com/files/${src.id}`)).json()) as Record<string, Record<string, Record<string, { url: string }>>>
  const get = async (map: string) => {
    const u = files[map]?.[src.res]?.jpg?.url ?? files[map]?.[src.res]?.png?.url
    return u ? download(u, join(dir, `${map}.${u.split(".").pop()}`)) : null
  }
  const [color, normal, rough, ao] = await Promise.all([get("Diffuse"), get("nor_gl"), get("Rough"), get("AO")])
  if (!color || !normal || !rough) throw new Error(`${src.id}: missing maps`)
  return { color, normal, rough, ao, metal: null }
}

async function fetchAmbientCG(src: Source, dir: string): Promise<Maps> {
  const zip = await download(`https://ambientcg.com/get?file=${src.id}_${src.res.toUpperCase()}-JPG.zip`, join(dir, "set.zip"))
  await run(["unzip", "-o", "-q", zip, "-d", dir])
  const names = readdirSync(dir)
  const find = (suffix: string) => names.find((n) => n.endsWith(`_${suffix}.jpg`) || n.endsWith(`_${suffix}.png`))
  const at = (n: string | undefined) => (n ? join(dir, n) : null)
  const color = at(find("Color"))
  const rough = at(find(src.roughMap ?? "Roughness"))
  if (!color || !rough) throw new Error(`${src.id}: missing maps in ${names.join(", ")}`)
  return { color, normal: at(find("NormalGL")), rough, ao: at(find("AmbientOcclusion")), metal: at(find("Metalness")) }
}

type Plane = [file: string, plane: "r" | "g" | "b" | "y"] | number
/**
 * Packs four planes into one lossless RGBA PNG with ffmpeg. Each entry is [file, plane] (plane "r"/"g"/"b" of an RGB
 * image, or "y" for the luma of a greyscale map) or a constant 0..255 when the map is missing.
 */
async function pack(planes: [Plane, Plane, Plane, Plane], size: number, out: string) {
  const inputs: string[] = []
  const filters = planes.map((p, i) => {
    const n = inputs.filter((a) => a === "-i").length
    if (typeof p === "number") {
      inputs.push("-f", "lavfi", "-i", `color=c=0x${p.toString(16).padStart(2, "0").repeat(3)}:s=${size}x${size}`)
      return `[${n}:v]format=gray,setsar=1[p${i}]`
    }
    inputs.push("-i", p[0])
    const pick = p[1] === "y" ? "format=gray" : `format=gbrp,extractplanes=${p[1]}`
    return `[${n}:v]scale=${size}:${size}:flags=lanczos,setsar=1,${pick}[p${i}]`
  })
  // gbrap plane order is G, B, R, A.
  const graph = `${filters.join(";")};[p1][p2][p0][p3]mergeplanes=0x00102030:gbrap,format=rgba`
  await run(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-frames:v", "1", out])
}

const basisu = (input: string, out: string, srgb: boolean) =>
  run([
    "basisu", "-ktx2", "-uastc", "-uastc_level", "2", "-uastc_rdo_l", "1", "-mipmap", "-y_flip",
    ...(srgb ? ["-srgb", "-mip_srgb"] : ["-linear", "-mip_linear"]),
    input, "-output_file", out,
  ])

/** Tiling value-noise fbm, four independent histogram-equalised channels (texel value = percentile). */
function noise(S = 512) {
  const data = new Uint8Array(S * S * 4)
  const val = new Float32Array(S * S)
  const rnd = (x: number, y: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const BINS = 4096
  const hist = new Uint32Array(BINS)
  for (let c = 0; c < 4; c++) {
    const base = 4 << c
    let lo = Infinity
    let hi = -Infinity
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0
        let amp = 1
        // Octaves stop at 4 px per cell so the finest layer never aliases into blocks.
        for (let n = base, o = 0; n <= S / 4; n *= 2, o++) {
          const fx = (x / S) * n
          const fy = (y / S) * n
          const ix = Math.floor(fx)
          const iy = Math.floor(fy)
          const tx = fade(fx - ix)
          const ty = fade(fy - iy)
          const sd = c * 16 + o
          const a = rnd(ix % n, iy % n, sd)
          const b = rnd((ix + 1) % n, iy % n, sd)
          const d = rnd(ix % n, (iy + 1) % n, sd)
          const e = rnd((ix + 1) % n, (iy + 1) % n, sd)
          v += amp * (a + (b - a) * tx + (d - a) * ty + (a - b - d + e) * tx * ty)
          amp *= 0.5
        }
        val[y * S + x] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    hist.fill(0)
    const k = (BINS - 1) / (hi - lo)
    for (let i = 0; i < S * S; i++) hist[Math.round((val[i]! - lo) * k)]!++
    let acc = 0
    for (let b = 0; b < BINS; b++) {
      const n = hist[b]!
      hist[b] = Math.round(((acc + n / 2) / (S * S)) * 255)
      acc += n
    }
    for (let i = 0; i < S * S; i++) data[i * 4 + c] = hist[Math.round((val[i]! - lo) * k)]!
  }
  return data
}

mkdirSync(root, { recursive: true })
const credits: string[] = []
let total = 0
for (const [name, src] of Object.entries(TEXTURE_SETS)) {
  const out = join(root, name)
  const page = src.site === "polyhaven" ? `https://polyhaven.com/a/${src.id}` : `https://ambientcg.com/view?id=${src.id}`
  const sizes = src.surface ? `${src.albedo} / ${src.surface}` : `${src.albedo}`
  credits.push(`| \`${name}/\` | ${src.site === "polyhaven" ? "Poly Haven" : "ambientCG"} | [${src.id}](${page}) | ${src.res} → ${sizes} | CC0 1.0 | ${src.note} |`)
  const want = src.surface ? ["albedo.ktx2", "surface.ktx2"] : ["albedo.ktx2"]
  if (!force && want.every((f) => existsSync(join(out, f)))) {
    console.log(`${name}: present`)
  } else {
    const dir = join(cacheDir, `${src.site}-${src.id}-${src.res}`)
    mkdirSync(dir, { recursive: true })
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const maps = src.site === "polyhaven" ? await fetchPolyHaven(src, dir) : await fetchAmbientCG(src, dir)
    const albedoPng = join(dir, "albedo.png")
    await pack([[maps.color, "r"], [maps.color, "g"], [maps.color, "b"], [maps.rough, "y"]], src.albedo, albedoPng)
    const jobs = [basisu(albedoPng, join(out, "albedo.ktx2"), true)]
    if (src.surface) {
      if (!maps.normal) throw new Error(`${src.id}: no normal map`)
      const surfacePng = join(dir, "surface.png")
      await pack([[maps.normal, "r"], [maps.normal, "g"], maps.ao ? [maps.ao, "y"] : 255, maps.metal ? [maps.metal, "y"] : 0], src.surface, surfacePng)
      jobs.push(basisu(surfacePng, join(out, "surface.ktx2"), false))
    }
    await Promise.all(jobs)
    console.log(`${name}: ${src.site}/${src.id} → ${sizes}`)
  }
  for (const f of readdirSync(out)) total += statSync(join(out, f)).size
}

const noiseFile = join(root, "noise.bin")
if (force || !existsSync(noiseFile)) writeFileSync(noiseFile, noise())
total += statSync(noiseFile).size

const basisDir = join(root, "basis")
mkdirSync(basisDir, { recursive: true })
const threeBasis = join(import.meta.dir, "../node_modules/three/examples/jsm/libs/basis")
const basisSrc = existsSync(threeBasis) ? threeBasis : join(import.meta.dir, "../../../node_modules/three/examples/jsm/libs/basis")
for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
  copyFileSync(join(basisSrc, f), join(basisDir, f))
  total += statSync(join(basisDir, f)).size
}

writeFileSync(
  join(root, "CREDITS.md"),
  `# Texture credits

Every texture here is **CC0 1.0 (public domain)**; no attribution is required, but sources are recorded so the set is
reproducible. Regenerate with \`bun scripts/fetch-textures.ts\` (\`--force\` to rebuild; needs ffmpeg, unzip and basisu).
Each folder holds \`albedo.ktx2\` (RGB colour sRGB + A roughness) and \`surface.ktx2\` (RG normal XY OpenGL, B AO,
A metalness), Basis UASTC with mipmaps, packed from the originals.

- Poly Haven licence: https://polyhaven.com/license
- ambientCG licence: https://docs.ambientcg.com/license/

| Folder | Site | Asset | Source → albedo / surface px | Licence | Use |
| --- | --- | --- | --- | --- | --- |
${credits.join("\n")}

\`noise.bin\` (512² RGBA tiling noise) is generated by the script. \`basis/\` is three.js's Basis Universal transcoder
(Apache-2.0), copied from \`three/examples/jsm/libs/basis\`.

Procedural (generated at runtime in \`src/render/materials.ts\`, no external source): chain-link mesh, barbed wire,
pine branch card, ceramic wall tile, linoleum, window glass, rubber, emissive lenses.
`,
)
console.log(`total ${(total / 1e6).toFixed(1)} MB in ${root}`)
