import "../style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { Input } from "@arcade/kit/client/input"
import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { attachLabPanelControl, registerGameCommands } from "@arcade/kit/dev-control"
import { openGpu } from "@arcade/kit/gpu/boot"
import { createLookSettings } from "@arcade/kit/gpu/look"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { type LabControl, LabPanel, type LabValue } from "@arcade/kit/lab-panel"
import { cooldowns } from "@arcade/kit/sim/abilities"
import { CENTER } from "../../shared/arena"
import { CHARACTERS, ROSTER } from "../../shared/characters"
import { GAME } from "../../shared/config"
import { Game } from "../game/game"
import { ARENA_THEMES, type ArenaThemeId, DEFAULT_ARENA_THEME } from "../render/arena-mesh"
import { Sound } from "../sound"
import { Hud, SLOT_KEYS } from "../ui/hud"
import { type LabScene, LabSession } from "./lab-session"
import { tuning } from "./lab-tuning"

const SCENES: readonly LabScene[] = ["gallery", "props", "bots"]
const MAX_DPR = 1.5

/**
 * The Brawl playground page (the Lab's `brawl` station embeds it): the character gallery, the prop playground and a bots
 * round, all on the production World, renderer and HUD, with the Abilities, Dodge and Props knobs in the shared panel.
 * `#gallery/<character>[/<slot>]`, `#props/<character>` and `#bots/<count>` pick the scene.
 */
