// Silent proof that the Lab plays the games' own audio. Each case renders the game's path and the Lab adapter's path
// into separate OfflineAudioContexts (never connected to a device) from identical input, then compares the node graph,
// every AudioParam automation call and the rendered samples.
//   bun games/lab/scripts/prove-game-audio.ts [--out dir]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const repo = resolve(root, "../..")
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const out = resolve(arg("--out") ?? resolve(repo, "captures/unified-lab"))
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), base: "/arcade/lab/", server: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("No port")
const base = `http://127.0.0.1:${address.port}/arcade/lab`
const browser = await chromium.launch({ executablePath, headless: true, args: ["--mute-audio", "--autoplay-policy=user-gesture-required"] })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  await page.goto(`${base}/sfx/ui_click.mp3`)
  const fs = (path: string) => `${base}/@fs${resolve(repo, path)}`
  const result = await page.evaluate(async modules => {
    type Log = { nodes: string[]; edges: string[]; params: string[] }
    // Record every node, connection and AudioParam automation made on one context, in order.
    const record = (ctx: BaseAudioContext): Log => {
      const log: Log = { nodes: [], edges: [], params: [] }
      const ids = new WeakMap<object, string>()
      const proto = BaseAudioContext.prototype as unknown as Record<string, unknown>
      for (const key of Object.getOwnPropertyNames(BaseAudioContext.prototype)) {
        if (!key.startsWith("create") || typeof proto[key] !== "function") continue
        const original = proto[key] as (...a: unknown[]) => unknown
        Object.defineProperty(ctx, key, { configurable: true, value: (...args: unknown[]) => {
          const node = original.apply(ctx, args)
          if (node instanceof AudioNode) {
            const id = `${log.nodes.length}:${node.constructor.name}`
            ids.set(node, id); log.nodes.push(id)
            for (const name of ["frequency", "detune", "Q", "gain", "pan", "playbackRate", "threshold", "knee", "ratio", "attack", "release", "offset"]) {
              const param = (node as unknown as Record<string, unknown>)[name]
              if (param instanceof AudioParam) ids.set(param, `${id}.${name}`)
            }
          }
          return node
        } })
      }
      const connect = AudioNode.prototype.connect
      AudioNode.prototype.connect = function (this: AudioNode, target: AudioNode | AudioParam, ...rest: number[]) {
        if (this.context === ctx) log.edges.push(`${ids.get(this) ?? "?"}->${ids.get(target) ?? (target === ctx.destination ? "destination" : "?")}`)
        return (connect as (...a: unknown[]) => AudioNode).call(this, target, ...rest)
      } as typeof connect
      for (const method of ["setValueAtTime", "setTargetAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "cancelScheduledValues", "cancelAndHoldAtTime"] as const) {
        const original = AudioParam.prototype[method] as (...a: number[]) => AudioParam
        ;(AudioParam.prototype as unknown as Record<string, unknown>)[method] = function (this: AudioParam, ...args: number[]) {
          const id = ids.get(this)
          if (id) log.params.push(`${id} ${method}(${args.map(v => Number(v.toFixed(6))).join(",")})`)
          return original.apply(this, args)
        }
      }
      return log
    }
    const restore = (() => {
      const connect = AudioNode.prototype.connect
      const params = Object.fromEntries((["setValueAtTime", "setTargetAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "cancelScheduledValues", "cancelAndHoldAtTime"] as const).map(m => [m, AudioParam.prototype[m]]))
      return () => { AudioNode.prototype.connect = connect; Object.assign(AudioParam.prototype, params) }
    })()
    const compare = async (a: { ctx: OfflineAudioContext; log: Log }, b: { ctx: OfflineAudioContext; log: Log }) => {
      const [ra, rb] = [await a.ctx.startRendering(), await b.ctx.startRendering()]
      let maxDiff = 0, peak = 0
      for (let c = 0; c < 2; c++) {
        const x = ra.getChannelData(c), y = rb.getChannelData(c)
        for (let i = 0; i < x.length; i++) { maxDiff = Math.max(maxDiff, Math.abs(x[i]! - y[i]!)); peak = Math.max(peak, Math.abs(x[i]!)) }
      }
      const same = (p: string[], q: string[]) => p.length === q.length && p.every((v, i) => v === q[i])
      // The first oscillator is the engine's firing tone: its targets over 1.5–2 s show the held RPM.
      const firing = a.log.nodes.find(n => n.endsWith(":OscillatorNode"))
      const held = new Set(a.log.params.filter(p => p.startsWith(`${firing}.frequency setTargetAtTime(`)).map(p => p.slice(p.indexOf("(") + 1, -1).split(",").map(Number)).filter(([, t]) => t! >= 1.5 && t! < 2).map(([hz]) => hz))
      return { nodes: a.log.nodes.length, edges: a.log.edges.length, params: a.log.params.length, sameNodes: same(a.log.nodes, b.log.nodes), sameEdges: same(a.log.edges, b.log.edges), sameParams: same(a.log.params, b.log.params), peak, maxDiff,
        maxDiffDb: maxDiff ? 20 * Math.log10(maxDiff) : -Infinity, heldRpm: held.size ? [Math.min(...held) * 120, Math.max(...held) * 120] : [] }
    }
    const seeded = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296 }

    // Getaway: the game's own offline render path (`renderOffline`'s construction) against the Lab adapter.
    const [{ AudioEngine }, { GameAudio }, { getawayLabAudio }, { Camera }, { generateCity }] = await Promise.all(modules.getaway.map(m => import(m)))
    const camera = new Camera(), right = camera.axes().right as [number, number]
    const fps = 60, seconds = 3, length = (seconds + 1) * 48000
    const frames: { car: Record<string, unknown>; input: Record<string, unknown> }[] = []
    let x = 0
    for (let i = 0; i < fps * seconds; i++) {
      const t = i / fps, sliding = t >= 2
      // Two seconds at a steady 18 m/s and 60% throttle (fixed RPM once the gearbox settles), then a handbrake slide.
      const speed = 18, drift = sliding ? 7 : 0
      x += speed / fps
      frames.push({
        car: { id: 1, ownerId: "lab", name: "Lab", role: "robber", vehicle: "muscle", x, z: 0, h: Math.PI / 2, vx: speed, vz: 0, y: 0, speed, drift, slide: sliding ? 0.6 : 0, boost: 1, impact: 0, ghost: false, human: true, stun: 0 },
        input: { throttle: 0.6, brake: 0, steer: sliding ? 0.6 : 0, handbrake: sliding, boost: false },
      })
    }
    const view = (t: number, car: unknown) => ({ t, round: 0, phase: "headstart", phaseT: 0, robberId: "lab", bust: 0, best: 0, survived: 0, busted: false, heli: { active: false, x: 0, z: 0, y: 0, lock: 0 }, cars: [car] })
    const city = generateCity(7)
    const run = async (lab: boolean) => {
      const ctx = new OfflineAudioContext(2, length, 48000)
      const log = record(ctx)
      const oldRandom = Math.random
      let engine: InstanceType<typeof AudioEngine>
      let update: (i: number) => void
      if (!lab) {
        engine = new AudioEngine(ctx)
        await engine.loadOffline()
        const sound = new GameAudio(undefined, city, engine)
        update = i => { camera.fx = frames[i]!.car.x as number; camera.fz = 0; sound.update(view(i / fps, frames[i]!.car), { myId: "lab", cam: camera, dt: 1 / fps, events: [], input: frames[i]!.input }) }
        Math.random = seeded(1337)
        try { for (let i = 0; i < frames.length; i++) { engine.scheduleTime = i / fps; update(i) } } finally { Math.random = oldRandom }
        engine.scheduleTime = seconds; sound.reset(); engine.master.gain.setTargetAtTime(0, seconds, 0.12)
      } else {
        const adapter = getawayLabAudio({ city })
        engine = adapter.engine
        await adapter.attach(ctx)
        adapter.mix({ muted: false, volume: 1, vehicles: 1, effects: 1, ambience: 1, ui: 1 })
        Math.random = seeded(1337)
        try {
          for (let i = 0; i < frames.length; i++) {
            engine.scheduleTime = i / fps
            adapter.update({ dt: 1 / fps, listener: { x: frames[i]!.car.x as number, z: 0, rightX: right[0], rightZ: right[1] }, ambience: 0.8, characters: [{ id: "getaway:muscle", state: { car: frames[i]!.car, input: frames[i]!.input } }] })
          }
        } finally { Math.random = oldRandom }
        engine.scheduleTime = seconds; adapter.silence(); engine.master.gain.setTargetAtTime(0, seconds, 0.12)
      }
      return { ctx, log }
    }
    const gameRun = await run(false)
    const labRun = await run(true)
    const getaway = await compare(gameRun, labRun)

    // Blackout: the game's Sound as `Game.cues` and `Game.explode` drive it, against the Lab adapter.
    const [{ Sound }, { blackoutLabAudio }, { EV }, { SPEED, SPRINT_SPEED }] = await Promise.all(modules.blackout.map(m => import(m)))
    class Running extends OfflineAudioContext { override get state() { return "running" as AudioContextState } override resume() { return Promise.resolve() } }
    const blackoutRun = async (lab: boolean) => {
      const ctx = new Running(2, 3 * 48000, 48000)
      const log = record(ctx)
      const oldRandom = Math.random
      Math.random = seeded(7)
      try {
        const steps = [EV.step, EV.step | EV.magOut, EV.step, EV.charge]
        if (!lab) {
          const sound = new Sound()
          sound.start(ctx as unknown as AudioContext)
          for (const ev of steps) { if (ev & EV.step) sound.step(0, 0, true, Math.min(SPRINT_SPEED, 5) / SPEED); sound.cue(ev, "rifle", 0, 0, true) }
          sound.explode(6, -3, "frag")
          sound.shot("shotgun", 4, 2, true)
        } else {
          const adapter = blackoutLabAudio()
          adapter.mix({ muted: false, volume: 1, vehicles: 1, effects: 1, ambience: 1, ui: 1 })
          adapter.attach(ctx)
          for (const ev of steps) adapter.update({ dt: 1 / 60, listener: { x: 0, z: 0, rightX: 1, rightZ: 0 }, ambience: 0, characters: [{ id: "blackout:soldier", state: { ev, gun: "rifle", speed: 5 } }] })
          adapter.event!({ type: "effect", section: "blackout-effects", effect: "explosion", x: 6, y: 0, z: -3 }, { x: 0, z: 0 })
          adapter.event!({ type: "effect", section: "blackout-effects", effect: "muzzle", settings: { weapon: "shotgun" }, x: 4, y: 0, z: 2 }, { x: 0, z: 0 })
        }
      } finally { Math.random = oldRandom }
      return { ctx, log }
    }
    const blackout = await compare(await blackoutRun(false), await blackoutRun(true))
    restore()
    return { getaway, blackout }
  }, {
    getaway: ["games/getaway/src/audio/engine.ts", "games/getaway/src/audio/game-audio.ts", "games/getaway/src/lab/audio.ts", "games/getaway/src/game/camera.ts", "games/getaway/shared/sim/city.ts"].map(fs),
    blackout: ["games/blackout/src/audio/sound.ts", "games/blackout/src/lab/audio.ts", "games/blackout/src/game/anim.ts", "games/blackout/shared/config.ts"].map(fs),
  })
  writeFileSync(resolve(out, "game-audio-proof.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  for (const [name, r] of Object.entries(result)) {
    assert(r.sameNodes && r.sameEdges && r.sameParams, `${name}: graph or automation differs`)
    assert(r.peak > 0.001, `${name}: rendered silence`)
    // Same graph and automation; the renderer itself may differ by a float rounding step (below -120 dBFS).
    assert(r.maxDiff <= 1e-6, `${name}: samples differ by ${r.maxDiff}`)
  }
  const [low, high] = result.getaway.heldRpm
  assert(low! > 1000 && high! - low! < 1, `engine held at one RPM: ${result.getaway.heldRpm}`)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
