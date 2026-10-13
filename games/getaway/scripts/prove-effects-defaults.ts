import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

// Serve the pre-extraction modules through the SAME renderer, host, seed and fixed clock.
const root=resolve(import.meta.dir,"../../.."),out=resolve(root,"captures/lab-effects"),files=[
  "games/blackout/src/game/game.ts","games/blackout/src/game/vehicles.ts","games/blackout/src/game/map-fx.ts",
  "games/getaway/src/game/fx.ts","games/getaway/src/game/scene.ts","games/getaway/src/game/vehicle-emissions.ts",
  "games/getaway/src/game/props/index.ts","games/getaway/src/game/props/particles.ts","packages/kit/fx/smoke-trail.ts",
  "games/getaway/src/game/chassis.ts",
]
const baseline=process.env.EFFECTS_BASELINE??"8211aa0",fixtures=files.map(f=>({original:f,temporary:f.replace(/\.ts$/,".effects-baseline.ts")}))
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
mkdirSync(out,{recursive:true})
for(const f of fixtures){
  let source=execFileSync("git",["show",`${baseline}:${f.original}`],{cwd:root}).toString()
  // The parallel motion-blur work changed Scene's output contract. Retain only that plumbing in BEFORE.
  if(f.original==="games/getaway/src/game/scene.ts")source=readFileSync(resolve(root,f.original),"utf8")
    .replace('import { getawayEffects as effectSettings } from "../lab/settings"','')
    .replaceAll('effectSettings.landing.spring','-2.5').replaceAll('effectSettings.landing.punch','0.8')
    .replaceAll('effectSettings.scrape.rate','12').replaceAll('effectSettings.scrape.speedRate','40')
    .replaceAll('effectSettings.headlights.radius','36').replaceAll('effectSettings.headlights.power','3.2')
  if(f.original==="games/getaway/src/game/fx.ts")source='import { spriteMotionKeys } from "../render/motion"\n'+source.replace('const o = i * SPRITE_FLOATS','let keys=spriteMotionKeys.get(out);if(!keys)spriteMotionKeys.set(out,keys=[]);keys[i]=p;\n    const o = i * SPRITE_FLOATS')
  writeFileSync(resolve(root,f.temporary),source)
}
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],results:unknown[]=[]
try{
  for(const game of ["blackout","getaway"]){
    const buffers:Buffer[]=[]
    for(const variant of ["before","after"]){
      console.log(`Capturing ${game} ${variant}`)
      const context=await browser.newContext({viewport:{width:960,height:640},deviceScaleFactor:1})
      await context.addInitScript(()=>{
        let seed=1337;Math.random=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}
        let time=0;const callbacks:FrameRequestCallback[]=[]
        performance.now=()=>time
        window.requestAnimationFrame=cb=>(callbacks.push(cb),callbacks.length)
        ;(window as any).proofTick=()=>{time+=1000/60;const current=callbacks.splice(0);for(const cb of current)cb(time)}
      })
      const page=await context.newPage();page.on("pageerror",e=>{errors.push(e.message);console.error(e.message)});page.on("console",m=>{if(m.type()==="error")console.error(m.text())});page.on("response",r=>{if(r.status()>=400)console.error(`${r.status()} ${r.url()}`)})
      if(variant==="before")await page.route("**/*",async route=>{
        const url=new URL(route.request().url()),fixture=fixtures.find(f=>url.pathname.endsWith(f.original.replace(`games/${game}`,""))||url.pathname.endsWith(f.original))
        if(!fixture){await route.continue();return}
        if(fixture.original.startsWith("packages/")){
          await route.fulfill({contentType:"application/javascript",body:new Bun.Transpiler({loader:"ts"}).transformSync(readFileSync(resolve(root,fixture.temporary),"utf8"))});return
        }
        url.pathname=url.pathname.replace(/\.ts$/,".effects-baseline.ts")
        const response=await route.fetch({url:url.toString()});await route.fulfill({response})
      })
      const host=game==="blackout"?"http://fx-kit-blackout.localhost:1355":"http://fx-kit-playground.localhost:1355"
      await page.goto(`${host}/?peaceful=1&seed=7${game==="getaway"?"&bench=1":""}`)
      await page.evaluate(()=>document.fonts.ready)
      if(game==="getaway"){
        await page.waitForFunction(()=>!!(window as any).__getawayBench,undefined,{polling:100}).catch(async e=>{console.error(await page.locator("body").innerText());throw e})
        await page.evaluate(async()=>{const b=(window as any).__getawayBench;await b.ready;b.reset(true);for(let i=0;i<80;i++)await b.step(i,1/60,true)})
      }else{
        await page.waitForFunction(()=>document.querySelector("#menu")?.classList.contains("hidden")||document.querySelector("canvas")?.width===960,undefined,{polling:100})
        // Give async GPU initialization a bounded readiness signal before pumping fixed frames.
        await page.waitForFunction(()=>!!document.querySelector("[data-lab]"),undefined,{polling:100})
        await page.evaluate(async()=>{for(let i=0;i<90;i++){(window as any).proofTick();await new Promise(r=>setTimeout(r,0))}})
      }
      await page.addStyleTag({content:"[data-lab],#hud,#mode-hud,#menu{visibility:hidden!important}"})
      const image=await page.screenshot({path:resolve(out,`${game}-defaults-${variant}.png`)});buffers.push(image)
      await context.close()
    }
    const equal=buffers[0].equals(buffers[1]);results.push({game,equal,hashes:buffers.map(b=>createHash("sha256").update(b).digest("hex"))})
    if(!equal)errors.push(`${game}: default screenshots differ`)
  }
  writeFileSync(resolve(root,"perf/lab-effects-defaults.json"),JSON.stringify({baseline,results,errors},null,2))
  console.log(JSON.stringify({baseline,results,errors}));if(errors.length)throw new Error(errors.join("\n"))
}finally{await browser.close();for(const f of fixtures)rmSync(resolve(root,f.temporary),{force:true})}
