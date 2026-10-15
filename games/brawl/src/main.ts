import "./style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { Input } from "@arcade/kit/client/input"
import { attachLabPanelControl } from "@arcade/kit/dev-control"
import { openGpu } from "@arcade/kit/gpu/boot"
import { applyLookPreset, createLookControls, createLookSettings } from "@arcade/kit/gpu/look"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { type LabControl, LabPanel, type LabSettings } from "@arcade/kit/lab-panel"
import { ROSTER } from "../shared/characters"
import { DEFAULT_FEEL, FEEL, GAME } from "../shared/config"
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
  const params = new URLSearchParams(location.search)
  const themeParam = params.get("theme") as ArenaThemeId | null
  let activeTheme: ArenaThemeId = themeParam && themeParam in ARENA_THEMES ? themeParam : DEFAULT_ARENA_THEME
  const lookSettings = ARENA_THEMES[activeTheme].look()
  renderer.setLook(lookSettings)
  const seed = Number(params.get("seed")) || undefined
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const sound = new Sound()
  const input = new Input(canvas, [])
  const hud = new Hud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null
  let pick = localStorage.getItem(PICK_KEY) ?? ""

  const labSettings: LabSettings = {
    theme: activeTheme,
    ...DEFAULT_FEEL,
    ...lookSettings,
  }
  const feelControls: LabControl[] = [
    {
      key: "theme",
      label: "Arena theme",
      group: "Arena Look",
      type: "select",
      options: (Object.keys(ARENA_THEMES) as ArenaThemeId[]).map((id) => ({ value: id, label: ARENA_THEMES[id].label })),
      change: (v) => {
        activeTheme = (v as ArenaThemeId) in ARENA_THEMES ? (v as ArenaThemeId) : DEFAULT_ARENA_THEME
        Object.assign(lookSettings, ARENA_THEMES[activeTheme].look())
        Object.assign(labSettings, lookSettings)
        game?.setTheme(activeTheme)
      },
    },
    { key: "moveScale", label: "Walk speed scale", group: "Feel & Pace", min: 0.6, max: 1.6, step: 0.05, unit: "×", change: (v) => (FEEL.moveScale = Number(v)) },
    { key: "accel", label: "Acceleration", group: "Feel & Pace", min: 10, max: 60, step: 1, unit: "/s", change: (v) => (FEEL.accel = Number(v)) },
    { key: "knockGrowth", label: "Knockback damage knee", group: "Feel & Pace", min: 25, max: 100, step: 1, unit: "%", change: (v) => (FEEL.knockGrowth = Number(v)) },
    { key: "ropeBreak", label: "Rope break speed", group: "Feel & Pace", min: 5, max: 15, step: 0.2, unit: "m/s", change: (v) => (FEEL.ropeBreak = Number(v)) },
    { key: "launchFriction", label: "Launch air drag", group: "Feel & Pace", min: 2, max: 12, step: 0.2, unit: "m/s²", change: (v) => (FEEL.launchFriction = Number(v)) },
    { key: "wallBounce", label: "Wall bounce", group: "Feel & Pace", min: 0.2, max: 1, step: 0.05, unit: "×", change: (v) => (FEEL.wallBounce = Number(v)) },
    { key: "overchargeAt", label: "Overcharge starts at", group: "Feel & Pace", min: 15, max: 120, step: 5, unit: "s", change: (v) => (FEEL.overchargeAt = Number(v)) },
    { key: "hitStopScale", label: "Hit-stop scale", group: "Feel & Pace", min: 0, max: 2, step: 0.1, unit: "×", change: (v) => (FEEL.hitStopScale = Number(v)) },
    { key: "shakeScale", label: "Camera shake scale", group: "Feel & Pace", min: 0, max: 2, step: 0.1, unit: "×", change: (v) => (FEEL.shakeScale = Number(v)) },
    { key: "camTightness", label: "Camera zoom tightness", group: "Feel & Pace", min: 0.8, max: 1.6, step: 0.02, unit: "×", change: (v) => (FEEL.camTightness = Number(v)) },
  ]
  const lookControls = createLookControls(labSettings, {
    onPresetChange: (preset) => {
      applyLookPreset(lookSettings, preset)
      Object.assign(labSettings, lookSettings)
      renderer.setLook(lookSettings)
    },
    onChange: (key, val) => {
      ;(lookSettings as Record<string, unknown>)[key] = val
      renderer.setLook(lookSettings)
    },
  })
  const labPanel = new LabPanel(labSettings, [...feelControls, ...lookControls], params, () => {
    input.release()
    Object.assign(FEEL, labSettings)
  }, { open: false, presets: false })
  attachLabPanelControl(labPanel)

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
