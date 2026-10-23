import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeSceneShader } from "../gpu/shaders"
import { cutoutDepthWgsl, forestHooks, forestLakeHooks, treeVertexWgsl } from "./shaders"

const today = makeSceneShader(forestHooks) + treeVertexWgsl + cutoutDepthWgsl
const moonlit = makeSceneShader(forestLakeHooks)

test("Today's forest shader carries nothing of the moonlit lake", () => {
  for (const token of ["lakeSky", "lakeRipples", "lakeBreakup", "struct Lake", "woodsWater", "waterSpecular", "@group(1) @binding(6)", "@group(1) @binding(7)"]) expect(today).not.toContain(token)
})

test("the moonlit lake shader adds its optics, bindings and kit water lobes", () => {
  for (const token of ["lakeRipples", "woodsWater = true", "@group(1) @binding(6) var lakeSky", "var<uniform> L: Lake", "waterSpecular(n, V, N.moon.xyz", "waterFresnel(dot(V, n))"]) expect(moonlit).toContain(token)
})

const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find((p): p is string => !!p && existsSync(p))
for (const [name, code] of [["Today", today], ["moonlit", moonlit]] as const) test.skipIf(!naga)(`forest ${name} WGSL validates`, () => {
  const dir = mkdtempSync(join(tmpdir(), "forest-wgsl-"))
  try {
    const file = join(dir, "forest.wgsl")
    writeFileSync(file, code)
    const result = Bun.spawnSync([naga!, file])
    expect(result.stderr.toString() + result.stdout.toString()).toContain("Validation successful")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
