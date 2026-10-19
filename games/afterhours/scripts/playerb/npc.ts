// Builds the NPC corpses from the Mixamo sources in mixamo-src/ (gitignored; the outputs are too: never commit them):
//
//   bun scripts/playerb/npc.ts [--only joe,brian]
//
// 1. Blender (scripts/playerb/mixamo.py poses): every death-*.fbx's last frame with its root motion collapsed, plus
//    the authored "slump-chair" pose → public/models/npc/poses.glb (one-frame clips) and the Blender bases.
// 2. Blender (mixamo.py character): each characters/npc-<name>.fbx with the player pipeline's fixes (shared
//    skeleton, metres, Y-up, texture channels), 1984 shoe tints, and per pose the floor offset of this character.
// 3. gltf-transform meshopt. Output: public/models/npc/<name>.glb, poses.glb, npc.json. Loader: src/world/npc/corpse.ts.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const src = join(root, "mixamo-src")
const out = join(root, "public/models/npc")
const cache = join(tmpdir(), "ahm")
const tools = join(cache, "tools")
mkdirSync(out, { recursive: true })
const args = process.argv.slice(2)
const oi = args.indexOf("--only")
const only = oi >= 0 ? args[oi + 1]!.split(",") : null
// Display-space RGB for the shoes (they share the body atlas; only their UV islands are recoloured).
const TINT = {
  "npc-elizabeth": { heel: [0.2, 0.13, 0.11] }, // red heels → dark oxblood/brown
  "npc-brian": { sneaker: [0.3, 0.31, 0.33] }, // white sneakers → worn grey canvas
}

const run = async (cmd: string[], env?: Record<string, string>) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  if ((await p.exited) !== 0 || /Traceback/.test(o + e)) throw new Error(`${cmd.join(" ")} failed:\n${(o + e).slice(-3000)}`)
  return o
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) throw new Error("run scripts/playerb/characters.ts once first (installs gltf-transform)")
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })
const optimise = async (raw: string, dest: string) => {
  const doc = await io.read(raw)
  await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
  await io.write(dest, doc)
  return statSync(dest).size
}
const py = join(import.meta.dir, "mixamo.py")
const posesJson = join(cache, "poses.json")
await run(["blender", "-b", "--python", py, "--", "poses", join(src, "anims"), join(src, "anims", "walking.fbx"), join(cache, "poses.glb"), posesJson])
await optimise(join(cache, "poses.glb"), join(out, "poses.glb"))
const P = (await Bun.file(posesJson).json()) as { poses: Record<string, Record<string, unknown>> }
const meta: { poses: Record<string, unknown>; characters: Record<string, unknown> } = existsSync(join(out, "npc.json")) ? await Bun.file(join(out, "npc.json")).json() : { poses: {}, characters: {} }
meta.poses = Object.fromEntries(Object.entries(P.poses).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== "rot" && f !== "hips"))]))
for (const f of readdirSync(join(src, "characters")).filter((f) => /^npc-.*\.fbx$/.test(f))) {
  const id = f.replace(/^npc-|\.fbx$/g, "")
  if (only && !only.includes(id)) continue
  const raw = join(cache, `npc-${id}.glb`)
  const mj = join(cache, `npc-${id}.json`)
  await run(["blender", "-b", "--python", py, "--", "character", join(src, "characters", f), join(src, "anims", "walking.fbx"), raw, mj, posesJson], { TINT: JSON.stringify(TINT) })
  const size = await optimise(raw, join(out, `${id}.glb`))
  const m = await Bun.file(mj).json()
  meta.characters[id] = { height: m.height, hips: m.hips, hipRatio: m.hipRatio, poses: m.poses, bytes: size }
  console.log(`${id}.glb ${(size / 1e6).toFixed(2)} MB`)
}
await Bun.write(join(out, "npc.json"), JSON.stringify(meta, null, 1) + "\n")
