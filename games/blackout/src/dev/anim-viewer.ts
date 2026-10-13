// Dev-only animation viewer (anim.html): scripted soldiers running, strafing, stopping, firing, reloading and dying,
// played through the real Game and Renderer. ?only=a,b picks actors, ?slow=0.25 slows time, ?zoom=9 sets the camera
// distance, ?manual stops the loop so window.advance(ms) can step it for frame captures.
import { GUNS, SPEED, SPRINT_SPEED, type Gun } from "../../shared/config"
import { raycast } from "../../shared/geom"
import type { MapDef } from "../../shared/maps"
import { Builder } from "../../shared/maps/builder"
import type { ClientMsg } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import { Sound } from "../audio/sound"
import { Game } from "../game/game"
import { Input } from "../game/input"
import type { Session } from "../game/session"
import { Camera } from "../render/camera"
import { Renderer } from "../render/renderer"
import { mat4 } from "wgpu-matrix"
import { IDLE_VIEW } from "../../shared/sim/modes"
import { DebugOverlay, juiceSettings } from "../ui/debug-overlay"
import { animation } from "../game/anim-settings"
import { Rng } from "../../shared/rng"
import { RigDemo, rigDemoControls } from "./rig-demo"
import { detachedSplatter } from "../game/human-splatter"
import { at } from "../game/rig"
import { RIG } from "../render/person"
import { wizardWeapon } from "../render/wizard"

const SEED = 990001
const W = 30
const H = 20

function room(): MapDef {
  const b = new Builder()
  b.floor("carpet", 0, 0, W, H)
  b.floor("tile", 18, 0, W, H)
  b.wall(0, 0, W, 0.3)
  b.wall(0, H - 0.3, W, H)
  b.wall(0, 0, 0.3, H)
  b.wall(W - 0.3, 0, W, H)
  b.wall(6, 4, 24, 4.3, 1.3, "partition")
  b.wall(26, 6, 26.3, 14)
  for (const [x, y] of [
    [7, 7],
    [13, 7],
    [19, 7],
    [7, 12],
    [13, 12],
    [19, 12],
    [25, 10],
  ] as const)
    b.light({ kind: "desk", x, y, h: 2.6, r: 7, power: 0.55, color: [0.8, 0.88, 1] })
  b.light({ kind: "desk", x: 10, y: 15, h: 1.05, r: 5, power: 0.5, color: [1, 0.72, 0.42] })
  b.spawns.push({ x: 15, y: 10 })
  return b.build({ id: "anim", seed: SEED, name: "Anim", size: [W, H] })
}

const MAP = room()

type Actor = {
  id: string
  gun: Gun
  /** Position, aim and whether alive at time t; and shots fired in (t0, t1]. */
  at(t: number): { x: number; y: number; aim: number; alive: boolean }
  shots?: (t: number) => number
  reloads?: (t: number) => number
}

const loop = (t: number, p: number) => ((t % p) + p) % p
const ease = (u: number) => u * u * (3 - 2 * u)

