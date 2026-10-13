/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root=resolve(import.meta.dir,"../../.."),out=join(root,"captures/lab-spawn")
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio","--disable-dawn-features=timestamp_quantization"]})
const errors:string[]=[],proof:any={}
try{
  for(const game of ["getaway","blackout"]){
    const dir=join(root,"games",game),server=await createServer({root:dir,configFile:join(dir,"vite.config.ts"),server:{host:"127.0.0.1",port:0}})
    await server.listen()
    try{
      const address=server.httpServer!.address();if(!address||typeof address==="string")throw new Error("No fixture port")
      const page=await browser.newPage({viewport:{width:1100,height:760}})
      page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404")){errors.push(m.text());console.error(m.text())}})
      await page.goto(`http://localhost:${address.port}/lab.html?bench`)
      await page.waitForFunction(()=>(window as any).lab)
      const adapter=await page.evaluate(()=>({architecture:(window as any).lab.adapter.architecture,vendor:(window as any).lab.adapter.vendor}))
      if(!adapter.architecture.includes("metal"))throw new Error("Not Metal")
      proof.adapter=adapter
      const select=(name:string,value:string)=>page.getByRole("combobox",{name,exact:true}).selectOption(value)
      const click=(name:string)=>page.getByRole("button",{name,exact:true}).click()
      const slider=(name:string,value:number)=>page.getByRole("slider",{name,exact:true}).evaluate((el,value)=>{(el as HTMLInputElement).value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}))},value)
      const draw=()=>page.evaluate(async()=>await(window as any).lab.render(true))
      const state=()=>page.evaluate(()=>(window as any).lab.spawn.inspect())
      const step=async(n:number)=>{for(let i=0;i<n;i++)await page.evaluate(async()=>{(window as any).lab.advance(1/60);await(window as any).lab.render()})}
      const focus=()=>page.locator("canvas").focus()
      const shot=async(name:string)=>{await focus();await page.keyboard.press("Backquote");await draw();await page.screenshot({path:join(out,`${game}-${name}.png`)});await page.keyboard.press("Backquote")}
      await select("Section","spawn")
      await select("Character",game==="getaway"?"getaway:muscle":"blackout:soldier")
      await click("Spawn character")
      if(game==="getaway"){
        await slider("Distance",6);await select("Item","cone");await click("Row")
        await slider("Distance",18);await select("Item","propane");await click("Spawn item")
        await draw();proof.before=await state();await shot("before")
        await focus();await page.keyboard.down("w")
        let hit=false,exploded=false,smoked=false,sprung=false,explosionFrame=-1
        for(let frame=0;frame<140;frame++){
          await step(1);const s=await state()
          smoked ||= s.character.tyreParticles>0;sprung ||= Math.abs(s.character.pitch)>.002
          if(!hit&&s.items.stats.hits){hit=true;await page.screenshot({path:join(out,"getaway-impact.png")})}
          if(!exploded&&s.items.stats.explosions){exploded=true;explosionFrame=frame;proof.explosion=s;await page.screenshot({path:join(out,"getaway-explosion.png")})}
          if(exploded&&frame===explosionFrame+10){await page.screenshot({path:join(out,"getaway-eruption.png")});break}
        }
        await page.keyboard.up("w");proof.after=await state()
        if(!hit||!exploded||!smoked||!sprung)throw new Error(`Car proof failed: ${JSON.stringify({hit,exploded,smoked,sprung})}`)
        const conesMoved=proof.after.items.props.filter((p:any,i:number)=>p.kind==="cone"&&Math.hypot(p.x-proof.before.items.props[i].x,p.z-proof.before.items.props[i].z)>.1).length
        if(conesMoved!==5||proof.after.items.chunks<1)throw new Error("Cone displacement or propane breakup failed")
        await shot("after")
        await focus();await page.keyboard.down("w")
        await page.getByRole("combobox",{name:"Item",exact:true}).focus();await step(1)
        if((await state()).character.input.throttle!==0)throw new Error("Panel focus did not release throttle")
        await page.keyboard.up("w")
        await select("Section","physics");await draw()
        if(!await page.getByRole("checkbox",{name:"Colliders",exact:true}).isVisible())throw new Error("Physics adapter controls missing")
        proof.physics=await page.evaluate(()=>document.querySelector("[data-lab]")!.shadowRoot!.querySelector("header")!.textContent)
        if(proof.physics.includes("pending")||!proof.physics.includes("sleeping"))throw new Error("Physics adapter not connected")
        await page.screenshot({path:join(out,"getaway-physics.png")})
        await select("Section","spawn");await click("Clear all")
        for(const id of ["compact","van","bike","cruiser","interceptor","swat"]){await select("Character",`getaway:${id}`);await click("Spawn character");await step(1);await draw()}
        await select("Item","bench");await slider("Count",3);await slider("Spacing",3);await slider("Distance",8);await click("Grid");await draw()
        if((await state()).items.props.length!==9)throw new Error("Grid did not spawn nine props")
        for(const id of ["lamp","spotlight","torch"]){await select("Light",id);await click("Drop light")}
        for(const id of ["smoke","tyre","nitro","sparks","explosion","water","debris","fire"]){await select("Effect",id);await click("Trigger effect");await step(1)}
        proof.spawned=await state();if(proof.spawned.lights!==3)throw new Error("Light spawn failed")
        await click("Clear all");if((await state()).items.props.length)throw new Error("Clear failed")
        proof.car={hit,exploded,smoked,sprung,conesMoved,panelRelease:true,allVehicles:true,grid:true,effects:true,lights:true}
      }else{
        await step(1);const initial=(await state()).character
        await focus();await page.keyboard.down("w");await step(60);await page.keyboard.up("w")
        const walk=(await state()).character
        if(initial.z-walk.z<3)throw new Error("Soldier did not walk")
        await page.keyboard.down("Shift");await page.keyboard.down(",");await step(60);await page.keyboard.up(",");await page.keyboard.up("Shift")
        const sprint=(await state()).character
        if(walk.z-sprint.z<5)throw new Error("Dvorak sprint failed")
        await page.keyboard.down("e");await step(30);await page.keyboard.up("e")
        if((await state()).character.x<sprint.x+1)throw new Error("Dvorak right failed")
        await select("Item","hydrant");await click("Spawn item");await select("Light","torch");await click("Drop light");await step(1)
        await shot("soldier")
        proof.soldier={initial,walk,sprint,final:(await state()).character}
      }
      if(errors.length)throw new Error(errors.join("\n"))
      await page.close()
    }finally{await server.close()}
  }
  proof.errors=errors;writeFileSync(join(out,"proof.json"),JSON.stringify(proof,null,2))
  console.log(JSON.stringify({car:proof.car,soldier:proof.soldier,errors}))
}finally{await browser.close()}
