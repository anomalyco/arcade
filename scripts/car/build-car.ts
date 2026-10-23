// Builds Barbara's car, games/barbara/public/car/car.glb, from Daniel Zhabotinsky's "Kiri '86" (CC BY 4.0, a crisp,
// boxy Japanese saloon standing in for STORY.md's blue 1993 Lexus ES; see games/barbara/public/car/CREDITS.md):
//
//   bun scripts/car/build-car.ts [--preview <dir>]
//
// 1. Downloads the model and its Objaverse metadata into a cache ($CAR_CACHE or ~/Library/Caches/arcade-car), refuses
//    any licence but CC BY, and checks the GLB against the SHA-256 in games/barbara/public/car/sources.json (a new file
//    is recorded; a changed one fails).
// 2. Runs scripts/car/build-car.py in headless Blender: metres, nose to -Z, driver's door open on its own node, merged
//    materials, LOD1, WebP maps (paint, dust and grime made there), leaves and the donut box.
// 3. Writes each material's kit surface into `extras.kit` (`loadGltf` reads it: the taillights and rear plate are
//    MAT.retro), then prunes, dedups and meshopt-compresses the GLB with the same tools as build-rocketbox.ts.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { MAT } from "../../packages/kit/gpu/mesh"

const UID = "5c17c582ef9549798f694b660feea42a"
const OBJAVERSE = "https://huggingface.co/datasets/allenai/objaverse/resolve/main"
const SHARD = "000-084"
/**
 * Kit surface per material kind. Rear reflectors and plates are retroreflective (`MAT.retro`; aux is the gain over
 * paint on the torch's line, the forest batch caps it at 6): the taillight lenses carry the reflector, dyed red so a
 * bright return stays red, and the plates are sheeting like the boundary signs.
 */
const SURFACE: Record<string, { mat: number; aux: number; color?: [number, number, number] }> = {
  reflector: { mat: MAT.retro, aux: 5, color: [1, 0.1, 0.07] },
  plate: { mat: MAT.retro, aux: 2.5 },
  "plate.front": { mat: MAT.retro, aux: 2.5 },
}

const root = join(import.meta.dir, "../..")
const cache = process.env.CAR_CACHE ?? join(homedir(), "Library/Caches/arcade-car")
const outDir = join(root, "games/barbara/public/car")
const sourcesFile = join(outDir, "sources.json")
const preview = process.argv.includes("--preview") ? process.argv[process.argv.indexOf("--preview") + 1] : undefined

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${(o + e).slice(-3000)}`)
  return o + e
}
const download = async (url: string, file: string) => {
  if (existsSync(file) && statSync(file).size > 0) return file
  mkdirSync(join(file, ".."), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}

const glbUrl = `${OBJAVERSE}/glbs/${SHARD}/${UID}.glb`
const src = await download(glbUrl, join(cache, "kiri86.glb"))
const meta = JSON.parse(gunzipSync(readFileSync(await download(`${OBJAVERSE}/metadata/${SHARD}.json.gz`, join(cache, `meta-${SHARD}.json.gz`)))).toString())[UID]
if (meta?.license !== "by") throw new Error(`Unexpected licence for ${UID}: ${meta?.license}`)
const sha = createHash("sha256").update(readFileSync(src)).digest("hex")
type Sources = { licence: string; model: string; author: string; source: string; files: Record<string, string> }
const sources: Sources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, "utf8")) : {
  licence: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
  model: `${meta.name} (now "Kiri '86 - Low poly model")`,
  author: `${meta.user.displayName} (${meta.user.profileUrl})`,
  source: meta.viewerUrl,
  files: {},
}
const want = sources.files[glbUrl]
if (want && want !== sha) throw new Error(`${glbUrl}: SHA-256 ${sha}, recorded ${want}`)
sources.files[glbUrl] = sha

const tools = join(cache, "tools")
if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) {
  mkdirSync(tools, { recursive: true })
  await Bun.write(join(tools, "package.json"), '{ "name": "arcade-car-tools", "private": true }\n')
  const p = Bun.spawn(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer"], { cwd: tools, stdout: "inherit", stderr: "inherit" })
  if ((await p.exited) !== 0) throw new Error("tool install failed")
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })

const raw = join(cache, "car.raw.glb")
const log = await run(["blender", "-b", "--factory-startup", "--python", join(import.meta.dir, "build-car.py"), "--", src, raw, join(cache, "tex"), ...(preview ? [preview] : [])])
const line = log.split("\n").find((l) => l.startsWith("CAR "))
if (!line) throw new Error(`no CAR line:\n${log.slice(-3000)}`)
const stats = JSON.parse(line.slice(4))

const doc = await io.read(raw)
for (const m of doc.getRoot().listMaterials()) {
  const kind = (m.getName() as string).replace(/\.\d{3}$/, "")
  const surface = SURFACE[kind]
  if (surface) m.setExtras({ kit: surface })
  // Lamps and reflectors must keep their atlas and stay dielectric: metal zeroes MAT.retro's tint.
  if ((kind === "lens" || kind === "reflector") && (!m.getBaseColorTexture() || m.getMetallicFactor() !== 0))
    throw new Error(`${kind}: base texture ${!!m.getBaseColorTexture()}, metallic ${m.getMetallicFactor()}`)
}
doc.getRoot().getAsset().extras = { car: { licence: "CC BY 4.0", source: `${sources.model} by ${sources.author}, ${sources.source}`, ...stats } }
await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
mkdirSync(outDir, { recursive: true })
const out = join(outDir, "car.glb")
await io.write(out, doc)
const textures = doc.getRoot().listTextures().map((t: any) => ({ name: t.getName(), kb: Math.round(t.getImage().byteLength / 1024), size: t.getSize() }))
console.log(`wrote ${out}`, JSON.stringify({ kb: Math.round(statSync(out).size / 1024), textures, ...stats }))
writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + "\n")
