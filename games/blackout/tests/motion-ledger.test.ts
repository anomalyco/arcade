import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeMotionLedger } from "../../../scripts/motion/ledger"

test("ledger increases are printed and refused without acceptance; partial refresh preserves other tapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "motion-ledger-")), file = join(dir, "baseline.json")
  try {
    writeMotionLedger(file, { walk: { velocity: 2 }, run: { velocity: 4 } })
    const before = readFileSync(file, "utf8")
    expect(() => writeMotionLedger(file, { walk: { velocity: 3 } })).toThrow("--accept-regression")
    expect(readFileSync(file, "utf8")).toBe(before)
    writeMotionLedger(file, { walk: { velocity: 1 } })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ walk: { velocity: 1 }, run: { velocity: 4 } })
    expect(() => writeMotionLedger(file, { walk: {} })).toThrow("removed")
    expect(() => writeMotionLedger(file, { walk: { velocity: Infinity } }, true)).toThrow("Invalid ledger")
    writeMotionLedger(file, { walk: { velocity: 3 } }, true)
    expect(JSON.parse(readFileSync(file, "utf8")).walk.velocity).toBe(3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
