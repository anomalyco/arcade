// Dev-only harness: builds realistic frames for visual checks. Open render-harness.html?scene=impact|aim|collapse|units
import type { Frame, LiveProjectile } from "../contracts"
import type { MatchView, SimEvent, Unit } from "../../sim/protocol"
import { carveCircle, generateTerrain, spawnPoints, surfaceY, WORLD_W } from "../../sim/terrain"
import { GRAVITY, launchVelocity, muzzle, WIND_ACCEL } from "../../sim/volley"
import type { WeaponId } from "../../sim/weapons"
import { createRenderer } from "./index"

const params = new URLSearchParams(location.search)
const scene = params.get("scene") ?? "impact"
const seed = Number(params.get("seed") ?? 7)
const canvas = document.getElementById("world") as HTMLCanvasElement
const renderer = createRenderer(canvas)
const dpr = Number(params.get("dpr") ?? window.devicePixelRatio ?? 1)
renderer.resize(window.innerWidth, window.innerHeight, dpr)

const NAMES = ["vex", "kilo", "ash", "mara", "juno", "rook", "pike", "nova"]
const xs = spawnPoints(seed, 8)
const mask = generateTerrain(seed, xs)
// battle scars: craters and a tunnel
carveCircle(mask, xs[2]! + 60, surfaceY(mask, xs[2]! + 60) + 4, 22)
carveCircle(mask, xs[5]! - 50, surfaceY(mask, xs[5]! - 50) + 2, 16)
for (let i = 0; i < 14; i++) carveCircle(mask, 300 + i * 6, 430 + Math.sin(i / 3) * 6, 9)

const wind = scene === "aim" ? 26 : -12
const angles = [0.95, 0.75, 2.2, 0.6, 2.4, 1.1, 0.9, 2.5]
const units: Unit[] = xs.map((x, i) => ({
  id: i,
  team: i,
  name: NAMES[i]!,
  x,
  y: surfaceY(mask, x),
  hp: i === 3 ? 30 : 100,
  maxHp: 100,
  alive: !(scene === "impact" && i === 6),
  kills: 0,
  ammo: {} as Record<WeaponId, number>,
  shield: i === 1 ? 40 : 0,
  boost: 0,
  fuel: 100,
  angle: angles[i]!,
}))

function path(u: Unit, angle: number, power: number, steps: number): number[] {
  const m = muzzle(u, angle)
  const v = launchVelocity(angle, power)
  let x = m.x
  let y = m.y
  let vx = v.vx
  let vy = v.vy
  const pts = [x, y]
  const dt = 1 / 60
  for (let i = 0; i < steps; i++) {
    vx += wind * WIND_ACCEL * dt
    vy += GRAVITY * dt
    x += vx * dt
    y += vy * dt
    pts.push(x, y)
    if (y > 640 || x < -50 || x > WORLD_W + 50) break
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (iy >= 0 && ix >= 0 && ix < WORLD_W && mask[iy * WORLD_W + ix] === 1) break
  }
  return pts
}

function proj(id: number, owner: number, kind: LiveProjectile["kind"], power: number, steps: number): LiveProjectile {
  const u = units[owner]!
  const pts = path(u, u.angle, power, steps)
  const n = pts.length / 2
  const x = pts[pts.length - 2]!
  const y = pts[pts.length - 1]!
  const px = pts[pts.length - 4] ?? x
  const py = pts[pts.length - 3] ?? y
  return { id, owner, kind, x, y, vx: (x - px) * 60, vy: (y - py) * 60, trail: pts.slice(Math.max(0, (n - 70) * 2), -2) }
}

const view: MatchView = {
  room: "harness",
  mode: "ffa",
  phase: scene === "aim" ? "aim" : "resolve",
  phaseEndsAt: 0,
  now: 0,
  battle: 1,
  battles: 3,
  volley: 2,
  seed,
  wind,
  hazardY: scene === "collapse" ? 600 : 9999,
  units,
  players: [],
  crates: [
    { id: 1, x: xs[4]! + 40, y: 160, kind: "shield", landed: false },
    { id: 2, x: xs[1]! + 50, y: surfaceY(mask, xs[1]! + 50), kind: "credits", landed: true },
  ],
  ghosts: [],
  battleWinner: null,
  matchWinner: null,
}

