import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildArchitectureMapTable,
  collectGameSharedImports,
  findUnclassifiedSharedImports,
  replaceArchitectureMapBlock,
} from "../packages/kit/architecture-map"

const repoRoot = resolve(import.meta.dir, "..")
const archDocPath = resolve(repoRoot, "docs/architecture.md")
const writeMode = process.argv.includes("--write")

const gameImports = collectGameSharedImports(repoRoot)
const unclassified = findUnclassifiedSharedImports(gameImports)
if (unclassified.length > 0) {
  console.error(
    `Unclassified @arcade/kit imports found: ${unclassified.join(", ")}.\nUpdate ARCHITECTURE_MAP_ROWS in packages/kit/architecture-map.ts.`,
  )
  process.exit(1)
}

const table = buildArchitectureMapTable(repoRoot)
const currentMarkdown = readFileSync(archDocPath, "utf8")
const expectedMarkdown = replaceArchitectureMapBlock(currentMarkdown, table)

if (writeMode) {
  if (currentMarkdown !== expectedMarkdown) {
    writeFileSync(archDocPath, expectedMarkdown, "utf8")
    console.log("Updated shared module table in docs/architecture.md")
  } else {
    console.log("docs/architecture.md shared module table is already up to date")
  }
  process.exit(0)
}

if (currentMarkdown !== expectedMarkdown) {
  console.error(
    "docs/architecture.md shared module table is out of date. Run: bun scripts/architecture-map.ts --write",
  )
  process.exit(1)
}

console.log("docs/architecture.md shared module table is up to date")
