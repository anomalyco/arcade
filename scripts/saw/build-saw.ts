// Builds TIMBER's chainsaw, games/timber/public/saw/saw.glb, from Lassi Kaukonen's photogrammetry scan "Chainsaw"
// (CC BY 4.0; see games/timber/CREDITS.md):
//
//   bun scripts/saw/build-saw.ts [--preview <dir>] [--quick]
//
// 1. Downloads the scan and its Objaverse metadata into a cache ($SAW_CACHE or ~/Library/Caches/arcade-saw), refuses
//    any licence but CC BY, and checks the GLB against the SHA-256 in games/timber/public/saw/sources.json (a new file
//    is recorded; a changed one fails).
// 2. Runs scripts/saw/build-saw.py in headless Blender: the scan's powerhead decimated and repainted from its own
//    bakes, a made bar, chain, starter grip and cord, the gloves and sleeves, LOD1 for third person, WebP maps.
// 3. Prunes, dedups and meshopt-compresses the GLB (the tools build-car.ts uses), and writes the build's triangle
//    counts and landmarks into `asset.extras.saw`, which the game reads.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

const UID = "052d0c1d5e6f48358dc89d6cefe45a38"
const OBJAVERSE = "https://huggingface.co/datasets/allenai/objaverse/resolve/main"
const SHARD = "000-089"

const root = join(import.meta.dir, "../..")
const cache = process.env.SAW_CACHE ?? join(homedir(), "Library/Caches/arcade-saw")
const outDir = join(root, "games/timber/public/saw")
const sourcesFile = join(outDir, "sources.json")
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const preview = arg("--preview")
const quick = process.argv.includes("--quick")

const run = async (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
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
const src = await download(glbUrl, join(cache, "chainsaw-scan.glb"))
const meta = JSON.parse(gunzipSync(readFileSync(await download(`${OBJAVERSE}/metadata/${SHARD}.json.gz`, join(cache, `meta-${SHARD}.json.gz`)))).toString())[UID]
if (meta?.license !== "by") throw new Error(`Unexpected licence for ${UID}: ${meta?.license}`)
const sha = createHash("sha256").update(readFileSync(src)).digest("hex")
type Sources = { licence: string; model: string; author: string; source: string; files: Record<string, string> }
const sources: Sources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, "utf8")) : {
  licence: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
  model: meta.name,
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
  await Bun.write(join(tools, "package.json"), '{ "name": "arcade-saw-tools", "private": true }\n')
  const p = Bun.spawn(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer"], { cwd: tools, stdout: "inherit", stderr: "inherit" })
  if ((await p.exited) !== 0) throw new Error("tool install failed")
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })

const raw = join(cache, "saw.raw.glb")
const log = await run(["blender", "-b", "--factory-startup", "--python", join(import.meta.dir, "build-saw.py"), "--", src, raw, join(cache, "tex"), ...(preview ? [preview] : [])], quick ? { SAW_QUICK: "1" } : {})
const line = log.split("\n").find((l) => l.startsWith("SAW "))
if (!line) throw new Error(`no SAW line:\n${log.slice(-3000)}`)
const stats = JSON.parse(line.slice(4))

const doc = await io.read(raw)
doc.getRoot().getAsset().extras = { saw: { licence: "CC BY 4.0", source: `${sources.model} by ${sources.author}, ${sources.source}`, ...stats } }
await doc.transform(fn.prune({ keepAttributes: true }), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
mkdirSync(outDir, { recursive: true })
const out = join(outDir, "saw.glb")
await io.write(out, doc)
const textures = doc.getRoot().listTextures().map((t: any) => ({ name: t.getName(), kb: Math.round(t.getImage().byteLength / 1024), size: t.getSize() }))
console.log(`wrote ${out}`, JSON.stringify({ kb: Math.round(statSync(out).size / 1024), textures, ...stats }))
writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + "\n")
