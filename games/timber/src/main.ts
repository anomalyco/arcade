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
import { FlareFx, flareSceneLight } from "@arcade/kit/fx/flare"
import { Particles } from "@arcade/kit/fx/particles"
import { Splatter, splatterPresets } from "@arcade/kit/fx/splatter"
import { SplatterSurfaces } from "@arcade/kit/fx/splatter-surfaces"
import { WoodFx, woodControls, woodDefaults } from "@arcade/kit/fx/wood"
import { openGpu } from "@arcade/kit/gpu/boot"
import { FrameParts, SPRITE } from "@arcade/kit/gpu/frame-parts"
import { createLookSettings } from "@arcade/kit/gpu/look"
import { MAT, Mesh, packVerts, type Rgb } from "@arcade/kit/gpu/mesh"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, type SceneLight, SceneLights } from "@arcade/kit/gpu/scene-frame"
import { GpuPerf } from "@arcade/kit/gpu-perf"
import { LabPanel } from "@arcade/kit/lab-panel"
import { QUALITY_PROFILES } from "@arcade/kit/quality"
import { audioRuntimeSync, createGameShell, createShellQuality, type GameShell } from "@arcade/kit/shell"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { SAW_BITE, SAW_ENGINE, TIMBER_SFX, TRUCK_ENGINE } from "../shared/sfx"
import {
  active,
  ARENA_HALF,
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
  WALLS,
  type World,
} from "../shared/sim"
import { HINGE, predictedFall, standingLean, type Tree, trunkHeightAt } from "../shared/trees"

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
const PART_GLOW: Record<PartKind | "gas", Rgb> = { fuel: [0.4, 1, 0.45], plug: [0.7, 0.85, 1], keys: [1, 0.85, 0.3], gas: [1, 0.35, 0.2] }

/** Reference tree the models are built at; each tree is drawn at scale h / TREE_H. */
const TREE_H = 25
const CROWNS = [1.6, 2.0, 2.4, 2.8]
const BARK: Rgb = [0.36, 0.25, 0.17]
const WOOD: Rgb = [0.93, 0.78, 0.54]
const NEEDLES: Rgb = [0.16, 0.34, 0.15]
const CROWN_BASE = 0.45

/** The trunk above the cut, hinged at the origin: the part that pivots. Its butt is fresh wood. */
function trunkMesh(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.25, 0.13, 0, TREE_H, 8, BARK, MAT.lit)
  return m
}

/** Torn fibres and the fresh face of the butt, drawn with the trunk once it has gone over. */
function buttMesh(seed: number): Mesh {
  const m = new Mesh()
  const rnd = mulberry32(seed)
  m.prism(0, 0, 0.245, 0.245, -0.012, 0.004, 8, WOOD, MAT.lit)
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2
    const d = rnd() * 0.18
    const len = 0.06 + rnd() * (i < 3 ? 0.32 : 0.12)
    m.prism(Math.cos(a) * d, Math.sin(a) * d, 0.012 + rnd() * 0.02, 0.002, -len, 0, 4, [WOOD[0] * 0.9, WOOD[1] * 0.85, WOOD[2] * 0.8], MAT.lit)
  }
  return m
}

/** A torn stump: the hinge strip and long fibres stand up out of the cut. */
function jaggedStumpMesh(seed: number): Mesh {
  const m = new Mesh()
  const rnd = mulberry32(seed)
  m.prism(0, 0, 0.27, 0.25, 0, HINGE, 8, BARK, MAT.lit)
  m.prism(0, 0, 0.235, 0.235, HINGE - 0.01, HINGE + 0.012, 8, WOOD, MAT.lit)
  for (let i = 0; i < 11; i++) {
    const a = rnd() * Math.PI * 2
    const d = 0.05 + rnd() * 0.17
    const len = 0.05 + rnd() * (i < 4 ? 0.34 : 0.14)
    m.prism(Math.cos(a) * d, Math.sin(a) * d, 0.014 + rnd() * 0.025, 0.002, HINGE, HINGE + len, 4, [WOOD[0] * (0.85 + rnd() * 0.15), WOOD[1] * 0.85, WOOD[2] * 0.78], MAT.lit)
  }
  return m
}

/** Both windings, so a thin face shows from either side. */
function quad2(m: Mesh, a: number[], b: number[], c: number[], d: number[], n: number[], col: Rgb) {
  m.quad(a, b, c, d, n, col, MAT.lit)
  m.quad(d, c, b, a, [-n[0]!, -n[1]!, -n[2]!], col, MAT.lit)
}

/** The face notch on the fall side (+x): a dark mouth with pale lips. */
function wedgeMesh(): Mesh {
  const m = new Mesh()
  const x0 = 0.262
  const x1 = 0.27
  quad2(m, [x0, -0.02, -0.21], [x0, 0.19, -0.21], [x0, 0.19, 0.21], [x0, -0.02, 0.21], [1, 0, 0], WOOD)
  quad2(m, [x1, 0.005, -0.18], [x1, 0.16, -0.18], [x1, 0.16, 0.18], [x1, 0.005, 0.18], [1, 0, 0], [0.06, 0.04, 0.03])
  return m
}

/** A stacked conifer crown on the same hinge: three cones, widest at the bottom. */
function crownMesh(crownR: number): Mesh {
  const m = new Mesh()
  const c0 = CROWN_BASE * TREE_H
  for (let i = 0; i < 3; i++) {
    const y0 = c0 + i * (TREE_H - c0) * 0.3
    const y1 = Math.min(TREE_H + 0.8, y0 + (TREE_H - c0) * 0.55)
    const r = crownR * (1 - i * 0.25)
    m.prism(0, 0, r, 0.05, y0, y1, 7, [NEEDLES[0] * (1 + i * 0.12), NEEDLES[1] * (1 + i * 0.1), NEEDLES[2]], MAT.lit, 0, true, i * 0.4)
  }
  return m
}

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
  } else if (kind === "plug") {
    m.box(-0.1, 0, -0.1, 0.1, 0.05, 0.1, [0.35, 0.3, 0.25], MAT.lit)
    m.prism(0, 0, 0.03, 0.03, 0.05, 0.16, 6, [0.92, 0.92, 0.88], MAT.lit)
    m.prism(0, 0, 0.022, 0.022, 0.16, 0.24, 6, [0.6, 0.62, 0.66], MAT.shiny)
  } else {
    m.box(-0.12, 0, -0.1, 0.12, 0.03, 0.1, [0.35, 0.3, 0.25], MAT.lit)
    m.box(-0.06, 0.03, -0.015, 0.03, 0.05, 0.05, [0.95, 0.78, 0.2], MAT.shiny)
    m.box(0.03, 0.03, 0, 0.12, 0.045, 0.02, [0.85, 0.85, 0.82], MAT.shiny)
  }
  return m
}

