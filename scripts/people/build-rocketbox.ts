// Builds the Rocketbox people, packages/kit/people/assets/<id>-rocketbox.glb (MIT, Microsoft; see
// packages/kit/people/assets/CREDITS.md), and their manifest, packages/kit/people/cast/rocketbox.gen.ts (CAST):
//
//   bun scripts/people/build-rocketbox.ts [m05 | f04 ...]
//
// 1. Downloads each avatar's FBX and source TGAs from github.com/microsoft/Microsoft-Rocketbox at a pinned commit into
//    a cache ($PEOPLE_CACHE or ~/Library/Caches/arcade-people/rocketbox), checked against the SHA-256s recorded in
//    packages/kit/people/assets/rocketbox-sources.json (a new file is recorded; a changed one fails).
// 2. Runs scripts/people/build-rocketbox.py in headless Blender: game_engine bone names, kinds, LOD1, WebP textures.
// 3. Writes `extras.people` (kind, piece) per material, alpha-tests the hair cards, then prunes, dedups and
//    meshopt-compresses the GLB with the same tools as scripts/people/build-people.ts.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const COMMIT = "0943055db6ec570bcef9f2c8b41c9e5467c808f9"
const RAW = `https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/${COMMIT}/Assets/Avatars`
/** Texture size (px) for every map; the sources are 2048. */
const PX = 1024

/** `tag` is the avatar's texture prefix in its Textures folder. */
const AVATARS = [
  { id: "m05", avatar: "Adults/Male_Adult_05", tag: "m009", outfit: "field vest over a long-sleeved shirt, work trousers, boots" },
  { id: "f04", avatar: "Adults/Female_Adult_04", tag: "f004", outfit: "hooded leather jacket, cargo trousers, boots" },
] as const

const root = join(import.meta.dir, "../..")
const cache = join(process.env.PEOPLE_CACHE ?? join(homedir(), "Library/Caches/arcade-people"), "rocketbox")
const outDir = join(root, "packages/kit/people/assets")
const sourcesFile = join(outDir, "rocketbox-sources.json")
type Sources = { licence: string; repository: string; commit: string; files: Record<string, string> }
const sources: Sources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, "utf8"))
  : { licence: "MIT (https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md)", repository: "https://github.com/microsoft/Microsoft-Rocketbox", commit: COMMIT, files: {} }
if (sources.commit !== COMMIT) throw new Error(`${sourcesFile} is for commit ${sources.commit}, not ${COMMIT}`)
/** Downloads `path` (under Assets/Avatars) and checks or records its SHA-256. */
const fetchSource = async (path: string, file: string) => {
  await download(`${RAW}/${path}`, file)
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex")
  const want = sources.files[path]
  if (want && want !== sha) throw new Error(`${path}: SHA-256 ${sha}, recorded ${want}`)
  sources.files[path] = sha
}

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

const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const jobs = AVATARS.filter((a) => !ids.length || ids.includes(a.id))
if (!jobs.length) throw new Error(`no Rocketbox avatars match ${ids.join(", ")}`)

const tools = join(cache, "..", "tools")
if (!existsSync(join(tools, "node_modules/@gltf-transform/functions"))) {
  mkdirSync(tools, { recursive: true })
  await Bun.write(join(tools, "package.json"), '{ "name": "arcade-people-tools", "private": true }\n')
  const p = Bun.spawn(["bun", "add", "@gltf-transform/core@4", "@gltf-transform/extensions@4", "@gltf-transform/functions@4", "meshoptimizer"], { cwd: tools, stdout: "inherit", stderr: "inherit" })
  if ((await p.exited) !== 0) throw new Error("tool install failed")
}
const mod = (name: string) => import(join(tools, "node_modules", name)) as Promise<any>
const [core, ext, fn, mo] = await Promise.all([mod("@gltf-transform/core"), mod("@gltf-transform/extensions"), mod("@gltf-transform/functions"), mod("meshoptimizer")])
await Promise.all([mo.MeshoptEncoder.ready, mo.MeshoptDecoder.ready])
const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": mo.MeshoptEncoder, "meshopt.decoder": mo.MeshoptDecoder })

mkdirSync(outDir, { recursive: true })
const report: Record<string, unknown> = {}
for (const a of jobs) {
  const name = a.avatar.split("/").pop()!
  const dir = join(cache, name)
  await fetchSource(`${a.avatar}/Export/${name}.fbx`, join(dir, "Export", `${name}.fbx`))
  const maps = ["body_color", "body_normal", "head_color", "head_normal", "opacity_color"]
  await Promise.all(maps.map((m) => fetchSource(`${a.avatar}/Textures/${a.tag}_${m}.tga`, join(dir, "Textures", `${a.tag}_${m}.tga`))))
  const raw = join(cache, `${a.id}.raw.glb`)
  const log = await run(["blender", "-b", "--factory-startup", "--python", join(import.meta.dir, "build-rocketbox.py"), "--", dir, raw, String(PX)])
  const line = log.split("\n").find((l) => l.startsWith("PERSON "))
  if (!line) throw new Error(`no PERSON line:\n${log.slice(-3000)}`)
  const stats = JSON.parse(line.slice(7))
  stats.loose = Number(log.match(/^LOOSE (\d+)/m)?.[1] ?? 0)
  const doc = await io.read(raw)
  for (const m of doc.getRoot().listMaterials()) {
    const [kind, piece] = (m.getName() as string).split(".")
    m.setBaseColorFactor([1, 1, 1, 1])
    m.setMetallicFactor(0)
    if (kind === "hair") { m.setAlphaMode("MASK"); m.setAlphaCutoff(0.4); m.setDoubleSided(true) }
    m.setExtras({ people: { kind, piece, albedo: null, mean: 1 } })
  }
  doc.getRoot().getAsset().extras = { people: { id: `${a.id}-rocketbox`, person: a.id, look: "rocketbox", outfit: a.outfit, licence: "MIT", source: `Microsoft Rocketbox ${a.avatar} @ ${COMMIT.slice(0, 7)}` } }
  await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
  const out = join(outDir, `${a.id}-rocketbox.glb`)
  await io.write(out, doc)
  const textures = doc.getRoot().listTextures().reduce((s: number, t: any) => s + t.getImage().byteLength, 0)
  report[a.id] = { kb: Math.round(statSync(out).size / 1024), textureKb: Math.round(textures / 1024), ...stats }
  console.log(`wrote ${out}`, JSON.stringify(report[a.id]))
}
console.log("REPORT", JSON.stringify(report))
sources.files = Object.fromEntries(Object.entries(sources.files).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + "\n")

const entries = AVATARS.filter((a) => existsSync(join(outDir, `${a.id}-rocketbox.glb`))).map((a) =>
  `  { id: "${a.id}-rocketbox", url: new URL("../assets/${a.id}-rocketbox.glb", import.meta.url).href, person: "${a.id}", look: "rocketbox", outfit: "${a.outfit}" },`)
writeFileSync(join(root, "packages/kit/people/cast/rocketbox.gen.ts"), [
  "// Generated by scripts/people/build-rocketbox.ts. Do not edit.",
  'import type { CastMember } from "../view"',
  "",
  "/** Microsoft Rocketbox avatars (MIT) on the people rig: an alternative cast to the MakeHuman looks. */",
  "export const CAST: readonly CastMember[] = [",
  ...entries,
  "]",
  "",
].join("\n"))
