/// <reference types="@webgpu/types" />
import { browserBudget } from "../../../scripts/browser-budget"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createServer, type ViteDevServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root=resolve(import.meta.dir,"../../.."),out=resolve(root,"captures/lab-effects")
mkdirSync(out,{recursive:true})
const cache=`${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath=readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).reverse().map(n=>`${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser=await chromium.launch({executablePath,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist","--mute-audio"]})
const errors:string[]=[],results:unknown[]=[]
const servers:ViteDevServer[]=[]
try {
  const hosts=process.env.LAB_URL?[process.env.LAB_URL]:[]
  if(!hosts.length)for(const game of ["getaway","blackout"]){
    const dir=resolve(root,"games/lab"),server=await createServer({root:dir,configFile:resolve(dir,"vite.config.ts"),server:{host:"127.0.0.1",port:0}})
    servers.push(server);await server.listen();const address=server.httpServer!.address()
    if(!address||typeof address==="string")throw new Error("No fixture port")
    hosts.push(`http://localhost:${address.port}`)
  }
  for(const [hostIndex,host] of hosts.entries()){
    const page=await browser.newPage({viewport:{width:1000,height:720}})
    page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("404"))errors.push(m.text())})
    await page.goto(`${host}/?bench`)
    await page.waitForFunction(()=>!!(window as any).lab,{},{timeout:60000})
    const adapter=await page.evaluate(()=>{const a=(window as any).lab.adapter;return {vendor:a.vendor,architecture:a.architecture}})
    if(!adapter.architecture.includes("metal"))throw new Error(`Not Metal: ${JSON.stringify(adapter)}`)
    const select=(name:string,value:string)=>page.getByRole("combobox",{name,exact:true}).selectOption(value)
    const click=(name:string)=>page.getByRole("button",{name,exact:true}).click()
    const draw=()=>page.evaluate(async()=>await(window as any).lab.render())
    const inspect=()=>page.evaluate(()=>{const l=(window as any).lab;return JSON.parse(l.sections.find((s:any)=>s.id===l.settings.section).telemetry().split("\n")[1])})
    const assert=(ok:unknown,message:string)=>{if(!ok)throw new Error(message)}
    const step=(n:number)=>page.evaluate(async n=>{const l=(window as any).lab;for(let i=0;i<n;i++){l.advance(1/60);await l.render()}},n)
    const shot=async(name:string)=>{await page.locator("canvas").focus();await page.keyboard.press("Backquote");await draw();await page.screenshot({path:resolve(out,`${name}.png`)});await page.keyboard.press("Backquote")}
    await select("Section","blackout-effects");await draw()
    for(const environment of ["office","corridor","meeting","breakroom","server","downtown"]){await select("Environment",environment);await draw();results.push({host,environment,telemetry:await page.locator("[data-lab]").evaluate(e=>e.shadowRoot!.querySelector("header")!.textContent)})}
    await select("Environment","meeting");await select("Effect","shot");await select("Surface","glass");await click("Trigger effect");await step(14)
    assert((await inspect()).sheets>0,"Glass surface did not emit shards")
    if(!hostIndex)await shot("glass-room-one")
    await click("Randomize environment");await step(14)
    assert((await inspect()).sheets>0,"Locked effect was not retriggered in the new room")
    if(!hostIndex)await shot("glass-room-two")
    await select("Effect","paper");await click("Clear effects");await click("Trigger effect");await step(20);if(!hostIndex)await shot("paper")
    assert((await inspect()).sheets>0,"Paper emitted no sheets")
    await click("Clear effects");await select("Effect","shot")
    for(const surface of ["wall","metal","partition"]){const before=(await inspect()).holes;await select("Surface",surface);await click("Trigger effect");await step(15);assert((await inspect()).holes>before,`${surface} emitted no bullet hole`)}
    if(!hostIndex)await shot("bullet-holes")
    await select("Surface","desk");await click("Trigger effect");await step(1)
    await select("Surface","monitor");await click("Trigger effect");await step(1)
    assert((await inspect()).monitors>0,"Monitor surface did not break a monitor")
    for(const effect of ["muzzle","tracer","blood","splats","impact","dust","monitor","casings","magazines","lamps","corpse","vehicle","fire","wreck","scorch","explosion"]){await select("Effect",effect);await click("Trigger effect");await step(2)}
    await click("Clear effects");await select("Effect","explosion");await click("Trigger effect");await step(8)
    if(!hostIndex)await shot("blackout-explosion")
    await select("Section","getaway-effects");await draw()
    for(const environment of ["street","alley","plaza"]){await select("Environment",environment);await draw()}
    await select("Environment","street");await select("Effect","hydrant");await click("Trigger effect");await step(45)
    assert((await inspect()).water>0,"Hydrant did not start its water reaction")
    if(!hostIndex)await shot("hydrant")
    await click("Clear effects");await select("Effect","explosion");await click("Trigger effect");await step(8)
    assert((await inspect()).explosions>0,"Propane did not explode")
    if(!hostIndex)await shot("getaway-explosion")
    await click("Clear effects");await select("Effect","sparks");await click("Trigger effect");await step(8)
    if(!hostIndex)await shot("sparks-default")
    await page.evaluate(()=>{const l=(window as any).lab,s=l.sections.find((s:any)=>s.id==="getaway-effects");s.settings["sparks.size"]=.5;s.settings["sparks.speed"]=2;s.settings["sparks.life"]=1.2;l.context.sync()})
    await click("Clear effects");await click("Trigger effect");await step(8);if(!hostIndex)await shot("sparks-tweaked")
    for(const effect of ["scrape","skids","nitro","pops","cold","landing","debris","plumes","headlights","tyre"]){await select("Effect",effect);await click("Trigger effect");await step(12)}
    await page.getByRole("checkbox",{name:"Lock environment",exact:true}).check()
    const before=await page.evaluate(()=>(window as any).lab.sections.find((s:any)=>s.id==="getaway-effects").settings.seed)
    await click("Randomize environment")
    const after=await page.evaluate(()=>(window as any).lab.sections.find((s:any)=>s.id==="getaway-effects").settings.seed)
    if(before!==after)throw new Error("Environment lock failed")
    await select("Effect","sparks");await click("Clear effects");await click("Randomize Sparks");await step(1)
    assert((await inspect()).particles>0,"Explicit group randomization failed under effect lock")
    await page.getByRole("checkbox",{name:"Loop",exact:true}).check();await step(121)
    assert((await inspect()).particles>0,"Loop failed to retrigger")
    await page.getByRole("checkbox",{name:"Play",exact:true}).uncheck()
    const paused=await inspect();await step(30);assert(JSON.stringify(paused)===JSON.stringify(await inspect()),"Pause advanced effects")
    await page.context().grantPermissions(["clipboard-read","clipboard-write"])
    await click("Copy JSON")
    const copied=await page.evaluate(async()=>JSON.parse(await navigator.clipboard.readText()))
    assert(copied.game==="getaway-effects"&&copied.settings.sparks,"Copy JSON omitted production settings")
    // Keyboard on the public panel control, no private DOM API.
    const slider=page.getByRole("slider",{name:"Target X",exact:true});await slider.focus();await page.keyboard.press("ArrowRight")
    await draw();results.push({host,adapter,locked:before===after,keyboard:true})
    await page.close()
  }
  if(errors.length)throw new Error(errors.join("\n"))
  mkdirSync(resolve(root,"perf"),{recursive:true});writeFileSync(resolve(root,"perf/lab-effects.json"),JSON.stringify({results,errors},null,2))
  console.log(JSON.stringify({results,errors}))
}finally{await browser.close();for(const server of servers)await server.close()}
