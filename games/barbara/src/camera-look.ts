import { BodycamRig } from "@arcade/kit/client/bodycam-rig"
import { registerGameCommands } from "@arcade/kit/dev-control"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { CAMERA_ARTIFACT_DEFAULTS, CameraArtifacts, cameraArtifactControls, type CameraArtifactFlicker, type CameraArtifactSettings, type CameraArtifactSource } from "@arcade/kit/gpu/post/camera-artifacts"
import { BODYCAM_PRESETS, CAMERA_FILTER_DEFAULTS, CameraFilter, applyCameraFilterPreset, cameraFilterControls, createCameraFilterSettings, type CameraFilterSettings } from "@arcade/kit/gpu/post/camcorder"
import { FinalPassChain } from "@arcade/kit/gpu/post/final-chain"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { torchProfile } from "@arcade/kit/forest/settings"
import { beamProfileCpu, type ForestTorch, type ForestView } from "@arcade/kit/forest/view"
import type { LabControl, LabPanel } from "@arcade/kit/lab-panel"
import type { DistantEvent } from "../shared/distant"
import { viewDir } from "../shared/sim"
import { groundHeight, treesNear, type WoodsWorld } from "../shared/world"
import type { WoodsCamera } from "./camera"
import { Eyeshine, type SpiderEye } from "./eyeshine"
import type { PlaceLights } from "./world-view"

/**
 * The woods' camera looks: what you see the night through. Eyes (today) by default; a night body camera, a '90s
 * camcorder's infrared NightShot, a phone's night mode and an '80s VHS camcorder as presets over typed settings, and
 * each realism effect on its own switch (`CameraArtifacts`), so Today is always one setting away.
 *
 * Post chain on the forest renderer (`Renderer.setFinalPass`, after the forest's own tonemapped composite in
 * `packages/kit/forest/post.ts`, which is untouched): lens artifacts → camera filter (`camcorder.ts`) → codec
 * artifacts. All off composites straight to the canvas. World-side pieces stay here: eyeshine sprites and the
 * camcorder's infrared lamp (a light at the lens).
 */
export type CameraLookId = "eyes" | "bodycam" | "nightshot" | "phone" | "vhs"
export const CAMERA_LOOK_DEFAULTS = {
  look: "eyes" as CameraLookId,
  eyeshine: false,
  /** NightShot's infrared lamp beside the lens (cd×, like the torch's power). */
  irLight: false,
  irPower: 24,
}
export type CameraLookSettings = typeof CAMERA_LOOK_DEFAULTS

type Preset = { label: string; note: string; look?: Partial<CameraLookSettings>; artifacts?: Partial<CameraArtifactSettings>; filter?: Partial<CameraFilterSettings> }
const strip = <T extends { label: string }>({ label: _, ...rest }: T) => rest
export const CAMERA_LOOKS: Record<CameraLookId, Preset> = {
  eyes: { label: "Eyes (today)", note: "Today's look: the forest renderer's own camera, nothing added." },
  bodycam: {
    label: "Body cam, night",
    note: "Chest mount, 140° fisheye, rolling shutter, auto-gain hunting and a starved encoder; a friend's LED torch bands.",
    filter: { mode: "bodycam", ...strip(BODYCAM_PRESETS.night), bodyPreset: "night" },
    artifacts: { compression: true, compressionAmount: 0.8, sensorGain: true, gainAmount: 0.7, gainSmear: 0.35, pwm: true, flare: true, flareAmount: 0.7 },
    look: { eyeshine: true },
  },
  nightshot: {
    label: "Camcorder NightShot",
    note: "A '90s Sony in infrared, Blair Witch: green monochrome, the IR lamp's own hotspot, blooming whites, crushed blacks, eyes that glow, and focus hunting in the dark.",
    filter: { mode: "vhs", strength: 0.45, overlay: false, vhsColor: 0, vhsDropouts: 0.4, vhsTracking: 0.2, vhsRoll: 0 },
    artifacts: { infrared: true, infraredBloom: 0.8, sensorGain: true, gainAmount: 1.3, gainSmear: 0.45, focusHunt: true, focusAmount: 0.8 },
    look: { irLight: true, eyeshine: true },
  },
  phone: {
    label: "Phone night mode",
    note: "Heavy temporal denoise that ghosts on motion, sharpening halos, noise that grows in the dark, lifted exposure.",
    filter: { mode: "iphone", phoneHdr: 1, phoneSharpen: 1.6, phoneNoise: 1.6, phoneDenoise: 1, phoneExposure: 0.8, phoneFocus: 0.4, phoneCompression: 0.6, phoneFlare: 0.7, phoneShake: 0.25 },
    artifacts: { sensorGain: true, gainAmount: 1, gainSmear: 1, compression: true, compressionAmount: 0.45, flare: true, flareAmount: 0.6 },
  },
  vhs: {
    label: "VHS camcorder",
    note: "An '80s VHS camcorder: soft luma, late colour, tape noise, its date stamp, gain-up in the dark and a lazy autofocus.",
    filter: { mode: "vhs" },
    artifacts: { sensorGain: true, gainAmount: 0.6, focusHunt: true, focusAmount: 0.5 },
  },
}

