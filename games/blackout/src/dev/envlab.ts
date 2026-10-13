// Dev-only environment viewer (envlab.html): a generated map through the real Game and Renderer, with a few soldiers
// standing about. ?kind=office|downtown and ?seed=N pick the map, ?x=&y= centre the camera, ?light=K centres on the
// K-th light of ?lkind=panel|street|neon|..., ?zoom=17 sets the distance, ?big=N tiles the floor NxN to stress
// culling, ?stress=N renders every frame N times. window.goto(x, y) moves.
import type { MapDef } from "../../shared/maps"
import { getMap, mapKindOf } from "../../shared/maps"
import type { ClientMsg } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import { Sound } from "../audio/sound"
import { Game } from "../game/game"
import { Input } from "../game/input"
import type { Session } from "../game/session"
import { Camera } from "../render/camera"
import { Renderer } from "../render/renderer"
import { IDLE_VIEW } from "../../shared/sim/modes"
import { DebugOverlay, juiceSettings } from "../ui/debug-overlay"
import { modelRoom } from "./model-room"

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
  constructor(map: MapDef, people: { x: number; y: number; aim: number }[]) {
    const players = people.map((p, i) => ({ id: i === 0 ? this.myId : `p${i}`, x: p.x, y: p.y, vx: 0, vy: 0, aim: p.aim, alive: true, gun: "rifle" as const, health: 100 }))
    this.snap = { snap: { type: "snap", tick: 0, t: 0, ack: 0, phase: "play", left: 300, map: map.seed, mapKind: map.kind, maps: map.kind, players, grenades: [], claymores: [], mode: IDLE_VIEW, you: null }, at: performance.now() }
  }
  latest() {
    return this.snap
  }
  roster(): RosterRow[] {
    return this.snap.snap.players.map((p) => ({ id: p.id, name: p.id, human: false, kills: 0, deaths: 0, team: -1, caps: 0, plants: 0, defuses: 0 }))
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
  const device = await adapter!.requestDevice({ requiredFeatures: adapter!.features.has("timestamp-query") ? ["timestamp-query"] : [] })
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  void device.lost.then((i) => console.error(`[gpu lost] ${i.reason} ${i.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)
  const params = new URLSearchParams(location.search)
  const seed = Number(params.get("seed") ?? "1")
  const mapKind = mapKindOf(params.get("kind")) ?? "office"
  let map = params.get("fixture") === "room" ? modelRoom() : getMap(mapKind, seed)
  if (params.has("big")) map = bigMap(map, Number(params.get("big")) || 2)
  let fx = Number(params.get("x") ?? map.size[0] / 2)
  let fy = Number(params.get("y") ?? map.size[1] / 2)
  const kind = params.get("lkind") ?? (mapKindOf(params.get("kind")) ? null : params.get("kind"))
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
  const session = new StillSession(map, people)
  const settings = juiceSettings(!params.has("vanilla"))
  if(params.has("fxproof"))new DebugOverlay(settings,params)
  if (params.has("monitors")) settings.monitors = params.get("monitors") === "1"
  const game = new Game(renderer, session, new Sound(), settings)
  ;(window as unknown as { setMonitors(on: boolean): void }).setMonitors = (on) => { settings.monitors = on }
  ;(game as unknown as { load(m: MapDef): void }).load(map)
  const input = new Input(canvas)
  const lab = new DebugOverlay(settings, params, () => input.release())
  addEventListener("keydown", (e) => { if (e.code === "Backquote" && !e.repeat) lab.toggle() })
  const cam = new Camera()
  cam.snap(fx, fy)
  const zoom = Number(params.get("zoom") ?? "17")
  const stress = Math.max(1, Number(params.get("stress") ?? "1"))
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
  ;(window as unknown as { gpuIdle(): Promise<number> }).gpuIdle = async () => {
    const t0 = performance.now()
    await device.queue.onSubmittedWorkDone()
    return performance.now() - t0
  }
  let visibleLights = 0, shadowLights = 0, monitorLights = 0
  w.stats = () => ({ chunks: renderer.drawnChunks, lights: map.lights.length, walls: map.walls.length, size: map.size, visibleLights, shadowLights, monitorLights })
  const info = document.getElementById("info")!
  let last = performance.now()
  let clock = 0
  let fps = 60
  const stepFx=(dt:number)=>{
    clock+=dt*1000;game.update(dt,input,cam,innerWidth,innerHeight,clock);cam.snap(fx,fy);cam.dist=zoom
    return game.build(cam,innerWidth,innerHeight,dt)
  }
  if(params.has("fxproof")){
    let sequence=0
    Object.assign(window,{fxProof:{game,map,renderer,settings,adapter:adapter!.info,
      step:async(dt:number)=>{renderer.render(stepFx(dt));await device.queue.onSubmittedWorkDone()},
      draw:async(on:boolean,measure=false)=>{settings.volumes=on;const f=stepFx(0);if(measure)return renderer.measure(f);renderer.render(f);await device.queue.onSubmittedWorkDone();return null},
      explode:(x=fx,y=fy)=>{(game as unknown as {explode(e:SimEvent):void}).explode({k:"explode",id:++sequence,by:"viewer",x,y,kind:"frag",aim:0})},
    }})
    stepFx(0)
  }
  const tick = (now: number) => {
    if(params.has("fxproof")&&params.has("bench")){requestAnimationFrame(tick);return}
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    clock += dt * 1000
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05
    info.textContent = `${mapKind} ${seed}  ${fx.toFixed(1)},${fy.toFixed(1)}  fps ${fps.toFixed(0)}  chunks ${renderer.drawnChunks}`
    game.update(dt, input, cam, innerWidth, innerHeight, clock)
    cam.follow(fx, fy, 0, 0, dt, false)
    cam.dist = zoom
    const f = game.build(cam, innerWidth, innerHeight, dt)
    visibleLights = f.lightCount
    shadowLights = f.shadowLightCount
    monitorLights = 0
    for (let i = 0; i < f.lightCount; i++) if (f.lights[i * 16 + 15]! >= map.lights.length) monitorLights++
    // ?stress=N renders each frame N times, to see how much headroom is left under vsync.
    for (let k = 0; k < stress; k++) renderer.render(f)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
