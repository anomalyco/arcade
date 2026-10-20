import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeSceneShader } from "@arcade/kit/gpu/shaders"
import { texturedSceneShader } from "@arcade/kit/gpu/textured-mesh"
import { hooks, texturedHooks, glassHooks, fenceHooks, fogVolume } from "../src/shaders"
import { post } from "../src/post"
const dir = join(tmpdir(), "arcade-lot-shaders")
await mkdir(dir, { recursive: true })
for (const [name, shader] of [["scene", makeSceneShader(hooks)], ["textured", texturedSceneShader(texturedHooks)], ["masked", texturedSceneShader(texturedHooks, true)], ["glass",texturedSceneShader(glassHooks)], ["fence",texturedSceneShader(fenceHooks)], ["fog",fogVolume.code], ["post",post]]) {
  const path = join(dir, name + ".wgsl")
  await Bun.write(path, shader!)
  const proc = Bun.spawn([process.env.NAGA ?? `${process.env.HOME}/.cargo/bin/naga`, path], { stdout: "inherit", stderr: "inherit" })
  if (await proc.exited !== 0) process.exit(1)
}
