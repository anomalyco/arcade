import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeSceneShader } from "@arcade/kit/gpu/shaders"
import { hooks, post, fogVolume } from "../src/shaders"
const dir=join(tmpdir(),"arcade-nightshift-shaders")
await mkdir(dir,{recursive:true})
for(const [name,shader] of [["scene",makeSceneShader(hooks)],["fog",fogVolume.code],["post",post]]) {
  const path=join(dir,name+".wgsl");await Bun.write(path,shader!)
  const p=Bun.spawn([process.env.NAGA??`${process.env.HOME}/.cargo/bin/naga`,path],{stdout:"inherit",stderr:"inherit"})
  if(await p.exited!==0)process.exit(1)
}
