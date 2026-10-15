import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildArchitectureMapTable,
  collectGameSharedImports,
  findUnclassifiedSharedImports,
  replaceArchitectureMapBlock,
} from "./architecture-map"

const repoRoot = resolve(import.meta.dir, "../..")
const archDocPath = resolve(repoRoot, "docs/architecture.md")

describe("architecture map table", () => {
  test("classifies every @arcade/kit and @arcade/knobs import across games", () => {
    const imports = collectGameSharedImports(repoRoot)
    expect(findUnclassifiedSharedImports(imports)).toEqual([])
  })

  test("keeps docs/architecture.md shared module table in sync with game imports", () => {
    if (!existsSync(archDocPath)) return
    const current = readFileSync(archDocPath, "utf8")
    const table = buildArchitectureMapTable(repoRoot)
    const expected = replaceArchitectureMapBlock(current, table)
    expect(current).toBe(expected)
  })
})
