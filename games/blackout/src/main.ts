import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "../shared/config"
import type { MapChoice } from "../shared/maps"
import { cleanName } from "../shared/protocol"
import { MODE_IDS, type ModeId, modeOf } from "../shared/sim/modes"
import { Sound } from "./audio/sound"
import { Game, SandboxSession } from "./game/game"
import { Input, type MuxState } from "./game/input"
import { NetSession, REJOIN_KEY } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { Camera } from "./render/camera"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"
import { ModeHud } from "./ui/modes-hud"
import { DebugOverlay, juiceSettings, LOOK_LABELS } from "./ui/debug-overlay"
import { GpuPerf } from "../../../packages/kit/gpu-perf"
import { Rng } from "../shared/rng"

const MAX_DPR = 1.5
const NAME_KEY = "blackout.name"
const GUN_KEY = "blackout.gun"
const EQUIP_KEY = "blackout.equip"

async function gpu(canvas: HTMLCanvasElement): Promise<{ renderer: Renderer; telemetry: GpuPerf } | string> {
  if (!navigator.gpu) return "BLACKOUT needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] })
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const telemetry = new GpuPerf(device)
  return { renderer: new Renderer(device, context, format), telemetry }
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const menuEl = document.getElementById("menu")!
  const graphics = await gpu(canvas)
  if (typeof graphics === "string") {
    menuEl.className = "full"
    menuEl.innerHTML = `<div class="landing"><div class="logo">BLACKOUT</div><div class="notice">${graphics}</div></div>`
    return
  }
  const params = new URLSearchParams(location.search)
  const { renderer, telemetry } = graphics
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const storedGun = localStorage.getItem(GUN_KEY) as Gun | null
  let gun: Gun = storedGun && GUN_IDS.includes(storedGun) ? storedGun : "rifle"
  const storedEquip = localStorage.getItem(EQUIP_KEY) as Equip | null
  let equip: Equip = storedEquip && EQUIP_IDS.includes(storedEquip) ? storedEquip : "frag"
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const settings = juiceSettings(params.get("vanilla") !== "1")
  if (params.get("look") === "0") for (const key of Object.keys(LOOK_LABELS) as (keyof typeof LOOK_LABELS)[]) settings[key] = false
  if (params.has("monitors")) settings.monitors = params.get("monitors") === "1"
  const debug = new DebugOverlay(settings, params, () => { input.release(); input.forward({ type: "mux-release" }) })
  input.onWheel = (delta) => { cam.zoomOffset = Math.max(-10, Math.min(24, cam.zoomOffset + Math.sign(delta))) }
  const hud = new Hud(document.getElementById("hud")!)
  const modeHud = new ModeHud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null

  const begin = (name: string, s: (name: string) => Session) => {
    const clean = cleanName(name)
    localStorage.setItem(NAME_KEY, clean)
    sound.start()
    session?.close()
    input.release()
    session = s(clean)
    game = new Game(renderer, session, sound, settings)
    menus.hide()
    hud.show(true)
  }
  const fatal = (message: string) => {
    session?.close()
    session = null
    game = null
    hud.show(false)
    history.replaceState(null, "", location.pathname)
    menus.landing(null, message)
  }
  const base = location.pathname.replace(/[^/]*$/, "")
  const api = (path: string) => fetch(`${base}api/${path}`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
  const enter = (name: string, room: string, priv = false, mode: ModeId | null = null, maps: MapChoice | null = null) => {
    history.replaceState(null, "", `?room=${room}`)
    begin(name, (n) => new NetSession(room, n, gun, equip, fatal, priv, mode, maps))
  }
  const vote = (mode: ModeId) => session?.send({ type: "vote", mode })
  const rawSeed = Number(params.get("seed") ?? 1)
  const seed = Number.isFinite(rawSeed) ? rawSeed : 1
  const sandbox = (name: string) => {
    const random = new Rng(seed)
    Math.random = () => random.next()
    begin(name, (n) => new SandboxSession(n, input.mux ? "rifle" : gun, input.mux ? "frag" : equip, seed))
    cam.zoomOffset = 0
    game!.update(0, input, cam, innerWidth, innerHeight, 0)
    if (game!.body) cam.snap(game!.body.x, game!.body.y)
    cam.update(innerWidth / innerHeight)
  }
  let scores = false
  const failed = (e: unknown) => menus.landing(null, `Couldn't reach the server (${e instanceof Error ? e.message : String(e)}).`)
  const menus = new Menus(menuEl, localStorage.getItem(NAME_KEY) ?? "", {
    quick: (name) => api("quick").then((r) => enter(name, r.room), failed),
    practice: (name, mode) => begin(name, (n) => new LocalSession(n, gun, equip, mode)),
    sandbox,
    create: (name, mode, maps) => api("create").then((r) => enter(name, r.room, true, mode, maps), failed),
    join: (name, room) => enter(name, room),
    vote,
    team: (id, team) => session?.send({ type: "team", id, team }),
    shuffle: () => session?.send({ type: "shuffle" }),
    maps: (maps) => session?.send({ type: "host", action: "maps", maps }),
    host: (mode, newFloor) => session?.send(mode ? { type: "host", action: "mode", mode, newFloor } : { type: "host", action: "reset", newFloor }),
  })
  if (!params.has("practice") && params.get("peaceful") !== "1" && params.get("sandbox") !== "1" && !input.mux) fetch(`${base}api/stats`)
    .then((r) => r.json() as Promise<{ players: number; games: number }>)
    .then((s) => menus.stats(s.players, s.games))
    .catch(() => {})
  input.onKey = (code) => {
    if (code === "Backquote") debug.toggle()
    if (code === "KeyB" && params.get("peaceful") !== "1" && session instanceof SandboxSession) session.toggleBots()
    if (code === "KeyM") sound.setMuted(!sound.muted)
    // T keeps the scoreboard open (the host picks teams there) until pressed again.
    if (code === "KeyT") scores = !scores
    // Between floors the number keys vote for the next mode.
    if (game?.snap?.phase === "end") {
      const v = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code)
      const offer = game.snap.mode.votes?.options ?? MODE_IDS
      if (v >= 0 && offer[v]) vote(offer[v])
      return
    }
    const i = ["Digit1", "Digit2", "Digit3"].indexOf(code)
    if (i >= 0 && session) {
      gun = GUN_IDS[i]!
      localStorage.setItem(GUN_KEY, gun)
      session.send({ type: "gun", gun })
    }
    const e = ["Digit4", "Digit5"].indexOf(code)
    if (e >= 0 && session) {
      equip = EQUIP_IDS[e]!
      localStorage.setItem(EQUIP_KEY, equip)
      session.send({ type: "equip", equip })
    }
  }
  if (!input.mux && params.get("peaceful") !== "1" && !params.has("practice")) menus.landing(roomParam)
  // Back from a version reload: straight into the same room.
  const rejoin = sessionStorage.getItem(REJOIN_KEY)
  sessionStorage.removeItem(REJOIN_KEY)
  if (rejoin && rejoin === roomParam) enter(localStorage.getItem(NAME_KEY) ?? "", rejoin)
  // Dev and screenshots: a local match against bots, no server.
  if (params.get("peaceful") === "1" || params.get("sandbox") === "1" || input.mux) sandbox(localStorage.getItem(NAME_KEY) ?? "you")
  else if (params.has("practice")) begin(localStorage.getItem(NAME_KEY) ?? "you", (n) => new LocalSession(n, gun, equip, modeOf(params.get("mode")) ?? "ffa", params.get("map")))

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.55, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  let muxTick = 0
  const ready = () => input.forward({ type: "mux-ready", protocol: 1, map: game?.map.seed, mode: game?.snap?.mode.id, ...game?.muxState() })
  const validState = (s: unknown): s is MuxState => {
    if (!s || typeof s !== "object") return false
    return ["x", "y", "vx", "vy", "aim", "tx", "ty"].every((key) => Number.isFinite((s as Record<string, unknown>)[key]))
  }
  addEventListener("message", (event) => {
    if (!input.accepts(event)) return
    const m = event.data
    if (m?.type === "mux-reset") { location.reload(); return }
    if (m?.type === "mux-hello") { ready(); return }
    if (!game || !session) return
    // The parent clocks simulation; rendering still runs independently for honest frame-rate measurements.
    if ((m?.type === "mux-step" || m?.type === "mux-sync") && Number.isFinite(m.dt) && Number.isFinite(m.now)) {
      if (!Number.isInteger(m.tick) || m.tick !== muxTick + 1) return
      muxTick = m.tick
      const dt = Math.max(0, Math.min(0.1, m.dt))
      input.enabled = game.snap?.phase === "play" || session instanceof SandboxSession
      game.update(dt, input, cam, innerWidth, innerHeight, m.now, m.type === "mux-sync" && validState(m) ? m : undefined)
      if (m.type === "mux-sync" && validState(m)) game.sync(m, false)
      else if (game.body) game.drawn.reset(game.body)
      if (game.body) cam.snap(game.body.x, game.body.y)
      input.forward({ type: m.type === "mux-step" ? "mux-state" : "mux-done", tick: m.tick, ...game.muxState() })
    } else if (m?.type === "mux-sync" && validState(m)) game.sync(m)
  })
  ready()
  const frame = (now: number) => {
    const elapsed = now - last
    const dt = Math.min(0.1, elapsed / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    if (game && session) {
      input.enabled = game.snap?.phase === "play"
      if (!input.mux) game.update(dt, input, cam, w, h, now)
      const body = game.body ? game.drawn : null
      const alive = game.alive
      // Out for the round in search and destroy: watch a teammate.
      const spec = modeHud.spectate(game)
      const fx = spec?.x ?? body?.x ?? game.map.size[0] / 2
      const fz = spec?.y ?? body?.y ?? game.map.size[1] / 2
      // Look-ahead: the view leans toward the cursor; holding right click leans much further (scouting, sniping).
      const far = input.looking && alive
      const k = far ? 0.65 : 0.35
      const cap = far ? 11 : 5
      // Driving, it leads ahead along the road instead.
      const lead = alive && !far ? game.vehicleLead() : null
      const lx = lead ? lead.x : alive && body ? Math.max(-cap, Math.min(cap, (game.cursor.x - body.x) * k)) : 0
      const lz = lead ? lead.y : alive && body ? Math.max(-cap * 0.7, Math.min(cap * 0.7, (game.cursor.y - body.y) * k)) : 0
      cam.follow(fx, fz, input.mux ? 0 : lx, input.mux ? 0 : lz, dt, !body, alive && !!game.riding)
      if (input.mux && body) { cam.snap(body.x, body.y); cam.dist = 24 + cam.zoomOffset }
      renderer.render(game.build(cam, w, h, dt))
      hud.update(game, cam, w, h, input.mouse, session.status())
      modeHud.update(game, cam, w, h)
      menus.update(game.snap, game.roster, session.myId, session.room, input.held("Tab") || scores, (id) => game!.colorOf(id))
      telemetry.enabled = debug.visible || input.mux
      const chunks = renderer.drawnChunks
      const perf = debug.sample(now, elapsed, telemetry, chunks, game.lightCount)
      if (perf && parent !== window) {
        const screen = body ? cam.project(body.x, 0.85, body.y, w, h) : null
        parent.postMessage({ type: "arcade-perf", ...perf, ...game.muxState(), tick: muxTick, map: game.map.seed, alive, screenX: screen ? screen.x / w : null, screenY: screen ? screen.y / h : null, run: input.muxRun }, input.parentOrigin)
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
