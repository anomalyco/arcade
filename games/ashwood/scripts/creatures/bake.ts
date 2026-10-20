// Bakes a procedural creature to public/models/monsters/<name>.bin.
//
//   bun scripts/creatures/bake.ts wendigo
import { mkdirSync, writeFileSync } from "node:fs"
import { encodeCreature } from "../../src/creatures/kit/format"
import { generateWendigo } from "../../src/creatures/wendigo/build"

const name = process.argv[2] ?? "wendigo"
const gens = { wendigo: generateWendigo }
const gen = gens[name as keyof typeof gens]
if (!gen) throw new Error(`unknown creature ${name}`)
const t = performance.now()
const data = gen((s) => console.log(s))
const out = `${import.meta.dir}/../../public/models/monsters`
mkdirSync(out, { recursive: true })
const bytes = encodeCreature(data)
writeFileSync(`${out}/${name}.bin`, bytes)
console.log(`${name}: ${data.positions.length / 3} vertices, ${data.indices.length / 3} triangles, ${data.bones.length} bones, ${(bytes.length / 1e6).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)} s`)
