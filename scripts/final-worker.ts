// Worker-only final comparison against the exact main archive, with browser-only Getaway clock hooks.
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (!process.env.ARCADE_BENCH_WORKER) throw new Error("Run through hivemind")
const root = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "arcade-final-"))
const baseline = join(scratch, "main")
const bench = join(root, "captures/bench/final")
const preview = join(root, "captures/preview/final")
for (const path of [baseline, bench, preview, join(scratch, "scripts"), join(scratch, "perf")]) mkdirSync(path, {recursive:true})
const env = {...process.env, ARCADE_ENCODE_LOCAL:"1", BENCH_DIR:bench, PREVIEW_DIR:preview}
async function run(args: string[], cwd = root) {
  console.log("RUN", args.join(" "))
  const p = Bun.spawn(args, {cwd,env,stdout:"inherit",stderr:"inherit"})
  if (await p.exited) throw new Error(`Failed: ${args.join(" ")}`)
}
function hashes(dir: string, prefix = ""): Record<string,string> {
  const out: Record<string,string> = {}
  for (const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === "build.gen.ts") continue
    const key = prefix + entry.name, path = join(dir,entry.name)
    if (entry.isDirectory()) Object.assign(out, hashes(path,key+"/"))
    else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex")
  }
  return out
}
try {
  const currentHashes = () => Object.fromEntries(["blackout","getaway"].map(game => [game, Object.fromEntries(["src","shared","server"].map(dir=>[dir,hashes(join(root,"games",game,dir))]))]))
  const current = currentHashes()
  await run(["tar","-xf",join(root,"captures/bench/main-source.tar"),"-C",baseline])
  const original = hashes(baseline)
  symlinkSync(join(root, "node_modules"), join(baseline, "node_modules"))
  // Historical Vite hooks use /node_modules URLs relative to each game.
  for (const game of ["blackout", "getaway"]) symlinkSync(join(root, "node_modules"), join(baseline, "games", game, "node_modules"))
  // Same benchmark inputs on main's simulation. The old API has no shared preparation functions.
  let mp = readFileSync(join(root,"scripts/bench-multiplayer.ts"),"utf8")
    .replaceAll('"../games/', `"${baseline}/games/`)
    .replace("buildSnapshot, snapshotEntities", "buildSnapshot")
    .replace("shared ? world.viewBase() : undefined", "undefined")
    .replace("shared ? snapshotEntities(world) : undefined", "undefined")
  const mpPath = join(scratch,"scripts/bench-main.ts")
  writeFileSync(mpPath,mp)
  for (const game of ["blackout","getaway"]) {
    await run(["bun",mpPath,`--game=${game}`,"--experiment=final-main"])
    const name = `${game}-multiplayer-final-main.json`
    writeFileSync(join(root,"perf",name),readFileSync(join(scratch,"perf",name)))
    await run(["bun","scripts/bench-multiplayer.ts",`--game=${game}`,"--experiment=final-integrated"])
  }
  if (!process.argv.includes("--probe")) for (const game of ["blackout","getaway"]) {
    await run(["bun","games/blackout/scripts/bench-worker.ts",`--game=${game}`,`--source-root=${baseline}`,"--experiment=final-main"])
    await run(["bun","games/blackout/scripts/bench-worker.ts",`--game=${game}`,"--monitors=1","--experiment=final-integrated"])
  }
  for (const game of process.argv.includes("--probe") ? ["getaway"] : ["blackout","getaway"]) {
    await run(["bun","games/blackout/scripts/bench-worker.ts",`--game=${game}`,`--source-root=${baseline}`,"--capture","--phase=before"])
    if (!process.argv.includes("--probe")) await run(["bun","games/blackout/scripts/bench-worker.ts",`--game=${game}`,"--capture","--phase=after","--monitors=1","--final-metrics"])
  }
  const final = hashes(baseline)
  const changed = Object.keys(original).filter(key=>original[key] !== final[key])
  if (changed.length) throw new Error(`Baseline files changed: ${changed.join(", ")}`)
  writeFileSync(join(root,"perf/final-baseline-integrity.json"),JSON.stringify({files:Object.keys(original).length,unchanged:true,main:"4495277405cc2e1376500f8090d8e03a4c10320e",hashes:original},null,2)+"\n")
  if (!process.argv.includes("--probe")) for (const game of ["blackout","getaway"]) await run(["bun","run","check"],join(root,"games",game))
  if (JSON.stringify(current) !== JSON.stringify(currentHashes())) throw new Error("Current game source changed during measurement")
  writeFileSync(join(root,"perf/final-source-integrity.json"),JSON.stringify({unchangedDuringRun:true,sha256:createHash("sha256").update(JSON.stringify(current)).digest("hex"),files:current},null,2)+"\n")
} finally { rmSync(scratch,{recursive:true,force:true}) }