const frame: Frame = {
  now: 0,
  dt: 1 / 60,
  view,
  you: "p0",
  yourUnit: 0,
  units,
  aim: scene === "aim" ? { angle: units[0]!.angle, power: 62, weapon: "shell" } : null,
  preview: null,
  ghostArcs: [],
  ghosts: [],
  projectiles: [],
  chunks: [],
  fires: [],
  wells: [],
  timeScale: 1,
  resolving: scene !== "aim" && params.get("still") !== "1",
}

renderer.setTerrain(mask)

const timeline: Array<{ at: number; ev: SimEvent }> = []
const powers = [64, 70, 58, 72, 66, 60, 50, 68]

if (scene === "aim") {
  frame.preview = path(units[0]!, units[0]!.angle, 62, 70)
  frame.ghostArcs = units.slice(1).map((u, i) => ({ unit: u.id, pts: path(u, u.angle, powers[i + 1]!, 40 + i * 4), locked: i % 2 === 0 }))
} else if (scene === "impact") {
  frame.projectiles = [
    proj(1, 0, "shell", 64, 95),
    proj(2, 1, "drill", 70, 80),
    proj(3, 2, "cluster", 58, 70),
    proj(4, 4, "gravity", 66, 85),
    proj(5, 5, "shell", 60, 110),
    proj(6, 7, "napalm", 68, 60),
    proj(7, 3, "buster", 72, 50),
  ]
  const b = (at: number, ev: SimEvent) => timeline.push({ at, ev })
  const hx = xs[4]! + 70
  const hy = surfaceY(mask, hx)
  b(0, { t: 0, type: "boom", x: hx, y: hy, r: 30, kind: "shell", owner: 3 })
  b(0, { t: 0, type: "carve", x: hx, y: hy, r: 24 })
  b(150, { t: 0, type: "collide", x: 520, y: 150 })
  b(80, { t: 0, type: "boom", x: xs[6]! - 30, y: surfaceY(mask, xs[6]! - 30), r: 16, kind: "cluster", owner: 2 })
  b(200, { t: 0, type: "boom", x: xs[6]! + 5, y: surfaceY(mask, xs[6]! + 5), r: 16, kind: "cluster", owner: 2 })
  b(260, { t: 0, type: "boom", x: xs[6]! + 30, y: surfaceY(mask, xs[6]! + 30), r: 16, kind: "cluster", owner: 2 })
  b(60, { t: 0, type: "hit", unit: 6, amount: 44, x: xs[6]!, y: surfaceY(mask, xs[6]!) - 7, killer: 2, kill: true })
  b(250, { t: 0, type: "hit", unit: 3, amount: 22, x: xs[3]!, y: surfaceY(mask, xs[3]!) - 7, killer: 0, kill: false })
  b(120, { t: 0, type: "absorb", unit: 1, amount: 18 })
} else if (scene === "collapse") {
  const cx = xs[3]!
  const sy = surfaceY(mask, cx)
  for (let i = 0; i < 10; i++) carveCircle(mask, cx - 50 + i * 10, sy + 30, 12)
  renderer.setTerrain(mask)
  // falling slab
  const w = 60
  const h = 26
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  const cg = c.getContext("2d")!
  cg.fillStyle = "#fff"
  cg.beginPath()
  cg.moveTo(0, 6)
  cg.lineTo(20, 0)
  cg.lineTo(60, 4)
  cg.lineTo(52, 26)
  cg.lineTo(8, 22)
  cg.fill()
  frame.chunks = [{ id: 1, canvas: c, x: cx - 30, y: sy + 8 }]
  frame.fires = [{ x0: xs[5]! - 30, x1: xs[5]! + 20, y: surfaceY(mask, xs[5]! - 5), until: 1e9 }]
  frame.wells = [{ x: xs[6]! - 60, y: 260, r: 46, until: 1e9 }]
  frame.projectiles = [proj(1, 0, "shell", 70, 120), proj(2, 7, "teleport", 60, 60)]
  timeline.push({ at: 0, ev: { t: 0, type: "chunk", id: 1, x: cx - 30, y: sy + 8, w, h, bits: "", dy: 30, dur: 600 } })
  timeline.push({ at: 50, ev: { t: 0, type: "boom", x: cx + 10, y: sy + 20, r: 22, kind: "buster", owner: 0 } })
  timeline.push({ at: 200, ev: { t: 0, type: "builder", x: xs[2]! + 40, y: surfaceY(mask, xs[2]! + 40) - 30, w: 14, h: 30 } })
  timeline.push({ at: 100, ev: { t: 0, type: "fall", unit: 3, x: cx, y: sy, dy: 30, dmg: 8 } })
} else if (scene === "weapons") {
  const kinds: WeaponId[] = ["shell", "cluster", "drill", "napalm", "gravity", "builder", "airstrike", "bouncer", "buster", "mirv"]
  const delay = Number(params.get("d") ?? 150)
  kinds.forEach((k, i) => {
    const x = 70 + i * 117
    const y = surfaceY(mask, x)
    timeline.push({ at: 0, ev: { t: 0, type: "boom", x, y: y - 2, r: k === "cluster" ? 16 : 28, kind: k, owner: i % 8 } })
    if (k === "builder") timeline.push({ at: 0, ev: { t: 0, type: "builder", x: x - 8, y: y - 30, w: 16, h: 30 } })
    if (k === "napalm") timeline.push({ at: 0, ev: { t: 0, type: "fire", x0: x - 30, x1: x + 30, y, dur: 3000, owner: 3 } })
  })
  timeline.push({ at: 0, ev: { t: 0, type: "collide", x: 600, y: 150 } })
  timeline.push({ at: 0, ev: { t: 0, type: "teleport", unit: 0, x0: 300, y0: 200, x: 900, y: 200 } })
  frame.fires = [{ x0: 70 + 3 * 117 - 30, x1: 70 + 3 * 117 + 30, y: surfaceY(mask, 70 + 3 * 117), until: 1e9 }]
  frame.wells = [{ x: 70 + 4 * 117, y: surfaceY(mask, 70 + 4 * 117) - 50, r: 46, until: 1e9 }]
  for (const u of units) u.alive = false
  units.length = 0
  void delay
} else if (scene === "units") {
  for (const u of units) u.alive = true
}

