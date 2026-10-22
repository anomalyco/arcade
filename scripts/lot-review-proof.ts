import assert from "node:assert/strict"
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { mat4 } from "wgpu-matrix"
import { chromium } from "playwright-core"
import { serveDist } from "../games/lot/scripts/serve-dist"

// Review regression: the actual ?camera=bodycam rig must survive WalkCamera's final view assembly.
// No screenshots, recordings or sound playback; the existing walking clip is the visual proof.
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const report:unknown[]=[],errors:string[]=[]
try {
  for(const game of ["lot","nightshift"]){
    const server=serveDist(resolve(`games/${game}/dist`))
    try {
      const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1})
      page.on("pageerror",e=>errors.push(`${game}: ${e.message}`))
      page.on("console",m=>{if(m.type()==="error")errors.push(`${game}: ${m.text()}`)})
      await page.goto(`http://127.0.0.1:${server.port}/arcade/${game}/?camera=bodycam&time=8`)
      await page.waitForFunction(game=>(window as any)[game]?.frames>=2,game,{timeout:180000})
      const frames=await page.evaluate(game=>{
        const a=(window as any)[game],filter=(window as any).cameraFilter,c=a.camera;a.paused=true
        if(filter.settings.mode!=="bodycam")throw Error("Query did not engage bodycam")
        const frames=[]
        for(const mode of ["bodycam","today"]){
          filter.settings.mode=mode
          for(let i=0;i<12;i++){
            c.yaw+=.025;c.pitch=.08;c.body.vx=.6;c.body.vy=-1.2;c.update(1/60,1280/720,[])
            frames.push({mode,yaw:c.yaw,pitch:c.pitch,fov:c.fov,near:c.near,far:c.far,eye:[...c.eye],direction:[...c.direction],roll:c.walk.roll,mount:{...c.mount},matrix:Array.from(c.viewProj) as number[]})
          }
        }
        return frames
      },game)
      let mountedError=0,offError=0,mountEffect=0
      for(const f of frames){
        const make=(mounted:boolean)=>{
          const m=mounted?f.mount:{yaw:0,pitch:0,roll:0,height:0,fov:0}
          const yaw=f.yaw+m.yaw,pitch=Math.max(-1.5,Math.min(1.5,f.pitch+m.pitch)),roll=f.roll+m.roll
          const c=Math.cos(yaw),s=Math.sin(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch)
          const direction=[-s*cp,sp,-c*cp],up=[s*sp*Math.cos(roll)+c*Math.sin(roll),cp*Math.cos(roll),c*sp*Math.cos(roll)-s*Math.sin(roll)]
          return mat4.multiply(mat4.perspective((f.fov+m.fov)*Math.PI/180,1280/720,f.near,f.far),mat4.lookAt(f.eye,f.eye.map((v:number,i:number)=>v+direction[i]!),up))
        }
        const diff=(a:ArrayLike<number>,b:ArrayLike<number>)=>Math.max(...Array.from({length:16},(_,i)=>Math.abs(a[i]!-b[i]!)))
        if(f.mode==="bodycam"){
          mountedError=Math.max(mountedError,diff(f.matrix,make(true)))
          mountEffect=Math.max(mountEffect,diff(f.matrix,make(false)))
        }else{
          assert(Object.values(f.mount).every(v=>v===0),`${game}: off left a mount offset`)
          offError=Math.max(offError,diff(f.matrix,make(false)))
        }
      }
      assert(mountedError<1e-5,`${game}: bodycam mount discarded (${mountedError})`)
      assert(mountEffect>.01,`${game}: bodycam had no projection effect`)
      assert(offError<1e-5,`${game}: off camera differs from original assembly (${offError})`)
      report.push({game,mountedError,offError,mountEffect,frames:frames.length})
      await page.close()
    }finally{server.stop()}
  }
  assert.deepEqual(errors,[])
  const out=resolve(process.env.LEASE_OUT??"captures/lot/review");mkdirSync(out,{recursive:true})
  writeFileSync(resolve(out,"bodycam.json"),JSON.stringify({report,errors},null,2))
  console.log(JSON.stringify({report,errors}))
}finally{await browser.close()}
