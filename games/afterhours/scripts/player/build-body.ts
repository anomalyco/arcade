// Builds the player's body, public/models/player/janitor.glb (CC0, see public/models/player/CREDITS.md):
//
//   bun scripts/player/build-body.ts
//
// 1. Installs MPFB 2 (MakeHuman for Blender) and unpacks the CC0 MakeHuman system assets it needs (cached in $TMPDIR).
// 2. Runs scripts/player/build-body.py in Blender: a middle-aged man in a work shirt, dark work trousers and work boots,
//    skinned to MPFB's game_engine skeleton (UE-style bone names), hidden skin under the clothes deleted.
// 3. Prunes, dedups and meshopt-compresses the export (quantised geometry; JPEG textures, so no KTX2 set-up needed).
import { existsSync, mkdirSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const cache = join(tmpdir(), "ah-body")
const tools = join(cache, "tools")
const out = join(root, "public/models/player/janitor.glb")
const MPFB = "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip"
const ASSETS = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
const userData = join(homedir(), "Library/Application Support/Blender/5.2/extensions/.user/user_default/mpfb/data")

const run = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${(o + e).slice(-1500)}`)
  return o
}
const download = async (url: string, file: string) => {
  if (existsSync(file) && statSync(file).size > 0) return file
  mkdirSync(cache, { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}

const mpfb = await download(MPFB, join(cache, "mpfb.zip"))
await run(["blender", "--command", "extension", "install-file", "-r", "user_default", "-e", mpfb])
const pack = await download(ASSETS, join(cache, "sys.zip"))
mkdirSync(userData, { recursive: true })
await run(["unzip", "-q", "-o", pack, "clothes/male_casualsuit01/*", "clothes/shoes03/*", "skins/middleage_caucasian_male/*", "hair/short02/*", "-d", userData])

const raw = join(cache, "janitor_raw.glb")
await run(["blender", "-b", "--python", join(import.meta.dir, "build-body.py"), "--", raw])

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
await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
mkdirSync(join(root, "public/models/player"), { recursive: true })
await io.write(out, doc)
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`)