// run the timeline with a fixed clock so screenshots are reproducible
const total = Number(params.get("t") ?? (scene === "impact" ? 420 : scene === "collapse" ? 330 : scene === "weapons" ? 130 : 200))
let t = 0
const step = 1000 / 60
const sorted = timeline.sort((a, b) => a.at - b.at)
let ti = 0
function tick(): void {
  while (ti < sorted.length && sorted[ti]!.at <= t) {
    const ev = sorted[ti]!.ev
    if (ev.type === "carve") {
      carveCircle(mask, ev.x, ev.y, ev.r)
      renderer.terrainChanged(ev.x - ev.r, ev.y - ev.r, ev.x + ev.r, ev.y + ev.r)
    }
    renderer.event(ev, frame)
    ti++
  }
  frame.now = t
  renderer.draw(frame)
  t += step
}
const live = params.get("live") === "1"
if (params.get("bench") === "1") {
  setTimeout(() => {
    while (t <= total) tick()
    const t0 = performance.now()
    for (let i = 0; i < 60; i++) tick()
    const t1 = performance.now()
    for (let i = 0; i < 60; i++) {
      const x = 200 + i * 13
      const y = 380 + (i % 5) * 10
      carveCircle(mask, x, y, 14)
      renderer.terrainChanged(x - 14, y - 14, x + 14, y + 14)
      renderer.draw(frame)
    }
    const t2 = performance.now()
    document.title = "ready"
    console.warn(`bench draw ${((t1 - t0) / 60).toFixed(2)}ms/frame, draw+carve ${((t2 - t1) / 60).toFixed(2)}ms/frame`)
  }, 600)
} else if (live) {
  const loop = () => {
    tick()
    requestAnimationFrame(loop)
  }
  loop()
} else {
  // let the backdrop plate decode first
  setTimeout(() => {
    while (t <= total) tick()
    document.title = "ready"
  }, 600)
}
window.addEventListener("resize", () => renderer.resize(window.innerWidth, window.innerHeight, dpr))
