/** Source and generated-shader pins against the experiment's original main revision. */
import { createHash } from "node:crypto"
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { OCEAN_WGSL } from "../games/carrier/src/render/ocean-shader"

const base = "52e5b830add6861c4639b06ad1747d0e8ac92549"
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args])
  if (result.exitCode) throw Error(result.stderr.toString())
  return result.stdout.toString()
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const tokens = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "")
const original = git("show", `${base}:games/carrier/src/render/ocean-shader.ts`)
const temporary = resolve("games/carrier/src/render/.water-baseline-shader.ts")
writeFileSync(temporary, original, { flag: "wx" })
let before: string
try { before = (await import(temporary)).OCEAN_WGSL as string }
finally { unlinkSync(temporary) }
if (tokens(before) !== tokens(OCEAN_WGSL)) throw Error("Today ocean shader changed")

// Compare inherited source to the current main ancestor; keep the original shader/sea pins above.
const sourceBase = git("merge-base", "HEAD", "origin/main").trim()
const paths = ["packages/kit", "packages/knobs", "games/getaway", "games/blackout", "games/outbreak", "games/brawl", "games/archers", "games/lot", "games/nightshift", "games/carrier/shared", "package.json", "bun.lock"]
// The architecture catalogue is build-time documentation metadata, never a renderer dependency.
const changed = git("diff", sourceBase, "--name-only", "--", ...paths, ":(exclude)packages/kit/water/**", ":(exclude)packages/kit/architecture-map.ts").trim()
if (changed) throw Error(`Default source pins changed:\n${changed}`)
const sea = "games/carrier/shared/sea.ts"
const seaHash = hash(await Bun.file(sea).text())
if (seaHash !== hash(git("show", `${base}:${sea}`))) throw Error("Authoritative sea changed")
const report = {
  base,
  sourceBase,
  todayShader: { identicalTokens: true, sha256: hash(tokens(OCEAN_WGSL)), originalBytes: before.length, currentBytes: OCEAN_WGSL.length },
  sea: { unchanged: true, sha256: seaHash },
  pinned: paths.map(path => ({ path, baseTree: git("rev-parse", `${sourceBase}:${path}`).trim() })),
  scope: "Source pins plus identical generated Today WGSL tokens. This is not an image or bundle-hash parity claim.",
  exclusions: ["packages/kit/water/** (new opt-in module)", "packages/kit/architecture-map.ts (documentation catalogue)"],
}
mkdirSync("captures/water", { recursive: true })
await Bun.write("captures/water/pins.json", JSON.stringify(report, null, 2))
console.log("Today WGSL and sea match original main; other-game source matches the current main ancestor.")
