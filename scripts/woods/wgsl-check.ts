/** Validates the forest renderer's WGSL with naga (`~/.cargo/bin/naga`): `bun scripts/woods/wgsl-check.ts`. */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeSceneShader } from "../../packages/kit/gpu/shaders"
import { fogScatterVolume } from "../../packages/kit/gpu/fog-scatter"
import { ssrVolume } from "../../packages/kit/gpu/reflections/ssr"
import { batchHooks, cutoutDepthWgsl, forestHooks, forestShadowInstanceWgsl, moteShader, skyShader, treeVertexWgsl, woodsUniformWgsl } from "../../packages/kit/forest/shaders"
import { forestPost } from "../../packages/kit/forest/post"
import { forestFogVolume } from "../../packages/kit/forest/view"
import { MIP_SHADER } from "../../packages/kit/forest/assets"
import { spotShadowDepthWgsl } from "../../packages/kit/gpu/shadows/spot-shadows"

const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga")].find((p): p is string => !!p && existsSync(p))
if (!naga) throw new Error("naga not found (cargo install naga-cli)")
const dir = mkdtempSync(join(tmpdir(), "woods-wgsl-"))
const cases: [string, string][] = [
  ["forest scene", makeSceneShader(forestHooks) + treeVertexWgsl + cutoutDepthWgsl],
  ["batch scene", makeSceneShader(batchHooks)],
  ["sky", skyShader],
  ["motes", moteShader],
  ["post", typeof forestPost === "string" ? forestPost : (forestPost as { code?: string }).code ?? ""],
  ["fog volume", forestFogVolume(false).code],
  ["fog volume smoke", forestFogVolume(true).code],
  ["ssr", ssrVolume().code],
  ["mips", MIP_SHADER],
  ["spot shadow depth", spotShadowDepthWgsl()],
  ["spot shadow depth forest", spotShadowDepthWgsl(forestShadowInstanceWgsl)],
]
let bad = 0
for (const [name, code] of cases) {
  if (!code) { console.log(`skip ${name}`); continue }
  const file = join(dir, name.replace(/\W+/g, "-") + ".wgsl")
  writeFileSync(file, code)
  const run = Bun.spawnSync([naga, file])
  if (run.exitCode === 0) console.log(`ok   ${name}`)
  else { bad++; console.log(`FAIL ${name} (${file})\n${(run.stderr.toString() + run.stdout.toString()).slice(0, 3000)}`) }
}
void fogScatterVolume; void woodsUniformWgsl
process.exit(bad ? 1 : 0)
