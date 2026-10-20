// Builds the playable roster from the Mixamo sources in mixamo-src/ (gitignored; never commit them):
//
//   bun scripts/playerb/characters.ts [--only louise,kate] [--no-anims]
//
// 1. Blender (scripts/playerb/mixamo.py): every character re-bound to the shared animation skeleton, materials
//    rebuilt for glTF (colour+alpha, normal, ORM with roughness = 1 - gloss), textures ≤ 2K WebP; all clips into one
//    animations glb with root motion handled per clip (meta: ground velocity, rise, one-shot root paths).
// 2. gltf-transform: prune, dedup, resample, meshopt (quantised geometry and animation).
// Output: public/models/characters/<id>.glb, anims.glb, and src/playerb/roster.json (character + clip metadata).
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const src = join(root, "mixamo-src")
const out = join(root, "public/models/characters")
const cache = join(tmpdir(), "ahm")
const tools = join(cache, "tools")
mkdirSync(out, { recursive: true })
mkdirSync(cache, { recursive: true })
const args = process.argv.slice(2)
const oi = args.indexOf("--only")
const only = oi >= 0 ? args[oi + 1]!.split(",") : null

const run = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  if ((await p.exited) !== 0 || /Traceback/.test(o + e)) throw new Error(`${cmd.join(" ")} failed:\n${(o + e).slice(-3000)}`)
  return o
}
if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) {
  mkdirSync(tools, { recursive: true })
  await Bun.write(join(tools, "package.json"), '{ "name": "ahm-tools", "private": true }\n')
  await run(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer"], tools)
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })
const py = join(import.meta.dir, "mixamo.py")

async function optimise(raw: string, dest: string) {
  const doc = await io.read(raw)
  await doc.transform(fn.prune(), fn.dedup(), fn.resample(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
  await io.write(dest, doc)
  return statSync(dest).size
}

const roster: { characters: Record<string, unknown>; anims?: unknown } = existsSync(join(root, "src/playerb/roster.json")) ? await Bun.file(join(root, "src/playerb/roster.json")).json() : { characters: {} }
if (!args.includes("--no-anims")) {
  const raw = join(cache, "anims.glb")
  const meta = join(cache, "anims.json")
  await run(["blender", "-b", "--python", py, "--", "anims", join(src, "anims"), raw, meta])
  const size = await optimise(raw, join(out, "anims.glb"))
  roster.anims = await Bun.file(meta).json()
  console.log(`anims.glb ${(size / 1e6).toFixed(2)} MB`)
}
const ref = join(src, "anims", "walking.fbx")
for (const f of readdirSync(join(src, "characters")).filter((f) => f.endsWith(".fbx") && !f.startsWith("npc-"))) {
  const id = f.replace(/\.fbx$/, "").toLowerCase()
  if (only && !only.includes(id)) continue
  const raw = join(cache, `${id}.glb`)
  const meta = join(cache, `${id}.json`)
  await run(["blender", "-b", "--python", py, "--", "character", join(src, "characters", f), ref, raw, meta])
  const size = await optimise(raw, join(out, `${id}.glb`))
  roster.characters[id] = { ...(await Bun.file(meta).json()), name: f.replace(/\.fbx$/, ""), bytes: size }
  console.log(`${id}.glb ${(size / 1e6).toFixed(2)} MB`)
}
await Bun.write(join(root, "src/playerb/roster.json"), JSON.stringify(roster, null, 1) + "\n")
// The same metadata next to the models, for any consumer (format: docs in scripts/playerb/CLIPS.md).
await Bun.write(join(out, "roster.json"), JSON.stringify(roster, null, 1) + "\n")
