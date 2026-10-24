import { SoundBank } from "@arcade/kit/audio"
import type { VoiceHandle } from "@arcade/kit/audio/types"
import { animate, type Avatar, hit as flinch, newAvatar, pose, type PartModels } from "@arcade/kit/avatar/anim"
import { emitRagdoll, ragdoll, type Ragdoll, stepRagdoll } from "@arcade/kit/avatar/ragdoll"
import { registerPersonModels } from "@arcade/kit/avatar/soldier"
import { Camera, cameraShakeControls, cameraShakeDefaults, HitStop } from "@arcade/kit/client/camera"
import { onKeyLayoutChange } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { attachLabPanelControl } from "@arcade/kit/dev-control"
import { FOREST_QUALITY } from "@arcade/kit/forest/settings"
import type { ForestTorch } from "@arcade/kit/forest/view"
import { FlareFx } from "@arcade/kit/fx/flare"
import { Particles } from "@arcade/kit/fx/particles"
import { WoodFx, woodControls, woodDefaults } from "@arcade/kit/fx/wood"
import { openGpu } from "@arcade/kit/gpu/boot"
import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { MotionBlurBurst, motionBlurControls, motionBlurDefaults } from "@arcade/kit/gpu/motion-blur"
import { LabPanel } from "@arcade/kit/lab-panel"
import { audioRuntimeSync, createGameShell, createShellQuality, type GameShell } from "@arcade/kit/shell"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { mat4 } from "wgpu-matrix"
import { TIMBER_SFX, TRUCK_ENGINE } from "../shared/sfx"
import {
  active,
  createWorld,
  FEEL,
  FEEL_CONTROLS,
  type Jack,
  type JackInput,
  lumberjackOf,
  MAX_HP,
  newJack,
  newTree,
  NO_INPUT,
  PART_KINDS,
  type PartKind,
  pushTarget,
  resetRound,
  reviveTarget,
  type Role,
  sawTarget,
  stepWorld,
  upright,
  type ViewStyle,
  WALLS,
  type World,
} from "../shared/sim"
import { HINGE, predictedFall, type Tree, trunkHeightAt } from "../shared/trees"
import { Dread } from "./dread"
import { LOOK, LOOK_CONTROLS } from "./look"
import { type Held, SAW_PITCH, TimberPeople } from "./people-view"
import { timberSamples, TimberSound } from "./sounds"
import { loadSawAsset, type SawPoints, sawWorldMesh, SawView } from "./viewmodel"
import { flakeMesh, sliverMesh } from "./debris"
import { type Crawl, crawlPose, handBack, newCrawl } from "./downed"
import { TimberView } from "./world-view"

const DT = 1 / 60
const FFA_NAMES = ["You", "Red", "Gold", "Violet", "Lime", "Rose", "Teal", "Ash"]
const SURVIVOR_NAMES = ["Mara", "Jonas", "Tess", "Ike", "Wren", "Otto"]
const COLORS: Rgb[] = [
  [0.25, 0.82, 0.98],
  [0.95, 0.32, 0.26],
  [0.98, 0.78, 0.22],
  [0.72, 0.45, 0.98],
  [0.55, 0.92, 0.3],
  [0.98, 0.5, 0.7],
  [0.3, 0.9, 0.8],
  [0.75, 0.75, 0.75],
]
const LUMBERJACK_TINT: Rgb = [0.86, 0.18, 0.12]
const SURVIVOR_TINTS: Rgb[] = [
  [0.25, 0.82, 0.98],
  [0.98, 0.78, 0.22],
  [0.55, 0.92, 0.3],
  [0.72, 0.45, 0.98],
  [0.3, 0.9, 0.8],
  [0.98, 0.5, 0.7],
]
const PART_NAMES: Record<PartKind | "gas", string> = { fuel: "fuel can", plug: "spark plug", keys: "keys", gas: "gas can" }
/** Where along a falling tree the felling cam looks (share of its length). */
const FELL_AIM = 0.36
/** A felled tree's mass relative to a 25 m spruce with a 2.2 m crown: scales the landing. */
const treeMass = (t: Tree) => (t.h / 25) ** 2 * (t.crownR / 2.2)
const WOOD: Rgb = [0.62, 0.47, 0.3]
const NEEDLES: Rgb = [0.1, 0.2, 0.09]
const BLOOD: Rgb = [0.11, 0.008, 0.006]

function sawMesh(): Mesh {
  const m = new Mesh()
  // Frame: x forward along the bar, y up, z right; the grip at the origin.
  m.box(-0.24, -0.11, -0.08, 0.1, 0.09, 0.08, [0.95, 0.45, 0.08], MAT.lit)
  m.box(-0.2, 0.09, -0.025, 0.02, 0.15, 0.025, [0.12, 0.12, 0.12], MAT.lit)
  m.box(0.1, -0.035, -0.014, 0.72, 0.035, 0.014, [0.62, 0.64, 0.68], MAT.shiny)
  return m
}

function axeMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.1, -0.018, -0.018, 0.68, 0.018, 0.018, [0.55, 0.38, 0.22], MAT.lit)
  m.box(0.58, -0.03, -0.012, 0.72, 0.16, 0.012, [0.5, 0.52, 0.56], MAT.shiny)
  m.box(0.6, 0.14, -0.006, 0.74, 0.19, 0.006, [0.85, 0.87, 0.9], MAT.shiny)
  return m
}

/** An old logging truck, nose along +x, with logs on the bed. */
function truckMesh(): Mesh {
  const m = new Mesh()
  m.box(-3, 0.55, -1.15, 1.2, 0.85, 1.15, [0.2, 0.2, 0.22], MAT.lit)
  m.box(1.1, 0.55, -1.15, 3, 1.5, 1.15, [0.62, 0.16, 0.12], MAT.lit)
  m.box(1.2, 1.5, -1.1, 2.4, 2.45, 1.1, [0.62, 0.16, 0.12], MAT.lit)
  m.box(2.3, 1.6, -1.0, 2.42, 2.3, 1.0, [0.2, 0.3, 0.36], MAT.shiny)
  for (const z of [-0.65, 0, 0.65]) m.box(-2.9, 0.85, z - 0.3, 0.9, 1.45, z + 0.3, [0.42, 0.3, 0.2], MAT.lit)
  m.box(-2.95, 0.88, -0.95, -2.6, 1.42, 0.95, WOOD, MAT.lit)
  for (const x of [-2.2, -0.9, 2.2])
    for (const z of [-1.18, 0.88]) m.box(x - 0.42, 0, z, x + 0.42, 0.84, z + 0.3, [0.08, 0.08, 0.08], MAT.lit)
  for (const z of [-0.8, 0.8]) m.box(2.98, 0.95, z - 0.14, 3.04, 1.15, z + 0.14, [1, 0.95, 0.75], MAT.lit)
  return m
}

function itemMesh(kind: PartKind | "gas"): Mesh {
  const m = new Mesh()
  if (kind === "fuel" || kind === "gas") {
    const c: Rgb = kind === "fuel" ? [0.25, 0.55, 0.28] : [0.75, 0.12, 0.08]
    m.box(-0.17, 0, -0.08, 0.17, 0.42, 0.08, c, MAT.lit)
    m.box(-0.12, 0.42, -0.03, 0.04, 0.5, 0.03, [0.15, 0.15, 0.15], MAT.lit)
    m.box(0.08, 0.42, -0.025, 0.14, 0.52, 0.025, [0.7, 0.62, 0.2], MAT.lit)
    // A reflective band, so a torch beam finds it in the dark.
    m.box(-0.175, 0.17, -0.085, 0.175, 0.23, 0.085, [0.85, 0.85, 0.8], MAT.retro)
  } else if (kind === "plug") {
    m.box(-0.1, 0, -0.1, 0.1, 0.05, 0.1, [0.35, 0.3, 0.25], MAT.lit)
    m.prism(0, 0, 0.03, 0.03, 0.05, 0.16, 6, [0.92, 0.92, 0.88], MAT.lit)
    m.prism(0, 0, 0.022, 0.022, 0.16, 0.24, 6, [0.6, 0.62, 0.66], MAT.shiny)
    m.box(-0.105, 0.05, -0.105, 0.105, 0.065, 0.105, [0.85, 0.85, 0.8], MAT.retro)
  } else {
    m.box(-0.12, 0, -0.1, 0.12, 0.03, 0.1, [0.35, 0.3, 0.25], MAT.lit)
    m.box(-0.06, 0.03, -0.015, 0.03, 0.05, 0.05, [0.95, 0.78, 0.2], MAT.shiny)
    m.box(0.03, 0.03, 0, 0.12, 0.045, 0.02, [0.85, 0.85, 0.82], MAT.shiny)
    m.box(-0.12, 0.03, -0.1, -0.07, 0.04, 0.1, [0.85, 0.85, 0.8], MAT.retro)
  }
  return m
}

/** A pool of blood at unit radius: an irregular dark disc lying on the ground. */
function poolMesh(seed: number): Mesh {
  const m = new Mesh()
  const rnd = mulberry32(seed)
  const seg = 18
  const lobes = Array.from({ length: 4 }, () => [rnd() * Math.PI * 2, 0.15 + rnd() * 0.25] as const)
  const at = (a: number) => {
    let r = 0.75 + rnd() * 0.1
    for (const [c, k] of lobes) r += k * Math.max(0, Math.cos(a - c)) ** 4
    return [Math.cos(a) * r, 0, Math.sin(a) * r]
  }
  const ring = Array.from({ length: seg }, (_, s) => at((s / seg) * Math.PI * 2))
  for (let s = 0; s < seg; s++) m.facet([0, 0, 0], ring[(s + 1) % seg]!, ring[s]!, BLOOD, MAT.lit)
  return m
}

const smooth = (e0: number, e1: number, v: number) => {
  const k = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return k * k * (3 - 2 * k)
}
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const mixAngle = (a: number, b: number, k: number) => a + wrapAngle(b - a) * k
/** The camera yaw that sits behind someone aiming at `aim` (sim radians). */
const yawBehind = (aim: number) => Math.atan2(-Math.cos(aim), -Math.sin(aim))
/** The sim aim along a camera yaw. */
const aimOfYaw = (yaw: number) => Math.atan2(-Math.cos(yaw), -Math.sin(yaw))

