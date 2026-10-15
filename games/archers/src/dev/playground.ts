import "../style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { attachLabPanelControl, registerGameCommands } from "@arcade/kit/dev-control"
import { openGpu } from "@arcade/kit/gpu/boot"
import { type LabControl, LabPanel, type LabSettings, type LabValue } from "@arcade/kit/lab-panel"
import { ARENA_DEFS } from "../../shared/arena"
import { GAME, MAX_PLAYERS } from "../../shared/config"
import { SLOT_NAMES } from "../../shared/match"
import { DEFAULT_TUNING, type Tuning } from "../../shared/tuning"
import { ITEMS, type Item } from "../../shared/world"
import { Controls } from "../game/controls"
import { Game, type Seat } from "../game/game"
import { Renderer } from "../render/renderer"
import { Sound } from "../sound"
import { Hud } from "../ui/hud"
import { DEMO_NOTES, DEMO_TICKS, stageItem } from "./gallery"

const SCENES = ["round", "practice", "items"] as const
type Scene = (typeof SCENES)[number]
const MAX_DPR = 1.5

/** Every movement and combat number as a knob: label, unit, range and step, grouped as the game uses them. */
const TUNING_KNOBS: readonly [keyof Tuning, string, string, number, number, number, string][] = [
  ["runSpeed", "Run speed", "tiles/s", 3, 14, 0.1, "Run"],
  ["groundAccel", "Ground acceleration", "tiles/s²", 20, 200, 1, "Run"],
  ["groundBrake", "Ground braking", "tiles/s²", 20, 250, 1, "Run"],
  ["airAccel", "Air acceleration", "tiles/s²", 10, 150, 1, "Run"],
  ["jumpSpeed", "Jump speed", "tiles/s", 8, 30, 0.1, "Jump"],
  ["jumpCut", "Early release keeps", "×", 0.1, 1, 0.01, "Jump"],
  ["gravity", "Gravity", "tiles/s²", 20, 100, 0.5, "Jump"],
  ["apexGravity", "Apex gravity (jump held)", "tiles/s²", 10, 100, 0.5, "Jump"],
  ["apexBand", "Apex band", "tiles/s", 0, 10, 0.1, "Jump"],
  ["maxFall", "Fall speed cap", "tiles/s", 5, 30, 0.5, "Jump"],
  ["fastFall", "Fast fall cap (down held)", "tiles/s", 5, 40, 0.5, "Jump"],
  ["coyote", "Coyote time", "s", 0, 0.3, 0.01, "Jump"],
  ["jumpBuffer", "Jump buffer", "s", 0, 0.3, 0.01, "Jump"],
  ["wallSlide", "Wall slide cap", "tiles/s", 0, 15, 0.1, "Walls and ledges"],
  ["wallJumpX", "Wall jump push", "tiles/s", 2, 20, 0.1, "Walls and ledges"],
  ["wallJumpY", "Wall jump lift", "tiles/s", 5, 30, 0.1, "Walls and ledges"],
  ["wallJumpLock", "Wall jump steering lock", "s", 0, 0.5, 0.01, "Walls and ledges"],
  ["ledgeReach", "Ledge reach", "tiles", 0, 1.2, 0.05, "Walls and ledges"],
  ["dodgeSpeed", "Dodge speed", "tiles/s", 5, 35, 0.5, "Dodge and catch"],
  ["dodgeTime", "Dodge time", "s", 0.05, 0.5, 0.01, "Dodge and catch"],
  ["dodgeCooldown", "Dodge cooldown", "s", 0, 1.5, 0.01, "Dodge and catch"],
  ["catchWindow", "Catch window", "s", 0, 0.4, 0.01, "Dodge and catch"],
  ["catchRadius", "Catch radius", "tiles", 0.2, 2.5, 0.05, "Dodge and catch"],
  ["arrowSpeed", "Arrow speed", "tiles/s", 8, 50, 0.5, "Arrows and stomps"],
  ["arrowGravity", "Arrow gravity", "tiles/s²", 0, 40, 0.5, "Arrows and stomps"],
  ["arrowHoming", "Arrow homing", "rad/s", 0, 6, 0.05, "Arrows and stomps"],
  ["stompBounce", "Stomp bounce", "tiles/s", 4, 30, 0.5, "Arrows and stomps"],
  ["flapSpeed", "Wing flap speed", "tiles/s", 4, 25, 0.5, "Wings"],
  ["glideFall", "Glide fall cap", "tiles/s", 1, 15, 0.25, "Wings"],
]

