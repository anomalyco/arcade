import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeSceneShader } from "@arcade/kit/gpu/shaders"
import { texturedSceneShader } from "@arcade/kit/gpu/textured-mesh"
import { hooks, propHooks, post, fogVolume, contactVolume } from "../src/shaders"
import { dustShader } from "../src/polish/dust"
import { lensPost } from "../src/polish/lens"
const dir=join(tmpdir(),"arcade-nightshift-shaders")
await mkdir(dir,{recursive:true})
for(const [name,shader] of [["lens",lensPost],["dust",dustShader],["scene",makeSceneShader(hooks)],["props",texturedSceneShader(propHooks)],["fog",fogVolume.code],["contact",contactVolume.code],["post",post]]) {
  const path=join(dir,name+".wgsl");await Bun.write(path,shader!)
  const p=Bun.spawn([process.env.NAGA??`${process.env.HOME}/.cargo/bin/naga`,path],{stdout:"inherit",stderr:"inherit"})
  if(await p.exited!==0)process.exit(1)
}
