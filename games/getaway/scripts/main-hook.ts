import type { Page } from "playwright-core"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Browser-only clock/input instrumentation. The exported main tree stays byte-for-byte unchanged. */
export async function installMainHook(page: Page, root: string) {
  let source = readFileSync(join(root, "games/getaway/src/main.ts"), "utf8")
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`main hook anchor missing: ${from}`)
    source = source.replace(from, to)
  }
  source = `import { applyStage } from "/src/game/stage.ts"\n` + source
  replace("void paintAtlas().then", "const atlasReady = paintAtlas().then")
  replace('const staged = import.meta.env.DEV && q.has("stage")', 'const staged = true')
  replace("const cam = new Camera()", "let cam = new Camera()")
  replace("  let last = performance.now()", `
  const w = window as any
  w.__getawayBench = {
    ready: atlasReady.then(() => true),
    adapterInfo: adapter.info,
    reset() {
      let seed = 1337
      Math.random = () => {
        seed |= 0; seed = seed + 0x6d2b79f5 | 0
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
      }
      const local = new LocalSession("Dax", { robber: "muscle", cop: "cruiser" }, 7) as any
      applyStage(local.world, "chase")
      const cops = local.world.cops()
      ;[[225,139,0.08],[231,131,-0.06],[226,122,0.04]].forEach(([x,z,h], i) => cops[i] && Object.assign(cops[i].body, {x,z,h,vx:0,vz:28}))
      local.world.seen = true
      local.world.lastSeen = {x:226,z:150,t:local.world.t}
      Object.assign(local.world.heli, {active:true,x:246,y:18,z:162,h:-1.6,sx:229,sz:174})
      local.prev = local.curr = local.world.view(local.myId)
      session = local
      const s = scene as any
      for (const key of ["puffs", "alpha", "add", "skids"]) if (s.fx[key]) s.fx[key].length = 0
      s.vis.clear(); s.time = 0; s.shake = 0
      cam = new Camera(); snapped = false
    },
    async step(i: number, dt = 1/30, waitGpu = false) {
      const start = performance.now()
      const local = session as any
      const r = local.world.robber()?.body
      const targetX = 228 + Math.sin(i * 0.085) * 3.4
      const steer = Math.max(-1, Math.min(1, (targetX - (r?.x ?? 228))*0.18 - (r?.h ?? 0)*2.2 - (r?.yaw ?? 0)*0.35))
      const input = {throttle:1,brake:0,steer,handbrake:i>=3&&i<9,boost:(i>=22&&i<52)||(i>=115&&i<150),gadget:null,engine:false}
      const view = local.update(dt,input)
      const mine = view.cars.find((c:any) => c.ownerId === local.myId && !c.ghost)
      const robber = view.cars.find((c:any) => c.ownerId === view.robberId && !c.ghost)
      const focus = (view.phase === "intro" ? robber : mine) ?? robber ?? view.cars[0] ?? null
      if (focus) {
        if (!snapped) { cam.snap(focus.x,focus.z); snapped = true }
        cam.update(focus.x,focus.z,focus.vx,focus.vz,dt)
      }
      if (scene.shake > 0) { cam.bump(scene.shake); scene.shake = 0 }
      scene.draw(view,cam,canvas.width,canvas.height,dt,focus)
      const events = local.drainEvents()
      hud.update(view,{myId:local.myId,cam,width:innerWidth,height:innerHeight,dt,events,players:local.players(),room:local.room,status:local.status()})
      const cpuMs = performance.now()-start
      const g0 = performance.now()
      if (waitGpu) await device.queue.onSubmittedWorkDone()
      const count = (renderer as any).city?.count ?? 0
      return {cpuMs,gpuMs:performance.now()-g0,stats:{cityVertsDrawn:count*2,mainCityVertsDrawn:count,shadowCityVertsDrawn:count,chunksDrawn:2,mainChunksDrawn:1,shadowChunksDrawn:1,totalChunks:1}}
    }
  }
  return
  let last = performance.now()`)
  source = source.replaceAll(/from "\.\//g, 'from "/src/').replace('import "./style.css"', 'import "/src/style.css"')
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
    .replaceAll('"@fontsource/barlow-condensed/', '"/node_modules/@fontsource/barlow-condensed/')
    .replaceAll(/from "(\/src\/[^".]+)"/g, 'from "$1.ts"')
  await page.route("**/src/main.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: js }))
}
