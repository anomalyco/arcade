import "@arcade/kit/dev-hub.css"
import "./characters.css"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { hubCommands, hubTargets } from "@arcade/kit/dev-hub-model"
import { applyArrowCameraKey, bindOrbitGestures, computeGrabPanDelta } from "@arcade/kit/orbit-gestures"
import { LabPanel, formatLabValue, inferControlUnit, type LabControl, type LabValue } from "@arcade/kit/lab-panel"
import { humanProfiles, humanProfileControls, type HumanPreset, type HumanProfile } from "@arcade/kit/human-profile"
import { attachment, bodyBones, boneParent, boneVisible, detach, poseArms, poseUnarmedArms, unarmedHands, type BoneId, type BonePose, type PartMotion } from "@arcade/kit/human-pose"
import { at, clamp, emit, len, moved, pitch, roll, scale, turn, yawFrame, type Frame, type PushPart, type V3 } from "@arcade/kit/rig"
import { mat4 } from "wgpu-matrix"
import { SPEED, SPRINT_SPEED } from "../../shared/config"
import { Builder } from "../../shared/maps/builder"
import type { MapDef } from "../../shared/maps"
import { IDLE_VIEW } from "../../shared/sim/modes"
import { stepBody } from "../../shared/sim/move"
import type { ClientMsg } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { SimEvent } from "../../shared/sim/world"
import { Rng } from "../../shared/rng"
import { Sound } from "../audio/sound"
import { animate, emitBody, newAvatar, swing, type Avatar, type PartModels } from "../game/anim"
import { Game } from "../game/game"
import { detachedSplatter } from "../game/human-splatter"
import { Input } from "../game/input"
import type { Session } from "../game/session"
import { Camera } from "../render/camera"
import { MAT, Mesh } from "../render/mesh"
import { personModels } from "../render/person"
import { Renderer, type Batch } from "../render/renderer"
import { wizardModels, wizardWeapon } from "../render/wizard"
import { outbreakPersonModels, zombieModels } from "../render/zombie"
import { juiceSettings } from "../ui/debug-overlay"
import { modelForBone, registerPartModels } from "./rig-demo"
import { registerDevControl } from "@arcade/kit/dev-control"
import {
  LabCommandRegistry,
  type LabCommand as CommandDef,
  type LabCommandArgField as CommandArgSpec,
  type LabCommandContext as CommandContext,
  type LabCommandDescriptor as CommandDescriptor,
  type LabCommandInvokeResult as CommandOutcome,
} from "@arcade/kit/lab-commands"

export type { CommandArgSpec, CommandContext, CommandDef, CommandDescriptor, CommandOutcome }

const SEED = 990010
const W = 28
const H = 20
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round4 = (n: number) => Math.round(n * 10000) / 10000

function buildStageMap(): MapDef {
  const b = new Builder()
  b.floor("wood", 0, 0, W, H)
  b.floor("tile", 3, 3, W - 3, H - 3)
  b.wall(0, 0, W, 0.35)
  b.wall(0, H - 0.35, W, H)
  b.wall(0, 0, 0.35, H)
  b.wall(W - 0.35, 0, W, H)
  b.wall(5, 5.2, 23, 5.55, 1.45, "partition")
  for (const [x, y, power, color] of [
    [7.5, 13.0, 0.42, [0.92, 0.94, 1.0]],
    [14.0, 13.2, 0.45, [0.95, 0.96, 1.0]],
    [20.5, 13.0, 0.42, [0.92, 0.94, 1.0]],
    [10.5, 6.2, 0.32, [1.0, 0.84, 0.64]],
    [17.5, 6.2, 0.32, [1.0, 0.84, 0.64]],
  ] as const) {
    b.light({ kind: "glow", x, y, h: 3.4, r: 8.5, power, color: [...color] })
  }
  b.spawns.push({ x: 14, y: 10 })
  return b.build({ id: "characters-stage", seed: SEED, name: "Characters Stage", size: [W, H] })
}

const STAGE_MAP = buildStageMap()

class EmptyStageSession implements Session {
  readonly room = null
  readonly myId = "stage-observer"
  private snap: { snap: Snapshot; at: number }
  constructor() {
    this.snap = {
      snap: {
        type: "snap",
        tick: 0,
        t: 0,
        ack: 0,
        phase: "play",
        left: 300,
        map: SEED,
        mapKind: "office",
        maps: "office",
        players: [],
        grenades: [],
        claymores: [],
        mode: IDLE_VIEW,
        you: null,
      },
      at: performance.now(),
    }
  }
  latest() { return this.snap }
  roster(): RosterRow[] { return [] }
  drainEvents(): SimEvent[] { return [] }
  send(_m: ClientMsg): void {}
  status(): string | null { return null }
  close(): void {}
  update(dt: number): void {
    this.snap.snap.t += dt
    this.snap.snap.tick = Math.floor(this.snap.snap.t * 60)
    this.snap.at = performance.now()
  }
}

export type ActorAction = "idle" | "walk" | "run"
export type ActorId = "soldier" | "wizard" | "zombie" | "survivor" | "outbreak-zombie"

export type DetachedPiece = PartMotion & {
  bone: BoneId
  spawnTick: number
}

export type StageActor = {
  id: ActorId
  label: string
  gameTag: string
  homeX: number
  homeY: number
  homeAim: number
  defaultPreset: HumanPreset
  preset: HumanPreset
  profile: HumanProfile
  color: readonly [number, number, number]
  models: PartModels
  wizardCast: boolean
  unarmedSwing: boolean
  action: ActorAction
  actionTime: number
  avatar: Avatar
  hiddenBones: Set<BoneId>
  previousBones: BonePose | undefined
  pieces: DetachedPiece[]
  noPop: boolean
  detachCount: number
}

const LIMB_CHOICES: { value: BoneId; label: string }[] = [
  { value: "right.foreArm", label: "Right forearm" },
  { value: "left.foreArm", label: "Left forearm" },
  { value: "right.upperArm", label: "Right upper arm" },
  { value: "left.upperArm", label: "Left upper arm" },
  { value: "head", label: "Head" },
  { value: "right.thigh", label: "Right thigh" },
  { value: "left.thigh", label: "Left thigh" },
  { value: "right.shin", label: "Right shin" },
  { value: "left.shin", label: "Left shin" },
  { value: "right.foot", label: "Right foot" },
  { value: "left.foot", label: "Left foot" },
]

function buildSelectionRing(): Mesh {
  const m = new Mesh()
  const sides = 24
  const r0 = 0.42
  const r1 = 0.48
  const y = 0.016
  const col = [1, 1, 1] as const
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2
    const a1 = ((i + 1) / sides) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0)
    const c1 = Math.cos(a1), s1 = Math.sin(a1)
    m.quad(
      [c0 * r0, y, s0 * r0],
      [c0 * r1, y, s0 * r1],
      [c1 * r1, y, s1 * r1],
      [c1 * r0, y, s1 * r0],
      [0, 1, 0],
      col,
      MAT.accent,
    )
  }
  m.facet([r1 + 0.02, y + 0.002, -0.09], [r1 + 0.17, y + 0.002, 0], [r1 + 0.02, y + 0.002, 0.09], col, MAT.accent)
  return m
}

function clearSubtree(hidden: Set<BoneId>, root: BoneId) {
  for (const candidate of [...hidden]) {
    let cur: BoneId | null = candidate
    while (cur) {
      if (cur === root) {
        hidden.delete(candidate)
        break
      }
      cur = boneParent[cur]
    }
  }
}

