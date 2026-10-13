import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { RUNES, resample, recognize } from "../src/game/runes"
import { spellDefaults } from "../shared/sim/spell-config"
import type { World } from "../shared/sim/world"
import type { Game } from "../src/game/game"
import type { Camera } from "../src/render/camera"
import type { Input } from "../src/game/input"

declare global { interface Window { practice: World; wizardProof: { game: Game; cam: Camera; input: Input }; advance(ms:number):Promise<void> } }
const out=process.env.OUT??"captures/wizards-spells",base=process.env.URL??"http://wizards.localhost:1355"
mkdirSync(out,{recursive:true})
const browser=await chromium.launch({executablePath:process.env.CHROME??join(homedir(),"Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"),headless:true,args:["--enable-unsafe-webgpu","--use-angle=metal","--mute-audio"]})
const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:1})
const errors:string[]=[]
page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error")errors.push(m.text())})
const advance=(ms:number)=>page.evaluate(ms=>window.advance(ms),ms)
const shot=(name:string)=>page.screenshot({path:join(out,`${name}.png`)})
const frameAt=(x:number,y:number)=>page.evaluate(async({x,y})=>{window.wizardProof.cam.snap(x,y);await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))},{x,y})
const state=()=>page.evaluate(()=>({t:window.practice.time,spells:window.practice.spells!.snapshot(),players:[...window.practice.players.values()].map(p=>({id:p.id,x:p.x,y:p.y,health:p.health,alive:p.alive}))}))
const assert=(v:unknown,message:string)=>{if(!v)throw Error(message)}
async function draw(spell:"moon"|"necromancy",x:number,y:number,sloppy=false,hold=false) {
  const at=await page.evaluate(({x,y})=>window.wizardProof.cam.project(x,0,y,innerWidth,innerHeight),{x,y})
  let points=resample(RUNES[spell])
  if(sloppy)points=points.map((p,i)=>({x:p.x+Math.sin(i*0.7)*0.23,y:p.y+Math.cos(i*0.6)*0.17}))
  const result=recognize(points,spellDefaults())
  await page.mouse.move(at.x+points[0]!.x*52,at.y+points[0]!.y*52)
  await page.mouse.down({button:"right"})
  for(const p of points.slice(1))await page.mouse.move(at.x+p.x*52,at.y+p.y*52)
  if(!hold){await page.mouse.up({button:"right"});await advance(70)}
  return result
}
try {
  await page.goto(`${base}/?sandbox=1&mode=wizards&seed=1&peaceful=1&manual&bench=1`)
  await page.waitForFunction(()=>!!window.practice?.spells && !!window.wizardProof?.game?.snap && typeof window.advance==="function")
  await advance(100)
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return a?{vendor:a.info.vendor,architecture:a.info.architecture}:null})
  assert(adapter && /metal/i.test(adapter.architecture),"Metal adapter required")
  await page.keyboard.press("f");await advance(1850);await shot("01-reading")
  await advance(250)
  assert((await state()).spells.learned.you?.includes("moon"),"F did not teach Moon Ball")
  await draw("moon",10,10,false,true);await shot("02-drawing")
  // A Dvorak physical E key remains movement while right-click is held; it must not read a scroll.
  const before=(await state()).players.find(p=>p.id==="you")!
  await page.keyboard.down("KeyE");await advance(80);await page.keyboard.up("KeyE")
  assert((await state()).players.find(p=>p.id==="you")!.x>before.x,"Dvorak movement froze during rune drawing")
  await page.mouse.up({button:"right"});await advance(70);await shot("03-cast")
  assert((await state()).spells.moons.length===1,"Mouse rune did not cast a moon")
  await advance(2200);await frameAt(9,10);await shot("04-orbit")
  let orbit=await state()
  // The seeded dummy is at (12,10); continue until the moving moon reaches it.
  if(!orbit.spells.moons.some(m=>m.orbiters.some(o=>o.kind==="player"))) {await advance(500);orbit=await state();await frameAt(9,10);await shot("04-orbit")}
  assert(orbit.spells.moons.some(m=>m.orbiters.some(o=>o.kind==="player")),"Moon did not capture a dummy")
  const end=orbit.spells.moons[0]!.end
  await advance((end-orbit.t)*1000+100);await frameAt(11,10);await shot("05-pop")
  const pop=await state();assert(pop.spells.flashes.some(f=>f.kind==="pop"),"Missing pop")
  assert(pop.players.find(p=>p.id==="bot1")!.health<100,"Moon pop did not damage dummy")
  await advance(1200)
  // Walk from the first lectern toward the next; no injected learning or cast intents.
  await page.keyboard.down("d");await advance(460);await page.keyboard.up("d");await advance(120)
  await page.keyboard.press("f");await advance(2150)
  assert((await state()).spells.learned.you?.includes("necromancy"),"Second scroll not learned")
  const me=(await state()).players.find(p=>p.id==="you")!
  await draw("necromancy",me.x+2,me.y);await advance(700);await shot("06-rising")
  const rising=await state();assert(rising.spells.skeletons.length===1,"No skeleton raised")
  await advance(1900);await shot("07-chasing")
  const chasing=await state();assert(chasing.spells.skeletons[0]!.target==="you","Skeleton did not chase its caster")
  const sloppy=await draw("moon",me.x+4,me.y,true);await advance(600);await shot("08-sloppy")
  assert(sloppy.spell==="moon"&&sloppy.quality<1,"Sloppy fixture not degraded")
  assert((await state()).spells.moons.some(m=>m.tiny),"Sloppy mouse cast did not create tiny moon")
  const result={adapter,errors,orbit,pop,rising,chasing,sloppy}
  writeFileSync(join(out,"proof.json"),JSON.stringify(result,null,2))
  assert(errors.length===0,errors.join("\n"))
  console.log(JSON.stringify({adapter,errors,captures:8,orbiters:orbit.spells.moons[0]!.orbiters,sloppy},null,2))
} finally {await browser.close()}