const GROUP = "Camera look"

type WoodsApi = {
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  autoplay: boolean
  world: WoodsWorld
  state: { players: { id: number; x: number; z: number; yaw: number }[]; brains: { id: number; mode: string; timer: number; heading: number; sweep: number }[] }
  settings: { botCount: number }
  camera: WoodsCamera
}

/** The camera lab's fixed night spot: 70 m into the woods north of camp, torch on, two friends searching with theirs. */
export function stageCameraLab(woods: WoodsApi) {
  const c = woods.world.camp, x = c.x + 10, z = c.z - 70
  woods.settings.botCount = 2
  woods.setPose(x, z, 0.08, -0.07)
  woods.camera.flashlight = true
  woods.autoplay = true
  // Bots appear on the next tick; place them once they exist.
  const place = () => {
    const friends = woods.state.players.filter((p) => p.id >= 100)
    if (friends.length < 2) { requestAnimationFrame(place); return }
    // The far friend's sweep (bot "wait": yaw ± 0.55 rad, pitch −0.34…−0.10 rad) is timed to cross your lens with
    // its beam highest about five seconds in: the flare, dirt and PWM moments.
    const fx = x + 4, fz = z - 11.5, toYou = Math.atan2(-(x - fx), -(z - fz)), peak = Math.PI / 2 / 0.7
    const spots: [number, number, number, number][] = [
      // Ahead and left, sweeping the ground beyond you.
      [x - 3.5, z - 9, 0.35, 0],
      [fx, fz, toYou - Math.sin(0.45 * peak) * 0.55, peak - 5],
    ]
    friends.slice(0, 2).forEach((p, i) => {
      const [px, pz, heading, sweep] = spots[i]!
      const b = woods.state.brains.find((q) => q.id === p.id)!
      p.x = px; p.z = pz; p.yaw = heading
      Object.assign(b, { mode: "wait", timer: 1e9, heading, sweep })
    })
  }
  place()
}

export type CameraLookFrame = {
  /** Sim time (s): distant events and sightings share it. */
  t: number
  dt: number
  eye: readonly number[]
  yaw: number
  pitch: number
  torches: readonly ForestTorch[]
  world: WoodsWorld
  fp: FrameParts
  place: PlaceLights
  /** The spider's eyes, drawn whatever the look (`Eyeshine.drawSpider`). */
  spiderEyes?: readonly SpiderEye[]
}

/**
 * The camera look saved from Settings, if it should apply: never under automation (`navigator.webdriver`, the smoke)
 * or when the URL asks for a camera itself (`?camera=`, `?lab=camera`, `woods.camera*` / `woods.artifacts.*` knobs),
 * so proofs stay reproducible and query parameters win.
 */
