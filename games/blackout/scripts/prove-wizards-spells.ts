import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import type { World } from "../shared/sim/world"
import type { Game } from "../src/game/game"
import type { Camera } from "../src/render/camera"
import type { Input } from "../src/game/input"

declare global { interface Window { practice: World; wizardProof: { game: Game; cam: Camera; input: Input }; advance(ms:number):Promise<void> } }
const out=resolve(process.env.OUT??"captures/wizards-click")
mkdirSync(join(out,"frames"),{recursive:true})
const server=process.env.URL?null:await createServer({root:resolve(import.meta.dir,".."),server:{host:"127.0.0.1",port:0},logLevel:"error"})
await server?.listen()
const base=process.env.URL??server!.resolvedUrls!.local[0]!
const browser=await chromium.launch({executablePath:process.env.CHROME,headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--mute-audio"]})
const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:1})
const errors:string[]=[]
page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
const advance=(ms:number)=>page.evaluate(ms=>window.advance(ms),ms)
const state=()=>page.evaluate(()=>({t:window.practice.time,spells:window.practice.spells!.snapshot(),selected:window.wizardProof.game.selectedSpell,players:[...window.practice.players.values()].map(p=>({id:p.id,x:p.x,y:p.y,health:p.health,alive:p.alive,meleeReadyAt:p.meleeReadyAt}))}))
const assert=(v:unknown,message:string)=>{if(!v)throw Error(message)}
const reset=async()=>{
  await page.goto(`${base}?sandbox=1&mode=wizards&seed=1&peaceful=1&manual&bench=1`)
  await page.waitForFunction(()=>!!window.practice?.spells && !!window.wizardProof?.game?.snap && typeof window.advance==="function")
  await advance(100)
}
const point=(x:number,y:number)=>page.evaluate(({x,y})=>window.wizardProof.cam.project(x,0,y,innerWidth,innerHeight),{x,y})
async function click(x:number,y:number) {const p=await point(x,y);await page.mouse.click(p.x,p.y)}
async function frame() {
  await page.evaluate(async()=>{window.wizardProof.cam.snap(9,10.5);await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))})
}
try {
  await reset()
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return a?{vendor:a.info.vendor,architecture:a.info.architecture}:null})
  assert(adapter && /metal/i.test(adapter.architecture),"Metal adapter required")
  assert((await state()).spells.learned.you?.length===2,"Both spells must be ready on spawn")
  // Down and up both occur before a fixed tick. The next tick must retain the press.
  await click(12,11);assert((await state()).spells.moons.length===0,"Manual clock advanced unexpectedly")
  await advance(70)
  assert((await state()).spells.moons.length===1,"Quick tap was dropped")
  assert((await state()).players.find(p=>p.id==="you")!.meleeReadyAt===0,"Click also bonked")
  for(let i=0;i<5;i++)await click(12,11)
  await advance(220);assert((await state()).spells.moons.length===1,"Rapid clicks bypassed cooldown")
  await page.keyboard.press("2");assert((await state()).selected==="necromancy","2 did not select skeleton")
  await click(6,8)
  await page.mouse.wheel(0,100);assert((await state()).selected==="moon","Wheel did not select moon")
  await advance(70);assert((await state()).spells.skeletons.length===1,"Selection changed a latched click / independent summon cooldown failed")
  await page.keyboard.press("2");await page.keyboard.press("1");assert((await state()).selected==="moon","1 did not select moon")
  const before=(await state()).players.find(p=>p.id==="you")!
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyD",key:"e",bubbles:true})));await click(12,11);await advance(120);await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyD",key:"e",bubbles:true})))
  assert((await state()).players.find(p=>p.id==="you")!.x>before.x,"Dvorak movement failed while casting")
  await advance(500);await click(12,11);await advance(70)
  assert((await state()).spells.moons.length===2,"Ready second click failed")
  await advance(900);await click(12,11);await advance(70)
  assert((await state()).spells.moons.length===2,"Per-caster moon cap failed")
  await page.keyboard.press("Backquote")
  const count=(await state()).spells.moons.length
  await page.locator("[data-row=moonCooldown] input").click()
  await advance(70);assert((await state()).spells.moons.length===count,"Lab click leaked")
  await page.keyboard.press("Backquote")
  // Fresh scenario for readable, uninterrupted capture, with only real player controls.
  await reset();await frame();await page.screenshot({path:join(out,"01-ready.png")})
  await click(12,11)
  let orbit:Awaited<ReturnType<typeof state>>|undefined,pop:typeof orbit,rising:typeof orbit,chasing:typeof orbit,windup:typeof orbit,impact:typeof orbit
  const clip = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1" || process.env.CLIP === "1"
  for(let i=0;i<240;i++) {
    if(i===115) {await page.keyboard.press("2");await click(6,8)}
    await advance(1000/30);await frame()
    const s=await state()
    if(i===5)await page.screenshot({path:join(out,"02-moon.png")})
    if(!orbit && s.spells.moons.some(m=>m.orbiters.some(o=>o.kind==="player")&&m.orbiters.some(o=>o.kind==="prop"))) {orbit=s;await page.screenshot({path:join(out,"03-orbit.png")})}
    if(!pop && s.spells.flashes.some(f=>f.kind==="pop")) {pop=s;await page.screenshot({path:join(out,"04-pop.png")})}
    if(i===124) {rising=s;await page.screenshot({path:join(out,"05-rising.png")})}
    if(i===147) {chasing=s;await page.screenshot({path:join(out,"06-chasing.png")})}
    if(!windup && s.spells.skeletons.some(sk=>sk.attackAt>s.t)) {windup=s;await page.screenshot({path:join(out,"07-windup.png")})}
    if(!impact && s.players.find(p=>p.id==="you")!.health<100) {impact=s;await page.screenshot({path:join(out,"08-impact.png")})}
    if(clip)await page.screenshot({path:join(out,"frames",`${String(i).padStart(4,"0")}.jpg`),type:"jpeg",quality:85})
  }
  assert(orbit,"No player + furniture pickup")
  assert(pop && pop.players.find(p=>p.id==="bot1")!.health<100,"No pop damage")
  assert(chasing?.spells.skeletons[0]?.target==="you","Skeleton did not pursue caster")
  assert(windup && impact,"Skeleton anticipation/impact missing")
  assert(errors.length===0,errors.join("\n"))
  const result={adapter,errors,controls:"tap, rapid taps, independent cooldown, keys, wheel, Dvorak, cap, Lab isolation",orbit,pop,rising,chasing,windup,impact,frames:clip?240:0}
  writeFileSync(join(out,"proof.json"),JSON.stringify(result,null,2))
  if(clip) {
    const p=Bun.spawn(["ffmpeg","-y","-v","error","-framerate","30","-i",join(out,"frames/%04d.jpg"),"-c:v","h264_videotoolbox","-profile:v","high","-q:v","75","-pix_fmt","yuv420p","-movflags","+faststart",join(out,"clip.mp4")],{stdout:"inherit",stderr:"inherit"})
    assert(await p.exited===0,"Video encode failed")
  }
  console.log(JSON.stringify({adapter,errors,controls:result.controls,orbiters:orbit?.spells.moons[0]?.orbiters,frames:result.frames},null,2))
} finally {await browser.close();await server?.close()}
