import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeSceneShader } from "@arcade/kit/gpu/shaders"
import { texturedSceneShader } from "@arcade/kit/gpu/textured-mesh"
import { cardShadingHooks, forestHooks } from "@arcade/kit/gpu/forest"
import { hooks, texturedHooks, glassHooks, fenceHooks, fogVolume, reflectionVolume, thinGlassHooksLot, windowHooks, contactVolume } from "../src/shaders"
import { post } from "../src/post"
const dir = join(tmpdir(), "arcade-lot-shaders")
await mkdir(dir, { recursive: true })
for (const [name, shader] of [["scene", makeSceneShader(hooks)], ["textured", texturedSceneShader(texturedHooks)], ["masked", texturedSceneShader(texturedHooks, true)], ["glass",texturedSceneShader(glassHooks)], ["fence",texturedSceneShader(fenceHooks)], ["forest",texturedSceneShader(forestHooks(texturedHooks),true)], ["undergrowth",texturedSceneShader(cardShadingHooks(texturedHooks,"N.forest.x","N.forest.y"),true)], ["thin-glass",texturedSceneShader(thinGlassHooksLot)], ["windows",texturedSceneShader(windowHooks)], ["contact",contactVolume.code], ["fog",fogVolume(false).code], ["fog-atmosphere",fogVolume(true).code], ["ssr",reflectionVolume.code], ["ssr-filter",reflectionVolume.filter], ["post",post]]) {
  const path = join(dir, name + ".wgsl")
  await Bun.write(path, shader!)
  const proc = Bun.spawn([process.env.NAGA ?? `${process.env.HOME}/.cargo/bin/naga`, path], { stdout: "inherit", stderr: "inherit" })
  if (await proc.exited !== 0) process.exit(1)
}