export function savedCameraLook(saved: string | null, params: URLSearchParams, automated: boolean): CameraLookId | null {
  if (automated || !saved || !(saved in CAMERA_LOOKS)) return null
  if (params.get("lab") === "camera" || [...params.keys()].some((k) => k === "camera" || k.startsWith("woods.camera") || k.startsWith("woods.artifacts"))) return null
  return saved as CameraLookId
}

export class CameraLook {
  readonly settings: CameraLookSettings = { ...CAMERA_LOOK_DEFAULTS }
  readonly artifacts: CameraArtifactSettings = { ...CAMERA_ARTIFACT_DEFAULTS }
  readonly filter: CameraFilter
  readonly lens: CameraArtifacts
  readonly codec: CameraArtifacts
  readonly eyeshine: Eyeshine
  readonly chain: FinalPassChain
  private readonly rig = new BodycamRig()
  private lastEye: readonly number[] = [0, 0, 0]
  private lastYaw = 0
  private lastT = 0
  private world: WoodsWorld | null = null
  private near: ReturnType<typeof treesNear> = []
  /** Called when the Lab picks a look, so the shell's Settings row follows. */
  onLook: (() => void) | null = null

  constructor(private readonly opts: { renderer: Renderer; device: GPUDevice; format: GPUTextureFormat; camera: WoodsCamera; forest: ForestView; panel: LabPanel; params: URLSearchParams; smoke: boolean; seed: number }) {
    const { renderer, device, format, camera, panel, params, smoke } = opts
    this.filter = new CameraFilter(device, format, createCameraFilterSettings(smoke ? undefined : params, {}, { bodycam: true }))
    this.lens = new CameraArtifacts(device, format, this.artifacts, "lens", opts.seed)
    this.codec = new CameraArtifacts(device, format, this.artifacts, "codec", opts.seed)
    this.eyeshine = new Eyeshine(opts.seed)
    this.chain = new FinalPassChain([this.lens, this.filter, this.codec])
    renderer.setFinalPass(this.chain)
    const fs = this.filter.settings
    camera.rig = (cam, dt, aspect) => this.rig.step(cam, dt, aspect, { lens: fs.bodyLens, mount: fs.bodyMount, sway: fs.bodySway, lag: fs.bodyLag, bob: fs.bodyBob }, fs.strength, fs.mode === "bodycam")
    const sync = () => queueMicrotask(() => panel.sync())
    panel.addControls(this.settings as unknown as Record<string, string | number | boolean>, this.lookControls(sync), { ...CAMERA_LOOK_DEFAULTS })
    panel.addControls(this.artifacts as unknown as Record<string, string | number | boolean>, cameraArtifactControls({ group: GROUP, prefix: "woods.artifacts.", subsection: "Realism" }), { ...CAMERA_ARTIFACT_DEFAULTS })
    panel.addControls(fs as unknown as Record<string, string | number | boolean>, cameraFilterControls({ group: GROUP, prefix: "woods.camera.", bodycam: true, onPreset: (look, id) => { if (this.filter.preset(look, id)) sync() } }), { ...CAMERA_FILTER_DEFAULTS })
    registerGameCommands((commands) => commands.register({
      id: "woods.camera.stage", label: "Stage the woods camera lab", shortLabel: "Camera lab", category: "Scene", enabled: () => true,
      run: () => ({ staged: this.stage() }),
    }))
  }

