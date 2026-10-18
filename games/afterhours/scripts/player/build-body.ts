// Builds the player's body, public/models/player/janitor.glb (CC0, see public/models/player/CREDITS.md):
//
//   bun scripts/player/build-body.ts
//
// 1. Installs MPFB 2 (MakeHuman for Blender) and unpacks the CC0 MakeHuman system assets it needs (cached in $TMPDIR).
// 2. Runs scripts/player/build-body.py in Blender: a middle-aged man in a work shirt, dark work trousers and work boots,
//    skinned to MPFB's game_engine skeleton (UE-style bone names), hidden skin under the clothes deleted.
// 3. Moves it onto the Quaternius Universal Animation Library skeleton's rest frames (scripts/player/rebind.ts) and
//    copies UAL 1 Standard clips verbatim (idle, walk, jog, sprint, crouch idle/walk, jump start/loop/land, interact,
//    torch idle): no retargeting. Backpedal plays the forward loops
//    in reverse and strafes come from orientation warping (src/player/body.ts), so no side/back clips are needed.
// 4. Prunes, dedups and meshopt-compresses the export (quantised geometry; JPEG textures, so no KTX2 set-up needed).
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { rebind } from "./rebind"
import { bakeMocap, type MocapClip } from "./mocap"

/** Cuts from the 100STYLE "Neutral" takes (straight, steady windows found by scanning hip travel). */
const MOCAP: MocapClip[] = [
  { name: "walk", file: "Neutral_FW.bvh", from: 8.0, to: 11.4, cycles: 1 },
  { name: "walk_back", file: "Neutral_BW.bvh", from: 17.6, to: 20.1, cycles: 1 },
  // The side-walk take steps to the actor's right; the left strafe is the same cycle mirrored.
  { name: "strafe_r", file: "Neutral_SW.bvh", from: 82.2, to: 84.7, cycles: 1 },
  { name: "strafe_l", file: "Neutral_SW.bvh", from: 82.2, to: 84.7, cycles: 1, mirror: true },
  { name: "idle", file: "Neutral_ID.bvh", from: 12, to: 18, cycles: 0, still: true },
]

/**
 * Downloads only the Neutral takes from the 1.4 GB 100STYLE zip on Zenodo (HTTP range requests on the zip's central
 * directory), into `dir`.
 */
async function fetch100Style(dir: string) {
  if (existsSync(join(dir, "Neutral_FW.bvh"))) return
  mkdirSync(dir, { recursive: true })
  await run(["python3", join(import.meta.dir, "fetch-100style.py"), dir])
}

const root = join(import.meta.dir, "../..")
const cache = join(tmpdir(), "ah-body")
const tools = join(cache, "tools")
const out = join(root, "public/models/player/janitor.glb")
const MPFB = "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip"
const ASSETS = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
const UAL1 = "https://raw.githubusercontent.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender/HEAD/Universal%20Animation%20Library%5BStandard%5D/Universal%20Animation%20Library%5BStandard%5D/Unreal-Godot/UAL1_Standard.glb"
const userData = join(homedir(), "Library/Application Support/Blender/5.2/extensions/.user/user_default/mpfb/data")

const run = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${(o + e).slice(-1500)}`)
  return o
}
const download = async (url: string, file: string) => {
  if (existsSync(file) && statSync(file).size > 0) return file
  mkdirSync(join(file, ".."), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}

const clipsOnly = process.argv.includes("--clips") && existsSync(join(cache, "janitor_raw.glb"))
const mpfb = clipsOnly ? "" : await download(MPFB, join(cache, "mpfb.zip"))
if (!clipsOnly) {
  await run(["blender", "--command", "extension", "install-file", "-r", "user_default", "-e", mpfb])
  const pack = await download(ASSETS, join(cache, "sys.zip"))
  mkdirSync(userData, { recursive: true })
  await run(["unzip", "-q", "-o", pack, "clothes/male_casualsuit01/*", "clothes/shoes03/*", "skins/middleage_caucasian_male/*", "hair/short02/*", "-d", userData])
}

const raw = join(cache, "janitor_raw.glb")
// `--clips`: reuse the cached Blender export and only redo the animation step.
if (!process.argv.includes("--clips") || !existsSync(raw)) await run(["blender", "-b", "--python", join(import.meta.dir, "build-body.py"), "--", raw])

if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) {
  mkdirSync(tools, { recursive: true })
  await Bun.write(join(tools, "package.json"), '{ "name": "ah-body-tools", "private": true }\n')
  await run(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer"], tools)
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })
const doc = await io.read(raw)
const ual = await io.read(await download(UAL1, join(cache, "UAL1.glb")))
rebind(doc, ual, [
  { name: "idle", clip: "Idle_Loop" },
  { name: "walk", clip: "Walk_Loop" },
  { name: "jog", clip: "Jog_Fwd_Loop" },
  { name: "sprint", clip: "Sprint_Loop" },
  { name: "crouch_idle", clip: "Crouch_Idle_Loop" },
  { name: "crouch_walk", clip: "Crouch_Fwd_Loop" },
  { name: "jump_start", clip: "Jump_Start" },
  { name: "jump_air", clip: "Jump_Loop" },
  { name: "jump_land", clip: "Jump_Land" },
  { name: "interact", clip: "Interact" },
  // UAL holds its torch in the left hand; mirrored, the right hand holds it (authored grip and arm).
  { name: "torch", clip: "Idle_Torch_Loop", fingers: "clip", mirror: true },
])
// Locomotion from real motion capture (100STYLE, CC BY 4.0), overriding the UAL loops of the same names.
for (const a of doc.getRoot().listAnimations()) if (MOCAP.some((m) => m.name === a.getName())) a.dispose()
const styleDir = join(cache, "100style")
await fetch100Style(styleDir)
bakeMocap(doc, styleDir, MOCAP, (f) => readFileSync(f, "utf8"))
await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
mkdirSync(join(root, "public/models/player"), { recursive: true })
await io.write(out, doc)
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`)