const ITEM_LABELS: Record<Item, string> = { bomb: "Bomb arrows", laser: "Laser arrows", drill: "Drill arrows", bramble: "Bramble arrows", shield: "Shield", wings: "Wings" }

/**
 * The Archers playground (the Lab's `archers` station embeds it): an arena preview with four bots, practice against
 * bots with every movement and combat number on knobs, and the power-up gallery, all on the production World,
 * renderer and HUD. `#round/<arena>`, `#practice/<arena>/<bots>` and `#items/<item>` pick the scene.
 */
async function main() {
  document.title = `${GAME.title} Playground`
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const caption = document.getElementById("caption")!
  const params = new URLSearchParams(location.search)
  const sound = new Sound()
  sound.runtime.muted = true
  const controls = new Controls()
  const hud = new Hud(hudEl)
  hud.joinHint = false
  let game: Game | null = null
  let panelFocused = false

  const [hScene, hA, hB] = location.hash.replace(/^#/, "").split("/")
  const arenaIds = ARENA_DEFS.map((a) => a.id)
  const settings: LabSettings = {
    scene: SCENES.includes(hScene as Scene) ? hScene! : "round",
    arena: arenaIds.includes(hA ?? "") ? hA! : "belltower",
    bots: hScene === "practice" && Number(hB) >= 0 ? Math.min(3, Number(hB)) : 3,
    item: ITEMS.includes(hA as Item) ? hA! : "bomb",
    seed: Number(params.get("seed")) || 7,
    speed: 1,
    sound: false,
  }
  for (const [key] of TUNING_KNOBS) settings[`t.${key}`] = DEFAULT_TUNING[key]
  let demoStart = 0

  const seatsFor = (scene: Scene): Seat[] => {
    const n = scene === "practice" ? 1 + Number(settings.bots) : MAX_PLAYERS
    return Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: scene === "practice" && i === 0 ? "YOU" : SLOT_NAMES[i]!, device: scene === "practice" && i === 0 ? "kb" : null }))
  }
  const start = () => {
    if (!game) return
    const scene = settings.scene as Scene
    game.script = null
    game.focus = null
    if (scene === "items") {
      game.focus = stageItem(game, settings.item as Item, Number(settings.seed))
      game.focusSpan = 9
      demoStart = game.world.s.tick
    } else game.restart(Number(settings.seed), String(settings.arena), seatsFor(scene))
    const tail = scene === "items" ? settings.item : scene === "practice" ? `${settings.arena}/${settings.bots}` : settings.arena
    history.replaceState(null, "", `${location.pathname}${location.search}#${scene}/${tail}`)
  }
  const restart = (_: LabValue) => start()

  const sceneControls: LabControl[] = [
    {
      key: "scene", label: "Scene", group: "Scene",
      options: [{ value: "round", label: "Arena preview (4 bots)" }, { value: "practice", label: "Practice vs bots" }, { value: "items", label: "Power-up gallery" }],
      change: restart,
    },
    { key: "arena", label: "Arena", group: "Scene", visible: (s) => s.scene !== "items", options: ARENA_DEFS.map((a) => ({ value: a.id, label: a.name })), change: restart },
    { key: "bots", label: "Bots", group: "Scene", visible: (s) => s.scene === "practice", min: 0, max: 3, step: 1, change: restart },
    { key: "item", label: "Power-up", group: "Scene", visible: (s) => s.scene === "items", options: ITEMS.map((i) => ({ value: i, label: ITEM_LABELS[i] })), change: restart },
    { key: "seed", label: "Match seed", group: "Scene", min: 1, max: 999, step: 1, change: restart },
    { key: "speed", label: "Sim speed", group: "Scene", min: 0.1, max: 1, step: 0.05, unit: "×" },
    { key: "sound", label: "Sound", group: "Scene", type: "toggle", change: (v) => (sound.runtime.muted = !v) },
    { key: "restart", label: "Restart scene", group: "Scene", type: "action", run: () => start() },
  ]
  // The knobs edit the live world's tuning in place; restarts keep it, so a scene change never loses a value.
  const tuningControls: LabControl[] = TUNING_KNOBS.map(([key, label, unit, min, max, step, subsection]) => ({
    key: `t.${key}`, label, unit, min, max, step, group: "Moves", subsection,
    change: (v) => game && (game.world.t[key] = Number(v)),
  }))
  const panel = new LabPanel(settings, [...sceneControls, ...tuningControls], params, () => controls.keys.clearDowns(), {
    open: !params.has("nolab"),
    presets: false,
    capture: "focus",
    onFocusChange: (focused) => (panelFocused = focused),
  })
  attachLabPanelControl(panel)

  const set = (key: string, value: LabValue | undefined) => {
    if (value !== undefined) settings[key] = value
  }
  registerGameCommands((commands) =>
    commands.registerAll([
      {
        id: "archers.scene",
        label: "Archers playground scene",
        shortLabel: "Scene",
        category: "Scene",
        args: {
          scene: { type: "string", enum: SCENES },
          arena: { type: "string", enum: arenaIds },
          item: { type: "string", enum: ITEMS },
          bots: { type: "number", min: 0, max: 3 },
        },
        enabled: () => true,
        run: (ctx) => {
          const a = ctx?.args ?? {}
          set("scene", a.scene)
          set("arena", a.arena)
          set("item", a.item)
          set("bots", a.bots)
          start()
          panel.refresh()
          return { scene: settings.scene, arena: settings.arena, item: settings.item }
        },
      },
      {
        id: "archers.state",
        label: "Archers playground state",
        shortLabel: "State",
        category: "Scene",
        readOnly: true,
        enabled: () => true,
        run: () => ({
          scene: settings.scene,
          arena: game?.world.s.arena,
          tick: game?.world.s.tick ?? 0,
          archers: game?.world.s.archers.map((a) => ({ id: a.id, name: a.name, alive: a.alive, x: +a.x.toFixed(2), y: +a.y.toFixed(2), quiver: a.quiver.length })) ?? [],
          counts: game?.counts ?? {},
        }),
      },
    ]),
  )

  const g = await openGpu(canvas, `${GAME.title} Playground`)
  if (typeof g === "string") {
    hudEl.innerHTML = `<div class="notice"><div class="logo">${GAME.title}</div><div>${g}</div></div>`
    return
  }
  const renderer = new Renderer(g.device, g.context, g.format)
  game = new Game(renderer, controls, sound, { arena: String(settings.arena), seats: seatsFor(settings.scene as Scene), seed: Number(settings.seed) })
  ;(globalThis as { archers?: Game }).archers = game
  for (const [key] of TUNING_KNOBS) game.world.t[key] = Number(settings[`t.${key}`])
  start()

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
  let lastCaption = ""
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const gm = game!
    controls.enabled = !panelFocused
    if (settings.scene === "items" && gm.world.s.tick - demoStart >= DEMO_TICKS) start()
    gm.update(dt * Number(settings.speed))
    renderer.render(gm.build(innerWidth, innerHeight, dt))
    sound.listen(gm.cam.cx, gm.cam.cy)
    hud.update(gm, innerWidth, innerHeight, settings.scene === "practice")
    const text = captionOf(settings)
    if (text !== lastCaption) caption.innerHTML = lastCaption = text
    controls.endFrame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  ;(globalThis as { ready?: boolean }).ready = true
}

function captionOf(s: Readonly<LabSettings>): string {
  if (s.scene === "items") return `<b>${ITEM_LABELS[s.item as Item].toUpperCase()}</b><span>${DEMO_NOTES[s.item as Item]}</span>`
  const arena = ARENA_DEFS.find((a) => a.id === s.arena)?.name.toUpperCase() ?? ""
  if (s.scene === "practice") return `<b>PRACTICE · ${arena}</b><span>You against ${s.bots} bot${s.bots === 1 ? "" : "s"} · the Moves knobs change the game as you play</span>`
  return `<b>${arena}</b><span>Four bots, rounds back to back</span>`
}

void main()