  private lookControls(sync: () => void): LabControl[] {
    return [
      { key: "woods.cameraLook", field: "look", label: "Camera look", group: GROUP, type: "select", options: Object.entries(CAMERA_LOOKS).map(([value, p]) => ({ value, label: p.label })), change: (v) => { this.apply(String(v) as CameraLookId); sync(); this.onLook?.() } },
      { key: "woods.eyeshine", field: "eyeshine", label: "Eyeshine", group: GROUP, subsection: "World", type: "toggle" },
      { key: "woods.eyeshineNow", label: "Show eyes now", group: GROUP, subsection: "World", type: "action", visible: (s) => s["woods.eyeshine"] === true, run: () => this.showEyes() },
      { key: "woods.irLight", field: "irLight", label: "Infrared lamp", group: GROUP, subsection: "World", type: "toggle" },
      { key: "woods.irPower", field: "irPower", label: "IR lamp power", group: GROUP, subsection: "World", min: 4, max: 80, step: 1, unit: "cd×", visible: (s) => s["woods.irLight"] === true },
    ]
  }

  /** Applies a look: every camera setting back to its default, then the preset's. */
  apply(id: CameraLookId) {
    const p = CAMERA_LOOKS[id]
    if (!p) return
    Object.assign(this.settings, CAMERA_LOOK_DEFAULTS, p.look ?? {}, { look: id })
    Object.assign(this.artifacts, CAMERA_ARTIFACT_DEFAULTS, p.artifacts ?? {})
    Object.assign(this.filter.settings, CAMERA_FILTER_DEFAULTS, p.filter ?? {})
    if (this.filter.settings.mode === "bodycam") applyCameraFilterPreset(this.filter.settings, "bodycam", this.filter.settings.bodyPreset)
  }

  /** Back to the camera lab's fixed spot (`stageCameraLab`) through the page's automation API. */
  stage(): boolean {
    const w = (globalThis as { woods?: WoodsApi }).woods
    if (w) stageCameraLab(w)
    return !!w
  }

  /** The Lab's "Show eyes now": a deer about 16 m out where you look. */
  showEyes() {
    if (this.world) this.eyeshine.show(this.world, this.lastEye, this.lastYaw, this.lastT, this.blocked)
  }

  event(e: DistantEvent) {
    if (this.settings.eyeshine && this.world) this.eyeshine.event(e, this.world, this.lastEye, this.lastT)
  }

  /** True when a trunk or the ground hides `b` from `a` (the last half metre at each end is ignored). */
  blocked = (a: readonly number[], b: readonly number[]): boolean => {
    const world = this.world
    if (!world) return false
    const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, dz = b[2]! - a[2]!, len = Math.hypot(dx, dz)
    if (len < 1) return false
    for (let s = 0.5; s < len - 0.5; s += 1) {
      const f = s / len, x = a[0]! + dx * f, y = a[1]! + dy * f, z = a[2]! + dz * f
      if (y < groundHeight(world, x, z) - 0.05) return true
      for (const t of treesNear(world, x, z, 0.6, this.near)) {
        // Distance from the trunk's axis to the segment in plan.
        const u = Math.max(0, Math.min(1, ((t.x - a[0]!) * dx + (t.z - a[2]!) * dz) / (len * len)))
        const px = a[0]! + dx * u - t.x, pz = a[2]! + dz * u - t.z
        if (u * len > 0.5 && (1 - u) * len > 0.5 && Math.hypot(px, pz) < t.radius * 0.9 && a[1]! + dy * u < t.y + t.height * 0.85) return true
      }
    }
    return false
  }

  /** Where a torch's beam lands within `reach` (m): terrain or a trunk; the end of reach if nothing. */
  private landing(world: WoodsWorld, o: readonly number[], d: readonly number[], reach: number): { p: number[]; dist: number } {
    for (let s = 0.5; s < reach; s += 0.5) {
      const x = o[0]! + d[0]! * s, y = o[1]! + d[1]! * s, z = o[2]! + d[2]! * s
      if (y < groundHeight(world, x, z)) return { p: [x, y, z], dist: s }
      for (const t of treesNear(world, x, z, 0, this.near)) if (Math.hypot(t.x - x, t.z - z) < t.radius && y < t.y + t.height * 0.85) return { p: [x, y, z], dist: s }
    }
    return { p: [o[0]! + d[0]! * reach, o[1]! + d[1]! * reach, o[2]! + d[2]! * reach], dist: reach }
  }

