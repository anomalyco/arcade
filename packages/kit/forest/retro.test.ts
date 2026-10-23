import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeSceneShader } from "../gpu/shaders"
import { MAT } from "../gpu/mesh"
import { batchHooks, RETRO_MAX, retroGain } from "./shaders"

/** The observation angle (rad) for a torch `offset` m from the eye lighting a surface `d` m away. */
const seen = (offset: number, d: number) => Math.atan2(offset, d)

test("retroreflective sheeting returns your own torch, more so from farther off, and never a flare beside it", () => {
  // A torch in your hand ~0.35 m from your eye.
  const near = retroGain(4, seen(0.35, 1.5)), mid = retroGain(4, seen(0.35, 4)), far = retroGain(4, seen(0.35, 15))
  expect(near).toBeLessThan(1.5)
  expect(mid).toBeGreaterThan(near)
  expect(far).toBeGreaterThan(mid)
  expect(far).toBeGreaterThan(1 + 4 * 0.85)
  // A flare on the ground a metre from a sign you stand 4 m from: ~14° off your line, so the sheeting is just paint.
  expect(retroGain(4, seen(1, 4))).toBeLessThan(1.01)
  // However large a game's aux, the return is capped.
  expect(retroGain(1e6, 0)).toBe(1 + RETRO_MAX)
  expect(retroGain(-5, 0)).toBe(1)
})

test("the batch shader lights MAT.retro with the lobe on each light's own line", () => {
  const code = makeSceneShader(batchHooks)
  expect(code).toContain(`mat == ${MAT.retro}`)
  expect(code).toContain("retroLobe(dot(ldir, V))")
  expect(code).toContain(`if (mat == 5 || mat == ${MAT.retro}) { col = tapeFluoresce`)
  expect(code).not.toContain("${")
})

const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find((p): p is string => !!p && existsSync(p))
test.skipIf(!naga)("the forest batch WGSL validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "forest-batch-wgsl-"))
  try {
    const file = join(dir, "batch.wgsl")
    writeFileSync(file, makeSceneShader(batchHooks))
    const result = Bun.spawnSync([naga!, file])
    expect(result.stderr.toString() + result.stdout.toString()).toContain("Validation successful")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
