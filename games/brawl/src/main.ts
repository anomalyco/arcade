import "./style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { Input } from "@arcade/kit/client/input"
import { openGpu } from "@arcade/kit/gpu/boot"
import { createLookSettings } from "@arcade/kit/gpu/look"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { ROSTER } from "../shared/characters"
import { GAME } from "../shared/config"
import { cleanName } from "../shared/protocol"
import { Game } from "./game/game"
import { ARENA_THEMES, type ArenaThemeId, DEFAULT_ARENA_THEME } from "./render/arena-mesh"
import { LocalSession, NetSession, REJOIN_KEY, type Session } from "./session"
import { Sound } from "./sound"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"

const MAX_DPR = 1.5
const NAME_KEY = `${GAME.id}.name`
const PICK_KEY = `${GAME.id}.pick`

async function main() {
  document.title = GAME.title
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const menuEl = document.getElementById("menu")!
  const g = await openGpu(canvas, GAME.title)
  if (typeof g === "string") {
    menuEl.className = "full"
    menuEl.innerHTML = `<div class="landing"><div class="logo">${GAME.title}</div><div class="notice">${g}</div></div>`
    return
  }
  const renderer = new Renderer(g.device, g.context, g.format)
  renderer.setLook(createLookSettings("night_ring"))
  const params = new URLSearchParams(location.search)
  const themeParam = params.get("theme") as ArenaThemeId | null
  const activeTheme: ArenaThemeId = themeParam && themeParam in ARENA_THEMES ? themeParam : DEFAULT_ARENA_THEME
  const seed = Number(params.get("seed")) || undefined
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const sound = new Sound()
  const input = new Input(canvas, [])
  const hud = new Hud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null
  let pick = localStorage.getItem(PICK_KEY) ?? ""

  const begin = (s: Session) => {
    session?.close()
    input.release()
    session = s
    game = new Game(renderer, s, sound, activeTheme)
    ;(globalThis as { brawl?: Game }).brawl = game
    const zoom = Number(params.get("zoom"))
    if (zoom) game.zoom = zoom
  }
  const play = (name: string, s: (name: string) => Session) => {
    const clean = cleanName(name)
    localStorage.setItem(NAME_KEY, clean)
    begin(s(clean))
    menus.hide()
  }
  const watch = () => begin(new LocalSession("", { watch: true, bots: Number(params.get("bots")) || 4, seed }))
  const fatal = (message: string) => {
    history.replaceState(null, "", location.pathname)
    watch()
    menus.landing(null, message)
  }
  const base = location.pathname.replace(/[^/]*$/, "")
  const api = (path: string) => fetch(`${base}api/${path}`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
  const failed = (e: unknown) => menus.landing(null, `Couldn't reach the server (${e instanceof Error ? e.message : String(e)}).`)
  const enter = (name: string, room: string, priv = false) => {
    history.replaceState(null, "", `?room=${room}`)
    play(name, (n) => new NetSession(room, n, pick, fatal, priv))
  }
  const practice = (name: string) => play(name, (n) => new LocalSession(n, { pick, seed }))
  const choose = (char: string) => {
    pick = char
    localStorage.setItem(PICK_KEY, char)
    session?.send({ type: "pick", char })
    sound.play("ui.click")
  }
  const ready = (on: boolean) => {
    session?.send({ type: "ready", ready: on })
    sound.play(on ? "ui.ping" : "ui.tick")
  }
  const menus = new Menus(menuEl, localStorage.getItem(NAME_KEY) ?? "", {
    quick: (name) => api("quick").then((r) => enter(name, r.room), failed),
    practice,
    create: (name) => api("create").then((r) => enter(name, r.room, true), failed),
    join: (name, room) => enter(name, room),
    watch: () => {
      watch()
      menus.hide()
    },
    pick: choose,
    ready,
  })

  input.onKey = (code) => {
    if (code === "KeyM") sound.setMuted(!sound.muted)
    const snap = game?.snap
    if (!game || !snap || !session?.myId) return
    if (snap.phase === "select") {
      const i = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(code)
      if (i >= 0 && ROSTER[i]) choose(ROSTER[i]!.id)
      if (code === "KeyR") choose(ROSTER[Math.floor(Math.random() * ROSTER.length)]!.id)
      const me = game.roster.find((r) => r.id === session!.myId)
      if ((code === "Enter" || code === "Space") && me?.pick) ready(!me.ready)
    } else if (snap.phase === "play") {
      if (code === "KeyQ") game.press(1)
      else if (code === "KeyE") game.press(2)
      else if (code === "Space") game.press(3)
    }
  }

  // Back from a version reload: straight into the same room.
  const rejoin = sessionStorage.getItem(REJOIN_KEY)
  sessionStorage.removeItem(REJOIN_KEY)
  const storedName = localStorage.getItem(NAME_KEY) ?? ""
  if (rejoin && rejoin === roomParam) enter(storedName, rejoin)
  else if (params.has("practice")) {
    if (params.get("pick")) pick = params.get("pick")!
    practice(storedName || "you")
    if (params.get("auto") === "1") {
      if (!pick) choose(ROSTER[0]!.id)
      ready(true)
    }
  } else if (params.has("watch")) watch()
  else {
    watch()
    menus.landing(roomParam)
  }

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
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
      input.enabled = game.snap?.phase === "play" && !!session.myId
      game.update(dt, input, w, h)
      renderer.render(game.build(w, h, dt))
      sound.listen(game.cam.x, game.cam.z)
      hud.show(!menus.landingShown)
      hud.update(game, w, h, session.status())
      menus.update(game.snap, game.roster, session.myId, session.room, (id) => game!.colorOf(id))
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