const ACTORS: Actor[] = [
  // Fixed-tick running study. Route is an automation input, not a presentation setting.
  { id: "running", gun: "rifle", at: (t) => {
    t = loop(t, 3)
    const route = new URLSearchParams(location.search).get("runRoute") ?? "run"
    const speed = route === "sprint" ? SPRINT_SPEED : SPEED
    let distance = speed * t
    if (route === "acceleration") {
      const u = Math.max(0, t - 0.3), ramp = Math.min(u, 0.7)
      distance = SPEED * (ramp * ramp / 1.4 + Math.max(0, u - 0.7))
    }
    if (route === "braking") {
      const u = Math.max(0, t - 1), ramp = Math.min(u, 0.7)
      distance = SPEED * (Math.min(t, 1) + ramp - ramp * ramp / 1.4)
    }
    const direction = route === "diagonal" ? Math.PI / 4 : 0
    return { x: 8 + Math.cos(direction) * distance, y: 10 + Math.sin(direction) * distance, aim: 0, alive: true }
  } },
  // Automation choreography: 2 seconds per beat, fixed root/aim and camera for both A/B paths.
  {
    id: "proof", gun: "rifle",
    at: (t) => {
      const beat = Math.min(8, Math.floor(t / 2)), u = t % 2
      const travel = Math.max(0, u - 0.15)
      let x = 12, y = 10, aim = 0
      if (beat === 0) x += travel * 1.4
      if (beat === 1) x += travel * SPRINT_SPEED
      if (beat === 2) y -= travel * 2
      if (beat === 3) y += travel * 2
      if (beat === 4) x -= travel * 1.5
      if (beat === 5) aim = travel * 2.5
      if (beat === 6) x += Math.min(travel, 0.85) * SPEED
      if (beat === 7) aim = Math.sin(u * 2) * 0.3
      if (beat === 8) x += Math.min(travel, 0.85) * 1.4
      return { x, y, aim, alive: beat !== 8 || u < 1.05 }
    },
    shots: (t) => t >= 14.25 && t < 15.25 ? Math.floor((t - 14.25) / 0.1) + 1 : 0,
  },
  // Runs a circle while aiming east: forward, strafe, backpedal.
  { id: "a", gun: "rifle", at: (t) => ({ x: 9 + Math.cos(t * 1.1) * 3, y: 10 + Math.sin(t * 1.1) * 3, aim: 0, alive: true }) },
  // Sprints east and west with hard stops, aiming where it runs.
  {
    id: "b",
    gun: "rifle",
    at: (t) => {
      const c = loop(t, 6)
      const leg = c < 3 ? c : c - 3
      const dir = c < 3 ? 1 : -1
      const u = Math.min(1, leg / 1.6)
      const x0 = dir > 0 ? 14 : 20
      return { x: x0 + dir * 6 * u, y: 15.5, aim: dir > 0 ? 0 : Math.PI, alive: true }
    },
  },
  // Rifle bursts with a reload every third burst.
  {
    id: "c",
    gun: "rifle",
    at: (t) => ({ x: 16, y: 8, aim: Math.sin(t * 0.4) * 0.5, alive: true }),
    shots: (t) => {
      const c = loop(t, 7.5)
      if (c > 4.5) return 0
      const b = loop(c, 1.5)
      return b < 0.6 ? Math.floor(b / 0.1) + 1 : 0
    },
    reloads: (t) => (loop(t, 7.5) > 4.6 ? 1 : 0),
  },
  { id: "d", gun: "shotgun", at: () => ({ x: 21, y: 10, aim: Math.PI - 0.3, alive: true }), shots: (t) => (loop(t, 6.5) < 3.4 ? Math.floor(loop(t, 6.5) / 0.85) + 1 : 0), reloads: (t) => (loop(t, 6.5) > 3.6 ? 1 : 0) },
  { id: "e", gun: "sniper", at: () => ({ x: 12, y: 8.5, aim: Math.PI + 0.25, alive: true }), shots: (t) => (loop(t, 7) < 3.6 ? Math.floor(loop(t, 7) / 1.25) + 1 : 0), reloads: (t) => (loop(t, 7) > 3.8 ? 1 : 0) },
  // Stands still and turns on the spot, then starts and stops.
  {
    id: "g",
    gun: "rifle",
    at: (t) => {
      const c = loop(t, 8)
      const aim = Math.floor(c / 1.2) * 1.4
      const run = c > 6 ? Math.min(1, (c - 6) / 0.9) : 0
      return { x: 9 + ease(run) * 4, y: 15.5, aim: c > 6 ? 0 : aim, alive: true }
    },
  },
  // Sprints across the room, stops and fires a burst, sprints back; "w" walks the same line at walk speed.
  ...(["s", "w"] as const).map(
    (id): Actor => ({
      id,
      gun: "rifle",
      at: (t) => {
        const v = id === "s" ? SPRINT_SPEED : SPEED
        const c = loop(t, 8)
        const leg = c < 4 ? c : c - 4
        const dir = c < 4 ? 1 : -1
        const run = Math.min(leg, 12 / v)
        const x0 = dir > 0 ? 8 : 20
        return { x: x0 + dir * v * run, y: id === "s" ? 12 : 15.5, aim: dir > 0 ? 0 : Math.PI, alive: true }
      },
      shots:
        id === "s"
          ? (t) => {
              const f = loop(t, 4) - 12 / SPRINT_SPEED - 0.3
              return f > 0 && f < 0.6 ? Math.floor(f / 0.1) + 1 : 0
            }
          : undefined,
    }),
  ),
  // Walks a little loop and keeps getting killed.
  {
    id: "f",
    gun: "rifle",
    at: (t) => {
      const c = loop(t, 5)
      return { x: 21 + Math.cos(t * 1.6) * 1.2, y: 14 + Math.sin(t * 1.6) * 1.2, aim: t * 1.6 + Math.PI / 2, alive: c < 1.5 }
    },
  },
  { id: "cast", gun: "rifle", at: () => ({ x: 16, y: 11, aim: 0, alive: true }) },
]

