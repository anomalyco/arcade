// Previews the station → scene migration (AR-25): writes the scene and collection files that would go under
// games/lab/scenes/, plus the migration notes, into an output folder (default captures/scenes-preview).
//   bun games/lab/scripts/stations-to-scenes.ts [--out <dir>]
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { sceneJson } from "@arcade/kit/lab/scenes/model"
import { repoPath } from "@arcade/kit/lab/scenes/store"
import { validateStations, type LabStation } from "@arcade/kit/lab/stations/types"
import { migrateStations } from "../src/scenes/from-stations"

const root = resolve(import.meta.dir, "../../..")
const at = process.argv.indexOf("--out")
const out = resolve(root, at > 0 ? process.argv[at + 1]! : "captures/scenes-preview")
const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations: LabStation[] = await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))
const problems = validateStations(stations)
if (problems.length) throw new Error(problems.join("\n"))

const { collections, scenes, notes } = migrateStations(stations, new Date().toISOString())
for (const c of collections) {
  mkdirSync(join(out, "games/lab/scenes", c.id), { recursive: true })
  writeFileSync(join(out, "games/lab/scenes", c.id, "collection.json"), `${JSON.stringify(c, null, 2)}\n`)
}
for (const s of scenes) writeFileSync(join(out, repoPath(s)), sceneJson(s))
writeFileSync(join(out, "notes.md"), `# Station migration notes\n\n${notes.map(n => `- ${n}`).join("\n")}\n`)
console.log(`${stations.length} stations → ${scenes.length} scenes in ${collections.length} collections (${notes.length} notes) → ${out}`)
