import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve, dirname, join, relative } from "node:path"
import ts from "typescript"

const root = resolve(import.meta.dir, "..")
const graph = new Map<string, string[]>()
for (const dir of ["src", "shared", "server"]) {
  for (const entry of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).map(String).filter(p => p.endsWith(".ts"))) {
    const file = join(root, dir, entry)
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true).importedFiles
    graph.set(file, imports.flatMap(({ fileName }) => {
      if (!fileName.startsWith(".")) return []
      const base = resolve(dirname(file), fileName.replace(/\.js$/, ""))
      const target = [base, base + ".ts", join(base, "index.ts")].find(existsSync)
      return target ? [target] : []
    }))
  }
}
const done = new Set<string>()
function visit(file: string, path: string[]) {
  if (path.includes(file)) throw new Error(`Import cycle: ${[...path, file].map(p => relative(root, p)).join(" → ")}`)
  if (done.has(file)) return
  for (const next of graph.get(file) ?? []) visit(next, [...path, file])
  done.add(file)
}
for (const file of graph.keys()) visit(file, [])
console.log(`check-cycles: no import cycles across ${graph.size} Nightshift modules`)