  /**
   * Per frame, before the forest draws: the infrared lamp, eyeshine sprites, and what the camera passes need (lights
   * aimed at the lens, flickering torches, the focus distance, the exposure gain).
   */
  frame(f: CameraLookFrame) {
    const s = this.settings, look = this.opts.forest.settings, cam = this.opts.forest.camera
    this.world = f.world
    this.lastEye = f.eye; this.lastYaw = f.yaw; this.lastT = f.t
    const halfAngle = (look.torchAngle * Math.PI) / 180
    const profile = torchProfile(look)
    const prof = (t: number) => beamProfileCpu(t, profile)
    const own = f.torches.find((t) => t.kind !== "remote" && t.on) ?? null
    const axis = viewDir(f.yaw, f.pitch)
    if (s.irLight) {
      f.place.scene.push({ id: 990, x: f.eye[0]!, y: f.eye[2]!, h: f.eye[1]! - 0.05, r: 16, color: [1, 1, 1], power: s.irPower, size: 0.03, unshadowed: true, beam: { axis, halfAngle: 0.55 } })
    }
    const lights = [
      ...(own ? [{ pos: own.pos, dir: own.dir, power: look.torchPower * 5 * (own.level ?? 1), halfAngle, profile: prof }] : []),
      ...(s.irLight ? [{ pos: f.eye, dir: axis, power: s.irPower * 5, halfAngle: 0.55, profile: prof }] : []),
    ]
    if (s.eyeshine) {
      this.eyeshine.step(f.world, f.eye, f.yaw, f.t)
      this.eyeshine.draw(f.fp, f.eye, f.t, lights, this.blocked, look.fogDensity)
    }
    if (f.spiderEyes?.length) this.eyeshine.drawSpider(f.fp, f.eye, f.spiderEyes, lights, this.blocked, look.fogDensity)
    const a = this.artifacts
    if (!(a.flare || a.dirt || a.pwm || a.focusHunt || a.sensorGain)) return
    const exposure = look.exposure * cam.exposure
    const sources: CameraArtifactSource[] = [], flicker: CameraArtifactFlicker[] = []
    for (const t of f.torches) {
      if (!t.on || t.kind !== "remote") continue
      const level = t.level ?? 1
      if (a.flare || a.dirt) {
        const to = [f.eye[0]! - t.pos[0], f.eye[1]! - t.pos[1], f.eye[2]! - t.pos[2]]
        const d = Math.hypot(to[0]!, to[1]!, to[2]!) || 1
        const cos = (to[0]! * t.dir[0] + to[1]! * t.dir[1] + to[2]! * t.dir[2]) / d
        const p = cos > 0 ? prof(Math.acos(Math.min(1, cos)) / halfAngle) : 0
        if (p > 0.002 && !this.blocked(f.eye, t.pos)) sources.push({ pos: t.pos, intensity: Math.min(6, (look.torchPower * 5 * p * level * exposure * 0.1) / (d * d)) })
      }
      if (a.pwm) {
        const hit = this.landing(f.world, t.pos, t.dir, look.torchReach * 0.7)
        const k = (t.id * 2654435761) >>> 0
        flicker.push({ lens: t.pos, spot: hit.p, spotRadius: hit.dist * Math.tan(halfAngle * 1.4), hz: 160 + (k % 7) * 47, duty: 0.35 + ((k >>> 8) % 5) * 0.06, phase: ((k >>> 16) % 100) / 100, level })
      }
    }
    sources.sort((p, q) => q.intensity - p.intensity)
    this.lens.input = this.codec.input = { sources, flicker, focus: own ? cam.hit : 12, gain: Math.max(0, Math.log2(Math.max(cam.exposure, 1e-3))) }
  }
}
