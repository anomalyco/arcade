// Flashlight hand stress test in the real game (changes normalised to a 60 Hz frame): with the torch on, the view pitch sweeps −85°..+85° while the yaw spins
// fast (both directions), walking, running, crouch-walking, on the core stair and through mantles. Every frame it
// measures the change of the left hand's and the torch's world orientation and flags frames where either turns by
// more than 30° (a flip), plus the hand's twist relative to the forearm. Saves the flagged frames.
//
//   bun scripts/character/torch-flip.ts [--tag t] [--secs 6]
//
// One browser, 960×600. Output: flag counts per scenario, captures/character/flip-<tag>.png (flagged frames, or a
// sample strip when clean).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1]! : undefined
}
const tag = flag("tag") ?? "run"
const secs = Number(flag("secs") ?? 6)
const out = `${import.meta.dir}/../../captures/character`
const tiles = `${out}/flip`
mkdirSync(tiles, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width: 960, height: 600 } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.length < 5 && errors.push(e.message))
await page.routeWebSocket(/.*/, () => {})
const files: string[] = []
const results: Record<string, { frames: number; flags: number; worst: number; worstAt: string; beamMax: number; beamBad: number; barrelMax: number }> = {}
try {
  const load = async (q: string) => {
    await page.goto(`http://localhost:5196/?${q}`)
    await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, null, { timeout: 240_000 })
    await page.addStyleTag({ content: "#hud{display:none!important}" })
    await install()
  }
  // The monitor: drives the view each frame and measures the hand/torch orientation change, the beam's direction
  // against the camera's forward and the torch barrel's against the view.
  const install = () => page.evaluate(async () => {
    const url = "/src/render/shared.ts"
    const RS = (await import(url)).renderState
    const G = globalThis as any
    const P = G.__afterhoursPlayer
    const B = G.__afterhoursBody
    const body = B.body
    const Q = body.root.quaternion.constructor
    const prev = { hand: new Q(), torch: new Q(), twist: 0, ok: false, root: new Q(), chest: new Q(), fore: new Q() }
    const M = (G.__flip = { on: false, t: 0, spin: 0, sweep: 0, frames: 0, flags: [] as unknown[], worst: 0, worstAt: "", label: "", flagNow: false, beamMax: 0, beamAt: "", barrelMax: 0, beamBad: 0 })
    const cam = G.__afterhoursDebug.camera
    const V = cam.position.constructor
    const tw = (q: any) => 2 * Math.atan2(q.y, q.w)
    let last = 0
    const step = (now: number) => {
      requestAnimationFrame(step)
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60
      last = now
      if (!M.on) {
        prev.ok = false
        return
      }
      M.t += dt
      P.yaw += M.spin * Math.sin(M.t * 0.9) * dt * 1.6
      P.pitch = Math.sin(M.t * M.sweep) * (85 * Math.PI) / 180
      // Beam vs camera forward (every frame the flashlight is lit), torch barrel vs view (while held).
      const fwd = new V(0, 0, -1).applyQuaternion(cam.quaternion)
      if (RS.flash.on && P.flashlight) {
        const e = (fwd.angleTo(RS.flash.dir) * 180) / Math.PI
        if (e > M.beamMax) {
          M.beamMax = e
          M.beamAt = `${M.label} t ${M.t.toFixed(2)} state ${body.debug.state}`
        }
        if (e > 3) M.beamBad++
      }
      if (body.torch.visible && body.torchHeld && !P.state.mantle) {
        const barrel = new V(0, 0, -1).transformDirection(body.torch.matrixWorld)
        M.barrelMax = Math.max(M.barrelMax, (barrel.angleTo(fwd) * 180) / Math.PI)
      }
      const hb = body.bones?.LeftHand
      if (!hb || !body.torch.visible) {
        prev.ok = false
        return
      }
      const h = hb.getWorldQuaternion(new Q())
      const t = body.torch.getWorldQuaternion(new Q())
      const local = hb.quaternion
      const rq = body.root.quaternion.clone()
      const cq = body.bones.Spine2.getWorldQuaternion(new Q())
      const fq = body.bones.LeftForeArm.getWorldQuaternion(new Q())
      const twist = tw(local)
      if (prev.ok) {
        const dh = (2 * Math.acos(Math.min(1, Math.abs(h.dot(prev.hand)))) * 180) / Math.PI
        const dtq = (2 * Math.acos(Math.min(1, Math.abs(t.dot(prev.torch)))) * 180) / Math.PI
        let dtw = Math.abs(twist - prev.twist)
        dtw = (Math.min(dtw, Math.PI * 4 - dtw) * 180) / Math.PI
        // Normalised to a 60 Hz frame (headless runs slower): a smooth fast turn scales, a flip stays huge.
        const d = (Math.max(dh, dtq) * (1 / 60)) / Math.max(dt, 1 / 60)
        const ang = (a: any, b: any) => +((2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI).toFixed(0)
        const extra = { root: ang(rq, prev.root), chest: ang(cq, prev.chest), fore: ang(fq, prev.fore), carry: +body.carryW.toFixed(2), vis: body.torch.visible, held: body.torchHeld }
        M.frames++
        if (d > M.worst) {
          M.worst = d
          M.worstAt = `${M.label} t ${M.t.toFixed(2)} pitch ${((P.pitch * 180) / Math.PI).toFixed(0)} state ${body.debug.state}`
        }
        if (d > 30) {
          M.flags.push({ t: +M.t.toFixed(2), d: +d.toFixed(0), dh: +dh.toFixed(0), dt: +dtq.toFixed(0), dtw: +dtw.toFixed(0), pitch: +((P.pitch * 180) / Math.PI).toFixed(0), state: body.debug.state, ...extra })
          M.flagNow = true
        }
      }
      prev.hand.copy(h)
      prev.torch.copy(t)
      prev.twist = twist
      prev.root.copy(rq)
      prev.chest.copy(cq)
      prev.fore.copy(fq)
      prev.ok = true
      void now
    }
    requestAnimationFrame(step)
  })
  await load("view=corridor")
  const ev = <T>(src: string): Promise<T> => page.evaluate((src) => new Function("P", "B", "M", src)((globalThis as any).__afterhoursPlayer, (globalThis as any).__afterhoursBody, (globalThis as any).__flip), src) as Promise<T>
  const wait = (ms: number) => page.waitForTimeout(ms)
  type Sc = { name: string; place: string; keys: string[]; spin: number; sweep: number; during?: () => Promise<void> }
  const SC: Sc[] = [
    { name: "spawn", place: `P.teleport("corridor")`, keys: [], spin: 3, sweep: 1 },
    { name: "stand-spin", place: `P.pos.x=-11;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57`, keys: [], spin: 9, sweep: 1.7 },
    { name: "walk", place: `P.pos.x=-14;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57`, keys: ["KeyW"], spin: 5, sweep: 1.3 },
    { name: "run", place: `P.pos.x=-14;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57`, keys: ["KeyW", "ShiftLeft"], spin: 6, sweep: 2.1 },
    { name: "strafe-back", place: `P.pos.x=-11;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57`, keys: ["KeyS", "KeyA"], spin: 7, sweep: 1.9 },
    { name: "crouch", place: `P.pos.x=-14;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57`, keys: ["KeyC", "KeyW"], spin: 5, sweep: 1.5 },
    { name: "stairs", place: `P.pos.x=-42.28;P.pos.y=0.3;P.pos.z=17.4;P.yaw=Math.PI`, keys: ["KeyW"], spin: 0.4, sweep: 1.6 },
    {
      name: "ladder",
      place: `const l = P.ctx.ladders.find(l => l.min[0] < -55 && l.max[0] > -57.5) ?? P.ctx.ladders[0]; P.pos.x=-57.2; P.pos.y=0.3; P.pos.z=(l.min[2]+l.max[2])/2; P.yaw=-Math.PI/2`,
      keys: [],
      spin: 0,
      sweep: 0.8,
      during: async () => {
        await page.keyboard.down("KeyW")
        await wait(5200)
        await page.keyboard.up("KeyW")
        // Off the top: spin and sweep on the landing.
        await ev(`M.spin = 7; M.sweep = 1.7`)
        await wait(3500)
      },
    },
    {
      name: "mantle",
      place: `P.pos.x=0;P.pos.y=0.3;P.pos.z=14.1;P.yaw=0`,
      keys: [],
      spin: 0,
      sweep: 1.2,
      during: async () => {
        for (let i = 0; i < 2; i++) {
          await ev(`P.pos.x=0;P.pos.y=0.3;P.pos.z=14.1;P.yaw=0;P.resetMotion(); P.__rm?.(); const F = P.pos.y; P.__rm = B.testBox([-0.5, F, 13.0], [0.5, F + ${i ? 1.3 : 0.9}, 13.4])`)
          await wait(200)
          await page.keyboard.press("Space")
          await wait(1400)
          // Walk off the top, spinning.
          await ev(`M.spin = 8`)
          await page.keyboard.down("KeyW")
          await wait(900)
          await page.keyboard.up("KeyW")
          await ev(`M.spin = 0; P.__rm?.(); P.__rm = null`)
        }
      },
    },
  ]
  for (const sc of SC) {
    await ev(`${sc.place}; P.pitch=0; P.resetMotion(); P.flashlight = true; M.flags = []; M.frames = 0; M.worst = 0; M.t = 0; M.beamMax = 0; M.beamBad = 0; M.barrelMax = 0; M.label = ${JSON.stringify(sc.name)}; M.spin = ${sc.spin}; M.sweep = ${sc.sweep}`)
    await wait(500)
    await ev(`M.on = true`)
    for (const k of sc.keys) await page.keyboard.down(k)
    if (sc.during) await sc.during()
    else {
      const end = Date.now() + secs * 1000
      let shots = 0
      while (Date.now() < end) {
        const fl = await ev<boolean>(`const f = M.flagNow; M.flagNow = false; return f`)
        if (fl && shots < 2) {
          const f = `${tiles}/${sc.name}-flag${shots++}.png`
          await page.screenshot({ path: f })
          files.push(f)
        }
        await wait(60)
      }
    }
    for (const k of sc.keys) await page.keyboard.up(k)
    await ev(`M.on = false`)
    const r = await ev<{ frames: number; flags: unknown[]; worst: number; worstAt: string; beamMax: number; beamBad: number; beamAt: string; barrelMax: number }>(`return { frames: M.frames, flags: M.flags, worst: M.worst, worstAt: M.worstAt, beamMax: M.beamMax, beamBad: M.beamBad, beamAt: M.beamAt, barrelMax: M.barrelMax }`)
    results[sc.name] = { frames: r.frames, flags: r.flags.length, worst: +r.worst.toFixed(1), worstAt: r.worstAt, beamMax: +r.beamMax.toFixed(1), beamBad: r.beamBad, barrelMax: +r.barrelMax.toFixed(1) }
    console.log(sc.name, JSON.stringify(results[sc.name]), r.flags.length ? JSON.stringify(r.flags.slice(0, 4)) : "")
  }
  // After the intro: skip it (Space), then the seated body's unseat hand-over, torch on, spin and walk.
  {
    await load("intro&introAt=40&view=lot")
    await wait(1500)
    // The skip is a hold (src/game/intro/skip.ts).
    await page.keyboard.down("Space")
    await wait(1600)
    await page.keyboard.up("Space")
    await page.waitForFunction(() => !(globalThis as any).__afterhoursBody.body.seated, null, { timeout: 20_000 }).catch(() => {})
    await wait(2500)
    await ev(`P.flashlight = true; M.flags = []; M.frames = 0; M.worst = 0; M.t = 0; M.beamMax = 0; M.beamBad = 0; M.barrelMax = 0; M.label = "after-intro"; M.spin = 7; M.sweep = 1.5`)
    await wait(400)
    await ev(`M.on = true`)
    await page.keyboard.down("KeyW")
    await wait(secs * 1000)
    await page.keyboard.up("KeyW")
    await ev(`M.on = false`)
    const r = await ev<{ frames: number; flags: unknown[]; worst: number; worstAt: string; beamMax: number; beamBad: number; beamAt: string; barrelMax: number; seated: boolean }>(`return { frames: M.frames, flags: M.flags, worst: M.worst, worstAt: M.worstAt, beamMax: M.beamMax, beamBad: M.beamBad, beamAt: M.beamAt, barrelMax: M.barrelMax, seated: B.body.seated }`)
    results["after-intro"] = { frames: r.frames, flags: r.flags.length, worst: +r.worst.toFixed(1), worstAt: r.worstAt + (r.seated ? " (STILL SEATED)" : ""), beamMax: +r.beamMax.toFixed(1), beamBad: r.beamBad, barrelMax: +r.barrelMax.toFixed(1) }
    console.log("after-intro", JSON.stringify(results["after-intro"]))
  }
  // Sample strip (third person, looking down / up) when nothing was flagged.
  if (!files.length) {
    for (const [i, p] of [-1.3, -0.5, 0.4, 1.2].entries()) {
      await ev(`P.pos.x=-11;P.pos.y=0.1;P.pos.z=0.2;P.yaw=1.57;P.pitch=${p};P.resetMotion();B.settings["body.view"]=1;B.settings["body.thirdDist"]=1.6`)
      await wait(700)
      const f = `${tiles}/sample${i}.png`
      await page.screenshot({ path: f })
      files.push(f)
    }
    await ev(`B.settings["body.view"]=0`)
  }
} finally {
  await context.close()
  await browser.close()
}
const total = Object.values(results).reduce((a, r) => a + r.flags, 0)
const frames = Object.values(results).reduce((a, r) => a + r.frames, 0)
const beamBad = Object.values(results).reduce((a, r) => a + r.beamBad, 0)
const beamMax = Math.max(...Object.values(results).map((r) => r.beamMax))
const barrelMax = Math.max(...Object.values(results).map((r) => r.barrelMax))
console.log(`TOTAL flags ${total} over ${frames} frames; beam vs view: max ${beamMax.toFixed(1)}°, ${beamBad} frames over 3°; torch barrel vs view: max ${barrelMax.toFixed(1)}°`)
if (files.length) {
  const n = Math.min(files.length, 8)
  const f = files.slice(0, n)
  const cols = Math.min(4, n)
  const at = (k: number, s: string) => (k ? Array.from({ length: k }, () => s).join("+") : "0")
  const layout = f.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const dest = `${out}/flip-${tag}.png`
  const p = n === 1 ? Bun.spawnSync(["cp", f[0]!, dest]) : Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...f.flatMap((x) => ["-i", x]), "-filter_complex", `xstack=inputs=${n}:layout=${layout}${n % cols ? ":fill=black" : ""},scale=iw*0.5:-1`, dest])
  if (p.exitCode === 0) console.log(dest)
}
console.log(JSON.stringify({ errors }))