function parseActorHash(hash: string): ActorId | null {
  const clean = hash.replace(/^#/, "").trim().toLowerCase()
  if (clean === "soldier" || clean === "wizard" || clean === "zombie" || clean === "survivor" || clean === "outbreak-zombie") {
    return clean
  }
  return null
}

async function main() {
  document.body.classList.add("characters-page")
  const targets = hubTargets(location.pathname, document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')?.content)
  const environment = targets.kind === "router" ? "Local" : "Production"
  const hubHref = targets.kind === "router" ? "/arcade/getaway/dev.html" : "dev.html"

  document.body.innerHTML = `
    <header class="hub-bar">
      <a class="hub-name" href="${hubHref}#games">Arcade</a>
      <nav aria-label="Developer"></nav>
      <div class="bar-actions">
        <button type="button" class="hub-btn" data-action="possess" aria-pressed="false" title="Possess selected character · P">Possess <kbd>P</kbd></button>
        <button type="button" class="hub-btn" data-action="toggle-lab" aria-pressed="true" title="Toggle Lab panel · Backquote">Lab <kbd>~</kbd></button>
        <span class="hub-env" data-env="${environment.toLowerCase()}">${environment}</span>
      </div>
    </header>
    <main class="characters-stage" data-possessing="false">
      <div class="char-hud-top">
        <div class="actor-tabs" role="tablist" aria-label="Characters"></div>
        <div class="possess-banner" data-possess-banner hidden>
          <span data-possess-text>Possessing</span>
          <kbd>WASD / ,AOE</kbd><span>Move</span>
          <kbd>Shift</kbd><span>Run</span>
          <kbd>Esc</kbd><span>Release</span>
        </div>
      </div>
      <canvas id="view" tabindex="0" aria-label="Characters stage"></canvas>
      <p class="char-status" role="status" data-status></p>
      <div class="char-dock" role="toolbar" aria-label="Character controls">
        <div class="dock-group">
          <label>Profile
            <select aria-label="Actor profile" data-control="actor-profile">
              <option value="soldier">Soldier</option>
              <option value="wizard">Wizard</option>
              <option value="zombie">Zombie</option>
            </select>
          </label>
          <span class="dock-sep"></span>
          <button type="button" data-action="walk" aria-pressed="true">Walk loop</button>
          <button type="button" data-action="run" aria-pressed="false">Run loop</button>
          <button type="button" data-action="stop" aria-pressed="false">Stop</button>
          <span class="dock-sep"></span>
          <select aria-label="Limb" data-control="limb"></select>
          <button type="button" data-action="detach">Detach limb</button>
          <button type="button" data-action="reset">Reset</button>
        </div>
        <div class="dock-group">
          <button type="button" data-action="pause" aria-pressed="false" title="Pause / Resume · Space">Pause</button>
          <button type="button" data-action="step" title="Step 1/60 s">Step</button>
          <label>Speed
            <input type="range" aria-label="Speed" data-control="speed" min="0.1" max="2" step="0.05" value="1" />
            <output data-readout="speed">1.00×</output>
          </label>
          <span class="dock-sep"></span>
          <button type="button" data-action="frame" title="Frame selected character · F">Frame <kbd>F</kbd></button>
          <button type="button" data-action="game-zoom" title="Gameplay camera scale">Game scale</button>
          <button type="button" data-action="lineup" title="Frame full lineup">Lineup</button>
        </div>
      </div>
    </main>
  `

  const nav = document.querySelector("nav")!
  for (const command of hubCommands) {
    const link = document.createElement("a")
    if (command.id === "characters") {
      link.href = "characters.html"
      link.setAttribute("aria-current", "page")
    } else if (command.id === "lab") {
      link.href = command.href
    } else {
      link.href = `${hubHref}${command.href.slice("dev.html".length)}`
    }
    link.textContent = command.label
    link.dataset.page = command.id
    nav.append(link)
  }

  const limbSelect = document.querySelector<HTMLSelectElement>('[data-control="limb"]')!
  for (const choice of LIMB_CHOICES) {
    limbSelect.add(new Option(choice.label, choice.value))
  }

  const stageEl = document.querySelector<HTMLElement>(".characters-stage")!
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const statusEl = document.querySelector<HTMLElement>("[data-status]")!
  const possessBtn = document.querySelector<HTMLButtonElement>('[data-action="possess"]')!
  const possessBanner = document.querySelector<HTMLElement>("[data-possess-banner]")!
  const possessText = document.querySelector<HTMLElement>("[data-possess-text]")!
  const labToggleBtn = document.querySelector<HTMLButtonElement>('[data-action="toggle-lab"]')!
  const actorTabsEl = document.querySelector<HTMLElement>(".actor-tabs")!
  const profileSelect = document.querySelector<HTMLSelectElement>('[data-control="actor-profile"]')!
  const walkBtn = document.querySelector<HTMLButtonElement>('[data-action="walk"]')!
  const runBtn = document.querySelector<HTMLButtonElement>('[data-action="run"]')!
  const stopBtn = document.querySelector<HTMLButtonElement>('[data-action="stop"]')!
  const detachBtn = document.querySelector<HTMLButtonElement>('[data-action="detach"]')!
  const resetBtn = document.querySelector<HTMLButtonElement>('[data-action="reset"]')!
  const pauseBtn = document.querySelector<HTMLButtonElement>('[data-action="pause"]')!
  const stepBtn = document.querySelector<HTMLButtonElement>('[data-action="step"]')!
  const speedInput = document.querySelector<HTMLInputElement>('[data-control="speed"]')!
  const speedOutput = document.querySelector<HTMLOutputElement>('[data-readout="speed"]')!
  const frameBtn = document.querySelector<HTMLButtonElement>('[data-action="frame"]')!
  const gameZoomBtn = document.querySelector<HTMLButtonElement>('[data-action="game-zoom"]')!
  const lineupBtn = document.querySelector<HTMLButtonElement>('[data-action="lineup"]')!

  const params = new URLSearchParams(location.search)
  const manual = params.has("manual")
  if (manual) {
    const rng = new Rng(7)
    Math.random = () => rng.next()
  }

  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) {
    statusEl.textContent = "WebGPU unavailable"
    throw new Error("WebGPU unavailable")
  }
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", e => {
    statusEl.textContent = e.error.message
    console.error(`[gpu] ${e.error.message}`)
  })
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })

  const renderer = new Renderer(device, context, format)
  const session = new EmptyStageSession()
  const sound = new Sound()
  const settings = juiceSettings(true)
  const game = new Game(renderer, session, sound, settings, STAGE_MAP)
  game.splatterStyle = 1

  const soldierParts = registerPartModels(renderer, personModels())
  const wizardParts = registerPartModels(renderer, wizardModels())
  const zombieParts = registerPartModels(renderer, zombieModels())
  const survivorParts = registerPartModels(renderer, outbreakPersonModels(false))
  const outbreakZombieParts = registerPartModels(renderer, outbreakPersonModels(true))
  const staffModel = renderer.addModel(wizardWeapon("rifle"))
  const ringModel = renderer.addModel(buildSelectionRing())

  const makeActor = (
    id: ActorId,
    label: string,
    gameTag: string,
    homeX: number,
    homeY: number,
    defaultPreset: HumanPreset,
    color: readonly [number, number, number],
    models: PartModels,
    wizardCast = false,
    unarmedSwing = false,
  ): StageActor => {
    const homeAim = Math.PI / 2
    const avatar = newAvatar(id, homeX, homeY, homeAim, "rifle")
    const profile: HumanProfile = { ...humanProfiles[defaultPreset] }
    avatar.profile = profile
    return {
      id,
      label,
      gameTag,
      homeX,
      homeY,
      homeAim,
      defaultPreset,
      preset: defaultPreset,
      profile,
      color,
      models,
      wizardCast,
      unarmedSwing,
      action: "walk",
      actionTime: 0,
      avatar,
      hiddenBones: new Set<BoneId>(),
      previousBones: undefined,
      pieces: [],
      noPop: false,
      detachCount: 0,
    }
  }

  const actors: StageActor[] = [
    makeActor("soldier", "Soldier", "Blackout", 8.8, 8.6, "soldier", [0.18, 0.78, 0.96], soldierParts, false, false),
    makeActor("wizard", "Wizard", "Blackout", 11.4, 8.6, "wizard", [0.46, 0.22, 0.68], wizardParts, true, false),
    makeActor("zombie", "Zombie", "Blackout", 14.0, 8.6, "zombie", [0.46, 0.78, 0.24], zombieParts, false, false),
    makeActor("survivor", "Survivor", "Outbreak", 16.6, 8.6, "soldier", [0.92, 0.68, 0.32], survivorParts, false, true),
    makeActor("outbreak-zombie", "Outbreak Zombie", "Outbreak", 19.2, 8.6, "zombie", [0.58, 0.76, 0.34], outbreakZombieParts, false, false),
  ]

  const resolveActor = (query: string | null | undefined): StageActor | undefined => {
    if (!query) return undefined
    const q = query.trim().toLowerCase().replace(/^(blackout|outbreak):/, "")
    return (
      actors.find(a => a.id === q) ??
      actors.find(a => a.label.toLowerCase() === q) ??
      actors.find(a => a.id.includes(q) || a.label.toLowerCase().includes(q))
    )
  }

  let selected: StageActor = resolveActor(parseActorHash(location.hash)) ?? actors[0]!
  let possessing = false
  let paused = false
  let simSpeed = 1
  let followSelected = true
  let tickCount = 0
  let clock = 0
  let detachEventId = 0x70000000

  const input = new Input(canvas)
  input.enabled = false
  let pointerMovedOnCanvas = false

  const cam = new Camera()
  const orbitState = {
    focusX: selected.homeX,
    focusY: 1.0,
    focusZ: selected.homeY,
    yaw: 0.32,
    pitch: 0.34,
    dist: 4.8,
    orbit(dyaw: number, dpitch: number) {
      this.yaw += dyaw
      this.pitch = clamp(this.pitch + dpitch, 0.08, 1.38)
    },
    panGrab(u0: number, v0: number, u1: number, v1: number) {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, rect.width || canvas.clientWidth || 1280)
      const h = Math.max(1, rect.height || canvas.clientHeight || 800)
      const { dx, dz } = computeGrabPanDelta(u0, v0, u1, v1, this.yaw, this.pitch, this.dist, w / h, 0.5)
      this.focusX += dx
      this.focusZ += dz
      followSelected = false
    },
    pan(dx: number, dz: number) {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, rect.width || canvas.clientWidth || 1280)
      const h = Math.max(1, rect.height || canvas.clientHeight || 800)
      this.panGrab(0.5, 0.5, 0.5 - dx / w, 0.5 - dz / h)
    },
    zoomBy(factor: number) {
      this.dist = clamp(this.dist * factor, 2.0, 28)
    },
  }

  cam.update = (aspect: number) => {
    const target: [number, number, number] = [orbitState.focusX, orbitState.focusY, orbitState.focusZ]
    const cp = Math.cos(orbitState.pitch), sp = Math.sin(orbitState.pitch)
    const cy = Math.cos(orbitState.yaw), sy = Math.sin(orbitState.yaw)
    const d = orbitState.dist
    cam.eye = [target[0] + sy * cp * d, target[1] + sp * d, target[2] + cy * cp * d]
    cam.x = target[0]
    cam.z = target[2]
    cam.dist = d
    const view = mat4.lookAt(cam.eye, target, [0, 1, 0])
    cam.viewProj = mat4.multiply(mat4.perspective(0.5, aspect, 0.3, 200), view)
    return cam.viewProj as Float32Array
  }

  function readCameraState() {
    cam.update(Math.max(0.1, canvas.width / Math.max(1, canvas.height)))
    return {
      orbit: round2((orbitState.yaw * 180) / Math.PI),
      elevation: round2((orbitState.pitch * 180) / Math.PI),
      distance: round2(orbitState.dist),
      dist: orbitState.dist,
      target: [round3(orbitState.focusX), round3(orbitState.focusY), round3(orbitState.focusZ)] as [number, number, number],
      focus: [orbitState.focusX, orbitState.focusY, orbitState.focusZ] as [number, number, number],
      yaw: round4(orbitState.yaw),
      pitch: round4(orbitState.pitch),
      eye: [round3(cam.eye[0]), round3(cam.eye[1]), round3(cam.eye[2])] as [number, number, number],
    }
  }

  function frameSelected(mode: "close" | "gameplay" | "lineup" = "close") {
    if (mode === "lineup") {
      followSelected = false
      orbitState.focusX = 14.0
      orbitState.focusY = 0.95
      orbitState.focusZ = 9.0
      orbitState.yaw = 0.0
      orbitState.pitch = 0.32
      orbitState.dist = 14.2
      return
    }
    followSelected = true
    orbitState.focusX = selected.avatar.x
    orbitState.focusZ = selected.avatar.y
    if (mode === "gameplay") {
      orbitState.focusY = 0.4
      orbitState.yaw = 0
      orbitState.pitch = 1.1
      orbitState.dist = 18
    } else {
      orbitState.focusY = 0.98
      orbitState.yaw = 0.35
      orbitState.pitch = 0.32
      orbitState.dist = 4.6
    }
  }

  if (params.has("lineup")) frameSelected("lineup")
  else frameSelected("close")

  const labSettingsProxy: Record<string, string | number | boolean> = {}
  const profileKeys = humanProfileControls.map(c => c.key as keyof HumanProfile)
  Object.defineProperty(labSettingsProxy, "profilePreset", {
    enumerable: true,
    configurable: true,
    get: () => selected.preset,
    set: (value: string) => {
      if (value === "soldier" || value === "wizard" || value === "zombie") {
        applyPresetToActor(selected, value)
        syncUI()
      }
    },
  })
  for (const key of profileKeys) {
    Object.defineProperty(labSettingsProxy, key, {
      enumerable: true,
      configurable: true,
      get: () => selected.profile[key],
      set: (value: number | string) => {
        ;(selected.profile as Record<string, unknown>)[key] = value
      },
    })
  }

  const labControls: LabControl[] = [
    {
      key: "profilePreset",
      label: "Profile",
      group: "Profile",
      options: [
        { label: "Soldier", value: "soldier" },
        { label: "Wizard", value: "wizard" },
        { label: "Zombie", value: "zombie" },
      ],
    },
    ...humanProfileControls.map(c => ({ ...c, group: "Profile" })),
  ]

  function syncLabDefaultsForActor(actor: StageActor) {
    const base = humanProfiles[actor.defaultPreset]
    labPanel.navigation.defaults.profilePreset = actor.defaultPreset
    for (const key of profileKeys) {
      labPanel.navigation.defaults[key] = base[key]
    }
  }

  let notifyDevControl = () => {}

  const labPanel = new LabPanel(
    labSettingsProxy,
    labControls,
    params,
    () => {
      if (possessing) setPossessing(false)
      else input.release()
    },
    {
      open: !params.has("nolab"),
      presets: false,
      capture: "focus",
      onToggle: visible => {
        labToggleBtn.setAttribute("aria-pressed", String(visible))
        notifyDevControl()
      },
    },
  )
  const innerPill = labPanel.host.shadowRoot?.querySelector<HTMLElement>(".pill")
  if (innerPill) innerPill.style.display = "none"
  labToggleBtn.setAttribute("aria-pressed", String(labPanel.visible))

  function applyPresetToActor(actor: StageActor, preset: HumanPreset) {
    actor.preset = preset
    Object.assign(actor.profile, humanProfiles[preset])
  }

  function syncUI() {
    for (const btn of actorTabsEl.querySelectorAll<HTMLButtonElement>("[data-actor-id]")) {
      btn.setAttribute("aria-selected", String(btn.dataset.actorId === selected.id))
    }
    profileSelect.value = selected.preset
    walkBtn.setAttribute("aria-pressed", String(!possessing && selected.action === "walk"))
    runBtn.setAttribute("aria-pressed", String(!possessing && selected.action === "run"))
    stopBtn.setAttribute("aria-pressed", String(!possessing && selected.action === "idle"))
    possessBtn.setAttribute("aria-pressed", String(possessing))
    possessBtn.innerHTML = possessing ? `Exit Possess <kbd>Esc</kbd>` : `Possess <kbd>P</kbd>`
    stageEl.dataset.possessing = String(possessing)
    possessBanner.hidden = !possessing
    possessText.textContent = `Possessing ${selected.label}`
    pauseBtn.setAttribute("aria-pressed", String(paused))
    pauseBtn.textContent = paused ? "Resume" : "Pause"
    speedInput.value = String(simSpeed)
    speedOutput.value = `${simSpeed.toFixed(2)}×`
    syncLabDefaultsForActor(selected)
    labPanel.refresh()
    notifyDevControl()
  }

  function selectActor(id: ActorId, frame = false, updateHash = true) {
    const next = resolveActor(id)
    if (!next) return
    if (selected !== next) {
      selected.avatar.body = null
      selected.actionTime = 0
      animate(selected.avatar, 1 / 60, selected.avatar.t + 1 / 60, selected.homeX, selected.homeY, 0, 0, selected.homeAim, selected.wizardCast)
    }
    selected = next
    if (frame) {
      followSelected = true
      orbitState.focusX = selected.avatar.x
      orbitState.focusZ = selected.avatar.y
    }
    if (updateHash && parseActorHash(location.hash) !== selected.id) {
      window.history.replaceState(null, "", `#${selected.id}`)
    }
    syncUI()
  }

  function setPossessing(next: boolean) {
    if (possessing === next) return
    possessing = next
    input.release()
    input.enabled = possessing
    pointerMovedOnCanvas = false
    if (possessing) {
      paused = false
      followSelected = true
      canvas.focus({ preventScroll: true })
    } else {
      selected.avatar.vx = 0
      selected.avatar.vy = 0
      selected.action = "idle"
    }
    syncUI()
  }

  function setAction(action: ActorAction) {
    if (possessing) setPossessing(false)
    selected.action = action
    syncUI()
  }

  function detachLimb(bone: BoneId = limbSelect.value as BoneId): DetachedPiece[] {
    if (!selected.avatar.body) return []
    if (limbSelect.value !== bone && LIMB_CHOICES.some(c => c.value === bone)) {
      limbSelect.value = bone
    }
    if (!boneVisible(bone, selected.hiddenBones)) {
      clearSubtree(selected.hiddenBones, bone)
    }
    const bones = bodyBones(selected.avatar.body)
    const rawPieces = detach(bones, selected.previousBones, 1 / 60, bone, selected.hiddenBones)
    if (!rawPieces.length) return []
    const rootPiece = rawPieces[0]!
    selected.noPop = JSON.stringify(rootPiece.frame) === JSON.stringify(bones[rootPiece.bone])
    selected.detachCount += rawPieces.length
    const spawned: DetachedPiece[] = rawPieces.map(p => ({ ...p, spawnTick: tickCount }))
    selected.pieces.push(...spawned)
    const aim = selected.avatar.aim
    const dir: V3 = [Math.cos(aim + 0.45), 0.32, Math.sin(aim + 0.45)]
    detachedSplatter(
      event => game.cosmeticSplatter(event),
      rootPiece,
      { id: detachEventId++, seed: SEED + detachEventId, direction: dir, amount: 1.35 },
    )
    statusEl.textContent = `Detached ${bone} from ${selected.label}`
    notifyDevControl()
    return spawned
  }

  function resetActor(actor: StageActor = selected) {
    if (possessing && actor === selected) setPossessing(false)
    actor.preset = actor.defaultPreset
    actor.profile = { ...humanProfiles[actor.defaultPreset] }
    actor.avatar = newAvatar(actor.id, actor.homeX, actor.homeY, actor.homeAim, "rifle")
    actor.avatar.profile = actor.profile
    actor.hiddenBones.clear()
    actor.previousBones = undefined
    actor.pieces = []
    actor.action = "walk"
    actor.actionTime = 0
    actor.noPop = false
    actor.detachCount = 0
    animate(actor.avatar, 1 / 60, 0, actor.homeX, actor.homeY, 0, 0, actor.homeAim, actor.wizardCast)
    actor.previousBones = bodyBones(actor.avatar.body!)
    if (actor === selected) {
      followSelected = true
      orbitState.focusX = actor.homeX
      orbitState.focusZ = actor.homeY
    }
    statusEl.textContent = `Reset ${actor.label}`
    syncUI()
  }

  // Register all Characters page actions in the shared-contract LabCommandRegistry
  const commands = new LabCommandRegistry()
  const actorIds = actors.map(a => a.id)
  const limbValues = LIMB_CHOICES.map(c => c.value)

  commands.registerAll([
    {
      id: "select",
      aliases: ["character.select", "object.select"],
      label: "Select Character",
      shortLabel: "Select",
      category: "Object",
      args: {
        target: { type: "string", description: "Character ID or name (soldier, wizard, zombie, survivor, outbreak-zombie)" },
        id: { type: "string", description: "Character ID alias" },
        frame: { type: "boolean", description: "Center camera on selected character" },
      },
      enabled: () => true,
      run: ctx => {
        const query = String(ctx?.args?.target ?? ctx?.args?.id ?? "").trim()
        const target = resolveActor(query)
        if (!target) throw new Error(`Unknown character "${query}". Available: ${actorIds.join(", ")}.`)
        const shouldFrame = ctx?.args?.frame !== false
        selectActor(target.id, shouldFrame)
        statusEl.textContent = `Selected ${target.label}`
        return {
          selected: {
            id: selected.id,
            label: selected.label,
            preset: selected.preset,
            action: selected.action,
          },
        }
      },
    },
    {
      id: "possess",
      aliases: ["object.possess", "mode.play", "character.possess"],
      label: "Possess Character",
      shortLabel: "Possess",
      category: "Mode",
      shortcut: "P",
      args: {
        target: { type: "string", description: "Optional character ID or name to select before possessing" },
      },
      enabled: () => true,
      run: ctx => {
        const query = typeof ctx?.args?.target === "string" ? ctx.args.target.trim() : ""
        if (query) {
          const target = resolveActor(query)
          if (!target) throw new Error(`Unknown character "${query}". Available: ${actorIds.join(", ")}.`)
          selectActor(target.id, true)
        }
        setPossessing(true)
        return {
          mode: "play",
          possessing: true,
          characterId: selected.id,
          characterLabel: selected.label,
        }
      },
    },
    {
      id: "release",
      aliases: ["mode.edit", "character.release"],
      label: "Release Character to Edit Mode",
      shortLabel: "Release",
      category: "Mode",
      shortcut: "Esc",
      enabled: () => true,
      run: () => {
        setPossessing(false)
        return {
          mode: "edit",
          possessing: false,
          characterId: selected.id,
          characterLabel: selected.label,
        }
      },
    },
    {
      id: "profile.set",
      aliases: ["character.profile", "profile"],
      label: "Set Character Rig Profile",
      shortLabel: "Profile",
      category: "Inspector",
      args: {
        profile: { type: "string", required: true, enum: ["soldier", "wizard", "zombie"], description: "Rig preset" },
        target: { type: "string", description: "Optional character ID" },
      },
      enabled: () => true,
      run: ctx => {
        const preset = String(ctx?.args?.profile ?? "").toLowerCase() as HumanPreset
        const actor = ctx?.args?.target ? resolveActor(String(ctx.args.target)) : selected
        if (!actor) throw new Error(`Unknown character "${String(ctx?.args?.target)}".`)
        applyPresetToActor(actor, preset)
        syncUI()
        return {
          actorId: actor.id,
          profile: actor.preset,
          settings: { ...actor.profile },
        }
      },
    },
    {
      id: "action.walk",
      aliases: ["walk", "character.walk"],
      label: "Start Walk Loop",
      shortLabel: "Walk loop",
      category: "Object",
      enabled: () => true,
      run: () => {
        setAction("walk")
        return { actorId: selected.id, action: selected.action }
      },
    },
    {
      id: "action.run",
      aliases: ["run", "character.run"],
      label: "Start Run Loop",
      shortLabel: "Run loop",
      category: "Object",
      enabled: () => true,
      run: () => {
        setAction("run")
        return { actorId: selected.id, action: selected.action }
      },
    },
    {
      id: "action.stop",
      aliases: ["stop", "character.stop", "action.idle"],
      label: "Stop Locomotion Loop",
      shortLabel: "Stop",
      category: "Object",
      enabled: () => true,
      run: () => {
        setAction("idle")
        return { actorId: selected.id, action: selected.action }
      },
    },
    {
      id: "action.set",
      aliases: ["character.action"],
      label: "Set Character Locomotion Action",
      shortLabel: "Action",
      category: "Object",
      args: {
        action: { type: "string", required: true, enum: ["walk", "run", "stop", "idle"], description: "Loop action" },
      },
      enabled: () => true,
      run: ctx => {
        const raw = String(ctx?.args?.action ?? "walk").toLowerCase()
        setAction(raw === "stop" || raw === "idle" ? "idle" : raw === "run" ? "run" : "walk")
        return { actorId: selected.id, action: selected.action }
      },
    },
    {
      id: "limb.detach",
      aliases: ["detach", "character.detach"],
      label: "Detach Character Limb",
      shortLabel: "Detach limb",
      category: "Object",
      args: {
        limb: { type: "string", enum: limbValues, description: "Semantic BoneId to detach" },
      },
      enabled: () => true,
      run: ctx => {
        const bone = (typeof ctx?.args?.limb === "string" ? ctx.args.limb : limbSelect.value) as BoneId
        const spawned = detachLimb(bone)
        return {
          actorId: selected.id,
          limb: bone,
          detached: spawned.map(p => p.bone),
          pieces: selected.pieces.length,
          noPop: selected.noPop,
          splatterActive: !!game.splatterFx?.particles.some((v: number) => v !== 0) || (game.splatterFx?.inspect().decals ?? 0) > 0,
        }
      },
    },
    {
      id: "character.reset",
      aliases: ["reset", "object.reset", "transport.retrigger"],
      label: "Reset Character State",
      shortLabel: "Reset",
      category: "Object",
      args: {
        target: { type: "string", description: "Character ID or 'all'" },
      },
      enabled: () => true,
      run: ctx => {
        const t = typeof ctx?.args?.target === "string" ? ctx.args.target.trim().toLowerCase() : ""
        if (t === "all") {
          for (const actor of actors) resetActor(actor)
          return { reset: actors.map(a => a.id), frames: tickCount, elapsed: round2(clock / 1000) }
        }
        const actor = t ? resolveActor(t) : selected
        if (!actor) throw new Error(`Unknown character "${t}".`)
        resetActor(actor)
        return { reset: [actor.id], frames: tickCount, elapsed: round2(clock / 1000) }
      },
    },
    {
      id: "transport.play",
      label: "Resume Simulation",
      shortLabel: "Play",
      category: "Transport",
      enabled: () => true,
      run: () => {
        paused = false
        syncUI()
        return { playing: true, frames: tickCount, elapsed: round2(clock / 1000), speed: simSpeed }
      },
    },
    {
      id: "transport.pause",
      label: "Pause Simulation",
      shortLabel: "Pause",
      category: "Transport",
      enabled: () => true,
      run: () => {
        paused = true
        syncUI()
        return { playing: false, frames: tickCount, elapsed: round2(clock / 1000), speed: simSpeed }
      },
    },
    {
      id: "transport.toggle",
      label: "Toggle Pause / Resume",
      shortLabel: "Pause",
      category: "Transport",
      shortcut: "Space",
      enabled: () => true,
      run: () => {
        paused = !paused
        syncUI()
        return { playing: !paused, frames: tickCount, elapsed: round2(clock / 1000), speed: simSpeed }
      },
    },
    {
      id: "transport.step",
      label: "Step Forward 1/60s",
      shortLabel: "Step",
      category: "Transport",
      args: {
        frames: { type: "number", min: 1, max: 120, description: "Number of 1/60s frames to advance" },
      },
      enabled: () => true,
      run: ctx => {
        const count = typeof ctx?.args?.frames === "number" ? Math.max(1, Math.min(120, Math.round(ctx.args.frames))) : 1
        paused = true
        for (let i = 0; i < count; i++) {
          stepSimulation(1 / 60)
          renderScene(1 / 60)
        }
        syncUI()
        return { stepped: count, frames: tickCount, elapsed: round2(clock / 1000) }
      },
    },
    {
      id: "transport.speed",
      label: "Set Simulation Speed",
      shortLabel: "Speed",
      category: "Transport",
      args: {
        speed: { type: "number", required: true, min: 0.1, max: 2, description: "Speed multiplier (0.1..2.0)" },
      },
      enabled: () => true,
      run: ctx => {
        simSpeed = clamp(Number(ctx?.args?.speed ?? 1), 0.1, 2)
        syncUI()
        return { speed: simSpeed }
      },
    },
    {
      id: "camera.get",
      aliases: ["camera"],
      label: "Get Camera State",
      shortLabel: "Camera Get",
      category: "Camera",
      readOnly: true,
      enabled: () => true,
      run: () => readCameraState(),
    },
    {
      id: "camera.set",
      aliases: ["camera.frame"],
      label: "Set Camera Orientation, Target or Framing",
      shortLabel: "Camera Set",
      category: "Camera",
      shortcut: "F",
      args: {
        orbit: { type: "number", min: -3600, max: 3600, description: "Orbit yaw in degrees" },
        elevation: { type: "number", min: 5, max: 85, description: "Elevation pitch in degrees" },
        distance: { type: "number", min: 2, max: 28, description: "Camera distance in metres" },
        target: { type: "number[]", description: "Target coordinates [x, y, z] or [x, z]" },
        frame: { type: "string", description: "Frame mode ('close', 'gameplay', 'lineup') or character ID" },
      },
      enabled: () => true,
      run: ctx => {
        const a = ctx?.args ?? {}
        if (typeof a.frame === "string" && a.frame.trim()) {
          const f = a.frame.trim().toLowerCase()
          if (f === "lineup" || f === "scene" || f === "all") frameSelected("lineup")
          else if (f === "gameplay" || f === "game") frameSelected("gameplay")
          else if (f === "close" || f === "selected" || f === "default") frameSelected("close")
          else {
            const targetActor = resolveActor(f)
            if (!targetActor) throw new Error(`Unknown camera frame target "${a.frame}".`)
            selectActor(targetActor.id, true)
            frameSelected("close")
          }
        }
        if (Array.isArray(a.target)) {
          const arr = a.target as number[]
          if (arr.length === 2) {
            orbitState.focusX = Number(arr[0])
            orbitState.focusZ = Number(arr[1])
            followSelected = false
          } else if (arr.length === 3) {
            orbitState.focusX = Number(arr[0])
            orbitState.focusY = Number(arr[1])
            orbitState.focusZ = Number(arr[2])
            followSelected = false
          }
        }
        if (typeof a.orbit === "number") orbitState.yaw = (a.orbit * Math.PI) / 180
        if (typeof a.elevation === "number") orbitState.pitch = clamp((a.elevation * Math.PI) / 180, 0.08, 1.38)
        if (typeof a.distance === "number") orbitState.dist = clamp(a.distance, 2.0, 28)
        renderScene(0)
        notifyDevControl()
        return readCameraState()
      },
    },
    {
      id: "lab.get",
      label: "Get Selected Actor Lab Parameter(s)",
      shortLabel: "Lab Get",
      category: "Inspector",
      readOnly: true,
      args: {
        path: { type: "string", description: "Control key or label (omit for all)" },
      },
      enabled: () => true,
      run: ctx => {
        const rawPath = typeof ctx?.args?.path === "string" ? ctx.args.path.trim() : ""
        if (!rawPath || rawPath === "all" || rawPath === "*") {
          const settingsMap: Record<string, LabValue> = { profilePreset: selected.preset, ...selected.profile }
          const controlsList = labControls.map(c => {
            const val = labPanel.navigation.settings[c.key]!
            return {
              key: c.key,
              label: c.label,
              group: c.group ?? "Profile",
              value: val,
              formatted: "min" in c ? formatLabValue(val, c.step, inferControlUnit(c.key, c.label, c.unit)) : String(val),
            }
          })
          return { actorId: selected.id, settings: settingsMap, controls: controlsList }
        }
        const keyLower = rawPath.toLowerCase().replace(/^profile\./, "")
        const ctrl = labControls.find(c => c.key.toLowerCase() === keyLower || c.label.toLowerCase() === keyLower)
        if (!ctrl) throw new Error(`Unknown Lab control "${rawPath}".`)
        const val = labPanel.navigation.settings[ctrl.key]!
        return {
          actorId: selected.id,
          key: ctrl.key,
          label: ctrl.label,
          group: ctrl.group ?? "Profile",
          value: val,
          formatted: "min" in ctrl ? formatLabValue(val, ctrl.step, inferControlUnit(ctrl.key, ctrl.label, ctrl.unit)) : String(val),
        }
      },
    },
    {
      id: "lab.set",
      aliases: ["scene.set-param"],
      label: "Set Selected Actor Lab Parameter",
      shortLabel: "Lab Set",
      category: "Inspector",
      args: {
        path: { type: "string", description: "Control key or label" },
        key: { type: "string", description: "Control key alias" },
        value: { type: "value", required: true, description: "New parameter value" },
      },
      enabled: () => true,
      run: ctx => {
        const rawPath = String(ctx?.args?.path ?? ctx?.args?.key ?? "").trim()
        const rawVal = ctx?.args?.value
        const keyLower = rawPath.toLowerCase().replace(/^profile\./, "")
        const ctrl = labControls.find(c => c.key.toLowerCase() === keyLower || c.label.toLowerCase() === keyLower)
        if (!ctrl) throw new Error(`Unknown Lab control "${rawPath}".`)
        const before = labPanel.navigation.settings[ctrl.key]
        const nextVal = "min" in ctrl ? Number(rawVal) : String(rawVal)
        labPanel.navigation.set(ctrl, nextVal)
        syncUI()
        const after = labPanel.navigation.settings[ctrl.key]!
        return {
          actorId: selected.id,
          key: ctrl.key,
          label: ctrl.label,
          group: ctrl.group ?? "Profile",
          before,
          value: after,
          formatted: "min" in ctrl ? formatLabValue(after, ctrl.step, inferControlUnit(ctrl.key, ctrl.label, ctrl.unit)) : String(after),
        }
      },
    },
    {
      id: "lab.toggle",
      label: "Toggle Lab Inspector Panel",
      shortLabel: "Lab",
      category: "Inspector",
      shortcut: "`",
      enabled: () => true,
      run: () => {
        labPanel.toggle()
        return { visible: labPanel.visible }
      },
    },
  ])

  function renderActorTabs() {
    actorTabsEl.replaceChildren()
    for (const actor of actors) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "actor-tab"
      btn.setAttribute("role", "tab")
      btn.dataset.actorId = actor.id
      btn.setAttribute("aria-selected", String(actor.id === selected.id))
      const name = document.createElement("span")
      name.textContent = actor.label
      const tag = document.createElement("small")
      tag.textContent = actor.gameTag
      btn.append(name, tag)
      btn.addEventListener("click", () => {
        void commands.invoke("select", { target: actor.id, frame: true }, { source: "ui" })
      })
      actorTabsEl.append(btn)
    }
  }

  for (const actor of actors) {
    animate(actor.avatar, 1 / 60, 0, actor.homeX, actor.homeY, 0, 0, actor.homeAim, actor.wizardCast)
    actor.previousBones = bodyBones(actor.avatar.body!)
  }
  renderActorTabs()
  syncUI()

  canvas.addEventListener("pointermove", () => {
    if (possessing) pointerMovedOnCanvas = true
  })

  function pickActorAtClient(clientX: number, clientY: number): StageActor | null {
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    let best: StageActor | null = null
    let bestDist = Math.max(42, 300 / Math.max(2, orbitState.dist))
    for (const actor of actors) {
      for (const h of [0.25, 0.7, 1.15, 1.55]) {
        const proj = cam.project(actor.avatar.x, h, actor.avatar.y, rect.width, rect.height)
        if (!proj.ok) continue
        const d = Math.hypot(proj.x - px, proj.y - py)
        if (d < bestDist) {
          bestDist = d
          best = actor
        }
      }
    }
    return best
  }

  const charMenu = document.createElement("div")
  charMenu.className = "context-menu"
  charMenu.popover = "auto"
  charMenu.setAttribute("role", "menu")
  charMenu.setAttribute("aria-label", "Character actions")
  charMenu.innerHTML = `
    <button type="button" role="menuitem" data-char-menu="frame">Frame<kbd>F</kbd></button>
    <button type="button" role="menuitem" data-char-menu="possess">Possess / Release<kbd>P</kbd></button>
    <button type="button" role="menuitem" data-char-menu="walk">Walk loop</button>
    <button type="button" role="menuitem" data-char-menu="run">Run loop</button>
    <button type="button" role="menuitem" data-char-menu="stop">Stop</button>
    <button type="button" role="menuitem" data-char-menu="detach">Detach limb</button>
    <button type="button" role="menuitem" data-char-menu="reset">Reset<kbd>0</kbd></button>
  `
  document.body.append(charMenu)

  function openCharMenu(x: number, y: number) {
    const hit = pickActorAtClient(x, y)
    if (hit && hit.id !== selected.id) {
      void commands.invoke("select", { target: hit.id, frame: false }, { source: "ui" })
    }
    charMenu.style.left = `${Math.min(x, innerWidth - 200)}px`
    charMenu.style.top = `${Math.min(y, innerHeight - 240)}px`
    charMenu.showPopover()
    charMenu.querySelector<HTMLElement>("button")?.focus()
  }

  charMenu.addEventListener("click", event => {
    const btn = (event.target as Element).closest<HTMLElement>("[data-char-menu]")
    if (!btn) return
    const action = btn.dataset.charMenu
    charMenu.hidePopover()
    if (action === "frame") void commands.invoke("camera.set", { frame: "close" }, { source: "ui" })
    else if (action === "possess") void commands.invoke(possessing ? "release" : "possess", {}, { source: "ui" })
    else if (action === "walk") void commands.invoke("action.walk", {}, { source: "ui" })
    else if (action === "run") void commands.invoke("action.run", {}, { source: "ui" })
    else if (action === "stop") void commands.invoke("action.stop", {}, { source: "ui" })
    else if (action === "detach") void commands.invoke("limb.detach", { limb: limbSelect.value }, { source: "ui" })
    else if (action === "reset") void commands.invoke("character.reset", {}, { source: "ui" })
    canvas.focus({ preventScroll: true })
  })

  const gestures = bindOrbitGestures(canvas, {
    target: orbitState,
    canPrimaryOrbit: () => !possessing,
    onChange: () => notifyDevControl(),
    onContextClick: (x, y) => {
      if (!possessing) openCharMenu(x, y)
    },
    onPrimaryClick: event => {
      if (possessing) {
        swing(selected.avatar, selected.avatar.t)
        return
      }
      const best = pickActorAtClient(event.clientX, event.clientY)
      if (best) {
        void commands.invoke("select", { target: best.id, frame: false }, { source: "ui" })
      }
    },
  })

  // Wire all UI controls through the command registry
  labToggleBtn.addEventListener("click", () => {
    void commands.invoke("lab.toggle", {}, { source: "ui" })
  })
  possessBtn.addEventListener("click", () => {
    void commands.invoke(possessing ? "release" : "possess", {}, { source: "ui" })
  })
  profileSelect.addEventListener("change", () => {
    void commands.invoke("profile.set", { profile: profileSelect.value }, { source: "ui" })
  })
  walkBtn.addEventListener("click", () => {
    void commands.invoke("action.walk", {}, { source: "ui" })
  })
  runBtn.addEventListener("click", () => {
    void commands.invoke("action.run", {}, { source: "ui" })
  })
  stopBtn.addEventListener("click", () => {
    void commands.invoke("action.stop", {}, { source: "ui" })
  })
  detachBtn.addEventListener("click", () => {
    void commands.invoke("limb.detach", { limb: limbSelect.value }, { source: "ui" })
  })
  resetBtn.addEventListener("click", () => {
    void commands.invoke("character.reset", {}, { source: "ui" })
  })
  pauseBtn.addEventListener("click", () => {
    void commands.invoke("transport.toggle", {}, { source: "ui" })
  })
  stepBtn.addEventListener("click", () => {
    void commands.invoke("transport.step", { frames: 1 }, { source: "ui" })
  })
  speedInput.addEventListener("input", () => {
    void commands.invoke("transport.speed", { speed: Number(speedInput.value) || 1 }, { source: "ui" })
  })
  frameBtn.addEventListener("click", () => {
    void commands.invoke("camera.set", { frame: "close" }, { source: "ui" })
  })
  gameZoomBtn.addEventListener("click", () => {
    void commands.invoke("camera.set", { frame: "gameplay" }, { source: "ui" })
  })
  lineupBtn.addEventListener("click", () => {
    void commands.invoke("camera.set", { frame: "lineup" }, { source: "ui" })
  })

  for (const bar of document.querySelectorAll<HTMLElement>(".hub-bar, .char-dock, .actor-tabs")) {
    bar.addEventListener("focusin", e => {
      if (possessing && e.target !== possessBtn) {
        void commands.invoke("release", {}, { source: "ui" })
      }
    })
  }

  window.addEventListener("keydown", event => {
    const typing = isEditableEventTarget(event.composedPath()[0])
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "Escape") {
      if (possessing) {
        event.preventDefault()
        void commands.invoke("release", {}, { source: "ui" })
        return
      }
      if (gestures.hasActivePointer()) {
        event.preventDefault()
        gestures.cancelDrag()
        return
      }
    }
    if (typing) return
    if (labPanel.visible && document.activeElement === labPanel.host) return
    if (!possessing && document.activeElement === canvas && applyArrowCameraKey(orbitState, event)) {
      event.preventDefault()
      notifyDevControl()
      return
    }
    const key = event.key.toLowerCase()
    if ((key === "m" || event.key === "ContextMenu") && !possessing) {
      event.preventDefault()
      const box = canvas.getBoundingClientRect()
      openCharMenu(box.left + box.width / 2, box.top + box.height / 2)
    } else if (key === "p" && !possessing) {
      event.preventDefault()
      void commands.invoke("possess", {}, { source: "ui" })
    } else if (key === "f" && !possessing) {
      event.preventDefault()
      void commands.invoke("camera.set", { frame: "close" }, { source: "ui" })
    } else if (event.code === "Space" && !possessing) {
      event.preventDefault()
      void commands.invoke("transport.toggle", {}, { source: "ui" })
    }
  })

  window.addEventListener("hashchange", () => {
    const id = parseActorHash(location.hash)
    if (id && id !== selected.id) {
      void commands.invoke("select", { target: id, frame: true }, { source: "ui" })
    }
  })

  function stepDetachedPiece(piece: DetachedPiece, dt: number, aim: number) {
    if (tickCount === piece.spawnTick + 1 && Math.hypot(piece.linear[0], piece.linear[2]) < 1.5) {
      const side = piece.bone.startsWith("left.") ? -1 : 1
      piece.linear = [
        piece.linear[0] + Math.cos(aim + side * 0.9) * 1.1,
        Math.max(piece.linear[1], 0) + 1.5,
        piece.linear[2] + Math.sin(aim + side * 0.9) * 1.1,
      ]
      piece.angular = [piece.angular[0] + 3.2 * side, piece.angular[1] + 2.0, piece.angular[2] - 3.6 * side]
    }
    piece.linear[1] -= 9.81 * dt
    const p: V3 = [
      piece.frame.p[0] + piece.linear[0] * dt,
      piece.frame.p[1] + piece.linear[1] * dt,
      piece.frame.p[2] + piece.linear[2] * dt,
    ]
    const angSpeed = len(piece.angular)
    piece.frame = moved(angSpeed > 0 ? turn(piece.frame, scale(piece.angular, 1 / angSpeed), angSpeed * dt) : piece.frame, p)
    const endOffset = piece.bone === "head" ? 0.25 : piece.bone === "torso" ? 0.42 : piece.bone.endsWith(".foot") ? -0.07 : -0.28
    const low = Math.min(piece.frame.p[1], at(piece.frame, 0, endOffset, 0)[1]) - 0.055
    if (low < 0) {
      piece.frame.p[1] -= low
      piece.linear = [piece.linear[0] * 0.72, Math.abs(piece.linear[1]) * 0.18, piece.linear[2] * 0.72]
      piece.angular = scale(piece.angular, 0.7)
    }
  }

  function stepActor(actor: StageActor, dt: number) {
    for (const piece of actor.pieces) {
      if (tickCount > piece.spawnTick) stepDetachedPiece(piece, dt, actor.avatar.aim)
    }

    const a = actor.avatar
    let nextX = a.x
    let nextY = a.y
    let vx = 0
    let vy = 0
    let aim = a.aim

    if (possessing && actor === selected) {
      const { mx, my } = input.move()
      const moveSpeed = input.sprinting ? SPRINT_SPEED : SPEED * 0.78
      const cy = Math.cos(orbitState.yaw), sy = Math.sin(orbitState.yaw)
      const worldMx = mx * cy + my * sy
      const worldMy = -mx * sy + my * cy
      const body = { x: a.x, y: a.y, vx: a.vx, vy: a.vy }
      stepBody(body, worldMx, worldMy, moveSpeed * simSpeed, game.solids, dt)
      nextX = body.x
      nextY = body.y
      vx = body.vx
      vy = body.vy
      if (pointerMovedOnCanvas) {
        const floorPt = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight, 0.9)
        if (Number.isFinite(floorPt.x) && Number.isFinite(floorPt.y)) {
          aim = Math.atan2(floorPt.y - nextY, floorPt.x - nextX)
        }
      } else if (Math.hypot(vx, vy) > 0.15) {
        aim = Math.atan2(vy, vx)
      }
      if (input.takeMelee()) swing(a, a.t)
    } else if (actor.action === "walk" || actor.action === "run") {
      actor.actionTime += dt * simSpeed
      const baseSpeed = actor.action === "run" ? SPEED : actor.preset === "zombie" ? 1.15 : 1.45
      const speed = baseSpeed * simSpeed
      if (actor === selected) {
        const distFromHome = Math.hypot(a.x - actor.homeX, a.y - actor.homeY)
        const wrapped = distFromHome >= 5.8
        if (wrapped) {
          actor.actionTime = 0
          a.body = null
          actor.previousBones = undefined
        }
        const dir = 0.72
        vx = Math.cos(dir) * speed
        vy = Math.sin(dir) * speed
        nextX = (wrapped ? actor.homeX : a.x) + vx * dt
        nextY = (wrapped ? actor.homeY : a.y) + vy * dt
        aim = dir + Math.sin(actor.actionTime * 1.8) * 0.14
        if (wrapped && followSelected) {
          orbitState.focusX = nextX
          orbitState.focusZ = nextY
        }
      } else {
        vx = 0
        vy = 0
        nextX = actor.homeX
        nextY = actor.homeY
        aim = actor.homeAim
      }
    } else {
      vx = 0
      vy = 0
      aim = a.aim
    }

    a.profile = actor.profile
    a.unarmed = actor.unarmedSwing && actor.profile.handPose === "weapon"
    animate(a, dt, a.t + dt, nextX, nextY, vx, vy, aim, actor.wizardCast)

    if (actor.unarmedSwing && actor.profile.handPose === "weapon" && a.body) {
      const torso = a.body.torso
      const [hL, hR] = unarmedHands(a, torso, a.t * 2)
      const arms = poseUnarmedArms(torso, hL, hR)
      a.body.ua = arms.ua
      a.body.fa = arms.fa
      a.body.gun = null
      a.body.mag = null
      a.body.pump = null
    }
  }

  function stepSimulation(dt: number) {
    tickCount++
    clock += dt * 1000
    session.update(dt)
    for (const actor of actors) {
      if (actor.avatar.body) actor.previousBones = bodyBones(actor.avatar.body)
      stepActor(actor, dt)
    }
    if (followSelected) {
      const k = 1 - Math.exp(-dt * 12)
      orbitState.focusX += (selected.avatar.x - orbitState.focusX) * k
      orbitState.focusZ += (selected.avatar.y - orbitState.focusZ) * k
    }
  }

  function renderScene(dt: number) {
    game.update(dt, input, cam, innerWidth, innerHeight, clock)
    const f = game.build(cam, innerWidth, innerHeight, dt)
    f.grade[1] = 0

    const batches: Batch[] = []
    const push: PushPart = (model, x, y, z, yaw, tint, pitchA, rollA, flash, alpha = 1) => {
      batches.push({ model, data: new Float32Array([x, y, z, yaw, ...tint, 1, pitchA, rollA, alpha, flash]), count: 1 })
    }

    const selFrame = yawFrame([selected.avatar.x, 0, selected.avatar.y], selected.avatar.aim)
    emit(push, ringModel, selFrame, selected.color, 0, 0.95)

    for (const actor of actors) {
      const body = actor.avatar.body
      if (!body) continue
      emitBody(push, body, actor.avatar.gun, actor.color, actor.models, actor.avatar.flash, 1, actor.hiddenBones)
      const bones = bodyBones(body)
      const rightHand = attachment(bones, "right.hand", actor.hiddenBones)
      if (rightHand && actor.profile.handPose === "staff") {
        const torsoYaw = Math.atan2(body.torso.x[2], body.torso.x[0])
        const staffFrame: Frame = pitch(roll(yawFrame(rightHand.p, torsoYaw), 0.08), -0.14)
        emit(push, staffModel, staffFrame, actor.color, 0)
      }
      for (const piece of actor.pieces) {
        emit(push, modelForBone(actor.models, piece.bone), piece.frame, actor.color, 0)
      }
    }

    f.batches.push(...batches)
    renderer.render(f)
  }

  const resize = () => {
    const rect = stageEl.getBoundingClientRect()
    canvas.width = Math.max(1, Math.floor(rect.width * Math.min(devicePixelRatio, 1.5)))
    canvas.height = Math.max(1, Math.floor(rect.height * Math.min(devicePixelRatio, 1.5)))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  window.addEventListener("resize", resize)

  function buildPageState() {
    return {
      mode: possessing ? ("play" as const) : ("edit" as const),
      selected: selected.id,
      possessing,
      paused,
      speed: simSpeed,
      camera: readCameraState(),
      actors: actors.map(a => ({
        id: a.id,
        label: a.label,
        gameTag: a.gameTag,
        preset: a.preset,
        action: a.action,
        x: round3(a.avatar.x),
        y: round3(a.avatar.y),
        aim: round3(a.avatar.aim),
        hiddenBones: [...a.hiddenBones],
        pieces: a.pieces.length,
        noPop: a.noPop,
      })),
      settings: { profilePreset: selected.preset, ...selected.profile },
      splatter: game.splatterFx?.inspect() ?? { particles: 0, decals: 0, walls: 0, time: 0 },
      commands: commands.describe(),
    }
  }

  // Connect to the shared DevControl runtime if loaded on this page
  const devControlAdapter = {
    kind: "characters" as const,
    commands,
    getCanvas: () => canvas,
    getMode: () => (possessing ? ("play" as const) : ("edit" as const)),
    getSection: () => selected.id,
    getState: () => buildPageState(),
    resolveTargetRect: (target: { objectId?: string; world?: [number, number, number] }) => {
      const cRect = canvas.getBoundingClientRect()
      if (cRect.width <= 0 || cRect.height <= 0) return null
      if (target.world) {
        const [wx, wy, wz] = target.world
        const proj = cam.project(wx, wy, wz, cRect.width, cRect.height)
        if (proj.ok) {
          return { x: cRect.left + proj.x - 40, y: cRect.top + proj.y - 40, width: 80, height: 80, shape: "pill" as const }
        }
      }
      if (target.objectId) {
        const actor = resolveActor(target.objectId) ?? (target.objectId === "character" || target.objectId === "active" ? selected : null)
        if (actor) {
          const proj = cam.project(actor.avatar.x, 0.9, actor.avatar.y, cRect.width, cRect.height)
          if (proj.ok) {
            return { x: cRect.left + proj.x - 44, y: cRect.top + proj.y - 54, width: 88, height: 108, shape: "pill" as const, label: actor.label }
          }
        }
      }
      return null
    },
  }
  const devControl = registerDevControl(devControlAdapter)
  notifyDevControl = devControl.notifyUpdate

  const w = window as unknown as {
    ready: boolean
    advance(ms: number): Promise<void>
    charactersProof: Record<string, unknown>
    charactersControl: typeof devControlAdapter
  }

  w.advance = async (ms: number) => {
    const n = Math.max(1, Math.round(ms / (1000 / 60)))
    for (let i = 0; i < n; i++) {
      if (!paused) stepSimulation(1 / 60)
      renderScene(1 / 60)
    }
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))
  }

  w.charactersControl = devControlAdapter
  w.charactersProof = {
    adapter: adapter.info,
    actors,
    game,
    labPanel,
    commands,
    invoke: (id: string, args?: Record<string, unknown>) => commands.invoke(id, args, { source: "cli" }),
    state: () => buildPageState(),
    get selected() { return selected.id },
    get possessing() { return possessing },
    get paused() { return paused },
    get speed() { return simSpeed },
    get camera() { return readCameraState() },
    get splatterActive() {
      return !!game.splatterFx?.particles.some((v: number) => v !== 0) || (game.splatterFx?.inspect().decals ?? 0) > 0
    },
    selectActor: (id: ActorId, frame = false) => selectActor(id, frame),
    setPossessing,
    setAction,
    detachLimb,
    resetActor: (id?: ActorId) => resetActor(id ? resolveActor(id) : selected),
    frameSelected,
  }

  renderScene(1 / 60)
  w.ready = true

  if (manual) return

  let last = performance.now()
  let fps = 60
  const tick = (now: number) => {
    const dt = Math.min(0.05, Math.max(1 / 240, (now - last) / 1000))
    last = now
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05
    if (!paused) stepSimulation(dt)
    renderScene(dt)
    if (tickCount % 12 === 0) {
      labPanel.header.textContent = `${selected.label} (${selected.preset}) · FPS ${fps.toFixed(0)}\nPos (${selected.avatar.x.toFixed(2)}, ${selected.avatar.y.toFixed(2)}) · Pieces ${selected.pieces.length}`
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
