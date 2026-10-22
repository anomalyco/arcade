/** One fixed-pose before/after for the shared contact-depth correction. Headless, muted. */
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { serveDist } from "../games/lot/scripts/serve-dist"
const out=resolve(process.env.LEASE_OUT??"captures/lot-contact-review");mkdirSync(out,{recursive:true})
const server=serveDist(resolve("games/lot/dist")),cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if(!executablePath)throw Error("Headless Chromium missing")
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const report:Record<string,unknown>={pose:[7.6,1.65,133.2,-.62,-.36],size:[1280,720]}
try{
  for(const variant of ["before","after"]){
    const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1}),errors:string[]=[]
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
    await page.addInitScript(before=>{
      window.requestAnimationFrame=()=>1
      const create=GPUDevice.prototype.createShaderModule
      GPUDevice.prototype.createShaderModule=function(d){
        if(d.code.includes("fn csNormal(")){
          ;(window as any).contactShaderCount=((window as any).contactShaderCount??0)+1
          if(before){
            let code=d.code
            code=code.replace(/fn csNormal\(uv: vec2f, p: vec3f\) -> vec4f \{[\s\S]*?  let dx =/,`fn csPos(uv: vec2f) -> vec3f { return volumeUnproject(uv, volumeDepthAt(uv)); }
fn csNormal(uv: vec2f, p: vec3f) -> vec4f {
  let px = 1.0 / V.size.zw;
  let r = csPos(uv + vec2f(px.x, 0.0)) - p;
  let l = p - csPos(uv - vec2f(px.x, 0.0));
  let d = csPos(uv + vec2f(0.0, px.y)) - p;
  let u = p - csPos(uv - vec2f(0.0, px.y));
  let dx =`)
            code=code.replace("let texel = volumeTexel(uv);\n    let d = textureLoad(sceneDepth, texel, 0);","let d = volumeDepthAt(uv);")
              .replace("length(volumeWorldAtTexel(texel) - V.eye.xyz)","length(volumeUnproject(uv, d) - V.eye.xyz)")
              .replace("let texel = volumeTexel(o.uv);\n  let d = textureLoad(sceneDepth, texel, 0);","let d = volumeDepthAt(o.uv);")
              .replace("let p = volumeWorldAtTexel(texel);","let p = volumeUnproject(o.uv, d);")
            if(code.includes("let texel =")||!code.includes("fn csPos("))throw Error("Baseline shader substitution incomplete")
            d={...d,code}
          }
        }
        return create.call(this,d)
      }
    },variant==="before")
    await page.goto(`${server.url}/arcade/lot/?time=8`,{timeout:120000,waitUntil:"domcontentloaded"})
    await page.waitForFunction(()=>(window as any).lot?.ready,undefined,{polling:100,timeout:180000})
    const state=await page.evaluate(async()=>{
      const a=(window as any).lot,d:GPUDevice=a.renderer.passContext.device
      a.paused=true;Object.assign(a.camera.body,{x:7.6,y:133.2,vx:0,vy:0});Object.assign(a.camera,{height:1.65,yaw:-.62,pitch:-.36,fov:68})
      a.contact.mode="screen";a.renderer.resetTemporalHistory()
      for(let i=0;i<40;i++){a.step(1000/60);await d.queue.onSubmittedWorkDone()}
      return {contact:a.contact,shaderCount:(window as any).contactShaderCount,frames:a.frames,eye:Array.from(a.camera.eye)}
    })
    if(state.shaderCount!==1||errors.length)throw Error(JSON.stringify({state,errors}))
    await page.addStyleTag({content:"#hud,#credits,[data-lab-panel],.hint{display:none!important}"})
    await page.screenshot({path:resolve(out,`${variant}.png`),timeout:60000})
    report[variant]={...state,errors};await page.close()
  }
}finally{await Bun.write(resolve(out,"report.json"),JSON.stringify(report,null,2));await browser.close();server.stop(true)}
console.log(JSON.stringify(report,null,2))
