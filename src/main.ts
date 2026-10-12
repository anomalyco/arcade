import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { GUN_IDS, type Gun } from "../shared/config"
import { cleanName } from "../shared/protocol"
import { Sound } from "./audio/sound"
import { Game } from "./game/game"
import { Input } from "./game/input"
import { NetSession } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { Camera } from "./render/camera"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"

const MAX_DPR = 1.5
const NAME_KEY = "blackout.name"
const GUN_KEY = "blackout.gun"

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
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const hud = new Hud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null

  const begin = (name: string, g: Gun, s: (name: string) => Session) => {
    const clean = cleanName(name)
    localStorage.setItem(NAME_KEY, clean)
    localStorage.setItem(GUN_KEY, g)
    gun = g
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
  const menus = new Menus(menuEl, localStorage.getItem(NAME_KEY) ?? "", gun, {
    practice: (name, g) => begin(name, g, (n) => new LocalSession(n, g)),
    create: async (name, g) => {
      const base = location.pathname.replace(/[^/]*$/, "")
      const res = await fetch(`${base}api/create`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
      history.replaceState(null, "", `?room=${res.room}`)
      begin(name, g, (n) => new NetSession(res.room, n, g, fatal))
    },
    join: (name, g, room) => {
      history.replaceState(null, "", `?room=${room}`)
      begin(name, g, (n) => new NetSession(room, n, g, fatal))
    },
  })
  input.onKey = (code) => {
    if (code === "KeyM") sound.setMuted(!sound.muted)
    const i = ["Digit1", "Digit2", "Digit3"].indexOf(code)
    if (i >= 0 && session) {
      gun = GUN_IDS[i]!
      localStorage.setItem(GUN_KEY, gun)
      session.send({ type: "gun", gun })
    }
  }
  menus.landing(roomParam)
  if (params.has("practice")) begin(localStorage.getItem(NAME_KEY) ?? "you", gun, (n) => new LocalSession(n, gun))

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
      const body = game.body
      const alive = game.alive
      const fx = body?.x ?? game.map.size[0] / 2
      const fz = body?.y ?? game.map.size[1] / 2
      // Lean the view toward the cursor so you can see where you aim.
      const lx = alive && body ? Math.max(-4, Math.min(4, (game.cursor.x - body.x) * 0.3)) : 0
      const lz = alive && body ? Math.max(-3, Math.min(3, (game.cursor.y - body.y) * 0.3)) : 0
      cam.follow(fx, fz, lx, lz, dt, !body)
      renderer.render(game.build(cam, w, h, dt))
      hud.update(game, cam, w, h, input.mouse, session.status())
      menus.update(game.snap, game.roster, session.myId, session.room, input.held("Tab"), (id) => game!.colorOf(id))
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
