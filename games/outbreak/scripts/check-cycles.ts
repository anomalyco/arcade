// Fails when Outbreak's own modules (shared/, src/, server/) import each other in a cycle, type imports included.
// Features import the types seam (shared/types.ts) and register with the feature registries instead of importing
// coop-sim or main.ts, so a cycle means a feature reached back into a composition root.
//
//   bun scripts/check-cycles.ts            list cycles and exit 1 if any
//   bun scripts/check-cycles.ts --max <n>  ratchet while cycles are being removed: fail only when more than n modules
//                                          sit in cycles (lower n as they go; drop the flag at zero)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const DIRS = ["shared", "src", "server"]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !name.includes(".test.")) out.push(path)
  }
  return out
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g

const files = DIRS.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : []))
const known = new Set(files)
const graph = new Map<string, string[]>()
for (const file of files) {
  const source = readFileSync(file, "utf8")
  const edges = new Set<string>()
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]!
    if (!spec.startsWith(".")) continue
    const target = resolveImport(file, spec)
    if (target && known.has(target)) edges.add(target)
  }
  graph.set(file, [...edges])
}

// Tarjan's strongly connected components; every component with more than one module is a cycle.
let index = 0
const indices = new Map<string, number>()
const low = new Map<string, number>()
const stack: string[] = []
const onStack = new Set<string>()
const cycles: string[][] = []
function connect(node: string): void {
  indices.set(node, index)
  low.set(node, index)
  index++
  stack.push(node)
  onStack.add(node)
  for (const next of graph.get(node)!) {
    if (!indices.has(next)) {
      connect(next)
      low.set(node, Math.min(low.get(node)!, low.get(next)!))
    } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!))
  }
  if (low.get(node) !== indices.get(node)) return
  const component: string[] = []
  let member: string
  do {
    member = stack.pop()!
    onStack.delete(member)
    component.push(member)
  } while (member !== node)
  if (component.length > 1) cycles.push(component)
}
for (const file of files) if (!indices.has(file)) connect(file)

/** One concrete loop through a component, for a readable report. */
function loop(component: string[]): string[] {
  const members = new Set(component)
  const start = component.sort()[0]!
  const previous = new Map<string, string>([[start, ""]])
  const queue = [start]
  while (queue.length) {
    const node = queue.shift()!
    for (const next of graph.get(node)!) {
      if (!members.has(next)) continue
      if (next === start) {
        const path = [node]
        while (path[0] !== start) path.unshift(previous.get(path[0]!)!)
        return [...path, start]
      }
      if (!previous.has(next)) {
        previous.set(next, node)
        queue.push(next)
      }
    }
  }
  return component
}

const argv = process.argv.slice(2)
const max = argv.includes("--max") ? Number(argv[argv.indexOf("--max") + 1]) : 0
const inCycles = cycles.reduce((n, c) => n + c.length, 0)
const name = (file: string) => relative(root, file)
if (cycles.length === 0) {
  console.log(`check-cycles: no import cycles across ${files.length} Outbreak modules`)
} else if (inCycles <= max) {
  console.log(`check-cycles: ${cycles.length} cycle(s), ${inCycles} modules in cycles (budget ${max}; lower it as cycles go)`)
} else {
  for (const component of cycles) {
    console.error(`cycle (${component.length} modules): ${loop(component).map(name).join(" → ")}`)
    if (component.length > 2) console.error(`  members: ${component.map(name).sort().join(", ")}`)
  }
  console.error(
    `check-cycles: ${cycles.length} import cycle(s), ${inCycles} modules in cycles (budget ${max}). Features import ` +
      `types from shared/types.ts and register with the feature registries; they never import coop-sim or main.ts.`,
  )
}
process.exit(inCycles <= max ? 0 : 1)
