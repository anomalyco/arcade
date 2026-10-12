import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "../shared/config"
import { cleanName } from "../shared/protocol"
import { MODE_IDS, type ModeId, modeOf } from "../shared/sim/modes"
import { Sound } from "./audio/sound"
import { Game } from "./game/game"
import { Input } from "./game/input"
import { NetSession } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { Camera } from "./render/camera"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"
import { ModeHud } from "./ui/modes-hud"

const MAX_DPR = 1.5
const NAME_KEY = "blackout.name"
const GUN_KEY = "blackout.gun"
const EQUIP_KEY = "blackout.equip"

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | string> {
  if (!navigator.gpu) return "BLACKOUT needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const menuEl = document.getElementById("menu")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") {
    menuEl.className = "full"
    menuEl.innerHTML = `<div class="landing"><div class="logo">BLACKOUT</div><div class="notice">${renderer}</div></div>`
    return
  }
  const params = new URLSearchParams(location.search)
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const storedGun = localStorage.getItem(GUN_KEY) as Gun | null
  let gun: Gun = storedGun && GUN_IDS.includes(storedGun) ? storedGun : "rifle"
  const storedEquip = localStorage.getItem(EQUIP_KEY) as Equip | null
  let equip: Equip = storedEquip && EQUIP_IDS.includes(storedEquip) ? storedEquip : "frag"
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const hud = new Hud(document.getElementById("hud")!)
  const modeHud = new ModeHud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null

  const begin = (name: string, s: (name: string) => Session) => {
    const clean = cleanName(name)
    localStorage.setItem(NAME_KEY, clean)
    sound.start()
    session = s(clean)
    game = new Game(renderer, session, sound)
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
  const enter = (name: string, room: string, priv = false, mode: ModeId | null = null) => {
    history.replaceState(null, "", `?room=${room}`)
    begin(name, (n) => new NetSession(room, n, gun, equip, fatal, priv, mode))
  }
  const vote = (mode: ModeId) => session?.send({ type: "vote", mode })
  let scores = false
  const failed = (e: unknown) => menus.landing(null, `Couldn't reach the server (${e instanceof Error ? e.message : String(e)}).`)
  const menus = new Menus(menuEl, localStorage.getItem(NAME_KEY) ?? "", {
    quick: (name) => api("quick").then((r) => enter(name, r.room), failed),
    create: (name, mode) => api("create").then((r) => enter(name, r.room, true, mode), failed),
    join: (name, room) => enter(name, room),
    vote,
    team: (id, team) => session?.send({ type: "team", id, team }),
    shuffle: () => session?.send({ type: "shuffle" }),
  })
  fetch(`${base}api/stats`)
    .then((r) => r.json() as Promise<{ players: number; games: number }>)
    .then((s) => menus.stats(s.players, s.games))
    .catch(() => {})
  input.onKey = (code) => {
    if (code === "KeyM") sound.setMuted(!sound.muted)
    // T keeps the scoreboard open (the host picks teams there) until pressed again.
    if (code === "KeyT") scores = !scores
    // Between floors the number keys vote for the next mode.
    if (game?.snap?.phase === "end") {
      const v = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code)
      if (v >= 0) vote(MODE_IDS[v]!)
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
  menus.landing(roomParam)
  // Dev and screenshots: a local match against bots, no server.
  if (params.has("practice")) begin(localStorage.getItem(NAME_KEY) ?? "you", (n) => new LocalSession(n, gun, equip, modeOf(params.get("mode")) ?? "ffa"))

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
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    if (game && session) {
      input.enabled = game.snap?.phase === "play"
      game.update(dt, input, cam, w, h, now)
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
      const lx = alive && body ? Math.max(-cap, Math.min(cap, (game.cursor.x - body.x) * k)) : 0
      const lz = alive && body ? Math.max(-cap * 0.7, Math.min(cap * 0.7, (game.cursor.y - body.y) * k)) : 0
      cam.follow(fx, fz, lx, lz, dt, !body)
      renderer.render(game.build(cam, w, h, dt))
      hud.update(game, cam, w, h, input.mouse, session.status())
      modeHud.update(game, cam, w, h)
      menus.update(game.snap, game.roster, session.myId, session.room, input.held("Tab") || scores, (id) => game!.colorOf(id))
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