const controlsHtml = () => {
  const common = [keyPromptHtml("KeyR", "New round"), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Escape", "Menu")]
  if (FEEL.mode === "ffa") return [keyPromptHtml("KeyW", "Move"), keyPromptHtml("ShiftLeft", "Sprint"), keyPromptHtml("Mouse0", "Saw (hold)"), keyPromptHtml("Space", "Lunge"), ...common].join(" ")
  if (FEEL.playAs === "lumberjack")
    return [keyPromptHtml("KeyW", "Move"), keyPromptHtml("Mouse0", "Rev / saw (hold)"), keyPromptHtml("Space", "Lunge (revved)"), keyPromptHtml("KeyQ", "Engine on/off"), ...common].join(" ")
  return [
    keyPromptHtml("KeyW", "Move"),
    keyPromptHtml("ShiftLeft", "Sprint"),
    keyPromptHtml("Mouse0", "Axe (hold)"),
    keyPromptHtml("KeyE", "Revive / shove", { hold: true }),
    keyPromptHtml("KeyF", "Torch"),
    keyPromptHtml("KeyG", "Flare"),
    ...common,
  ].join(" ")
}

type AutoCamera = { x: number; y: number; dist: number; pitch: number; yaw?: number; height?: number; fov?: number }
type Automation = { input: JackInput | null; camera: AutoCamera | null }
type Later = { at: number; run: () => void }

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hud = document.getElementById("hud")!
  const status = document.getElementById("status")!
  const banner = document.getElementById("banner")!
  const feed = document.getElementById("feed")!
  const ring = document.getElementById("cut")!
  const bars = document.getElementById("bars")!
  const hint = document.getElementById("hint")!
  const clock = document.getElementById("clock")!
  const ping = document.getElementById("ping")!
  const truckPing = document.getElementById("truckping")!
  const glare = document.getElementById("glare")!
  const params = new URLSearchParams(location.search)

  const smoke = params.has("smoke")
  const live: { panel: LabPanel | null; shell: GameShell | null; view: TimberView | null; newRound?: () => void } = { panel: null, shell: null, view: null }
  // Auto starts at High and steps down on slow frames; `?quality=` pins a mode for automation.
  const quality = createShellQuality({
    game: "timber",
    tiers: FOREST_QUALITY,
    params,
    onChange: () => {
      live.view?.forest.setQuality(quality.tier)
      live.shell?.settings.changed()
    },
  }).expose()
  if (smoke) quality.setMode("low", false)
  const shell = createGameShell({
    game: "timber",
    title: "TIMBER",
    subtitle: "One lumberjack with a chainsaw. Three of you with axes. Fix the truck and get out of the woods.",
    playLabel: "Into the woods",
    resumeLabel: "Back to the forest",
    channels: ["master", "effects", "engine", "ambience"],
    labels: { engine: "Engines (saw, truck)" },
    quality,
    pauseOnHidden: true,
    blocked: () => live.panel?.holdsInput ?? false,
    keysBlocked: () => live.panel?.hasFocus() ?? false,
    controls: controlsHtml,
    onLeave: () => live.newRound?.(),
  })
  live.shell = shell

  const gpu = await openGpu(canvas, "TIMBER")
  if (typeof gpu === "string") {
    hud.textContent = gpu
    return
  }
  const seed = Number(params.get("seed")) || 1 + Math.floor(Math.random() * 1e6)
  const w: World = createWorld(seed, FEEL)
  const view = await TimberView.create(gpu, w, quality.tier, smoke)
  live.view = view
  const r = view.renderer

  const human = registerPersonModels((m) => r.addModel(m))
  const sawModel = r.addModel(sawMesh())
  const motorMesh = new Mesh()
  motorMesh.box(-0.06, -0.06, -0.06, 0.06, 0.06, 0.06, [0.95, 0.45, 0.08], MAT.lit)
  const motorModel = r.addModel(motorMesh)
  const axeModel = r.addModel(axeMesh())
  const noMag = r.addModel(new Mesh())
  // The rig's rifle hold, with a chainsaw (or an axe) in the rifle's place.
  const sawParts: PartModels = { ...human, gun: { ...human.gun, rifle: sawModel }, mag: { ...human.mag, rifle: motorModel } }
  const axeParts: PartModels = { ...human, gun: { ...human.gun, rifle: axeModel }, mag: { ...human.mag, rifle: noMag } }
  // Flakes and slivers, one in three with bark on its underside, picked per chip.
  const chipModels = [11, 23, 37, 41, 59, 67].map((seed, i) => r.addModel(flakeMesh(seed, i % 3 === 2)))
  const splinterModels = [5, 17, 29].map((seed, i) => r.addModel(sliverMesh(seed, i === 1)))
  const twigMesh = new Mesh()
  twigMesh.box(-0.03, -0.5, -0.03, 0.03, 0.5, 0.03, [0.22, 0.15, 0.1], MAT.lit)
  twigMesh.box(-0.12, 0.1, -0.12, 0.12, 0.5, 0.12, NEEDLES, MAT.lit)
  const twigModel = r.addModel(twigMesh)
  const truckModel = r.addModel(truckMesh())
  const itemModels = { fuel: r.addModel(itemMesh("fuel")), plug: r.addModel(itemMesh("plug")), keys: r.addModel(itemMesh("keys")), gas: r.addModel(itemMesh("gas")) }
  const poolModels = [3, 19, 41, 77].map((s) => r.addModel(poolMesh(s)))
  const torchMesh = new Mesh()
  torchMesh.box(-0.11, -0.017, -0.017, 0.1, 0.017, 0.017, [0.05, 0.05, 0.055], MAT.lit)
  torchMesh.box(0.1, -0.024, -0.024, 0.135, 0.024, 0.024, [0.3, 0.3, 0.32], MAT.shiny)
  const torchModel = r.addModel(torchMesh)
  // The software-GPU smoke stays on the blocky rig.
  const people = smoke ? null : new TimberPeople(r)

  const sound = new SoundBank("timber", TIMBER_SFX, timberSamples(import.meta.env.BASE_URL))
  const tsound = new TimberSound(sound)
  const dread = new Dread(canvas)
  const syncRuntime = audioRuntimeSync(shell.settings, sound.runtime)
  // The bank re-applies its own volumes when it unlocks; keep them the shell's so that never undoes the player's mix.
  const syncAudio = () => {
    Object.assign(sound.volumes, shell.settings.volumes)
    syncRuntime()
  }
  const particles = new Particles()
  const fx = mulberry32(7)
  const fp = new FrameParts()
  const input = new Input(canvas, [])
  const labSettings = Object.assign(FEEL, LOOK, cameraShakeDefaults(), woodDefaults())
  const wood = new WoodFx(labSettings, 2400, 3)
  const cam = new Camera(labSettings)
  const hitStop = new HitStop()
  // The scanned saw: in your hands as the overlay pass, at its low LOD in everyone else's (the block until it loads).
  const sawView = new SawView(r.passContext, labSettings)
  r.setOverlayPass(sawView.overlay)
  let sawAt: SawPoints | null = null
  void loadSawAsset(`${import.meta.env.BASE_URL}saw/saw.glb`)
    .then(async (asset) => {
      r.setModel(sawModel, sawWorldMesh(asset))
      await sawView.upload(asset, r.passContext.device)
    })
    .catch((err) => console.error("saw", err))

  const panel = new LabPanel(labSettings, [...FEEL_CONTROLS, ...LOOK_CONTROLS, ...woodControls(), ...cameraShakeControls], params, () => input.release(), { open: false, openGroups: ["Round"] })
  panel.addControls(view.forest.settings as unknown as Record<string, number | string | boolean>, view.forest.controls())
  // The shared shutter blur; sprinting scales its strength and impacts add bursts.
  const blurSettings = motionBlurDefaults()
  panel.addControls(blurSettings, [...motionBlurControls])
  const burst = new MotionBlurBurst()
  const frameBlur = { settings: { ...blurSettings }, burst, dt: DT }
  live.panel = panel
  attachLabPanelControl(panel)
  shell.settings.subscribe(() => {
    labSettings.reduceMotion = shell.settings.reduceMotion ? 1 : 0
    panel.sync()
  })
  labSettings.reduceMotion = shell.settings.reduceMotion ? 1 : 0

  const prompts = () => (hud.innerHTML = [controlsHtml(), keyPromptHtml("Backquote", "Feel knobs")].join(" "))
  prompts()
  onKeyLayoutChange(prompts)

  // Hurt: the edges of the view go dark red.
  const hurt = document.createElement("div")
  hurt.style.cssText = "position:fixed;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 45%,rgba(70,0,0,.9) 100%)"
  canvas.after(hurt)
  let avatars = new Map<number, Avatar>()
  /** Ragdolls: the dead, and the downed (which crawl, so they follow the sim body). */
  let corpses = new Map<number, Ragdoll>()
  let crawlAt = new Map<number, { x: number; y: number }>()
  /** The downed, face down and dragging themselves along; and the torches they dropped, still on, where they fell. */
  let crawls = new Map<number, Crawl>()
  let dropped = new Map<number, { x: number; y: number; yaw: number; on: boolean }>()
  let truckVoice: VoiceHandle | null = null
  let flareFx = new Map<number, FlareFx>()
  let whooshed = new Set<number>()
  let later: Later[] = []
  let feedLines: { text: string; t: number }[] = []
  let camYaw = 0
  /** First person: how far the view looks down (rad). */
  let camPitch = LOOK.firstPitch
  /** Field-of-view punch (°), the pull cord's pitch kick (rad), a stumble (0..1), the sprint (0..1) and the bob phase. */
  let fovKick = 0
  let pitchKick = 0
  let stumble = 0
  let sprintK = 0
  let bobPhase = 0
  /** How deep the bar is in wood (0..1, eased), for the viewmodel. */
  let cutK = 0
  /** The chase camera's distance after pulling in at trunks (m). */
  let chaseD = LOOK.chaseDist
  /** The felling cam: a shot side-on to a tree you dropped, on game time so slow-mo stretches it. */
  let fellShot: { tree: number; at: number; x: number; y: number } | null = null
  let wasFirst = false
  type Pool = { x: number; y: number; at: number; size: number; yaw: number; model: number }
  let pools: Pool[] = []
  let dripAt = new Map<number, number>()
  /** Each lumberjack's helmet lamp: where it points (eased, as a head turns) and the tree he is watching fall. */
  let lamps = new Map<number, { dir: [number, number, number]; tree: number; until: number }>()
  let slowMo = 0
  const auto: Automation = { input: null, camera: null }

  const newAvatars = () => {
    tsound.stopAll()
    truckVoice?.stop(0.2)
    truckVoice = null
    dread.clear()
    people?.reset()
    burst.reset()
    fovKick = pitchKick = stumble = sprintK = cutK = 0
    camPitch = LOOK.firstPitch
    corpses = new Map()
    crawlAt = new Map()
    crawls = new Map()
    dropped = new Map()
    flareFx = new Map()
    whooshed = new Set()
    later = []
    avatars = new Map(w.jacks.map((j) => [j.id, newAvatar(`jack-${j.id}`, j.x, j.y, j.aim, "rifle")]))
    const me = w.jacks[0]
    if (me) {
      cam.snap(me.x, me.y)
      camYaw = yawBehind(me.aim)
    }
    cam.resetShake()
    view.forest.resetExposure()
    pools = []
    dripAt = new Map()
    lamps = new Map()
    fellShot = null
    particles.reset()
    wood.reset()
    feedLines = []
    slowMo = 0
    prompts()
  }
  newAvatars()
  const newRound = () => {
    resetRound(w, FEEL)
    view.sync(w)
    newAvatars()
  }
  live.newRound = newRound

  // The lobby: pick a side. Bots take the other seats.
  const picks = document.createElement("div")
  picks.className = "tb-picks"
  const drawPicks = () => {
    const opt = (role: Role, title: string, line: string) =>
      `<button type="button" data-role="${role}" class="${FEEL.mode === "hunt" && FEEL.playAs === role ? "on" : ""}"><b>${title}</b><small>${line}</small></button>`
    picks.innerHTML =
      opt("survivor", "Survivor", "Axe, torch and two flares. Find the fuel, the spark plug and the keys, then get to the truck.") +
      opt("lumberjack", "Lumberjack", "A chainsaw and a tank of fuel. Hunt them through the trees. Nobody leaves.")
  }
  drawPicks()
  picks.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-role]") as HTMLButtonElement | null
    if (!b) return
    FEEL.mode = "hunt"
    FEEL.playAs = b.dataset.role as Role
    panel.sync()
    drawPicks()
    newRound()
    sound.play("ui.click")
  })
  shell.view?.titleSlot.append(picks)

  const pressed = { engine: false, torch: false, flare: false }
  input.onKey = (code) => {
    if (!shell.playing) return
    if (code === "KeyR") newRound()
    else if (code === "KeyQ") pressed.engine = true
    else if (code === "KeyF") pressed.torch = true
    else if (code === "KeyG") pressed.flare = true
  }
  /**
   * The view in use. `auto` is Dead by Daylight's split: the lumberjack in first person, survivors close over the
   * shoulder, and the low chase once you're out and watching someone else.
   */
  const resolvedView = (): ViewStyle => {
    if (FEEL.viewStyle !== "auto") return FEEL.viewStyle
    const f = focusJack()
    if (f.id !== 0) return "chase"
    return f.role === "lumberjack" ? "first" : "shoulder"
  }
  // The first-person, chase and shoulder views: mouse look on the pointer lock (click to take it).
  const mouseLook = () => {
    const v = resolvedView()
    return v === "first" || v === "chase" || v === "shoulder"
  }
  canvas.addEventListener("click", () => {
    if (mouseLook() && shell.playing && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
  })
  // Escape releases the lock before the shell sees the key, so a lost lock mid-play is the pause.
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== canvas && shell.playing) shell.flow.pause()
  })
  shell.flow.subscribe(() => {
    if (!shell.playing && document.pointerLockElement === canvas) document.exitPointerLock()
  })
  window.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas || !mouseLook()) return
    camYaw -= e.movementX * 0.0028
    if (resolvedView() === "first") camPitch = Math.max(-0.5, Math.min(1, camPitch + e.movementY * 0.0024))
  })

  const say = (text: string) => {
    feedLines.push({ text, t: w.t })
    if (feedLines.length > 5) feedLines.shift()
  }
  const nameOf = (id: number) => {
    if (id < 0) return "Nobody"
    if (id === 0) return "You"
    if (w.mode === "ffa") return FFA_NAMES[id] ?? `Bot ${id}`
    const j = w.jacks[id]
    if (j?.role === "lumberjack") return "The lumberjack"
    return SURVIVOR_NAMES[id % SURVIVOR_NAMES.length]!
  }
  const tintOf = (id: number): Rgb => {
    if (w.mode === "ffa") return COLORS[id % COLORS.length]!
    return w.jacks[id]?.role === "lumberjack" ? LUMBERJACK_TINT : SURVIVOR_TINTS[id % SURVIVOR_TINTS.length]!
  }
  const after = (s: number, run: () => void) => later.push({ at: w.t + s, run })

  const resize = () => {
    if (quality.fit(canvas, innerWidth, innerHeight)) view.forest.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

  const humanInput = (): JackInput => {
    const me = w.jacks[0]!
    const presses = { ...pressed }
    pressed.engine = pressed.torch = pressed.flare = false
    if (auto.input) {
      // Presses last one tick, as from the keyboard.
      const once = { ...auto.input }
      auto.input.engine = auto.input.torch = auto.input.flare = false
      return once
    }
    if (!input.enabled) return { ...NO_INPUT, aim: me.aim }
    const { mx, my } = input.move()
    const keys = { ...presses, use: input.held("KeyE"), saw: input.firing, dash: input.takeJump(), sprint: input.sprinting }
    if (mouseLook()) {
      const fwdX = -Math.sin(camYaw)
      const fwdY = -Math.cos(camYaw)
      const rx = Math.cos(camYaw)
      const ry = -Math.sin(camYaw)
      // Locked, you aim where the camera looks; before the click, the cursor turns the aim off the view's centre.
      const u = document.pointerLockElement === canvas ? 0 : ((input.mouse.x / innerWidth) * 2 - 1) * Math.tan(cam.fov / 2) * (innerWidth / Math.max(1, innerHeight))
      return { ...keys, mx: rx * mx - fwdX * my, my: ry * mx - fwdY * my, aim: Math.atan2(fwdY + ry * u, fwdX + rx * u) }
    }
    const cursor = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight, 1)
    return { ...keys, mx, my, aim: Math.atan2(cursor.y - me.y, cursor.x - me.x) }
  }

  /** Who the camera follows: you, or once you're out, someone still in it. */
  const focusJack = (): Jack => {
    const me = w.jacks[0]!
    if (active(me) || w.mode === "ffa") return me
    return w.jacks.find((j) => j.role === "survivor" && upright(j)) ?? w.jacks.find((j) => active(j)) ?? me
  }
  const listener = () => focusJack()
  const camDist = (x: number, y: number) => {
    const f = listener()
    return Math.hypot(x - f.x, y - f.y)
  }
  const involvesMe = (...ids: number[]) => ids.includes(focusJack().id)

  /** A pool of blood that spreads where it lands; a fresh one this close just feeds the last. */
  const pool = (x: number, y: number, size: number) => {
    if (labSettings.bloodPool <= 0) return
    size *= labSettings.bloodPool
    const near = pools.find((p) => Math.hypot(p.x - x, p.y - y) < p.size * 0.8)
    if (near) {
      near.size = Math.min(1.6, Math.hypot(near.size, size * 0.7))
      return
    }
    pools.push({ x, y, at: w.t, size, yaw: fx() * Math.PI * 2, model: poolModels[Math.floor(fx() * poolModels.length)]! })
    if (pools.length > 60) pools.shift()
  }
  const bleed = (x: number, y: number, dir: number, amount: number) => {
    wood.bloodMist(particles, x, 1.05, y, dir, amount * labSettings.bloodDrops)
    pool(x + Math.cos(dir) * 0.45, y + Math.sin(dir) * 0.45, 0.22 * Math.sqrt(amount))
  }

  const ragdollFor = (j: Jack, dir: number, style: "crush" | "saw" | "down") => {
    const a = avatars.get(j.id)
    if (!a?.body || corpses.has(j.id)) return
    const s =
      style === "crush" ? { push: 0.4, lift: 0, spin: 0, buckle: 2.2 } : style === "down" ? { push: 1.6, lift: 0.1, spin: (fx() - 0.5), buckle: 1.4 } : { push: 4.5, lift: 0.5, spin: (fx() - 0.5) * 2, buckle: 0.2 }
    const rd = ragdoll(a.body, "rifle", j.vx, j.vy, Math.cos(dir), Math.sin(dir), s, WALLS)
    corpses.set(j.id, rd)
    crawlAt.set(j.id, { x: j.x, y: j.y })
    if (style === "down") {
      crawls.set(j.id, newCrawl(rd, j.aim, w.t, j.x, j.y))
      // The torch leaves the hand and lands a step off, pointing wherever it fell.
      if (j.role === "survivor" && w.mode === "hunt") {
        const side = fx() < 0.5 ? -1 : 1
        const ox = Math.cos(dir) * 0.35 - Math.sin(j.aim) * side * 0.45
        const oy = Math.sin(dir) * 0.35 + Math.cos(j.aim) * side * 0.45
        dropped.set(j.id, { x: j.x + ox, y: j.y + oy, yaw: dir + (fx() - 0.5) * 1.6, on: j.torch })
      }
    }
  }

  const slow = () => {
    if (FEEL.slowMoTime > 0) slowMo = FEEL.slowMoTime
  }
  const reduced = () => cam.isReducedMotion()
  /** A blur burst (directional along screen angle `dir`, radial, shutter boost), off with reduced motion. */
  const blurHit = (radial: number, boost: number, dir?: number, directional = 0) => {
    if (!reduced()) burst.add({ radial, boost, ...(dir !== undefined ? { dir, directional } : {}) }, blurSettings.burst)
  }
  /** Saw contact near the camera: hit-stop's partner, a field-of-view punch, a burst and blood on the lens. */
  const contact = (x: number, y: number, amount: number) => {
    const d = camDist(x, y)
    if (d > 3) return
    const k = 1 - d / 3
    fovKick = Math.max(fovKick, labSettings.fovPunch * k * Math.min(1, amount))
    blurHit(0.008 * k * amount, 0.5 * k, fx() * Math.PI * 2, 0.005 * k)
    dread.splash(amount * k, labSettings, fx)
  }

  const handleEvents = () => {
    const me = w.jacks[0]!
    for (const e of w.events) {
      if (e.kind === "warn") {
        const t = w.trees[e.tree]!
        tsound.at("tree-creak", t.x, t.y, { gain: 1.3, h: 4 })
      } else if (e.kind === "fell") {
        const t = w.trees[e.tree]!
        // The big crack as the hinge lets go, then the long groan as it tips.
        tsound.at("tree-crack", t.x, t.y, { gain: 1.6, h: 1 })
        after(0.32, () => tsound.at("tree-groan", t.x, t.y, { gain: 1.2, h: 3 }))
        wood.splinters(t.x, HINGE, t.y, t.fx, t.fy, view.cutRadius(t, e.tree))
        if (involvesMe(e.by)) cam.add(0.12)
        fellCam(t)
        const lamp = lamps.get(e.by)
        if (lamp) Object.assign(lamp, { tree: t.id, until: w.t + labSettings.fellCamTime })
        say(`${nameOf(e.by)} felled a tree`)
      } else if (e.kind === "domino") {
        const t = w.trees[e.tree]!
        const h = Math.min(t.h, 9)
        sound.play("melee.break", t.x, t.y, { rate: 0.6, gain: 1.2 })
        tsound.at("tree-crack", t.x, t.y, { gain: 1.3, rate: 0.9 })
        wood.branches(particles, t.x, h, t.y, 1.4)
        wood.splinters(t.x, HINGE, t.y, t.fx, t.fy, view.cutRadius(t, e.tree))
        if (e.chain >= 2) slow()
        say(e.chain >= 2 ? `Domino ×${e.chain + 1}!` : "Domino!")
      } else if (e.kind === "brush") {
        // A falling crown raking a standing tree: branches snap off it.
        const from = w.trees[e.from]!
        const o = w.trees[e.tree]!
        const s = Math.hypot(o.x - from.x, o.y - from.y)
        const h = Math.max(2, trunkHeightAt(from, s))
        wood.branches(particles, o.x, h, o.y, 0.9)
        sound.play("melee.hit.wood", o.x, o.y, { rate: 0.7 + fx() * 0.2, gain: 1.1 })
        after(0.07, () => sound.play("impact.bullet.wood", o.x, o.y, { rate: 0.8, gain: 0.7 }))
      } else if (e.kind === "land") {
        const t = w.trees[e.tree]!
        const mx = t.x + t.fx * t.h * 0.5
        const my = t.y + t.fy * t.h * 0.5
        const near = Math.max(0, 1 - camDist(mx, my) / 40)
        const mass = treeMass(t)
        const k = Math.min(1.4, (e.speed / 35) * mass)
        sound.play("weather.thunder.close", mx, my, { gain: 0.6 * k + 0.15, rate: 1.3 })
        tsound.at("tree-crash", mx, my, { gain: 1.1 + 0.5 * Math.min(1, k), h: 0.5 })
        for (const d of [0.06, 0.17, 0.31]) {
          const s = t.h * (0.55 + fx() * 0.45)
          after(d, () => sound.play("melee.hit.wood", t.x + t.fx * s, t.y + t.fy * s, { rate: 0.55 + fx() * 0.3, gain: 0.9 }))
        }
        hitStop.trigger((FEEL.landHitStopMs / 1000) * near * Math.min(1, k))
        cam.add(FEEL.landShake * labSettings.landingShake * near * Math.min(1, k), Math.atan2(t.fy, t.fx))
        view.land(t.id, e.speed / (t.h + HINGE), labSettings)
        wood.landing(particles, t.x, t.y, t.fx, t.fy, t.h, t.crownR, 1 - t.crown0, mass * Math.min(1.3, e.speed / 30))
        blurHit(0.012 * near * Math.min(1, k), 0.7 * near)
        // Close to where it came down, the ground jumps under you and you stumble.
        const f = focusJack()
        const s = Math.max(0, Math.min(t.h, (f.x - t.x) * t.fx + (f.y - t.y) * t.fy))
        const off = Math.hypot(t.x + t.fx * s - f.x, t.y + t.fy * s - f.y)
        if (upright(f)) stumble = Math.max(stumble, Math.max(0, 1 - off / 9) * Math.min(1, k) * labSettings.stumble)
      } else if (e.kind === "crush") {
        const j = w.jacks[e.jack]!
        const t = w.trees[e.tree]
        const dir = t ? Math.atan2(t.fy, t.fx) : 0
        sound.play("zombie.hit", j.x, j.y, { rate: 0.7, gain: 1.3 })
        sound.play("body.hurt", j.x, j.y)
        bleed(j.x, j.y, dir, 2.2)
        corpses.delete(j.id)
        ragdollFor(j, dir, "crush")
        slow()
        say(e.by === e.jack ? `${nameOf(e.jack)} dropped a tree on themselves` : `${nameOf(e.by)} crushed ${nameOf(e.jack)}`)
      } else if (e.kind === "pin") {
        const j = w.jacks[e.jack]!
        sound.play("body.hurt", j.x, j.y, { rate: 0.8, gain: 1.2 })
        sound.play("melee.hit.metal", j.x, j.y, { rate: 0.6 })
        say(`${nameOf(e.by)} pinned ${nameOf(e.jack).toLowerCase()} under a tree!`)
        if (involvesMe(e.jack)) cam.addFlash(0.6)
      } else if (e.kind === "sawStart") {
        const v = w.jacks[e.jack]!
        const by = w.jacks[e.by]!
        sound.play("melee.hit.blade", v.x, v.y, { gain: 1.1 })
        if (involvesMe(e.by, e.jack)) {
          hitStop.trigger(FEEL.sawHitStopMs / 1000)
          const dir = Math.atan2(v.y - by.y, v.x - by.x)
          // Chain kickback: the bar jumps back at whoever holds it.
          cam.add(FEEL.sawShake, e.by === focusJack().id ? dir + Math.PI : dir, FEEL.sawKick)
          contact(v.x, v.y, 1)
        }
        if (e.by === focusJack().id) sawView.kick(1)
      } else if (e.kind === "gore") {
        bleed(e.x, e.y, e.dir, 0.5)
        if (fx() < 0.4) sound.play("zombie.hit", e.x, e.y, { gain: 0.6, rate: 0.9 + fx() * 0.3 })
        const v = avatars.get(e.jack)
        if (v && !corpses.has(e.jack)) flinch(v, Math.cos(e.dir), Math.sin(e.dir), 0.6)
        if (involvesMe(e.by, e.jack)) cam.add(FEEL.sawShake * 0.25, e.by === focusJack().id ? e.dir + Math.PI : e.dir, FEEL.sawKick * 0.3)
        if (e.jack === focusJack().id) cam.addFlash(0.15)
        if (e.by === focusJack().id) sawView.kick(0.25)
        if (involvesMe(e.by, e.jack) && fx() < 0.35) contact(e.x, e.y, 0.4)
      } else if (e.kind === "clash") {
        // In first person the sparks come off your own bar's nose, where the view shows it.
        const mine = sawAt && (e.a === focusJack().id || e.b === focusJack().id)
        if (mine) wood.sparks(particles, sawAt!.nose[0], sawAt!.nose[1], sawAt!.nose[2], e.dir)
        else wood.sparks(particles, e.x, 1.0, e.y, e.dir)
        sound.play("melee.hit.metal", e.x, e.y, { rate: 1.2 + fx() * 0.3, gain: 0.9 })
        if (involvesMe(e.a, e.b)) cam.add(FEEL.sawShake * 0.3, e.dir + Math.PI, FEEL.sawKick * 0.5)
        if (mine) sawView.kick(0.5)
      } else if (e.kind === "fling") {
        const v = w.jacks[e.jack]!
        sound.play("melee.swing.heavy", v.x, v.y)
        const a = avatars.get(e.jack)
        if (a) flinch(a, Math.cos(e.dir), Math.sin(e.dir), 1.4)
      } else if (e.kind === "kill" || e.kind === "execute") {
        const v = w.jacks[e.jack]!
        sound.play("zombie.hit", v.x, v.y, { gain: 1.3, rate: 0.75 })
        sound.play("body.hurt", v.x, v.y)
        bleed(v.x, v.y, e.dir, e.kind === "execute" ? 3 : 2)
        if (e.kind === "kill") ragdollFor(v, e.dir, "saw")
        if (involvesMe(e.by, e.jack)) {
          hitStop.trigger(0.11)
          cam.add(FEEL.sawShake * 1.6, e.dir, FEEL.sawKick)
          contact(v.x, v.y, 1.6)
          if (e.kind === "execute" && labSettings.executeSlowMo > 0) slow()
        }
        if (e.by === focusJack().id) sawView.kick(1.2)
        say(e.kind === "execute" ? `${nameOf(e.by)} finished ${nameOf(e.jack)}` : `${nameOf(e.by)} sawed ${nameOf(e.jack)}`)
      } else if (e.kind === "down") {
        const v = w.jacks[e.jack]!
        sound.play("body.hurt", v.x, v.y, { gain: 1.2 })
        sound.play("zombie.hit", v.x, v.y, { gain: 1.1, rate: 0.8 })
        bleed(v.x, v.y, e.dir, 1.6)
        ragdollFor(v, e.dir, "down")
        if (involvesMe(e.by, e.jack)) {
          hitStop.trigger(0.09)
          cam.add(FEEL.sawShake * 1.2, e.dir, FEEL.sawKick)
          contact(v.x, v.y, 1.2)
        }
        if (e.by === focusJack().id) sawView.kick(1.1)
        say(`${nameOf(e.jack)} ${e.jack === 0 ? "are" : "is"} down`)
      } else if (e.kind === "bleedout") {
        say(`${nameOf(e.jack)} bled out`)
      } else if (e.kind === "revive") {
        const v = w.jacks[e.jack]!
        corpses.delete(e.jack)
        crawlAt.delete(e.jack)
        crawls.delete(e.jack)
        dropped.delete(e.jack)
        avatars.set(e.jack, newAvatar(`jack-${e.jack}`, v.x, v.y, v.aim, "rifle"))
        sound.play("pickup.item", v.x, v.y, { rate: 0.7 })
        say(`${nameOf(e.by)} got ${e.jack === 0 ? "you" : nameOf(e.jack)} up`)
      } else if (e.kind === "dash") {
        const j = w.jacks[e.jack]!
        sound.play("melee.swing.light", j.x, j.y, { rate: 0.8 })
        if (j.id === focusJack().id) {
          blurHit(0.01, 0.6)
          sawView.lunge()
        }
      } else if (e.kind === "pull") {
        const j = w.jacks[e.jack]!
        tsound.at("saw-pull", j.x, j.y, { gain: 1.1 })
        // The cord yanks the view: a kick down and back that springs up.
        if (j.id === focusJack().id) sawView.yank()
        if (j.id === focusJack().id && !reduced()) {
          pitchKick += 0.07 * labSettings.pullKick
          cam.add(0.08 * labSettings.pullKick, j.aim + Math.PI, 0.6 * labSettings.pullKick)
        }
      } else if (e.kind === "start") {
        const j = w.jacks[e.jack]!
        tsound.started(j)
        // The first fire: a cough of smoke out of the muffler.
        const mine = sawAt && j.id === focusJack().id
        for (let i = 0; i < 8; i++) {
          if (mine) wood.exhaust(particles, 0.1, `start${i}`, sawAt!.muffler[0], sawAt!.muffler[1], sawAt!.muffler[2], sawAt!.exhaust[0], sawAt!.exhaust[2], 1)
          else wood.exhaust(particles, 0.1, `start${i}`, j.x, 0.95, j.y, -Math.sin(j.aim), Math.cos(j.aim), 1)
        }
        if (j.id === focusJack().id) sawView.shudder(1)
      } else if (e.kind === "sputter") {
        const j = w.jacks[e.jack]!
        if (e.flooded) tsound.at("saw-flood", j.x, j.y)
        if (j.id === focusJack().id) sawView.shudder(e.flooded ? 0.3 : 0.6)
        if (e.jack === 0) say(e.flooded ? "Flooded. Wait for it to clear." : "It didn't catch.")
      } else if (e.kind === "stop") {
        const j = w.jacks[e.jack]!
        if (e.why === "dry" && e.jack === 0) say("Out of fuel. Find a gas can.")
        // His engine dying near a survivor: the recording dies, then nothing; the world holds its breath.
        const f = focusJack()
        tsound.cutOut(j, f.role === "survivor" && active(f) && w.mode === "hunt", labSettings)
        if (tsound.hush > 0) {
          dread.hush()
          say("His saw cut out.")
        }
      } else if (e.kind === "chop") {
        const j = w.jacks[e.jack]!
        const t = w.trees[e.tree]!
        sound.play("melee.hit.wood", t.x, t.y, { rate: 0.9 + fx() * 0.2, gain: 1 })
        sound.play("melee.swing.light", j.x, j.y, { rate: 1.2, gain: 0.5 })
        const R = view.cutRadius(t, e.tree)
        wood.chop(t.x - Math.cos(j.aim) * R, HINGE + 0.3, t.y - Math.sin(j.aim) * R, Math.cos(j.aim), Math.sin(j.aim))
      } else if (e.kind === "push") {
        const t = w.trees[e.tree]!
        sound.play("melee.shove", t.x, t.y, { gain: 1.2 })
        say(`${nameOf(e.jack)} shoved a tree over`)
      } else if (e.kind === "torch") {
        const j = w.jacks[e.jack]!
        sound.play("flashlight.click", j.x, j.y)
      } else if (e.kind === "flare") {
        const j = w.jacks[e.jack]!
        sound.play("flare.ignite", j.x, j.y)
        const f = new FlareFx(seed * 31 + e.flare, { burnTime: FEEL.flareBurn })
        f.strike()
        flareFx.set(e.flare, f)
      } else if (e.kind === "blind") {
        const j = w.jacks[e.jack]!
        sound.play("body.hurt", j.x, j.y, { rate: 0.85 })
        say(`${nameOf(e.jack)} ${e.jack === 0 ? "are" : "is"} blinded`)
      } else if (e.kind === "pickup") {
        const j = w.jacks[e.jack]!
        sound.play("pickup.item", j.x, j.y, { rate: e.item === "gas" ? 0.8 : 1 })
        if (e.item !== "gas") say(`${nameOf(e.jack)} found the ${PART_NAMES[e.item]}`)
        else if (e.jack === 0) say("Refuelled")
      } else if (e.kind === "drop") {
        const j = w.jacks[e.jack]!
        sound.play("item.drop", j.x, j.y)
        say(`${nameOf(e.jack)} dropped the ${PART_NAMES[e.item]}`)
      } else if (e.kind === "install") {
        sound.play("ui.click", w.truck?.x, w.truck?.y)
        say(`${PART_NAMES[e.part]} in the truck (${w.truck?.parts.length ?? 0}/3)`)
      } else if (e.kind === "truck") {
        sound.play("ui.ping")
        say("The truck's running! Get to it!")
      } else if (e.kind === "escape") {
        sound.play("ui.ping")
        say(`${nameOf(e.jack)} ${e.jack === 0 ? "got" : "got"} away`)
      } else if (e.kind === "over") {
        sound.play("ui.ping")
      }
      if (e.kind === "down" && e.jack === me.id) cam.addFlash(0.8)
    }
  }

  const updateVoices = (dt: number) => {
    if (!sound.runtime.ctx) return
    const ear = listener()
    // The loops only sound in play: the title and the pause menu are quiet.
    const inPlay = shell.playing && !paused
    tsound.ear = { x: ear.x, y: ear.y, rx: Math.cos(cam.yaw), ry: -Math.sin(cam.yaw) }
    tsound.trunks = w.trees
    const winded = ear.role === "survivor" ? (ear.exhausted ? 1 : ear.sprinting ? Math.max(0, 1 - ear.stamina / FEEL.staminaMax) : 0) : 0
    tsound.frame(w, dt, inPlay, ear, dread.fear, winded)
    const tr = w.truck
    if (inPlay && tr?.started && w.phase === "play") {
      const near = (1 / (1 + Math.hypot(tr.x - ear.x, tr.y - ear.y) / 10)) * (tsound.hush > 0 ? 0.15 : 1)
      truckVoice ??= sound.runtime.playCue(TRUCK_ENGINE, { gain: 0.6 * near, rate: 0.7, ownerKey: "truck" })
      truckVoice?.setParams({ gain: 0.6 * near }, 0.1)
    } else if (truckVoice) {
      truckVoice.stop(0.5)
      truckVoice = null
    }
  }

  let last = performance.now()
  let acc = 0
  let frames = 0
  let paused = false
  let meInput: JackInput = NO_INPUT
  let smokeTarget: GPUTexture | null = null

  /**
   * The felling cam: when a tree you dropped (or one near you) goes over, the view drops to a low eye a few metres off
   * your shoulder, turned so the fall line crosses the frame, and looks up the trunk as it comes down, then eases back
   * after `fellCamTime`. Low and near you, it stays under the crowns and in the room you cut in.
   */
  const fellCam = (t: Tree) => {
    const focus = focusJack()
    if (labSettings.fellCam <= 0 || !mouseLook() || auto.camera || Math.hypot(t.x - focus.x, t.y - focus.y) > 22) return
    const D = labSettings.fellCamDist
    let best = { x: 0, y: 0, score: -Infinity }
    for (const turn of [45, -45, 70, -70, 100, -100]) {
      const a = (turn * Math.PI) / 180
      const ex = -t.fx * Math.cos(a) + t.fy * Math.sin(a)
      const ey = -t.fy * Math.cos(a) - t.fx * Math.sin(a)
      let clear = D
      for (const o of w.trees) {
        if (o.state !== "standing" || o === t) continue
        const rx = o.x - focus.x
        const ry = o.y - focus.y
        const s = rx * ex + ry * ey
        const R = o.r * 1.2
        if (s < 0.2 || s - R > clear) continue
        if (Math.abs(rx * ey - ry * ex) < R + 0.35) clear = Math.max(1.5, s - R - 0.45)
      }
      // A short swing from where the view already is reads as one shot; room to stand back reads the fall.
      const score = clear - Math.abs(wrapAngle(Math.atan2(ex, ey) - camYaw)) * 0.9 + Math.abs(Math.sin(a)) * 0.8
      if (score > best.score) best = { x: focus.x + ex * clear, y: focus.y + ey * clear, score }
    }
    fellShot = { tree: t.id, at: w.t, x: best.x, y: best.y }
  }

  /** Per-tick fx that follow state, not events: kerf spray, exhaust, flares in flight. */
  const tickFx = () => {
    for (const j of w.jacks) {
      if (!active(j)) continue
      const ax = Math.cos(j.aim)
      const ay = Math.sin(j.aim)
      if (j.role === "lumberjack" && (j.engine === "on" || j.engine === "pulling")) {
        // The muffler sits on the motor's right side, behind the grip.
        const rev = j.engine === "pulling" ? 0.2 : j.trigger ? 1 : 0
        // Your own saw's muffler is where the first-person view shows it; a revved chain flings a fine oil mist off
        // the nose.
        const at = j.id === focusJack().id ? sawAt : null
        if (j.engine === "on" || fx() < 0.15) {
          if (at) wood.exhaust(particles, DT, `ex${j.id}`, at.muffler[0], at.muffler[1], at.muffler[2], at.exhaust[0], at.exhaust[2], rev, labSettings.sawExhaust)
          else wood.exhaust(particles, DT, `ex${j.id}`, j.x + ax * 0.2 - ay * 0.32, 0.98, j.y + ay * 0.2 + ax * 0.32, -ay, ax, rev)
        }
        if (at && j.engine === "on" && j.trigger) wood.exhaust(particles, DT * 0.3, `oil${j.id}`, at.nose[0], at.nose[1], at.nose[2], at.forward[0], at.forward[2], 0)
      }
      if (j.trigger && j.target?.kind === "tree" && j.role === "lumberjack") {
        const t = w.trees[j.target.id]!
        const R = view.cutRadius(t, j.target.id)
        wood.kerf(particles, DT, `k${j.id}`, t.x - ax * R, HINGE, t.y - ay * R, ax, ay, 1)
      }
    }
    for (const f of w.flares) {
      const fl = flareFx.get(f.id)
      if (!fl) continue
      fl.x = f.x
      fl.y = f.z
      fl.z = f.y
      const sp = Math.hypot(f.vx, f.vy, f.vz)
      if (!f.landed && sp > 0.1) {
        fl.dx = f.vx / sp
        fl.dy = f.vz / sp
        fl.dz = f.vy / sp
      } else {
        const a = f.id * 2.1
        fl.dx = Math.cos(a) * 0.95
        fl.dy = 0.3
        fl.dz = Math.sin(a) * 0.95
      }
      fl.vx = f.landed ? 0 : f.vx
      fl.vy = f.landed ? 0 : f.vz
      fl.vz = f.landed ? 0 : f.vy
      fl.step(DT, particles)
    }
    // Twigs and needles brushed off by a crown in the last stretch of its fall.
    for (const t of w.trees) {
      if (t.state !== "falling") continue
      const speed = t.omega * t.h
      if (!whooshed.has(t.id) && speed > 9) {
        whooshed.add(t.id)
        const s = t.h * 0.8 * Math.sin(Math.min(t.theta, 1.5))
        sound.play("weather.wind.gust", t.x + t.fx * s, t.y + t.fy * s, { rate: 0.85, gain: 1 })
      }
    }
  }

  /** Arrow at `el` round the player's spot on screen, pointing at world (x, y). */
  const pointAt = (el: HTMLElement, from: { x: number; y: number }, x: number, y: number, show: boolean, opacity = 1) => {
    if (!show) {
      el.style.display = "none"
      return
    }
    // A short step towards the target, not the target itself: one behind the camera doesn't project.
    const d = Math.hypot(x - from.x, y - from.y) || 1
    const a = cam.project(from.x, 1, from.y, innerWidth, innerHeight)
    const b = cam.project(from.x + ((x - from.x) / d) * 0.5, 1, from.y + ((y - from.y) / d) * 0.5, innerWidth, innerHeight)
    if (!a.ok || !b.ok) {
      el.style.display = "none"
      return
    }
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const rad = 96
    el.style.display = "block"
    el.style.opacity = String(opacity)
    el.style.transform = `translate(${a.x + Math.cos(ang) * rad}px, ${a.y + Math.sin(ang) * rad}px) rotate(${ang}rad)`
  }

  const frame = (now: number) => {
    shell.tick(now)
    if (shell.playing) quality.frame(now)
    else quality.pause()
    resize()
    syncAudio()
    const elapsed = Math.min(0.1, (now - last) / 1000)
    last = now
    const playing = shell.playing && !paused
    input.enabled = shell.playing && !panel.holdsInput
    let scaledDt = playing ? hitStop.step(elapsed) : 0
    if (slowMo > 0 && playing) {
      slowMo -= elapsed
      scaledDt *= Math.max(0.02, FEEL.slowMoScale)
    }
    acc += scaledDt

    while (acc >= DT) {
      acc -= DT
      const prevAlive = w.jacks.map((j) => j.alive)
      meInput = humanInput()
      stepWorld(w, [meInput], DT, FEEL)
      handleEvents()
      for (const j of w.jacks) if (prevAlive[j.id] && !j.alive && !corpses.has(j.id)) ragdollFor(j, 0, j.cause === "crush" ? "crush" : "saw")
      tickFx()
      const due = later.filter((l) => l.at <= w.t)
      if (due.length) {
        later = later.filter((l) => l.at > w.t)
        for (const l of due) l.run()
      }
      if (w.phase === "over" && w.t - w.overAt > FEEL.restartDelay && !auto.input) newRound()
    }
    // After the ticks: a new round (auto-advance) replaces the jacks.
    const me = w.jacks[0]!

    particles.update(scaledDt, [], () => 0)
    wood.step(scaledDt)
    for (const [id, rd] of corpses) {
      const j = w.jacks[id]!
      // Killed where they lay: the ragdoll goes on from the crawl.
      const cr = crawls.get(id)
      if (cr && !(j.alive && j.downed)) {
        handBack(cr, rd)
        crawls.delete(id)
      }
      stepRagdoll(rd, scaledDt)
      // The downed crawl: carry their body along with them.
      const at = crawlAt.get(id)
      if (at && j.alive && j.downed) {
        const dx = j.x - at.x
        const dz = j.y - at.y
        if (dx || dz) {
          for (const p of rd.pos) {
            p[0] += dx
            p[2] += dz
          }
          for (const p of rd.prev) {
            p[0] += dx
            p[2] += dz
          }
          at.x = j.x
          at.y = j.y
        }
      }
    }
    const focus = focusJack()
    sound.listen(focus.x, focus.y)
    updateVoices(elapsed)

    // Camera.
    const aspect = innerWidth / Math.max(1, innerHeight)
    const locked = document.pointerLockElement === canvas
    const L = labSettings
    const style = resolvedView()
    const calm = reduced()
    // Running feel: the sprint eases in and out; the bob follows the stride; kicks and stumbles spring back.
    const speed = Math.hypot(focus.vx, focus.vy)
    const sprinting = upright(focus) && (focus.sprinting || focus.dashing > 0)
    sprintK += ((sprinting ? 1 : 0) - sprintK) * (1 - Math.exp(-elapsed * (sprinting ? 5 : 3)))
    bobPhase += (speed * scaledDt) / 1.25 * Math.PI
    const bobK = calm || !upright(focus) ? 0 : Math.min(1, speed / 6) * L.headBob
    const bobY = Math.abs(Math.sin(bobPhase)) * 0.045 * bobK - 0.02 * bobK
    const bobRoll = Math.sin(bobPhase) * 0.012 * bobK
    fovKick *= Math.exp(-elapsed * 7)
    pitchKick *= Math.exp(-elapsed * 9)
    stumble *= Math.exp(-elapsed * 2.6)
    if (calm) fovKick = pitchKick = stumble = 0
    const stumbleT = stumble * Math.sin(w.t * 13) * 0.7 + stumble
    const fovExtra = sprintK * L.sprintFov + fovKick
    // The bar in wood, eased, for the first-person saw.
    const biting = focus.role === "lumberjack" && focus.engine === "on" && focus.trigger && focus.target !== null
    cutK += ((biting ? 1 : 0) - cutK) * (1 - Math.exp(-elapsed * 10))
    cam.near = 1
    cam.fov = 0.52
    /** First person this frame (you, standing, not under a felling shot). */
    let first = false
    if (auto.camera) {
      const a = auto.camera
      cam.yaw = a.yaw ?? 0
      cam.lookHeight = a.height ?? 0
      cam.pitch = a.pitch
      if (a.fov) {
        cam.fov = (a.fov * Math.PI) / 180
        cam.near = 0.1
      }
      cam.zoomOffset = a.dist - 24
      cam.follow(a.x, a.y, 0, 0, elapsed, false)
    } else if (mouseLook()) {
      // Before the click (and for bots, automation and spectating) the view turns to follow the aim.
      if (!locked && (auto.input || focus.id !== 0 || !input.enabled)) camYaw = mixAngle(camYaw, yawBehind(focus.aim), 1 - Math.exp(-elapsed * L.chaseTurn))
      if (!locked) camPitch += ((biting || (focus.trigger && focus.target) ? 0.45 : L.firstPitch) - camPitch) * (1 - Math.exp(-elapsed * 3))
      const fwdX = -Math.sin(camYaw)
      const fwdY = -Math.cos(camYaw)
      cam.near = 0.1
      const shot = fellShot
      const ft = shot ? w.trees[shot.tree] : undefined
      if (!ft) fellShot = null
      else if (w.t - shot!.at > L.fellCamTime) fellShot = null
      first = style === "first" && !fellShot && upright(focus)
      cam.yaw = camYaw
      if (first) {
        // Placed by the override below; follow and update still run for the shake.
        cam.pitch = camPitch
        cam.lookHeight = L.firstEye
        cam.fov = ((L.firstFov + fovExtra) * Math.PI) / 180
        cam.follow(focus.x, focus.y, 0, 0, elapsed, false)
      } else {
        const tight = style === "shoulder"
        // The low chase or the tight shoulder: behind and just above, pulled in where a trunk would come between.
        const baseD = tight ? L.shoulderDist : L.chaseDist
        const basePitch = tight ? L.shoulderPitch : L.chasePitch
        let side = tight ? L.shoulderSide : L.chaseSide
        let lead = tight ? L.shoulderLead : L.chaseLead
        let want = baseD
        if (L.chaseCollide > 0) {
          const tx = focus.x + fwdX * lead + Math.cos(camYaw) * side
          const ty = focus.y + fwdY * lead - Math.sin(camYaw) * side
          const ex = Math.sin(camYaw)
          const ey = Math.cos(camYaw)
          const reach = want * Math.cos(basePitch)
          for (const t of w.trees) {
            if (t.state !== "standing") continue
            const rx = t.x - tx
            const ry = t.y - ty
            const s = rx * ex + ry * ey
            if (s < 0.3 || s > reach + t.r + 0.4) continue
            if (Math.abs(rx * ey - ry * ex) < t.r * 1.25 + 0.22) want = Math.min(want, Math.max(tight ? 0.6 : 1.2, (s - t.r * 1.25 - 0.3) / Math.cos(basePitch)))
          }
        }
        chaseD += (want - chaseD) * (1 - Math.exp(-elapsed * (want < chaseD ? 18 : 3)))
        let yaw = camYaw
        let px = focus.x
        let py = focus.y
        let dist = chaseD
        let pitch = basePitch + stumbleT * 0.06
        let height = (tight ? L.shoulderHeight : L.chaseHeight) + bobY * (tight ? 0.7 : 0.3) - stumble * 0.08
        // The felling cam blends in over half a second, holds, and blends back out; from first person it cuts.
        if (fellShot && ft) {
          const age = w.t - fellShot.at
          const k = style === "first" ? 1 : smooth(0, 0.6, age) * (1 - smooth(L.fellCamTime - 0.7, L.fellCamTime, age))
          // Look at a point a third of the way up the trunk, wherever the fall has it now.
          const along = (ft.h + HINGE) * FELL_AIM
          const tx = ft.x + ft.fx * Math.sin(ft.theta) * along
          const ty = ft.y + ft.fy * Math.sin(ft.theta) * along
          const th = HINGE + Math.cos(ft.theta) * along
          const flat = Math.max(0.5, Math.hypot(fellShot.x - tx, fellShot.y - ty))
          yaw = mixAngle(camYaw, Math.atan2(fellShot.x - tx, fellShot.y - ty), k)
          px += (tx - px) * k
          py += (ty - py) * k
          dist += (Math.hypot(flat, L.fellCamHeight - th) - dist) * k
          pitch += (Math.atan2(L.fellCamHeight - th, flat) - pitch) * k
          height += (th - height) * k
          lead *= 1 - k
          side *= 1 - k
        }
        cam.yaw = yaw
        cam.pitch = pitch
        cam.lookHeight = height
        cam.fov = (((tight ? L.shoulderFov : L.chaseFov) + fovExtra) * Math.PI) / 180
        // Over the right shoulder, so the bar and the kerf show past you.
        cam.follow(px, py, -Math.sin(yaw) * lead + Math.cos(yaw) * side, -Math.cos(yaw) * lead - Math.sin(yaw) * side, elapsed, false)
        cam.dist = dist
      }
    } else {
      const top = style === "top"
      cam.yaw = 0
      cam.lookHeight = 0
      cam.pitch = top ? 1.32 : 0.98
      cam.zoomOffset = top ? 8 : 4
      cam.follow(focus.x, focus.y, Math.cos(focus.aim) * 2.5, Math.sin(focus.aim) * 2.5, elapsed, false)
    }
    let vp = cam.update(aspect)
    // In and out of first person is a cut (the felling shot, spectating): drop TAA, mist and blur history so it doesn't
    // smear. The exposure is left alone, so the cut doesn't flash.
    if (first !== wasFirst) view.forest.renderer.resetTemporalHistory()
    wasFirst = first
    /** First person: the eye in your head, the camera's shake turned into a small turn and nod, the saw's buzz on top. */
    const fpEye: [number, number, number] = [0, 0, 0]
    const fpLook = { yaw: 0, pitch: 0, roll: 0 }
    if (first) {
      const o = cam.offset
      const scale = focus.role === "lumberjack" ? L.jackScale : 1
      const lift = focus.climb * 0.45 - (focus.stun > 0 ? 0.6 : 0)
      const on = focus.engine === "on"
      const buzz = calm || !on ? 0 : L.sawBuzz * (0.0012 + (focus.trigger ? 0.0025 : 0) + cutK * 0.006)
      const t = now / 1000
      const yaw = camYaw + o.x * 0.05 + Math.sin(t * 91) * buzz + Math.sin(t * 57) * buzz * 0.6
      const pitch = camPitch + pitchKick + o.z * 0.05 + stumbleT * 0.1 + Math.sin(t * 79 + 1) * buzz + Math.sin(t * 43) * buzz * 0.5
      const roll = o.roll + bobRoll + stumble * 0.05 * Math.sin(w.t * 9)
      fpEye[0] = focus.x - Math.sin(camYaw) * 0.12
      fpEye[1] = L.firstEye * scale + lift + bobY - stumble * 0.1 + (o.zoom ? -o.zoom * 0.02 : 0)
      fpEye[2] = focus.y - Math.cos(camYaw) * 0.12
      const cp = Math.cos(pitch)
      const target = [fpEye[0] - Math.sin(yaw) * cp, fpEye[1] - Math.sin(pitch), fpEye[2] - Math.cos(yaw) * cp]
      const up = [Math.sin(roll) * Math.cos(yaw), Math.cos(roll), -Math.sin(roll) * Math.sin(yaw)]
      Object.assign(fpLook, { yaw, pitch, roll })
      const proj = mat4.perspective(cam.fov, aspect, 0.05, 400)
      cam.eye = [fpEye[0], fpEye[1], fpEye[2]]
      cam.viewProj = mat4.multiply(proj, mat4.lookAt(fpEye, target, up))
      vp = cam.viewProj as Float32Array
    }
    const eye = cam.eye
    const near = (x: number, y: number, r = 40) => Math.hypot(x - eye[0], y - eye[2]) < r

    view.sync(w)
    view.pose(w, FEEL, labSettings, scaledDt)
    fp.begin()
    view.draw(fp, w, FEEL)

    // The fall hint: only while you cut a tree or shove one, faint and growing with the cut.
    let ringTree: Tree | null = null
    if (active(me) && !me.downed) {
      const target = sawTarget(w, me, FEEL)
      const shove = me.role === "survivor" && w.mode === "hunt" ? pushTarget(w, me, FEEL) : null
      const t = target?.kind === "tree" ? w.trees[target.id]! : shove
      if (t) {
        ringTree = t
        const working = t === shove ? meInput.use : meInput.saw && me.trigger
        if (working) {
          const f = predictedFall(t, me.x, me.y)
          view.hint(fp, t, f.x, f.y, L.fallHint * (0.35 + 0.65 * Math.min(1, t.cut)))
        }
      }
    }

    // Chips, splinters and twigs, flying and lying, lit by whatever beam they cross.
    const chipLife = L.woodChipLife
    wood.chips.forEach((c, i) => {
      if (!c.live || !near(c.x, c.z)) return
      const fade = c.rest < 0 ? 1 : Math.min(1, (chipLife - c.rest) / 3)
      const model = c.kind === 0 ? chipModels[i % chipModels.length]! : c.kind === 1 ? splinterModels[i % splinterModels.length]! : twigModel
      // Flying, a flake tumbles on two axes, so its pale face flashes as it turns through a beam.
      const roll = c.rest < 0 && c.kind !== 2 ? c.pitch * 0.61 + i : 0
      fp.part(model, c.x, c.y + c.size * 0.05, c.z, c.yaw, [c.shade, c.shade, c.shade], c.pitch, roll, 0, 1, c.size * fade)
    })
    // Blood pools spread over a few seconds, then stay.
    pools.forEach((p, i) => {
      const k = smooth(-0.4, 3.5, w.t - p.at)
      fp.part(p.model, p.x, 0.012 + i * 0.0003, p.y, p.yaw, [1, 1, 1], 0, 0, 0, 1, p.size * (0.25 + 0.75 * k))
    })

    for (const it of w.items) if (!it.taken) fp.push(itemModels[it.kind], it.x, 0, it.y, it.id * 1.3, [1, 1, 1], 0, 0, 0)
    const tr = w.truck
    if (tr) {
      fp.push(truckModel, tr.x, 0, tr.y, tr.yaw, [1, 1, 1], 0, 0, 0)
      if (tr.started) {
        const fx2 = Math.cos(tr.yaw)
        const fy2 = Math.sin(tr.yaw)
        wood.exhaust(particles, scaledDt, "truck", tr.x - fx2 * 3.1 + fy2 * 1.0, 0.4, tr.y - fy2 * 3.1 - fx2 * 1.0, -fx2, -fy2, 0.4)
      }
    }

    // Lumberjacks and survivors, then the bodies that stay: Rocketbox people where they've loaded, the blocky rig
    // otherwise (and with Realistic people off). In first person you don't draw yourself.
    const real = people && L.realPeople > 0
    const drawn = new Set<number>()
    const held = new Map<number, Held>()
    const eyeV: [number, number, number] = [eye[0], eye[1], eye[2]]
    for (const j of w.jacks) {
      const a = avatars.get(j.id)
      if (!a || j.escaped) continue
      const color = tintOf(j.id)
      const hunted = j.role === "survivor" && w.mode === "hunt"
      const partsFor = hunted ? axeParts : sawParts
      const scale = j.role === "lumberjack" ? L.jackScale : 1
      const dead = corpses.get(j.id)
      const cr = crawls.get(j.id)
      const crawling = dead && cr && j.alive && j.downed
      const rd = crawling ? crawlPose(cr, dead, j.x, j.y, j.aim, w.t, L) : dead
      if (rd) {
        if (real && people.lie(j, rd, scaledDt, scale, eyeV, crawling ? L.crawlLook : 0)) drawn.add(j.id)
        else {
          const dim = j.alive ? 0.85 : 0.6
          emitRagdoll(fp.push, rd, "rifle", [color[0] * dim, color[1] * dim, color[2] * dim], partsFor, j.alive && j.revive > 0 ? 0.05 : 0, 1, 0)
        }
        // The downed leave a trail as they crawl.
        if (j.alive && j.downed && playing && w.t - (dripAt.get(j.id) ?? -1) > 0.9) {
          dripAt.set(j.id, w.t)
          pool(j.x + (fx() - 0.5) * 0.3, j.y + (fx() - 0.5) * 0.3, 0.1 + fx() * 0.06)
        }
        continue
      }
      if (!j.alive) continue
      animate(a, scaledDt, w.t, j.x, j.y, j.vx, j.vy, j.aim)
      a.flash = j.held > 0 ? 0.03 + 0.03 * Math.sin(w.t * 40) : j.stun > 0 ? 0.04 + 0.03 * Math.sin(w.t * 10) : j.dashing > 0 ? 0.05 : Math.max(0, a.flash - scaledDt * 4)
      const lift = j.climb * 0.45 - (j.stun > 0 ? 0.6 : 0)
      const hidden = first && j.id === focus.id
      const chopping = hunted && j.trigger && j.target?.kind === "tree"
      const got = real
        ? people.stand(j, {
            dt: scaledDt, t: w.t, scale, eye: eyeV, hidden, lift,
            torchDir: hunted && j.torch ? [Math.cos(j.aim) * 0.99, -0.12, Math.sin(j.aim) * 0.99] : null,
            chop: chopping ? ((w.t * 1.4 + j.id * 0.37) % 1) + 1e-3 : 0,
            cutting: j.trigger && j.target !== null,
          })
        : null
      if (got) {
        drawn.add(j.id)
        held.set(j.id, got)
        if (!hidden) {
          if (got.saw) fp.part(sawModel, got.saw.p[0], got.saw.p[1], got.saw.p[2], got.saw.aim, [1, 1, 1], SAW_PITCH, 0, 0, 1, scale)
          if (got.axe) {
            const swing = chopping ? Math.sin(((w.t * 1.4 + j.id * 0.37) % 1) * Math.PI * 2) : 0
            fp.part(axeModel, got.axe.p[0], got.axe.p[1], got.axe.p[2], j.aim, [1, 1, 1], chopping ? 0.2 + swing * 0.9 : -1.25, 0, 0, 1, 1)
          }
          if (got.torch) {
            const d = got.torch.x
            fp.part(torchModel, got.torch.p[0], got.torch.p[1], got.torch.p[2], Math.atan2(d[2], d[0]), [1, 1, 1], Math.asin(Math.max(-1, Math.min(1, d[1]))), 0, 0, 1, 1)
          }
        }
      } else if (!hidden) {
        const scaled = lift !== 0 || scale !== 1
        pose(scaled ? fp.scaled(scale, j.x, j.y, lift) : fp.push, a, color, partsFor)
      }
      if (j.carrying && !hidden) fp.part(itemModels[j.carrying], j.x - Math.cos(j.aim) * 0.25, 1.15, j.y - Math.sin(j.aim) * 0.25, j.aim, [1, 1, 1], 0, 0, 0, 1, 0.75)
    }
    people?.hideExcept(drawn)
    for (const d of dropped.values())
      if (near(d.x, d.y)) fp.part(torchModel, d.x, 0.025, d.y, d.yaw, [1, 1, 1], 0, 0, 0, 1, 1)

    // The night is the forest's moon; the rest is torches, his helmet lamp, flares and the truck's lamps.
    const torches: ForestTorch[] = []
    const kindOf = (id: number) => (id === focus.id ? "local" : "remote") as "local" | "remote"
    for (const j of w.jacks) {
      if (!upright(j)) continue
      const ax = Math.cos(j.aim)
      const ay = Math.sin(j.aim)
      if (j.role === "survivor" && w.mode === "hunt") {
        // From the torch in their hand when they're a person; it stutters the closer he is.
        const tf = held.get(j.id)?.torch
        const pos: [number, number, number] = tf ? [tf.p[0] + tf.x[0] * 0.14, tf.p[1] + tf.x[1] * 0.14, tf.p[2] + tf.x[2] * 0.14] : [j.x + ax * 0.45, 1.2, j.y + ay * 0.45]
        const dir: [number, number, number] = tf ? [tf.x[0], tf.x[1], tf.x[2]] : [ax * 0.99, -0.12, ay * 0.99]
        const fear = j.id === focus.id ? dread.fear : Dread.target(w, j, L)
        const level = dread.flicker(L.torchLevel, now / 1000, j.id, fear, L)
        torches.push({ id: j.id, pos, dir, on: j.torch && L.torchLevel > 0, kind: kindOf(j.id), level })
      } else if (j.role === "lumberjack") {
        // His helmet lamp, wired to the saw: it dies with the engine when he sneaks. It looks where he looks: down the
        // bar, into the kerf while he cuts, then up the trunk as the tree he dropped goes over. On the helmet, not the
        // saw, so the bark he cuts is a metre and more away and doesn't flood the frame.
        const pos: [number, number, number] = [j.x + ax * 0.15, 1.72 * L.jackScale, j.y + ay * 0.15]
        let lamp = lamps.get(j.id)
        if (!lamp) lamps.set(j.id, (lamp = { dir: [ax, -0.3, ay], tree: -1, until: -1 }))
        let look: [number, number, number] = [pos[0] + ax * 3, 0.6, pos[2] + ay * 3]
        const watched = lamp.until > w.t ? w.trees[lamp.tree] : undefined
        if (watched && watched.state !== "standing") {
          const s = (watched.h + HINGE) * 0.5
          const up = Math.cos(watched.theta)
          const out = Math.sin(watched.theta)
          look = [watched.x + watched.fx * out * s, HINGE + up * s, watched.y + watched.fy * out * s]
        } else if (j.trigger && j.target?.kind === "tree") {
          const t = w.trees[j.target.id]!
          const R = view.cutRadius(t, j.target.id)
          look = [t.x - ax * R, HINGE + 0.15, t.y - ay * R]
        }
        const lx = look[0] - pos[0]
        const ly = look[1] - pos[1]
        const lz = look[2] - pos[2]
        const ll = Math.hypot(lx, ly, lz) || 1
        const ease = 1 - Math.exp(-elapsed * 9)
        for (const [i, v] of [lx / ll, ly / ll, lz / ll].entries()) lamp.dir[i] = lamp.dir[i]! + (v - lamp.dir[i]!) * ease
        const dl = Math.hypot(...lamp.dir) || 1
        const dir: [number, number, number] = [lamp.dir[0] / dl, lamp.dir[1] / dl, lamp.dir[2] / dl]
        // Your own, in first person, shines from a little way down its axis: your hands and saw sit on the line to the
        // kerf, and half a metre from the lens the beam's core blows them out. Its level makes up the shorter throw, so
        // what it lights stays as bright; `sawFill` stands in for its spill on your hands. The saw still takes it from
        // the helmet, at its full level (`sawView.frame` below reads these this frame).
        const ahead = first && j.id === focus.id ? Math.min(L.sawLampAhead, ll - 0.3) : 0
        for (let i = 0; i < 3; i++) pos[i] = pos[i]! + dir[i]! * ahead
        const throwK = ((ll - ahead) / ll) ** 2
        if (first && j.id === focus.id) {
          sawView.lampBack = [-dir[0] * ahead, -dir[1] * ahead, -dir[2] * ahead]
          sawView.lampGain = ahead > 0 ? 1 / throwK : 0
        }
        // The lamp runs off the saw's magneto: each yank of the cord spins it, and the lamp flickers up and dies away.
        const pulling = j.engine === "pulling"
        const spin = pulling ? Math.exp(-j.pullT * 5) * (0.75 + 0.25 * Math.sin(j.pullT * 90)) : 0
        torches.push({ id: j.id, pos, dir, on: (j.engine === "on" || spin > 0.05) && L.sawLight > 0, kind: kindOf(j.id), level: L.sawLight * throwK * (pulling ? spin : 1), ...(watched && watched.state !== "standing" ? { air: L.fellLampAir } : {}) })
      }
    }
    if (tr) {
      const fx2 = Math.cos(tr.yaw)
      const fy2 = Math.sin(tr.yaw)
      for (const [n, side] of [[0, -0.8], [1, 0.8]] as const)
        torches.push({ id: 900 + n, pos: [tr.x + fx2 * 3.1 - fy2 * side, 1.05, tr.y + fy2 * 3.1 + fx2 * side], dir: [fx2 * 0.997, -0.08, fy2 * 0.997], on: tr.started && L.truckLamps > 0, kind: "remote", level: L.truckLamps })
    }
    // Dropped torches: lying in the leaves, still shining along the ground.
    for (const [id, d] of dropped) {
      const dx = Math.cos(d.yaw)
      const dy = Math.sin(d.yaw)
      torches.push({ id: 800 + id, pos: [d.x + dx * 0.12, 0.05, d.y + dy * 0.12], dir: [dx * 0.996, -0.09, dy * 0.996], on: d.on && L.droppedTorch > 0, kind: "remote", level: L.droppedTorch * L.torchLevel, air: L.droppedAir, shadows: false })
    }
    // Only one torch gets the shadow map and drives exposure.
    if (!torches.some((t) => t.kind === "local" && t.on)) for (const t of torches) t.kind = "remote"
    view.lights(torches, [...flareFx.values()].map((f) => f.light()), eye, L)
    if (first && focus.role === "lumberjack" && focus.engine === "on" && L.sawLight > 0 && L.sawFill > 0) {
      // Reaches your hands and saw, not the ground.
      view.lit.scene.push({ x: eye[0], y: eye[2], h: eye[1] + 0.05, r: 1, color: [1, 0.86, 0.68], power: L.sawFill * L.sawLight, size: 0.1, unshadowed: true })
    }

    // Your saw in first person, with chips off the bar coming at the lens while you cut.
    if (first && focus.role === "lumberjack") {
      const tt = focus.target?.kind === "tree" ? w.trees[focus.target.id] : undefined
      sawAt = sawView.frame({
        eye: fpEye, yaw: fpLook.yaw, pitch: fpLook.pitch, roll: fpLook.roll, worldFov: cam.fov, aimYaw: camYaw, aimPitch: camPitch, aspect,
        dt: paused ? 0 : elapsed, t: now / 1000, engine: focus.engine, throttle: focus.trigger, cut: cutK, sprint: sprintK,
        speed, bob: bobY, calm, trunk: tt && focus.target ? { x: tt.x, z: tt.y, r: view.cutRadius(tt, focus.target.id) } : null,
      })
      // While the bar bites, chips come off its underside, some at the lens.
      if (sawAt && biting && tt && playing) {
        const u = sawAt.under
        wood.toward(scaledDt, "lens", u[0], u[1], u[2], fpEye[0], fpEye[1] - 0.25, fpEye[2], 22 * cutK)
        wood.kerf(particles, scaledDt, "vm", u[0], u[1], u[2], sawAt.forward[0], sawAt.forward[2], 0.5 * cutK)
      }
    } else {
      sawView.frame(null)
      sawAt = null
    }
    if (tr?.started) {
      const fx2 = Math.cos(tr.yaw)
      const fy2 = Math.sin(tr.yaw)
      for (const side of [-0.8, 0.8]) view.glow(tr.x + fx2 * 3.06 - fy2 * side, 1.05, tr.y + fy2 * 3.06 + fx2 * side, L.truckLamps)
    }
    for (const d of dropped.values()) {
      if (d.on && L.droppedTorch > 0) view.glow(d.x + Math.cos(d.yaw) * 0.14, 0.03, d.y + Math.sin(d.yaw) * 0.14, 0.1 * L.droppedTorch)
    }
    hurt.style.opacity = String(cam.damageFlash)
    dread.step(playing ? Dread.target(w, focus, L) : 0, elapsed, L, (v) => (view.forest.settings.vignette = Math.min(1, v)), calm)
    // The shutter blur: stronger at a sprint, with a steady radial pull while you run flat out.
    if (sprintK > 0.05) blurHit(0.12 * sprintK * L.sprintBlur * elapsed, 0)
    burst.step(elapsed, blurSettings.burstDecay)
    Object.assign(frameBlur.settings, blurSettings, { enabled: blurSettings.enabled && !calm && !smoke, strength: blurSettings.strength * (1 + sprintK * L.sprintBlur) })
    frameBlur.dt = elapsed
    if (smoke && (!smokeTarget || smokeTarget.width !== canvas.width || smokeTarget.height !== canvas.height)) {
      smokeTarget?.destroy()
      smokeTarget = gpu.device.createTexture({ size: [canvas.width, canvas.height], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    }
    view.frame({ eye: [eye[0], eye[1], eye[2]], viewProj: vp, width: canvas.width, height: canvas.height, time: w.t, dt: elapsed, fovY: cam.fov, fp, pool: particles, motionBlur: frameBlur, ...(smokeTarget ? { target: smokeTarget.createView() } : {}) })

    drawHud(me, ringTree)
    frames++
    // The software-GPU smoke draws two frames, then holds.
    if (smoke && frames >= 2) paused = true
    requestAnimationFrame(frame)
  }

  const bar = (cls: string, k: number, color?: string) => `<div class="meter ${cls}"><i style="width:${Math.max(0, Math.min(1, k)) * 100}%${color ? `;background:${color}` : ""}"></i></div>`
  const css = (c: Rgb) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`

  const drawHud = (me: Jack, ringTree: Tree | null) => {
    const hunt = w.mode === "hunt"
    const lj = lumberjackOf(w)
    const left = Math.max(0, FEEL.roundTime - w.t)
    clock.textContent = hunt ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}` : ""
    if (!hunt) {
      const alive = w.jacks.filter((j) => j.alive).length
      status.innerHTML = `${bar("hp", me.hp / MAX_HP)}<span>${alive} standing</span><span class="cd">${me.dashCd > 0 ? "lunge…" : "lunge ready"}</span>`
    } else if (me.role === "lumberjack") {
      const engine = me.floodLock > 0 ? "FLOODED" : me.engine === "on" ? (me.trigger ? "REVVING" : "IDLE") : me.engine === "pulling" ? "PULLING…" : "ENGINE OFF"
      const left2 = w.jacks.filter((j) => j.role === "survivor" && active(j)).length
      status.innerHTML = `<span class="tag lj">LUMBERJACK</span>${bar("fuel", me.fuel / FEEL.fuelMax, me.fuel < FEEL.fuelMax * 0.2 ? "#e2483c" : "#e8a33c")}<span>fuel</span><span class="eng ${me.engine}">${engine}</span><span class="cd">${me.stun > 0 ? "PINNED" : me.blind > 0 ? "BLINDED" : me.dashCd > 0 ? "lunge…" : "lunge ready"}</span><span>${left2} left</span>`
    } else {
      const parts = PART_KINDS.map((k) => `<span class="part ${tr(k)}">${PART_NAMES[k]}</span>`).join("")
      status.innerHTML = `<span class="tag sv">SURVIVOR</span>${bar("hp", me.hp / MAX_HP)}${bar("stam", me.stamina / FEEL.staminaMax, me.exhausted ? "#8a8f96" : "#7fd0ff")}<span>torch ${me.torch ? "on" : "off"}</span><span>flares ${me.flares}</span>${parts}`
    }
    function tr(k: PartKind) {
      if (w.truck?.parts.includes(k)) return "in"
      if (w.jacks.some((j) => j.carrying === k)) return "held"
      return ""
    }
    // Context hints.
    let h = ""
    if (hunt && active(me)) {
      if (me.downed) h = `DOWN · bleeding out in ${Math.ceil(me.bleed)}s · crawl to a friend`
      else if (me.role === "survivor") {
        const rv = reviveTarget(w, me)
        if (rv) h = keyPromptHtml("KeyE", `Revive ${nameOf(rv.id)}`, { hold: true })
        else if (pushTarget(w, me, FEEL)) h = keyPromptHtml("KeyE", "Shove it over")
        else if (me.carrying) h = `Carrying the ${PART_NAMES[me.carrying]}: get it to the truck`
        else if (w.truck?.started) h = "The truck's running: get to it"
      } else if (me.engine === "off" && me.floodLock <= 0 && me.stun <= 0) h = keyPromptHtml("KeyQ", me.fuel > 0 ? "Pull the cord" : "No fuel")
      else if (me.stun > 0) h = "Pinned under a tree"
    } else if (hunt && me.escaped) h = "You got away. Watching the others."
    else if (hunt && !me.alive && w.phase === "play") h = "You're dead. Watching the others."
    if (!h && mouseLook() && shell.playing && !auto.input && active(me) && document.pointerLockElement !== canvas) h = "Click to look around"
    hint.innerHTML = h
    hint.style.display = h ? "block" : "none"
    // The saw: survivors hear where it is.
    const ear = focusJack()
    if (hunt && lj && active(lj) && ear.role === "survivor") {
      const d = Math.hypot(lj.x - ear.x, lj.y - ear.y)
      const loud = lj.noise * FEEL.hearRange
      const k = loud > 0 ? Math.max(0, 1 - d / loud) : 0
      pointAt(ping, ear, lj.x, lj.y, k > 0.02 && d > 3, Math.min(1, 0.35 + k) * (0.75 + 0.25 * Math.sin(w.t * 18)))
    } else pointAt(ping, ear, 0, 0, false)
    if (hunt && w.truck && ear.role === "survivor") {
      const p = cam.project(w.truck.x, 1, w.truck.y, innerWidth, innerHeight)
      const off = !p.ok || p.x < 40 || p.y < 40 || p.x > innerWidth - 40 || p.y > innerHeight - 40
      pointAt(truckPing, ear, w.truck.x, w.truck.y, off, 0.8)
    } else pointAt(truckPing, ear, 0, 0, false)
    glare.style.opacity = hunt && ear.role === "lumberjack" && ear.blind > 0 ? String(Math.min(1, (ear.blind / FEEL.blindTime) * 1.2)) : "0"

    if (ringTree && ringTree.state === "standing") {
      const p = cam.project(ringTree.x, 2.2, ringTree.y, innerWidth, innerHeight)
      ring.style.display = p.ok ? "block" : "none"
      ring.style.transform = `translate(${p.x - 18}px, ${p.y - 18}px)`
      const pct = Math.round(ringTree.cut * 100)
      ring.style.background = `conic-gradient(${ringTree.cut >= FEEL.warnAt ? "#ffb347" : "#f4f1e8"} ${pct}%, rgba(0,0,0,.35) 0)`
    } else ring.style.display = "none"
    let barsHtml = ""
    for (const j of w.jacks) {
      if (!active(j) || j.id === 0) continue
      const p = cam.project(j.x, j.downed ? 0.9 : 2.25 + j.climb * 0.45, j.y, innerWidth, innerHeight)
      if (!p.ok) continue
      const c = tintOf(j.id)
      if (j.downed) barsHtml += `<div class="bar down" style="transform:translate(${p.x - 22}px,${p.y}px)"><i style="width:${(j.bleed / FEEL.downTime) * 100}%"></i><b style="width:${j.revive * 100}%"></b></div>`
      else if (j.role === "lumberjack" && hunt) {
        if (j.stun > 0) barsHtml += `<div class="tagline" style="transform:translate(${p.x - 30}px,${p.y - 6}px)">PINNED ${Math.ceil(j.stun)}</div>`
      } else barsHtml += `<div class="bar" style="transform:translate(${p.x - 22}px,${p.y}px)"><i style="width:${(j.hp / MAX_HP) * 100}%;background:${css(c)}"></i></div>`
    }
    bars.innerHTML = barsHtml
    feed.innerHTML = feedLines.filter((l) => w.t - l.t < 6 && l.t <= w.t).map((l) => `<div>${l.text}</div>`).join("")
    if (w.phase === "over") {
      const secs = Math.max(0, Math.ceil(FEEL.restartDelay - (w.t - w.overAt)))
      let msg: string
      if (!hunt) msg = w.winner === 0 ? "Last one standing" : me.alive ? "Draw" : me.cause === "crush" ? `Crushed by ${me.killedBy === 0 ? "your own tree" : `${nameOf(me.killedBy)}’s tree`}` : `Sawed by ${nameOf(me.killedBy)}`
      else if (w.side === "survivor") {
        const escaped = w.jacks.filter((j) => j.escaped).length
        msg = lj && !lj.alive ? (me.role === "lumberjack" ? "Crushed under your own forest" : "Timber! The lumberjack is dead") : me.role === "lumberjack" ? `${escaped} got away` : me.escaped ? "You got away" : `${escaped} got away`
      } else msg = me.role === "lumberjack" ? "Nobody leaves the woods" : "The lumberjack got everyone"
      banner.innerHTML = `<b>${msg}</b><span>${auto.input ? "" : `Next round in ${secs}s · `}${keyPromptHtml("KeyR", "Now")}</span>`
      banner.style.display = "flex"
    } else banner.style.display = "none"
  }

  /** Automation: stage a scene and drive the player. Never used in play. */
  const { botSpeed, botAggro } = FEEL
  const stage = (name: "fell" | "domino" | "saw" | "hunt" | "chase" | "flee" | "kill" | "pull") => {
    const asSurvivor = name === "hunt" || name === "flee"
    const botsGo = name === "hunt" || name === "chase" || name === "flee"
    Object.assign(FEEL, { mode: "hunt", playAs: asSurvivor ? "survivor" : "lumberjack", botWarmup: botsGo ? 0 : 1e9, botSpeed: name === "flee" ? 1.12 : botSpeed, botAggro: name === "flee" ? 4 : botAggro, restartDelay: 1e9, gasCans: 0 })
    resetRound(w, FEEL)
    if (name === "hunt") {
      view.sync(w)
      newAvatars()
      return
    }
    const keep = (out: (t: Tree) => boolean) => {
      w.trees = w.trees.filter((t) => !out(t))
      w.trees.forEach((t, i) => (t.id = i))
    }
    const add = (x: number, y: number, h: number, cut: number, crownR = 2.3) => {
      const t = newTree(w.trees.length, x, y, h)
      t.cut = cut
      t.notched = cut > 0
      t.crownR = crownR
      w.trees.push(t)
      return t
    }
    const dummies: Jack[] = []
    const dummy = (x: number, y: number, aim: number, bot = false) => {
      const j = Object.assign(newJack(dummies.length + 1, bot, x, y, "survivor", FEEL), { aim })
      dummies.push(j)
      return j
    }
    w.items = []
    w.truck = null
    let me = newJack(0, false, 0, 0, "lumberjack", FEEL)
    if (name === "fell") {
      // One big tree in a clearing, a neighbour in the crown's path for the branches to rake, and you behind it.
      keep((t) => t.x > -6 && t.x < 24 && t.y > 4 && t.y < 21)
      const big = add(0, 12, 26, 0.3, 2.8)
      big.notched = false
      add(15, 14.6, 22, 0, 2.4)
      add(19, 9.2, 20, 0, 2.2)
      me = Object.assign(newJack(0, false, -0.78, 12, "lumberjack", FEEL), { aim: 0 })
      dummy(-20, -20, 0)
    } else if (name === "domino") {
      // A lane cleared through the forest: you cut the first tree; it drops two notched trees in a row onto survivors.
      keep((t) => t.y > -1.5 && t.y < 9.5 && t.x > -19 && t.x < 21)
      add(-15, 4, 13, 0)
      add(-6, 4.3, 13, 0.55)
      add(3, 3.8, 14, 0.55)
      me = Object.assign(newJack(0, false, -15.78, 4, "lumberjack", FEEL), { aim: 0 })
      dummy(-0.5, 4.6, Math.PI)
      dummy(10.5, 3.4, Math.PI)
    } else if (name === "chase") {
      // A lane through the trees: a survivor (a bot) runs from you; a half-cut tree in the lane goes over after them.
      keep((t) => t.y > 1 && t.y < 7 && t.x > -20 && t.x < 22)
      add(-2, 4.1, 19, 0.3, 2.5)
      add(-9, 6.5, 21, 0)
      add(4, 1.5, 19, 0)
      add(11, 6.6, 22, 0)
      me = Object.assign(newJack(0, false, -15, 4, "lumberjack", FEEL), { aim: 0 })
      // No flares: the clip is the chase, not the blinding.
      dummy(-8, 3.6, 0, true).flares = 0
    } else if (name === "flee") {
      // You, a survivor with your torch on, run down a lane that turns a corner; the lumberjack (a bot) is right behind.
      keep((t) => (t.y > 1 && t.y < 7 && t.x > -25 && t.x < 21) || (t.x > 15 && t.x < 21 && t.y > 1 && t.y < 25))
      add(-6, 6.6, 20, 0)
      add(4, 1.4, 19, 0)
      add(16, 9, 21, 0)
      me = Object.assign(newJack(0, false, -17, 4, "survivor", FEEL), { aim: 0, flares: 0 })
      const lj = Object.assign(newJack(1, true, -23, 4, "lumberjack", FEEL), { aim: 0 })
      dummies.push(lj)
    } else if (name === "kill") {
      // First person: a survivor stands with his back to you; you saw him down and finish him, then drop the half-cut
      // tree beyond him.
      keep((t) => Math.hypot(t.x - 2, t.y - 12) < 8)
      add(5.2, 12, 20, 0.45, 2.5)
      me = Object.assign(newJack(0, false, -1.6, 12, "lumberjack", FEEL), { aim: 0 })
      dummy(1.4, 12.2, 0).torch = true
      // A second survivor far off, so the round runs on after the kill.
      dummy(-20, -20, 0)
    } else if (name === "pull") {
      // First person, engine off, at a trunk: pull-start, rev and saw it. A survivor's torch from the side is the only
      // light until the helmet lamp comes on with the engine.
      keep((t) => Math.hypot(t.x, t.y - 12) < 4.6)
      add(0.25, 12, 20, 0)
      me = Object.assign(newJack(0, false, -1.9, 12, "lumberjack", FEEL), { aim: 0, engine: "off" as const })
      dummy(0.4, 14.2, Math.atan2(12 - 14.2, -1.9 - 0.4)).torch = true
      dummy(-20, -20, 0)
    } else {
      keep((t) => Math.hypot(t.x, t.y - 12) < 4)
      me = Object.assign(newJack(0, false, -0.6, 12, "lumberjack", FEEL), { aim: 0 })
      dummy(0.55, 12, Math.PI)
      dummy(3, 15, Math.PI)
    }
    w.jacks = [me, ...dummies]
    view.sync(w)
    newAvatars()
  }

  Object.assign(window, {
    timber: {
      world: w,
      feel: FEEL,
      auto,
      stage,
      shell,
      wood,
      view,
      look: labSettings,
      blur: blurSettings,
      sawView,
      people,
      dread,
      sound: tsound,
      get style() {
        return resolvedView()
      },
      /** The people still loading resolve this (never rejects). */
      peopleReady: () => people?.preload() ?? Promise.resolve(),
      measure: (n?: number, step?: number) => view.forest.measure(n, step),
      get frames() {
        return frames
      },
      set paused(v: boolean) {
        paused = v
      },
      newRound,
      ready: true,
    },
  })
  requestAnimationFrame(frame)
}

void main()