async function main() {
  document.title = `${GAME.title} Playground`
  const canvas = document.getElementById("view") as HTMLCanvasElement
  // Commands and knobs exist before the GPU does, so a station's setup never races the page; scenes start once it's up.
  let renderer: Renderer | null = null
  const params = new URLSearchParams(location.search)
  const sound = new Sound()
  // Silent until the Sound switch says otherwise.
  sound.runtime.muted = true
  const input = new Input(canvas, [])
  const hud = new Hud(document.getElementById("hud")!)
  const caption = document.getElementById("caption")!
  const loop = document.getElementById("loop")!

  const [hScene, hArg, hLoop] = location.hash.replace(/^#/, "").split("/")
  const scene0: LabScene = SCENES.includes(hScene as LabScene) ? (hScene as LabScene) : "gallery"
  let session: LabSession | null = null
  let game: Game | null = null

  const { settings, controls } = tuning(() => session?.world.props.retune())
  Object.assign(settings, {
    scene: scene0,
    character: CHARACTERS[hArg ?? ""] ? hArg! : ROSTER[0]!.id,
    loop: hLoop !== undefined && /^[0-3]$/.test(hLoop) ? Number(hLoop) : -1,
    bots: scene0 === "bots" && Number(hArg) >= 2 ? Math.min(8, Number(hArg)) : 4,
    theme: DEFAULT_ARENA_THEME,
    speed: 1,
    sound: false,
  })

  const slots = () => (settings.loop === -1 ? [0, 1, 2, 3] : [Number(settings.loop)])
  const start = () => {
    if (!renderer) return
    const scene = settings.scene as LabScene
    session = new LabSession(scene, { char: String(settings.character), slots: slots(), bots: Number(settings.bots), seed: Number(params.get("seed")) || 7 })
    session.speed = Number(settings.speed)
    input.release()
    const theme = (settings.theme as ArenaThemeId) in ARENA_THEMES ? (settings.theme as ArenaThemeId) : DEFAULT_ARENA_THEME
    game = new Game(renderer, session, sound, theme)
    ;(globalThis as { brawl?: Game }).brawl = game
    const arg = scene === "bots" ? settings.bots : settings.character
    const loop = scene === "gallery" && settings.loop !== -1 ? `/${settings.loop}` : ""
    history.replaceState(null, "", `${location.pathname}${location.search}#${scene}/${arg}${loop}`)
  }
  const restart = (_: LabValue) => start()
  const shove = () => session?.world.props.blast(CENTER.x, CENTER.y, 30, 12, "")

  const sceneControls: LabControl[] = [
    { key: "scene", label: "Scene", group: "Scene", options: [{ value: "gallery", label: "Character gallery" }, { value: "props", label: "Prop playground" }, { value: "bots", label: "Bots round" }], change: restart },
    { key: "character", label: "Character", group: "Scene", options: ROSTER.map((c) => ({ value: c.id, label: c.name })), visible: (s) => s.scene !== "bots", change: restart },
    {
      key: "loop", label: "Loops", group: "Scene", visible: (s) => s.scene === "gallery",
      options: [{ value: -1, label: "Every ability in turn" }, { value: 0, label: "LMB only" }, { value: 1, label: "Q only" }, { value: 2, label: "E only" }, { value: 3, label: "Space only" }],
      change: () => {
        if (session?.brain) session.brain.slots = slots()
      },
    },
    { key: "bots", label: "Bots", group: "Scene", visible: (s) => s.scene === "bots", min: 2, max: 8, step: 1, change: restart },
    {
      key: "theme", label: "Arena theme", group: "Scene",
      options: [
        { value: "spotlit_ring", label: "Spotlit Fight Night" },
        { value: "neon_club", label: "Neon Club Pit" },
        { value: "back_alley", label: "Back Alley Cage" },
        { value: "party_pop", label: "Party Pop (Legacy)" },
      ],
      change: (v) => game?.setTheme(String(v) as ArenaThemeId),
    },
    { key: "speed", label: "Sim speed", group: "Scene", min: 0.1, max: 1, step: 0.05, unit: "×", change: (v) => session && (session.speed = Number(v)) },
    { key: "sound", label: "Sound", group: "Scene", type: "toggle", change: (v) => (sound.runtime.muted = !v) },
    { key: "restart", label: "Restart scene", group: "Scene", type: "action", run: () => start() },
  ]
  const propActions: LabControl[] = [
    { key: "resetProps", label: "Reset props", group: "Props", type: "action", run: () => session?.resetProps() },
    { key: "shove", label: "Shove everything", group: "Props", type: "action", run: shove },
  ]
  let panelFocused = false
  const panel = new LabPanel(settings, [...sceneControls, ...controls, ...propActions], params, () => input.release(), {
    open: !params.has("nolab"),
    presets: false,
    capture: "focus",
    onFocusChange: (focused) => (panelFocused = focused),
  })
  attachLabPanelControl(panel)

  const set = (key: string, value: LabValue | undefined) => {
    if (value === undefined) return
    settings[key] = value
  }
  registerGameCommands((commands) => commands.registerAll([
    {
      id: "brawl.scene",
      label: "Brawl playground scene",
      shortLabel: "Scene",
      category: "Scene",
      args: {
        scene: { type: "string", enum: SCENES },
        character: { type: "string", enum: ROSTER.map((c) => c.id) },
        loop: { type: "number", min: -1, max: 3 },
        bots: { type: "number", min: 2, max: 8 },
      },
      enabled: () => true,
      run: (ctx) => {
        const a = ctx?.args ?? {}
        set("scene", a.scene)
        set("character", a.character)
        set("loop", a.loop)
        set("bots", a.bots)
        start()
        panel.refresh()
        return { scene: settings.scene, character: settings.character }
      },
    },
    { id: "brawl.reset-props", label: "Reset props", shortLabel: "Reset props", category: "Scene", enabled: () => true, run: () => session?.resetProps() },
    { id: "brawl.shove", label: "Shove every prop", shortLabel: "Shove", category: "Scene", enabled: () => true, run: shove },
    {
      id: "brawl.state",
      label: "Brawl playground state",
      shortLabel: "State",
      category: "Scene",
      readOnly: true,
      enabled: () => true,
      run: () => ({
        scene: settings.scene,
        character: settings.character,
        loop: settings.loop,
        tick: session?.world.tick ?? 0,
        fighters: session?.world.actors.map((f) => ({ id: f.id, char: f.char, damage: Math.round(f.damage), x: +f.x.toFixed(2), y: +f.y.toFixed(2) })) ?? [],
        props: session?.world.props.list.filter((p) => p.alive).length ?? 0,
      }),
    },
  ]))

  input.onKey = (code) => {
    if (!game || session?.scene !== "props") return
    if (code === "KeyQ") game.press(1)
    else if (code === "KeyE") game.press(2)
    else if (code === "Space") game.press(3)
  }

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer?.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  const g = await openGpu(canvas, `${GAME.title} Playground`)
  if (typeof g === "string") {
    document.getElementById("menu")!.textContent = g
    return
  }
  renderer = new Renderer(g.device, g.context, g.format)
  renderer.setLook(createLookSettings("night_ring"))
  resize()
  addEventListener("resize", resize)
  start()

  let last = performance.now()
  let lastCaption = ""
  let lastStrip = ""
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    if (game && session) {
      input.enabled = session.scene === "props" && !panelFocused
      game.update(dt, input, w, h)
      renderer.render(game.build(w, h, dt))
      sound.listen(game.cam.x, game.cam.z)
      const star = session.scene === "gallery" ? session.star : null
      const strip = star && session.brain ? stripOf(star.char, cooldowns(star, session.world.time), session.brain.active) : ""
      if (strip !== lastStrip) loop.innerHTML = lastStrip = strip
      hud.update(game, w, h, null)
      const text = captionOf(session)
      if (text !== lastCaption) caption.innerHTML = lastCaption = text
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  ;(globalThis as { ready?: boolean }).ready = true
}

/** The gallery character's abilities with key caps and cooldowns; the one being cast is lit. */
function stripOf(char: string, cd: readonly number[], active: number): string {
  return CHARACTERS[char]!.abilities
    .map((a, i) => {
      const left = cd[i] ?? 0
      return `<div class="${i === active ? "on" : left > 0.05 ? "cooling" : ""}">${keyCapHtml(SLOT_KEYS[i]!)}<b>${a.name}</b><span>${left > 0.05 ? left.toFixed(1) + " s" : "ready"}</span></div>`
    })
    .join("")
}

function captionOf(s: LabSession): string {
  if (s.scene === "bots") return `<b>Bots round</b><span>${s.world.actors.length} bots with every ability</span>`
  if (s.scene === "props") return `<b>Prop playground</b><span>WASD, mouse, Q / E / Space · Slab throws whatever is nearest</span>`
  const c = CHARACTERS[s.star?.char ?? ""]
  return c ? `<b>${c.name}</b><span>${c.title} · ${c.tagline}</span>` : ""
}

void main()