function groundSurfaces(): SplatterSurfaces {
  const tris: number[] = []
  const step = 4
  for (let x = -ARENA_HALF; x < ARENA_HALF; x += step)
    for (let z = -ARENA_HALF; z < ARENA_HALF; z += step) {
      tris.push(x, 0, z, x, 0, z + step, x + step, 0, z, 1)
      tris.push(x + step, 0, z, x, 0, z + step, x + step, 0, z + step, 1)
    }
  return new SplatterSurfaces(tris)
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k
const mix3 = (a: readonly number[], b: readonly number[], k: number): [number, number, number] => [mix(a[0]!, b[0]!, k), mix(a[1]!, b[1]!, k), mix(a[2]!, b[2]!, k)]

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

type Automation = { input: JackInput | null; camera: { x: number; y: number; dist: number; pitch: number } | null }
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

  let renderer: Renderer | null = null
  const live: { panel: LabPanel | null; shell: GameShell | null; gpuMs: () => number; newRound?: () => void } = { panel: null, shell: null, gpuMs: () => 0 }
  const quality = createShellQuality({
    game: "timber",
    tiers: QUALITY_PROFILES,
    params,
    gpuMs: () => live.gpuMs(),
    onChange: (tier) => {
      renderer?.setBloomLevels(tier.bloomLevels)
      live.shell?.settings.changed()
    },
  }).expose()
  const shell = createGameShell({
    game: "timber",
    title: "TIMBER",
    subtitle: "One lumberjack with a chainsaw. Three of you with axes. Fix the truck and get out of the woods.",
    playLabel: "Into the woods",
    resumeLabel: "Back to the forest",
    channels: ["master", "effects", "ambience"],
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
  const perf = new GpuPerf(gpu.device)
  renderer = new Renderer(gpu.device, gpu.context, gpu.format)
  const r = renderer
  live.gpuMs = () => perf.gpuMs ?? r.lastGpuMs
  r.setLook(createLookSettings())
  r.setBloomLevels(quality.profile.bloomLevels)

  const level = new Mesh()
  level.box(-ARENA_HALF - 6, -0.2, -ARENA_HALF - 6, ARENA_HALF + 6, 0, ARENA_HALF + 6, [0.2, 0.27, 0.14], MAT.lit)
  // A low earth bank round the woods, so the edge reads.
  for (const [x0, y0, x1, y1] of WALLS) level.box(x0, 0, y0, x1, 0.9, y1, [0.26, 0.22, 0.16], MAT.lit)
  const lighting = flatLighting(0, 1, [0.32, 0.36, 0.26])
  r.setLevel({
    chunks: [{ data: packVerts(level.v), box: [-ARENA_HALF - 6, -ARENA_HALF - 6, ARENA_HALF + 6, ARENA_HALF + 6] }],
    glass: [],
    floor: lighting.floor,
    bounce: lighting.bounce,
  })

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
  const trunkModel = r.addModel(trunkMesh())
  const trunkFadeModel = r.addModel(trunkMesh())
  // Faded crowns draw through the alpha pipeline; their own models keep the opaque batches opaque.
  const crownModels = CROWNS.map((c) => r.addModel(crownMesh(c)))
  const crownFadeModels = CROWNS.map((c) => r.addModel(crownMesh(c)))
  const stumpMesh = new Mesh()
  stumpMesh.prism(0, 0, 0.27, 0.25, 0, HINGE, 8, BARK, MAT.lit)
  const stumpModel = r.addModel(stumpMesh)
  const jaggedModels = [11, 23, 37].map((s) => r.addModel(jaggedStumpMesh(s)))
  const buttModels = [5, 17, 29].map((s) => r.addModel(buttMesh(s)))
  const slitMesh = new Mesh()
  slitMesh.box(-0.5, -0.014, -0.265, 0, 0.014, 0.265, [0.05, 0.03, 0.02], MAT.lit)
  slitMesh.box(-0.5, -0.03, -0.27, -0.46, 0.03, 0.27, WOOD, MAT.lit)
  const slitModel = r.addModel(slitMesh)
  const wedgeModel = r.addModel(wedgeMesh())
  const chipMesh = new Mesh()
  chipMesh.box(-0.5, -0.15, -0.35, 0.5, 0.15, 0.35, WOOD, MAT.lit)
  const chipModel = r.addModel(chipMesh)
  const splinterMesh = new Mesh()
  splinterMesh.box(-0.06, -0.5, -0.03, 0.06, 0.5, 0.03, [WOOD[0] * 0.95, WOOD[1] * 0.9, WOOD[2] * 0.85], MAT.lit)
  const splinterModel = r.addModel(splinterMesh)
  const twigMesh = new Mesh()
  twigMesh.box(-0.03, -0.5, -0.03, 0.03, 0.5, 0.03, [0.32, 0.22, 0.14], MAT.lit)
  twigMesh.box(-0.12, 0.1, -0.12, 0.12, 0.5, 0.12, NEEDLES, MAT.lit)
  const twigModel = r.addModel(twigMesh)
  const truckModel = r.addModel(truckMesh())
  const itemModels = { fuel: r.addModel(itemMesh("fuel")), plug: r.addModel(itemMesh("plug")), keys: r.addModel(itemMesh("keys")), gas: r.addModel(itemMesh("gas")) }

  const sound = new SoundBank("timber", TIMBER_SFX)
  const syncRuntime = audioRuntimeSync(shell.settings, sound.runtime)
  // The bank re-applies its own volumes when it unlocks; keep them the shell's so that never undoes the player's mix.
  const syncAudio = () => {
    Object.assign(sound.volumes, shell.settings.volumes)
    syncRuntime()
  }
  const particles = new Particles()
  const splatter = new Splatter(groundSurfaces())
  const blood = { ...splatterPresets.blood }
  const fx = mulberry32(7)
  const fp = new FrameParts()
  const input = new Input(canvas, [])
  const labSettings = Object.assign(FEEL, cameraShakeDefaults(), woodDefaults())
  const wood = new WoodFx(labSettings, 2400, 3)
  const cam = new Camera(labSettings)
  const hitStop = new HitStop()
  const lights = new SceneLights()
  const sceneFrame = newSceneFrame()

  const panel = new LabPanel(labSettings, [...FEEL_CONTROLS, ...woodControls(), ...cameraShakeControls], params, () => input.release(), { open: false, openGroups: ["Round"] })
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

  const seed = Number(params.get("seed")) || 1 + Math.floor(Math.random() * 1e6)
  const w: World = createWorld(seed, FEEL)
  let avatars = new Map<number, Avatar>()
  /** Ragdolls: the dead, and the downed (which crawl, so they follow the sim body). */
  let corpses = new Map<number, Ragdoll>()
  let crawlAt = new Map<number, { x: number; y: number }>()
  let voices = new Map<number, { engine: VoiceHandle | null; bite: VoiceHandle | null }>()
  let truckVoice: VoiceHandle | null = null
  let heartVoice: VoiceHandle | null = null
  let flareFx = new Map<number, FlareFx>()
  let whooshed = new Set<number>()
  let later: Later[] = []
  let feedLines: { text: string; t: number }[] = []
  let camYaw = 0
  let slowMo = 0
  const auto: Automation = { input: null, camera: null }

  const newAvatars = () => {
    for (const v of voices.values()) {
      v.engine?.stop(0.1)
      v.bite?.stop(0.1)
    }
    truckVoice?.stop(0.2)
    truckVoice = null
    voices = new Map()
    corpses = new Map()
    crawlAt = new Map()
    flareFx = new Map()
    whooshed = new Set()
    later = []
    avatars = new Map(w.jacks.map((j) => [j.id, newAvatar(`jack-${j.id}`, j.x, j.y, j.aim, "rifle")]))
    const me = w.jacks[0]
    if (me) cam.snap(me.x, me.y)
    splatter.reset()
    particles.reset()
    wood.reset()
    feedLines = []
    slowMo = 0
    prompts()
  }
  newAvatars()
  const newRound = () => {
    resetRound(w, FEEL)
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
  // Over the shoulder: mouse look on the pointer lock (click to take it).
  canvas.addEventListener("click", () => {
    if (FEEL.viewStyle === "shoulder" && shell.playing && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
  })
  // Escape releases the lock before the shell sees the key, so a lost lock mid-play is the pause.
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== canvas && shell.playing) shell.flow.pause()
  })
  shell.flow.subscribe(() => {
    if (!shell.playing && document.pointerLockElement === canvas) document.exitPointerLock()
  })
  window.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas && FEEL.viewStyle === "shoulder") camYaw -= e.movementX * 0.0028
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
    if (quality.fit(canvas, innerWidth, innerHeight)) r.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

  const humanInput = (): JackInput => {
    const me = w.jacks[0]!
    const presses = { ...pressed }
    pressed.engine = pressed.torch = pressed.flare = false
    if (auto.input) return auto.input
    if (!input.enabled) return { ...NO_INPUT, aim: me.aim }
    const { mx, my } = input.move()
    const keys = { ...presses, use: input.held("KeyE"), saw: input.firing, dash: input.takeJump(), sprint: input.sprinting }
    if (FEEL.viewStyle === "shoulder") {
      const fwdX = -Math.sin(camYaw)
      const fwdY = -Math.cos(camYaw)
      const rx = Math.cos(camYaw)
      const ry = -Math.sin(camYaw)
      return { ...keys, mx: rx * mx - fwdX * my, my: ry * mx - fwdY * my, aim: Math.atan2(fwdY, fwdX) }
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

  let splatId = 0
  const bleed = (x: number, y: number, dir: number, amount: number) => {
    splatId++
    splatter.emit({ id: splatId, seed: seed ^ splatId, x, y: 1.05, z: y, dx: Math.cos(dir), dy: 0.15, dz: Math.sin(dir), amount }, blood)
    wood.bloodMist(particles, x, 1.05, y, dir, amount)
  }

  const ragdollFor = (j: Jack, dir: number, style: "crush" | "saw" | "down") => {
    const a = avatars.get(j.id)
    if (!a?.body || corpses.has(j.id)) return
    const s =
      style === "crush" ? { push: 0.4, lift: 0, spin: 0, buckle: 2.2 } : style === "down" ? { push: 1.6, lift: 0.1, spin: (fx() - 0.5), buckle: 1.4 } : { push: 4.5, lift: 0.5, spin: (fx() - 0.5) * 2, buckle: 0.2 }
    corpses.set(j.id, ragdoll(a.body, "rifle", j.vx, j.vy, Math.cos(dir), Math.sin(dir), s, WALLS))
    crawlAt.set(j.id, { x: j.x, y: j.y })
  }

  const treeMass = (t: Tree) => (t.h / TREE_H) ** 2 * (t.crownR / 2.2)
  const slow = () => {
    if (FEEL.slowMoTime > 0) slowMo = FEEL.slowMoTime
  }

  const handleEvents = () => {
    const me = w.jacks[0]!
    for (const e of w.events) {
      if (e.kind === "warn") {
        const t = w.trees[e.tree]!
        sound.play("door.wood.open", t.x, t.y, { rate: 0.55, gain: 1.2 })
      } else if (e.kind === "fell") {
        const t = w.trees[e.tree]!
        // Crack, snap, then the long groan as it tips.
        sound.play("barricade.break", t.x, t.y, { rate: 0.7, gain: 1.3 })
        after(0.11, () => sound.play("impact.bullet.wood", t.x, t.y, { rate: 0.6, gain: 1.2 }))
        after(0.28, () => sound.play("ship.hull.creak", t.x, t.y, { rate: 0.85, gain: 1.1 }))
        wood.splinters(t.x, HINGE, t.y, t.fx, t.fy, t.r)
        if (involvesMe(e.by)) cam.add(0.12)
        say(`${nameOf(e.by)} felled a tree`)
      } else if (e.kind === "domino") {
        const t = w.trees[e.tree]!
        const h = Math.min(t.h, 9)
        sound.play("melee.break", t.x, t.y, { rate: 0.6, gain: 1.2 })
        sound.play("barricade.break", t.x, t.y, { rate: 0.6 })
        after(0.1, () => sound.play("impact.bullet.wood", t.x, t.y, { rate: 0.55, gain: 1.1 }))
        wood.branches(particles, t.x, h, t.y, 1.4)
        wood.splinters(t.x, HINGE, t.y, t.fx, t.fy, t.r)
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
        sound.play("weather.thunder.close", mx, my, { gain: 0.8 * k + 0.2, rate: 1.3 })
        sound.play("door.bash", mx, my, { rate: 0.55, gain: 1.2 })
        for (const d of [0.06, 0.17, 0.31]) {
          const s = t.h * (0.55 + fx() * 0.45)
          after(d, () => sound.play("melee.hit.wood", t.x + t.fx * s, t.y + t.fy * s, { rate: 0.55 + fx() * 0.3, gain: 0.9 }))
        }
        hitStop.trigger((FEEL.landHitStopMs / 1000) * near * Math.min(1, k))
        cam.add(FEEL.landShake * near * Math.min(1, k), Math.atan2(t.fy, t.fx))
        wood.landing(particles, t.x, t.y, t.fx, t.fy, t.h, t.crownR, 1 - t.crown0, mass * Math.min(1.3, e.speed / 30))
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
        }
      } else if (e.kind === "gore") {
        bleed(e.x, e.y, e.dir, 0.5)
        if (fx() < 0.4) sound.play("zombie.hit", e.x, e.y, { gain: 0.6, rate: 0.9 + fx() * 0.3 })
        const v = avatars.get(e.jack)
        if (v && !corpses.has(e.jack)) flinch(v, Math.cos(e.dir), Math.sin(e.dir), 0.6)
        if (involvesMe(e.by, e.jack)) cam.add(FEEL.sawShake * 0.25, e.by === focusJack().id ? e.dir + Math.PI : e.dir, FEEL.sawKick * 0.3)
        if (e.jack === focusJack().id) cam.addFlash(0.15)
      } else if (e.kind === "clash") {
        wood.sparks(particles, e.x, 1.0, e.y, e.dir)
        sound.play("melee.hit.metal", e.x, e.y, { rate: 1.2 + fx() * 0.3, gain: 0.9 })
        if (involvesMe(e.a, e.b)) cam.add(FEEL.sawShake * 0.3, e.dir + Math.PI, FEEL.sawKick * 0.5)
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
        }
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
        }
        say(`${nameOf(e.jack)} ${e.jack === 0 ? "are" : "is"} down`)
      } else if (e.kind === "bleedout") {
        say(`${nameOf(e.jack)} bled out`)
      } else if (e.kind === "revive") {
        const v = w.jacks[e.jack]!
        corpses.delete(e.jack)
        crawlAt.delete(e.jack)
        avatars.set(e.jack, newAvatar(`jack-${e.jack}`, v.x, v.y, v.aim, "rifle"))
        sound.play("pickup.item", v.x, v.y, { rate: 0.7 })
        say(`${nameOf(e.by)} got ${e.jack === 0 ? "you" : nameOf(e.jack)} up`)
      } else if (e.kind === "dash") {
        const j = w.jacks[e.jack]!
        sound.play("melee.swing.light", j.x, j.y, { rate: 0.8 })
      } else if (e.kind === "pull") {
        const j = w.jacks[e.jack]!
        sound.play("window.slide", j.x, j.y, { rate: e.extra ? 2.1 : 1.7, gain: 0.9 })
      } else if (e.kind === "start") {
        const j = w.jacks[e.jack]!
        sound.play("melee.hit.metal", j.x, j.y, { rate: 0.45, gain: 0.5 })
        for (let i = 0; i < 8; i++) wood.exhaust(particles, 0.1, `start${i}`, j.x, 0.95, j.y, -Math.sin(j.aim), Math.cos(j.aim), 1)
      } else if (e.kind === "sputter") {
        const j = w.jacks[e.jack]!
        sound.play("melee.hit.metal", j.x, j.y, { rate: 0.35, gain: 0.45 })
        if (e.jack === 0) say(e.flooded ? "Flooded. Wait for it to clear." : "It didn't catch.")
      } else if (e.kind === "stop") {
        const j = w.jacks[e.jack]!
        if (e.why === "dry" && e.jack === 0) say("Out of fuel. Find a gas can.")
        if (e.why !== "off") sound.play("melee.hit.metal", j.x, j.y, { rate: 0.4, gain: 0.35 })
      } else if (e.kind === "chop") {
        const j = w.jacks[e.jack]!
        const t = w.trees[e.tree]!
        sound.play("melee.hit.wood", t.x, t.y, { rate: 0.9 + fx() * 0.2, gain: 1 })
        sound.play("melee.swing.light", j.x, j.y, { rate: 1.2, gain: 0.5 })
        wood.chop(t.x - Math.cos(j.aim) * t.r, HINGE + 0.3, t.y - Math.sin(j.aim) * t.r, Math.cos(j.aim), Math.sin(j.aim))
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

  const updateVoices = () => {
    if (!sound.runtime.ctx) return
    const ear = listener()
    // The loops only sound in play: the title and the pause menu are quiet.
    const inPlay = shell.playing && !paused
    for (const j of w.jacks) {
      let v = voices.get(j.id)
      if (!v) voices.set(j.id, (v = { engine: null, bite: null }))
      const running = inPlay && active(j) && w.phase !== "over" && j.role === "lumberjack" && j.engine === "on"
      const d = Math.hypot(j.x - ear.x, j.y - ear.y)
      const near = 1 / (1 + d / 9)
      const pan = Math.max(-0.8, Math.min(0.8, (j.x - ear.x) / 14))
      const biting = running && j.trigger && j.target !== null && j.target.kind === "tree"
      if (!running) {
        v.engine?.stop(0.25)
        v.engine = null
      } else {
        const revving = j.trigger
        const rate = biting ? 1.75 + Math.sin(w.t * 23 + j.id) * 0.05 : revving ? 2.2 : 1.45
        const gain = (j.id === ear.id ? 0.55 : 0.5) * near * (revving ? 1.3 : 0.8)
        v.engine ??= sound.runtime.playCue(SAW_ENGINE, { gain, rate, pan, ownerKey: `saw-${j.id}` })
        v.engine?.setParams({ gain, rate, pan }, 0.06)
      }
      if (biting && !v.bite) v.bite = sound.runtime.playCue(SAW_BITE, { gain: 0.9 * near, rate: 1.35, pan, ownerKey: `bite-${j.id}` })
      if (!biting && v.bite) {
        v.bite.stop(0.12)
        v.bite = null
      }
      v.bite?.setParams({ gain: 0.9 * near, pan }, 0.05)
    }
    const tr = w.truck
    if (inPlay && tr?.started && w.phase === "play") {
      const near = 1 / (1 + Math.hypot(tr.x - ear.x, tr.y - ear.y) / 10)
      truckVoice ??= sound.runtime.playCue(TRUCK_ENGINE, { gain: 0.6 * near, rate: 0.7, ownerKey: "truck" })
      truckVoice?.setParams({ gain: 0.6 * near }, 0.1)
    } else if (truckVoice) {
      truckVoice.stop(0.5)
      truckVoice = null
    }
    // A heartbeat when he's close and you're a survivor.
    const lj = lumberjackOf(w)
    const me = w.jacks[0]!
    const close = inPlay && lj && active(lj) && me.role === "survivor" && active(me) && w.phase === "play" ? Math.max(0, 1 - Math.hypot(lj.x - me.x, lj.y - me.y) / 14) : 0
    if (close > 0.05) {
      heartVoice ??= sound.runtime.playCue("body.heartbeat", { gain: close, rate: 0.9 + close * 0.4, ownerKey: "heart" })
      heartVoice?.setParams({ gain: close * 0.9, rate: 0.9 + close * 0.4 }, 0.2)
    } else if (heartVoice) {
      heartVoice.stop(0.4)
      heartVoice = null
    }
  }

  let last = performance.now()
  let acc = 0
  let frames = 0
  let paused = false

  /** Canopy cutaway: a capsule on the ground from the focus towards the camera, `r` wide (0 = off). */
  type Cutaway = { x: number; y: number; vx: number; vy: number; len: number; r: number }
  const along = (c: Cutaway, px: number, py: number) => {
    const s = (px - c.x) * c.vx + (py - c.y) * c.vy
    const k = Math.max(0, Math.min(c.len, s))
    return { s, d: Math.hypot(px - c.x - c.vx * k, py - c.y - c.vy * k) }
  }
  const smooth = (e0: number, e1: number, v: number) => {
    const k = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
    return k * k * (3 - 2 * k)
  }
  /** Crown opacity: crowns overhead in the cutaway fade out; falling ones stay half visible and firm up near the ground. */
  const crownAlpha = (t: Tree, dir: { x: number; y: number }, theta: number, c: Cutaway) => {
    if (c.r <= 0) return 1
    const hc = (CROWN_BASE + 1) * 0.5 * t.h
    const lift = HINGE + Math.cos(theta) * hc
    if (lift < 2.5) return 1
    const { d } = along(c, t.x + dir.x * Math.sin(theta) * hc, t.y + dir.y * Math.sin(theta) * hc)
    const floor = t.state === "standing" ? FEEL.canopyAlpha : Math.max(FEEL.canopyAlpha, 0.55)
    const a = floor + (1 - floor) * smooth(c.r * 0.6, c.r + t.crownR, d)
    return a + (1 - a) * (1 - smooth(2.5, 6, lift))
  }
  /** Trunk opacity: only standing trunks on the camera side of the focus fade, so the tree you cut stays solid. */
  const trunkAlpha = (t: Tree, c: Cutaway) => {
    if (c.r <= 0 || t.state !== "standing") return 1
    const { s, d } = along(c, t.x, t.y)
    if (s < 1.5) return 1
    const floor = Math.max(FEEL.canopyAlpha, 0.3)
    return floor + (1 - floor) * Math.max(smooth(c.r * 0.4, c.r * 0.7, d), 1 - smooth(1.5, 3, s))
  }

  const drawTree = (t: Tree, cut: Cutaway) => {
    const s = t.h / TREE_H
    const k = t.crownR / s
    let mi = 0
    for (let i = 1; i < CROWNS.length; i++) if (Math.abs(CROWNS[i]! - k) < Math.abs(CROWNS[mi]! - k)) mi = i
    const shade = 0.85 + ((t.id * 37) % 23) / 70
    const tint: Rgb = t.notched ? [shade * 1.08, shade * 1.02, shade * 0.86] : [shade, shade, shade]
    let theta = t.theta
    let dir = { x: t.fx, y: t.fy }
    const yawOf = (d: { x: number; y: number }) => Math.atan2(d.y, d.x)
    // Sawdust heaped round the foot of anything cut.
    // Sprites are unlit, so the heap dims with the night.
    const fresh = t.notched ? t.cut - FEEL.notchedCut : t.cut
    if (fresh > 0.02) {
      const dim = mix(0.8, 0.22, Math.max(0, Math.min(1, FEEL.night)))
      fp.sprite(false, t.x, 0.022, t.y, 0.28 + Math.min(1, t.cut) * 0.4, WOOD[0] * dim, WOOD[1] * dim, WOOD[2] * dim, 0.45, SPRITE.disc)
    }
    if (t.state === "standing") {
      fp.push(stumpModel, t.x, 0, t.y, 0, [1, 1, 1], 0, 0, 0)
      dir = predictedFall(t, t.x - t.cdx, t.y - t.cdy, 0)
      if (Math.hypot(t.cdx, t.cdy) < 1e-6) {
        const a = t.id * 2.399
        dir = { x: Math.cos(a), y: Math.sin(a) }
      }
      theta = standingLean(t, FEEL)
      // Creaking: a shiver once it is past the warning point.
      if (t.cut >= FEEL.warnAt) theta += Math.sin(w.t * 31 + t.id) * 0.004
      if (t.cut > 0.02) {
        // The back cut grows in from the cutter's side; the face notch sits on the fall side.
        const depth = t.cut * 0.5
        const sc = Math.max(0.2, t.cut)
        fp.part(slitModel, t.x - dir.x * (t.r - depth), HINGE, t.y - dir.y * (t.r - depth), yawOf(dir), [1, 1, 1], 0, 0, 0, 1, sc)
        if (t.cut > 0.12) fp.part(wedgeModel, t.x, HINGE - 0.02, t.y, yawOf(dir), [1, 1, 1], 0, 0, 0, 1, Math.min(1, 0.4 + t.cut))
      }
      // Crown shade on the ground.
      fp.sprite(false, t.x, 0.02, t.y, t.crownR * 1.05, 0, 0, 0, 0.22, SPRITE.disc)
    } else {
      fp.push(jaggedModels[t.id % 3]!, t.x, 0, t.y, t.id * 1.7, [1, 1, 1], 0, 0, 0)
      fp.part(buttModels[t.id % 3]!, t.x, HINGE, t.y, yawOf(dir), [1, 1, 1], -theta, 0, 0, 1, 1)
      const reach = t.h * Math.sin(Math.min(theta, Math.PI / 2))
      const cx = t.x + t.fx * reach * 0.5
      const cy = t.y + t.fy * reach * 0.5
      fp.sprite(false, cx, 0.02, cy, Math.max(0.5, reach * 0.5), 0, 0, 0, 0.2, SPRITE.line, yawOf(dir), 1.6 / Math.max(0.5, reach * 0.5))
    }
    const flash = t.state === "standing" && t.cut >= FEEL.warnAt ? 0.12 + 0.1 * Math.sin(w.t * 12) : 0
    const yaw = yawOf(dir)
    const trunk = trunkAlpha(t, cut)
    if (trunk >= 0.999) fp.part(trunkModel, t.x, HINGE, t.y, yaw, tint, -theta, 0, flash, 1, s)
    else fp.part(trunkFadeModel, t.x, HINGE, t.y, yaw, tint, -theta, 0, flash, trunk, s)
    const alpha = crownAlpha(t, dir, theta, cut)
    if (alpha >= 0.999) fp.part(crownModels[mi]!, t.x, HINGE, t.y, yaw, tint, -theta, 0, flash, 1, s)
    else if (alpha > 0.02) fp.part(crownFadeModels[mi]!, t.x, HINGE, t.y, yaw, tint, -theta, 0, flash, alpha, s)
  }

  /** Ground strip where a tree will land: trunk line and crown footprint. */
  const fallStrip = (t: Tree, dx: number, dy: number, rr: number, g: number, b: number, a: number) => {
    // Unlit sprites glare in the dark: keep the ground markings quiet at night.
    a *= mix(1, 0.5, Math.max(0, Math.min(1, FEEL.night)))
    const rot = Math.atan2(dy, dx)
    const L = t.h + HINGE
    const half = L * 0.5
    fp.sprite(false, t.x + dx * half, 0.04, t.y + dy * half, half, rr, g, b, a, SPRITE.line, rot, 0.45 / half)
    const c0 = t.crown0 * t.h
    const ch = (t.h - c0) * 0.5
    fp.sprite(false, t.x + dx * (c0 + ch), 0.035, t.y + dy * (c0 + ch), ch, rr, g, b, a * 0.45, SPRITE.line, rot, (t.crownR * 1.3) / ch)
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
        if (j.engine === "on" || fx() < 0.15) wood.exhaust(particles, DT, `ex${j.id}`, j.x + ax * 0.2 - ay * 0.32, 0.98, j.y + ay * 0.2 + ax * 0.32, -ay, ax, rev)
      }
      if (j.trigger && j.target?.kind === "tree" && j.role === "lumberjack") {
        const t = w.trees[j.target.id]!
        wood.kerf(particles, DT, `k${j.id}`, t.x - ax * t.r, HINGE, t.y - ay * t.r, ax, ay, 1)
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
    const a = cam.project(from.x, 1, from.y, innerWidth, innerHeight)
    const b = cam.project(x, 1, y, innerWidth, innerHeight)
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
    const me = w.jacks[0]!

    while (acc >= DT) {
      acc -= DT
      const prevAlive = w.jacks.map((j) => j.alive)
      stepWorld(w, [humanInput()], DT, FEEL)
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

    particles.update(scaledDt, [], () => 0)
    splatter.update(scaledDt)
    wood.step(scaledDt)
    for (const [id, rd] of corpses) {
      stepRagdoll(rd, scaledDt)
      // The downed crawl: carry their body along with them.
      const j = w.jacks[id]!
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
    updateVoices()

    // Camera.
    const aspect = innerWidth / Math.max(1, innerHeight)
    if (auto.camera) {
      cam.yaw = 0
      cam.lookHeight = 0
      cam.pitch = auto.camera.pitch
      cam.zoomOffset = auto.camera.dist - 24
      cam.follow(auto.camera.x, auto.camera.y, 0, 0, elapsed, false)
    } else if (FEEL.viewStyle === "shoulder") {
      cam.yaw = camYaw
      cam.pitch = 0.36
      cam.lookHeight = 1.5
      cam.zoomOffset = -17.5
      cam.follow(focus.x, focus.y, -Math.sin(camYaw) * 2.2, -Math.cos(camYaw) * 2.2, elapsed, false)
    } else {
      const top = FEEL.viewStyle === "top"
      cam.yaw = 0
      cam.lookHeight = 0
      cam.pitch = top ? 1.32 : 0.98
      cam.zoomOffset = top ? 8 : 4
      cam.follow(focus.x, focus.y, Math.cos(focus.aim) * 2.5, Math.sin(focus.aim) * 2.5, elapsed, false)
    }
    const vp = cam.update(aspect)
    const viewRect = cam.groundRect(30)
    const inView = (x: number, y: number, pad = 2) => x > viewRect[0] - pad && x < viewRect[2] + pad && y > viewRect[1] - pad && y < viewRect[3] + pad

    fp.begin()
    const focusAt = auto.camera ?? focus
    const toEye = Math.hypot(cam.eye[0] - focusAt.x, cam.eye[2] - focusAt.y)
    const cut: Cutaway = {
      x: focusAt.x,
      y: focusAt.y,
      vx: toEye > 1e-3 ? (cam.eye[0] - focusAt.x) / toEye : 0,
      vy: toEye > 1e-3 ? (cam.eye[2] - focusAt.y) / toEye : 1,
      len: toEye,
      r: FEEL.viewStyle === "shoulder" && !auto.camera ? 0 : FEEL.canopyCut,
    }
    for (const t of w.trees) drawTree(t, cut)

    // Fall lines: the tree you'd cut or shove now (faint), anything creaking (amber) and anything coming down (red).
    let ringTree: Tree | null = null
    if (active(me) && !me.downed) {
      const target = sawTarget(w, me, FEEL)
      const shove = me.role === "survivor" && w.mode === "hunt" ? pushTarget(w, me, FEEL) : null
      if (target?.kind === "tree") {
        const t = w.trees[target.id]!
        const f = predictedFall(t, me.x, me.y)
        fallStrip(t, f.x, f.y, 1, 1, 1, 0.12 + 0.3 * t.cut)
        ringTree = t
      } else if (shove) {
        const f = predictedFall(shove, me.x, me.y)
        fallStrip(shove, f.x, f.y, 1, 1, 1, 0.3)
        ringTree = shove
      }
    }
    for (const t of w.trees) {
      if (t.state === "falling") fallStrip(t, t.fx, t.fy, 1, 0.15, 0.1, 0.16)
      else if (t.state === "standing" && t.cut >= FEEL.warnAt && t !== ringTree) {
        const f = predictedFall(t, t.x - t.cdx, t.y - t.cdy, 0)
        fallStrip(t, f.x, f.y, 1, 0.6, 0.1, 0.22)
      }
    }

    // Chips, splinters and twigs, flying and lying.
    const chipLife = labSettings.woodChipLife
    for (const c of wood.chips) {
      if (!c.live || !inView(c.x, c.z)) continue
      const fade = c.rest < 0 ? 1 : Math.min(1, (chipLife - c.rest) / 3)
      const model = c.kind === 0 ? chipModel : c.kind === 1 ? splinterModel : twigModel
      fp.part(model, c.x, c.y + c.size * 0.12, c.z, c.yaw, [c.shade, c.shade, c.shade], c.pitch, 0, c.rest < 0 ? 0.08 : 0, 1, c.size * fade)
    }

    // Items: parts glint so they read in the dark.
    for (const it of w.items) {
      if (it.taken) continue
      const glow = PART_GLOW[it.kind]
      fp.push(itemModels[it.kind], it.x, 0, it.y, it.id * 1.3, [1, 1, 1], 0, 0, 0.15)
      const pulse = 0.55 + 0.45 * Math.sin(w.t * 3 + it.id)
      fp.sprite(true, it.x, 0.35, it.y, 0.55 + 0.2 * pulse, glow[0], glow[1], glow[2], 0.35 * pulse, SPRITE.glow)
      fp.sprite(false, it.x, 0.03, it.y, 0.7, glow[0], glow[1], glow[2], 0.25, SPRITE.ring)
    }
    const tr = w.truck
    if (tr) {
      fp.push(truckModel, tr.x, 0, tr.y, tr.yaw, [1, 1, 1], 0, 0, 0)
      fp.sprite(false, tr.x, 0.03, tr.y, 3.6, 1, 0.85, 0.35, 0.18 + (tr.started ? 0.15 * Math.sin(w.t * 6) : 0), SPRITE.ring)
      if (tr.started) {
        const fx2 = Math.cos(tr.yaw)
        const fy2 = Math.sin(tr.yaw)
        for (const side of [-0.8, 0.8]) fp.sprite(true, tr.x + fx2 * 3.05 - fy2 * side, 1.05, tr.y + fy2 * 3.05 + fx2 * side, 0.6, 1, 0.95, 0.75, 0.8, SPRITE.glow)
        wood.exhaust(particles, scaledDt, "truck", tr.x - fx2 * 3.1 + fy2 * 1.0, 0.4, tr.y - fy2 * 3.1 - fx2 * 1.0, -fx2, -fy2, 0.4)
      }
    }

    // Lumberjacks and survivors, then the bodies that stay.
    for (const j of w.jacks) {
      const a = avatars.get(j.id)
      if (!a || j.escaped) continue
      const color = tintOf(j.id)
      const partsFor = j.role === "survivor" && w.mode === "hunt" ? axeParts : sawParts
      const rd = corpses.get(j.id)
      if (rd) {
        const dim = j.alive ? 0.85 : 0.6
        emitRagdoll(fp.push, rd, "rifle", [color[0] * dim, color[1] * dim, color[2] * dim], partsFor, j.alive && j.revive > 0 ? 0.05 : 0, 1, 0)
        if (j.alive && j.downed) fp.sprite(true, j.x, 0.3, j.y, 0.9, 1, 0.1, 0.05, 0.25 + 0.15 * Math.sin(w.t * 5), SPRITE.glow)
        continue
      }
      if (!j.alive) continue
      animate(a, scaledDt, w.t, j.x, j.y, j.vx, j.vy, j.aim)
      a.flash = j.held > 0 ? 0.03 + 0.03 * Math.sin(w.t * 40) : j.stun > 0 ? 0.04 + 0.03 * Math.sin(w.t * 10) : j.dashing > 0 ? 0.05 : Math.max(0, a.flash - scaledDt * 4)
      const lift = j.climb * 0.45 - (j.stun > 0 ? 0.6 : 0)
      pose(lift !== 0 ? fp.scaled(1, j.x, j.y, lift) : fp.push, a, color, partsFor)
      fp.sprite(false, j.x, 0.03, j.y, 0.5, color[0], color[1], color[2], j.id === 0 ? 0.55 : 0.35, j.id === 0 ? SPRITE.ring : SPRITE.disc)
      if (j.carrying) fp.part(itemModels[j.carrying], j.x - Math.cos(j.aim) * 0.25, 1.15, j.y - Math.sin(j.aim) * 0.25, j.aim, [1, 1, 1], 0, 0, 0.2, 1, 0.75)
      if (j.role === "survivor" && j.torch && w.mode === "hunt") fp.sprite(true, j.x + Math.cos(j.aim) * 0.45, 1.15, j.y + Math.sin(j.aim) * 0.45, 0.35, 1, 0.95, 0.8, 0.9, SPRITE.glow)
      if (j.role === "lumberjack" && w.mode === "hunt") fp.sprite(true, j.x + Math.cos(j.aim) * 0.12, 1.72, j.y + Math.sin(j.aim) * 0.12, 0.22, 1, 0.85, 0.6, 0.8, SPRITE.glow)
      if (j.blind > 0) fp.sprite(true, j.x, 1.8, j.y, 0.8, 1, 0.3, 0.3, 0.3, SPRITE.glow)
    }

    // Night: a dim blue moon, torches, headlamps, flares and the truck's lamps do the lighting.
    const night = Math.max(0, Math.min(1, FEEL.night))
    const activeLights: SceneLight[] = [{ x: focus.x + 14, y: focus.y - 10, h: 40, r: 120, color: mix3([1, 0.94, 0.82], [0.5, 0.62, 1], night), power: mix(2.4, 0.8, night) }]
    if (w.mode === "hunt") {
      for (const j of w.jacks) {
        if (!upright(j)) continue
        const ax = Math.cos(j.aim)
        const ay = Math.sin(j.aim)
        if (j.role === "survivor" && j.torch) {
          activeLights.push({ x: j.x + ax * 0.45, y: j.y + ay * 0.45, h: 1.2, r: FEEL.torchRange, color: [1, 0.93, 0.8], power: FEEL.torchPower * night, cone: [ax, ay, Math.cos(0.42)], size: 0.06, ...(j.id === focus.id ? {} : { unshadowed: true }) })
        } else if (j.role === "lumberjack") {
          activeLights.push({ x: j.x + ax * 0.2, y: j.y + ay * 0.2, h: 1.75, r: FEEL.torchRange * 0.7, color: [1, 0.78, 0.55], power: FEEL.torchPower * 0.18 * night, cone: [ax, ay, Math.cos(0.6)], size: 0.06, ...(j.id === focus.id ? {} : { unshadowed: true }) })
        }
      }
    }
    for (const fl of flareFx.values()) {
      const l = fl.light()
      if (l.level > 0) activeLights.push(flareSceneLight(l, 3 + 4 * night, 14, true))
    }
    if (tr?.started) {
      const fx2 = Math.cos(tr.yaw)
      const fy2 = Math.sin(tr.yaw)
      activeLights.push({ x: tr.x + fx2 * 3.1, y: tr.y + fy2 * 3.1, h: 1.05, r: 26, color: [1, 0.95, 0.78], power: FEEL.torchPower * 1.5 * night + 0.5, cone: [fx2, fy2, Math.cos(0.5)], size: 0.2 })
    }
    lights.update(activeLights.slice(0, 60), w.jacks.filter((j) => active(j)))
    packSceneFrame(sceneFrame, {
      viewProj: vp,
      eye: cam.eye,
      time: w.t,
      width: r.width,
      height: r.height,
      lightCount: lights.lightCount,
      ambient: [...mix3([0.36, 0.4, 0.36], [0.05, 0.06, 0.1], night), 0],
      mapSize: [ARENA_HALF * 2, ARENA_HALF * 2],
      ao: 0.35,
    })
    r.render({
      frame: sceneFrame as Float32Array<ArrayBuffer>,
      fxParticles: particles,
      splatter,
      lights: lights.lights as Float32Array<ArrayBuffer>,
      lightCount: lights.lightCount,
      shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ as Float32Array<ArrayBuffer>,
      occluderCount: lights.occCount,
      lampPower: lights.power as Float32Array<ArrayBuffer>,
      lampCount: 0,
      view: viewRect,
      batches: fp.batches(),
      alphaSprites: fp.alpha as Float32Array<ArrayBuffer>,
      alphaCount: fp.nAlpha,
      addSprites: fp.add as Float32Array<ArrayBuffer>,
      addCount: fp.nAdd,
      grade: [w.t, 0, cam.damageFlash, 1],
    })

    drawHud(me, ringTree)
    frames++
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
  const stage = (name: "fell" | "domino" | "saw" | "hunt") => {
    Object.assign(FEEL, { mode: "hunt", playAs: name === "hunt" ? "survivor" : "lumberjack", botWarmup: name === "hunt" ? 0 : 1e9, restartDelay: 1e9, gasCans: 0 })
    resetRound(w, FEEL)
    if (name === "hunt") {
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
    const dummy = (x: number, y: number, aim: number) => {
      const j = Object.assign(newJack(dummies.length + 1, false, x, y, "survivor", FEEL), { aim })
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
    } else {
      keep((t) => Math.hypot(t.x, t.y - 12) < 4)
      me = Object.assign(newJack(0, false, -0.6, 12, "lumberjack", FEEL), { aim: 0 })
      dummy(0.55, 12, Math.PI)
      dummy(3, 15, Math.PI)
    }
    w.jacks = [me, ...dummies]
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