class ScriptSession implements Session {
  demo = false
  readonly room = null
  readonly myId = "viewer"
  t = 0
  private events: SimEvent[] = []
  private snap: { snap: Snapshot; at: number } | null = null
  private actors: Actor[]
  private prev = new Map<string, { x: number; y: number; shots: number; reloads: number; alive: boolean }>()
  private kills = 0

  constructor(only: string[] | null) {
    this.actors = ACTORS.filter((a) => only ? only.includes(a.id) : a.id !== "proof" && a.id !== "running")
  }

  latest() {
    return this.snap
  }
  roster(): RosterRow[] {
    return ACTORS.map((a) => ({ id: a.id, name: a.id, human: false, kills: 0, deaths: 0, team: -1, caps: 0, plants: 0, defuses: 0 }))
  }
  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }
  send(_m: ClientMsg): void {}
  status(): string | null {
    return null
  }
  close(): void {}

  update(dt: number): void {
    this.t += dt
    const t = this.t
    const players: Snapshot["players"] = []
    for (const a of this.demo ? [] : this.actors) {
      const s = a.at(t)
      const p = this.prev.get(a.id) ?? { x: s.x, y: s.y, shots: 0, reloads: 0, alive: s.alive }
      const cut = a.id === "proof" && Math.floor(t / 2) !== Math.floor((t - dt) / 2)
        || a.id === "running" && Math.floor(t / 3) !== Math.floor((t - dt) / 3)
      const vx = dt > 0 && !cut ? (s.x - p.x) / dt : 0
      const vy = dt > 0 && !cut ? (s.y - p.y) / dt : 0
      const shots = a.shots?.(t) ?? 0
      const reloads = a.reloads?.(t) ?? 0
      if (shots > p.shots) {
        const g = GUNS[a.gun]
        for (let k = 0; k < g.pellets; k++) {
          const spread = g.pellets > 1 ? ((k + 0.5) / g.pellets - 0.5) * 2 * g.spread : (Math.random() * 2 - 1) * g.spread
          const ang = s.aim + spread
          const dx = Math.cos(ang)
          const dy = Math.sin(ang)
          const stop = Math.min(g.range, raycast(s.x, s.y, dx, dy, MAP.walls.map((w) => w.rect), g.range))
          this.events.push({ k: "shot", by: a.id, x0: s.x, y0: s.y, x1: s.x + dx * stop, y1: s.y + dy * stop, hit: "" })
        }
      }
      if (reloads > p.reloads) this.events.push({ k: "reload", by: a.id })
      // Actor "a" takes a hit from the north every 1.3 s, to show the flinch.
      if (a.id === "a" && Math.floor(t / 1.3) > Math.floor((t - dt) / 1.3)) this.events.push({ k: "shot", by: "zz", x0: s.x, y0: s.y - 8, x1: s.x, y1: s.y, hit: "a" })
      if (p.alive && !s.alive) {
        const killer = this.actors.find((k) => k.id !== a.id && ["c", "d", "e"][this.kills % 3] === k.id) ?? this.actors.find((k) => k.id !== a.id)
        this.kills++
        if (killer || a.id === "proof") {
          const ks = killer?.at(t) ?? { x: s.x - 4, y: s.y - 2 }
          const d = Math.hypot(s.x - ks.x, s.y - ks.y) || 1
          const dx = (s.x - ks.x) / d
          const dy = (s.y - ks.y) / d
          this.events.push({ k: "shot", by: killer?.id ?? "fixture", x0: ks.x, y0: ks.y, x1: s.x, y1: s.y, hit: a.id })
          this.events.push({ k: "kill", killer: killer?.id ?? "fixture", victim: a.id, dx, dy, how: killer?.gun ?? "rifle" })
        }
      }
      this.prev.set(a.id, { x: s.x, y: s.y, shots, reloads, alive: s.alive })
      players.push({ id: a.id, x: s.x, y: s.y, vx, vy, aim: s.aim, alive: s.alive, gun: a.gun, health: 100 })
    }
    this.snap = { snap: { type: "snap", tick: Math.floor(t * 30), t, ack: 0, phase: "play", left: 300, map: SEED, mapKind: "office", maps: "office", players, grenades: [], claymores: [], mode: IDLE_VIEW, you: null }, at: performance.now() }
  }
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  const device = await adapter!.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)
  const params = new URLSearchParams(location.search)
  const only = params.get("only")?.split(",") ?? null
  const slow = Number(params.get("slow") ?? "1")
  const zoom = Number(params.get("zoom") ?? "15")
  const manual = params.has("manual")
  if (manual) { const rng = new Rng(7); Math.random = () => rng.next() }
  const weapons = only?.[0] === "weapons" ? (["rifle", "shotgun", "sniper"] as const).map((gun) => renderer.addModel(wizardWeapon(gun))) : []
  const session = new ScriptSession(only)
  const sound = new Sound()
  const settings = { ...juiceSettings(!params.has("vanilla")), rigDemo: "off", rigDemoSpeed: 1.1 }
  const game = new Game(renderer, session, sound, settings)
  ;(game as unknown as { load(m: MapDef): void }).load(MAP)
  const input = new Input(canvas)
  new DebugOverlay(settings, params, () => input.release(), rigDemoControls)
  let detachId = 0x60000000
  const rigDemo = new RigDemo(renderer, part => detachedSplatter(event => game.cosmeticSplatter(event), part,
    { id: detachId++, seed: SEED, direction: [1, 0.2, 0], amount: 1 }))
  const side = params.get("side")
  const cam = new Camera()
  if (side !== null) {
    // Orbit camera for inspecting poses: ?side=<yaw degrees>&elev=<degrees>.
    const yaw = (Number(side) * Math.PI) / 180
    const elev = (Number(params.get("elev") ?? "12") * Math.PI) / 180
    cam.update = (aspect: number) => {
      const target = [cam.x, 1.15, cam.z]
      const d = cam.dist
      cam.eye = [target[0]! + Math.sin(yaw) * Math.cos(elev) * d, 1.15 + Math.sin(elev) * d, target[2]! + Math.cos(yaw) * Math.cos(elev) * d]
      const view = mat4.lookAt(cam.eye, target, [0, 1, 0])
      cam.viewProj = mat4.multiply(mat4.perspective(0.5, aspect, 0.5, 200), view)
      return cam.viewProj as Float32Array
    }
  }
  const focus = { x: Number(params.get("x") ?? "16"), y: Number(params.get("y") ?? "10") }
  cam.snap(focus.x, focus.y)
  cam.dist = zoom
  const resize = () => {
    canvas.width = Math.floor(innerWidth * Math.min(devicePixelRatio, 1.5))
    canvas.height = Math.floor(innerHeight * Math.min(devicePixelRatio, 1.5))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)
  let clock = 0
  const info = document.getElementById("info")!
  const frame = (dt: number) => {
    if (only?.includes("proof") && Math.floor((session.t + dt) / 2) !== Math.floor(session.t / 2)) game.avatars.delete("proof")
    if (only?.includes("running") && Math.floor((session.t + dt) / 3) !== Math.floor(session.t / 3)) game.avatars.delete("running")
    clock += dt * 1000
    session.demo = settings.rigDemo !== "off"
    if (session.demo) game.avatars.clear()
    game.update(dt, input, cam, innerWidth, innerHeight, clock)
    const fid = params.get("follow") ?? (only?.length === 1 ? only[0] : null)
    const lead = fid ? session.latest()?.snap.players.find((p) => p.id === fid) : undefined
    if (lead && !params.has("x")) cam.snap(lead.x, lead.y)
    else cam.follow(focus.x, focus.y, 0, 0, dt, false)
    cam.dist = zoom
    const demoBatches = rigDemo.build(dt, settings.rigDemo, settings.rigDemoSpeed)
    if (session.demo) cam.snap(rigDemo.avatar.x, rigDemo.avatar.y)
    // Reuse the rig's existing free-hand throw for a casting pose study.
    const caster = game.avatars.get("cast")
    if (settings.wizards && caster) caster.throwAt = Math.floor(session.t / 3) * 3 + 0.2
    const f = game.build(cam, innerWidth, innerHeight, dt)
    f.batches.push(...demoBatches)
    f.grade[1] = 0 // The viewer is a spectator, not a dead player; inspect the actual team colours.
    for (const [i, model] of weapons.entries()) f.batches.push({ model, count: 1, data: new Float32Array([focus.x + (i - 1) * 1.5, 1.2, focus.y, 0, 1, 1, 1, 1, 0, 0, 1, 0]) })
    renderer.render(f)
    const beats = ["Walk", "Run", "Strafe left", "Strafe right", "Backpedal", "Turn in place", "Hard stop", "Recoil", "Death"]
    if (session.demo) info.textContent = ""
    else if (only?.includes("proof")) info.textContent = `${animation.animationMode === "old" ? "Old" : "New"} · ${beats[Math.min(8, Math.floor(session.t / 2))]}`
  }
  const w = window as unknown as { advance(ms: number): Promise<void>; ready: boolean }
  w.advance = async (ms: number) => {
    const n = Math.max(1, Math.round(ms / (1000 / 60)))
    for (let i = 0; i < n; i++) frame((1 / 60) * slow)
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(r))
  }
  // Renders frames and tiles them into one image over the page, so a single screenshot captures a sequence.
  ;(window as unknown as { sheet: unknown }).sheet = (start: number, step: number, n: number, cols: number, clip: [number, number, number, number] | null) => {
    // Clip is in fractions of the view; tiles are in canvas pixels.
    const [cx, cy, cw, ch] = (clip ?? [0, 0, 1, 1]).map((v, i) => v * (i % 2 ? canvas.height : canvas.width)) as [number, number, number, number]
    const rows = Math.ceil(n / cols)
    const f = Math.min(1, canvas.width / (cw * cols), canvas.height / (ch * rows))
    const tw = Math.floor(cw * f)
    const th = Math.floor(ch * f)
    const out = document.createElement("canvas")
    out.width = tw * cols
    out.height = th * rows
    const g = out.getContext("2d")!
    const stepTo = (ms: number) => {
      const k = Math.max(1, Math.round(ms / (1000 / 60)))
      for (let i = 0; i < k; i++) frame((1 / 60) * slow)
    }
    stepTo(start)
    for (let i = 0; i < n; i++) {
      if (i > 0) stepTo(step)
      const x = (i % cols) * tw
      const y = Math.floor(i / cols) * th
      g.drawImage(canvas, cx, cy, cw, ch, x, y, tw, th)
      g.strokeStyle = "#fff"
      g.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1)
    }
    return out.toDataURL("image/jpeg", 0.9)
  }
  w.ready = true
  Object.assign(window, { animProof: { game, session, animation, settings, rigDemo, adapter: adapter!.info, step: frame,
    sample: () => {
      const a = game.avatars.get("running")
      if (!a?.body) return null
      const b = a.body
      const angles = (f: typeof b.pelvis) => ({ pitch: Math.atan2(f.x[1], Math.hypot(f.x[0], f.x[2])), roll: Math.asin(Math.max(-1, Math.min(1, -f.z[1]))), yaw: Math.atan2(f.x[2], f.x[0]) })
      return { time: session.t, root: [a.x, a.y], velocity: [a.vx, a.vy], aim: a.aim, phase: a.phase, duty: a.duty,
        feet: a.feet, motion: a.motion, pelvis: angles(b.pelvis), chest: angles(b.torso), head: angles(b.head),
        pelvisPosition: b.pelvis.p, headPosition: b.head.p, shoulders: [at(b.torso, 0, RIG.shoulderY, -RIG.shoulderW), at(b.torso, 0, RIG.shoulderY, RIG.shoulderW)],
        boots: b.ft, gun: b.gun, lean: [a.leanX.x, a.leanY.x], seed: a.seed }
    },
  } })
  if (manual) return
  let last = performance.now()
  let fps = 60
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05
    info.textContent = `t ${session.t.toFixed(2)}  fps ${fps.toFixed(0)}`
    frame(dt * slow)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
