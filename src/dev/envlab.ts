// Dev-only environment viewer (envlab.html): a generated office floor through the real Game and Renderer, with a few
// soldiers standing about. ?seed=N picks the floor, ?x=&y= centre the camera, ?light=K centres on the K-th light of
// ?kind=panel|desk|exit|..., ?zoom=17 sets the distance, ?big=1 builds a 160 m stress floor. window.goto(x, y) moves.
import type { MapDef } from "../../shared/maps"
import { getMap } from "../../shared/maps"
import type { ClientMsg } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import { Sound } from "../audio/sound"
import { Game } from "../game/game"
import { Input } from "../game/input"
import type { Session } from "../game/session"
import { Camera } from "../render/camera"
import { Renderer } from "../render/renderer"

/** Tiles a floor into a big grid of copies, to stress culling (lights, occluders, chunks). */
function bigMap(base: MapDef, n: number): MapDef {
  const [W, H] = base.size
  const out = { ...base, size: [W * n, H * n] as const, floors: [] as MapDef["floors"][number][], walls: [] as MapDef["walls"][number][], windows: [] as MapDef["windows"][number][], glass: [] as MapDef["glass"][number][], props: [] as MapDef["props"][number][], lights: [] as MapDef["lights"][number][], tape: [] as MapDef["tape"][number][], spawns: [] as MapDef["spawns"][number][] }
  const r = (q: readonly number[], dx: number, dy: number) => [q[0]! + dx, q[1]! + dy, q[2]! + dx, q[3]! + dy] as const
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const dx = i * W
      const dy = j * H
      const lo = out.lights.length
      for (const f of base.floors) out.floors.push({ ...f, rect: r(f.rect, dx, dy) })
      for (const w of base.walls) out.walls.push({ ...w, rect: r(w.rect, dx, dy) })
      for (const p of base.props) out.props.push({ ...p, rect: r(p.rect, dx, dy), light: p.light !== undefined ? p.light + lo : undefined })
      for (const l of base.lights) out.lights.push({ ...l, x: l.x + dx, y: l.y + dy, id: l.id + lo })
      for (const s of base.spawns) out.spawns.push({ x: s.x + dx, y: s.y + dy })
    }
  return out as MapDef
}

class StillSession implements Session {
  readonly room = null
  readonly myId = "viewer"
  private snap: { snap: Snapshot; at: number }
  constructor(seed: number, people: { x: number; y: number; aim: number }[]) {
    const players = people.map((p, i) => ({ id: `p${i}`, x: p.x, y: p.y, vx: 0, vy: 0, aim: p.aim, alive: true, gun: "rifle" as const, health: 100 }))
    this.snap = { snap: { type: "snap", tick: 0, t: 0, ack: 0, phase: "play", left: 300, map: seed, players, you: null }, at: performance.now() }
  }
  latest() {
    return this.snap
  }
  roster(): RosterRow[] {
    return this.snap.snap.players.map((p) => ({ id: p.id, name: p.id, human: false, kills: 0, deaths: 0 }))
  }
  drainEvents(): SimEvent[] {
    return []
  }
  send(_msg: ClientMsg): void {}
  status(): string | null {
    return null
  }
  update(): void {}
  close(): void {}
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
  const seed = Number(params.get("seed") ?? "1")
  let map = getMap(seed)
  if (params.has("big")) map = bigMap(map, Number(params.get("big")) || 2)
  let fx = Number(params.get("x") ?? map.size[0] / 2)
  let fy = Number(params.get("y") ?? map.size[1] / 2)
  const kind = params.get("kind")
  if (params.has("light")) {
    const ls = map.lights.filter((l) => !kind || l.kind === kind)
    const l = ls[Number(params.get("light")) % Math.max(1, ls.length)]
    if (l) {
      fx = l.x
      fy = l.y + 1
    }
  }
  const people = [
    { x: fx + 1.2, y: fy + 0.6, aim: -0.6 },
    { x: fx - 2.5, y: fy - 1.5, aim: 0.4 },
  ]
  const session = new StillSession(seed, people)
  const game = new Game(renderer, session, new Sound())
  ;(game as unknown as { load(m: MapDef): void }).load(map)
  const input = new Input(canvas)
  const cam = new Camera()
  cam.snap(fx, fy)
  const zoom = Number(params.get("zoom") ?? "17")
  cam.dist = zoom
  const resize = () => {
    canvas.width = Math.floor(innerWidth * Math.min(devicePixelRatio, 1.5))
    canvas.height = Math.floor(innerHeight * Math.min(devicePixelRatio, 1.5))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)
  const w = window as unknown as { goto(x: number, y: number): void; lights: MapDef["lights"]; stats(): unknown }
  w.goto = (x, y) => {
    fx = x
    fy = y
    cam.snap(x, y)
  }
  w.lights = map.lights
  w.stats = () => ({ chunks: renderer.drawnChunks, lights: map.lights.length, walls: map.walls.length, size: map.size })
  const info = document.getElementById("info")!
  let last = performance.now()
  let clock = 0
  let fps = 60
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    clock += dt * 1000
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05
    info.textContent = `seed ${seed}  ${fx.toFixed(1)},${fy.toFixed(1)}  fps ${fps.toFixed(0)}  chunks ${renderer.drawnChunks}`
    game.update(dt, input, cam, innerWidth, innerHeight, clock)
    cam.follow(fx, fy, 0, 0, dt, false)
    cam.dist = zoom
    renderer.render(game.build(cam, innerWidth, innerHeight, dt))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
