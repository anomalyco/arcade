// Builds the shared people cast, packages/kit/people/assets/<person>-<look>.glb (CC0; see
// packages/kit/people/assets/CREDITS.md), and the manifest packages/kit/people/cast.gen.ts:
//
//   hivemind run --kind render --fetch packages/kit/people --fetch scripts/people -- bun scripts/people/build-people.ts [a | woods | a-woods ...]
//
// Filters pick people, looks or single person-looks; with none it builds everything.
//
// 1. Downloads MPFB 2 (MakeHuman for Blender) and the CC0 MakeHuman system assets into a cache ($PEOPLE_CACHE or
//    ~/Library/Caches/arcade-people) and installs MPFB into a private Blender user dir there (BLENDER_USER_RESOURCES), so the
//    machine's own Blender set-up is untouched.
// 2. Runs scripts/people/build-person.py in headless Blender for each person's looks in scripts/people/cast.json.
// 3. Sets each material's default tint (baseColorFactor = albedo / MEAN on the luminance textures), alpha modes and
//    `extras.people` (kind, piece, albedo) for the runtime, then prunes, dedups and meshopt-compresses the GLB.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MPFB = "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip"
const ASSETS = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
/** Luminance textures average this per region (build-person.py MEAN). */
const MEAN = 0.72

const root = join(import.meta.dir, "../..")
const cache = process.env.PEOPLE_CACHE ?? join(homedir(), "Library/Caches/arcade-people")
const outDir = join(root, "packages/kit/people/assets")
const castFile = join(import.meta.dir, "cast.json")
const cast = JSON.parse(readFileSync(castFile, "utf8")) as Cast

type Part = { name: string; albedo: number[]; kind?: string; rough?: number }
type Look = { outfit: string; beanie?: { albedo: number[] }; tints?: Record<string, number[]> }
type Person = { id: string; note?: string; hair?: { asset: string; albedo: number[] }; macro?: Record<string, unknown>; looks: Record<string, Look> }
type Cast = { outfits: Record<string, { note?: string; clothes: { asset: string; parts: Part[] }[] }>; people: Person[] }

const run = async (cmd: string[], env?: Record<string, string>) => {
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

const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const jobs = cast.people.flatMap((person) => Object.entries(person.looks).map(([look, spec]) => ({ person, look, spec, id: `${person.id}-${look}` })))
  .filter((j) => !ids.length || ids.some((f) => f === j.id || f === j.person.id || f === j.look))
// --manifest only rewrites the per-look manifests from the GLBs already built.
const manifestOnly = process.argv.includes("--manifest")
if (!jobs.length && !manifestOnly) throw new Error(`no people match ${ids.join(", ")}`)
if (manifestOnly) { writeManifests(); process.exit(0) }

const blenderUser = join(cache, "blender-user")
const env = { BLENDER_USER_RESOURCES: blenderUser }
if (!existsSync(join(blenderUser, "extensions/user_default/mpfb")) && !existsSync(join(blenderUser, "extensions/.user"))) {
  const mpfb = await download(MPFB, join(cache, "mpfb.zip"))
  console.log(await run(["blender", "--command", "extension", "install-file", "-r", "user_default", "-e", mpfb], env))
}
const assets = join(cache, "assets")
if (!existsSync(join(assets, "clothes"))) {
  const pack = await download(ASSETS, join(cache, "sys.zip"))
  await run(["unzip", "-q", "-o", pack, "clothes/*", "hair/*", "skins/*", "eyes/*", "eyebrows/*", "-d", assets])
}

const tools = join(cache, "tools")
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
for (const { person, look, spec, id } of jobs) {
  const raw = join(cache, `${id}.raw.glb`)
  const t0 = performance.now()
  const log = await run(["blender", "-b", "--python", join(import.meta.dir, "build-person.py"), "--", castFile, person.id, look, assets, raw], env)
  const line = log.split("\n").find((l) => l.startsWith("PERSON "))
  if (!line) throw new Error(`no PERSON line:\n${log.slice(-3000)}`)
  const stats = JSON.parse(line.slice(7))
  const doc = await io.read(raw)
  const parts = new Map(cast.outfits[spec.outfit]!.clothes.flatMap((c) => c.parts).map((p) => [p.name, p]))
  const gear = (stats.albedos ?? {}) as Record<string, number[]>
  for (const m of doc.getRoot().listMaterials()) {
    const name: string = m.getName()
    const [kind, piece] = name.includes(".") ? name.split(".") : [name, name]
    let albedo: number[] | null = null
    if (parts.has(piece!)) albedo = spec.tints?.[piece!] ?? parts.get(piece!)!.albedo
    else if (kind === "hair" && person.hair) albedo = spec.tints?.hair ?? person.hair.albedo
    else if (piece === "beanie" && spec.beanie) albedo = spec.tints?.beanie ?? spec.beanie.albedo
    else if (gear[piece!]) albedo = spec.tints?.[piece!] ?? gear[piece!]!
    // Luminance textures average MEAN; untextured gear takes its albedo as is.
    const mean = albedo && m.getBaseColorTexture() ? MEAN : 1
    if (albedo) m.setBaseColorFactor([...albedo.map((c) => Math.min(1, c / mean)), 1])
    if (kind === "hair" || kind === "brow") { m.setAlphaMode("MASK"); m.setAlphaCutoff(kind === "hair" ? 0.4 : 0.3); m.setDoubleSided(true) }
    m.setExtras({ people: { kind, piece, albedo, mean } })
  }
  doc.getRoot().getAsset().extras = { people: { id, person: person.id, look, outfit: spec.outfit, licence: "CC0-1.0", source: "MakeHuman/MPFB 2 + makehuman_system_assets_cc0" } }
  await doc.transform(fn.prune(), fn.dedup(), fn.meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }))
  const out = join(outDir, `${id}.glb`)
  await io.write(out, doc)
  const kb = statSync(out).size / 1024
  report[id] = { kb: Math.round(kb), seconds: Math.round((performance.now() - t0) / 100) / 10, faces: stats.faces }
  console.log(`wrote ${out} (${kb.toFixed(0)} KB)`, JSON.stringify(stats.faces))
}
console.log("REPORT", JSON.stringify(report))

writeManifests()

// One manifest per look (packages/kit/people/cast/<look>.gen.ts) listing its built GLBs, so a game's bundle (Vite
// emits each `new URL` asset) carries only the looks it imports.
function writeManifests() {
  const built = new Set(readdirSync(outDir).filter((f) => f.endsWith(".glb")).map((f) => f.slice(0, -4)))
  const looks = new Set(cast.people.flatMap((p) => Object.keys(p.looks)))
  mkdirSync(join(root, "packages/kit/people/cast"), { recursive: true })
  for (const look of looks) {
    const entries = cast.people.filter((p) => p.looks[look] && built.has(`${p.id}-${look}`)).map((p) =>
      `  { id: "${p.id}-${look}", url: new URL("../assets/${p.id}-${look}.glb", import.meta.url).href, person: "${p.id}", look: "${look}", outfit: "${p.looks[look]!.outfit}" },`)
    const code = [
      "// Generated by scripts/people/build-people.ts from scripts/people/cast.json. Do not edit.",
      'import type { CastMember } from "../view"',
      "",
      `/** The cast in the ${look} look. */`,
      "export const CAST: readonly CastMember[] = [",
      ...entries,
      "]",
      "",
    ]
    writeFileSync(join(root, `packages/kit/people/cast/${look}.gen.ts`), code.join("\n"))
  }
}
