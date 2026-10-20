import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "../world/context"
import { BUILDING, VIEWPOINTS, type ViewpointName } from "../world/layout"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "../render/materials"
import { createAtmosphere } from "../render/atmosphere"
import { createLighting } from "../render/lighting"
import { createPost } from "../render/post"
import { Player } from "../player"
import { Doors } from "../world/doors"
import { createGameBody } from "../playerb/game"
import { renderState } from "../render/shared"
import { nextFrame, yieldToMain } from "./schedule"
import { createWarmup } from "./warmup"
import { distanceTo } from "./priority"
import { modelLoadsPending } from "./loads"
import { MODELS as MODEL_LIBRARY, initModels, preloadModels, type ModelName } from "../render/models"

// The world boot, shared by the game (src/main.ts) and the Look Lab. `bootWorld` builds only terrain plus the render rig
// and resolves when the first frame can be drawn. The caller starts its frame loop (calling `render`) and then awaits
// `stream()`, which builds and warms everything else (the light rig adopts lamps as they register) behind the loading
// screen, so once it lifts, play never stalls on shader compilation, texture uploads or model loads.

export type WorldBuilder = { build: (ctx: WorldContext) => WorldModule | void | Promise<WorldModule | void> }

// Each world module loads on its own so a broken module removes only its part of the world.
export const MODULES: Record<string, () => Promise<WorldBuilder>> = {
  terrain: () => import("../world/terrain"),
  roads: () => import("../world/roads"),
  compound: () => import("../world/compound"),
  facility: () => import("../world/facility"),
  forest: () => import("../world/forest"),
  interior: () => import("../world/interior"),
}
/** Built before the first frame, straight into the scene. */
export const FIRST_FRAME = new Set(["terrain"])
/**
 * Build order after the first frame. Everything warms behind the loading screen, so the order is about the critical
 * path, not the view: the interior goes first because its follow-up furniture bake (after `build()` returns) can then
 * overlap the other modules' builds and shader compiles instead of trailing at the end.
 */
const BUILD_ORDER = ["interior", "facility", "forest", "roads", "compound"]
/** Relative boot cost per module (build + compile, measured), for the loading bar. */
const STAGE_WEIGHT: Record<string, number> = { forest: 0.6, roads: 0.5, compound: 0.4, facility: 1.5, interior: 3 }
const BODY_WEIGHT = 0.3
const MODELS_WEIGHT = 1

export type BootOptions = {
  /** Start viewpoint (default: `?view=` or "road"). */
  view?: ViewpointName
  /** Pointer-lock/keyboard input for the player (default: on unless `?shot`). */
  input?: boolean
  /** Collects boot errors (default: a new array, returned as `errors`). */
  errors?: string[]
  /** Progress before the first frame (0..1). */
  onStep?: (label: string, fraction: number) => void
}

export type StreamHooks = {
  /** A module was shown (`done` of `total`). */
  onShown?: (name: string, done: number, total: number) => void
  /** Every module has built, so `ctx.controls` is complete (create the Lab panel here). */
  onBuilt?: () => void
  /** What the boot is doing now and how far it is (0..1 of the whole warm-up, weighted by measured stage cost). */
  onProgress?: (stage: string, fraction: number) => void
}

export type World = Awaited<ReturnType<typeof bootWorld>>

export async function bootWorld(canvas: HTMLCanvasElement, params: URLSearchParams, options: BootOptions = {}) {
  const step = options.onStep ?? (() => {})
  const errors = options.errors ?? []
  const fail = (message: string) => {
    errors.push(message)
    console.error(message)
  }

  const only = params.get("only")?.split(",")
  const wanted = Object.keys(MODULES).filter((name) => !only || only.includes(name))
  // Start every module download now; in dev each is a tree of unbundled files.
  const imports = new Map(wanted.map((name) => [name, MODULES[name]!().catch((e: unknown) => e)]))

  step("starting webgpu", 0.05)
  // Reversed-Z: float depth precision where it matters (far facades); `reversedDepth=0` is for A/B automation only.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: params.has("perf"), reversedDepthBuffer: params.get("reversedDepth") !== "0" } as ConstructorParameters<typeof THREE.WebGPURenderer>[0])
  performance.mark("gpu:init:start")
  await renderer.init()
  performance.mark("gpu:init:end")
  if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) fail("WebGPU unavailable: running on the WebGL fallback")
  // Every prop/vehicle GLB starts downloading and transcoding now, overlapping the terrain build and shader compiles,
  // instead of when each builder first asks (the interior's furniture otherwise arrives seconds into the boot).
  initModels(renderer)
  preloadModels(Object.keys(MODEL_LIBRARY) as ModelName[])
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false)
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(68, (canvas.clientWidth || innerWidth) / (canvas.clientHeight || innerHeight), Number(params.get("near") ?? 0.15), 1600)
  ;(globalThis as { __afterhoursDebug?: unknown }).__afterhoursDebug = { renderer, scene, camera }
  const ctx: WorldContext = {
    scene,
    renderer,
    camera,
    colliders: [],
    floors: [],
    ladders: [],
    lamps: [],
    doors: new Doors(params.has("shot")),
    settings: { "player.walk": 1.6, "player.sensitivity": 1 },
    controls: [
      { key: "player.walk", label: "Walk speed", group: "Player", unit: "m/s", min: 0.8, max: 4, step: 0.1 },
      { key: "player.sensitivity", label: "Mouse sensitivity", group: "Player", min: 0.2, max: 3, step: 0.05 },
    ],
    params,
  }
  Object.assign(ctx.settings, MATERIAL_SETTINGS)
  bindMaterialSettings(ctx.settings)
  ctx.controls.push(...MATERIAL_CONTROLS)
  // Textures download and transcode while terrain builds; only the first frame waits for them.
  performance.mark("materials:start")
  const materials = loadMaterials(renderer)
    .catch((e) => fail(`materials: ${e}`))
    .finally(() => performance.mark("materials:end"))

  type Staged = { name: string; root: THREE.Object3D; update?: WorldModule["update"] }
  const updates: NonNullable<WorldModule["update"]>[] = []
  /** Builds a module; non-first-frame ones go into a detached group so they can be compiled before they're shown. */
  async function buildModule(name: string): Promise<Staged | null> {
    performance.mark(`mod:${name}:import:start`)
    const m = await imports.get(name)!
    performance.mark(`mod:${name}:build:start`)
    let staged: Staged | null = null
    try {
      if (m instanceof Error || !m || typeof (m as WorldBuilder).build !== "function") throw m
      const root = FIRST_FRAME.has(name) ? scene : new THREE.Group()
      root.name ||= name
      const mod = await (m as WorldBuilder).build({ ...ctx, scene: root as THREE.Scene })
      if (mod?.update) updates.push(mod.update)
      if (root !== scene) staged = { name, root, update: mod?.update }
    } catch (e) {
      fail(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
    }
    performance.mark(`mod:${name}:build:end`)
    await yieldToMain()
    return staged
  }

  for (const name of wanted) {
    if (!FIRST_FRAME.has(name)) continue
    step(`building ${name}`, 0.4)
    await buildModule(name)
  }

  performance.mark("rig:start")
  step("lighting", 0.75)
  const player = new Player(camera, canvas, ctx, options.input ?? !params.has("shot"))
  const gameBody = createGameBody(ctx, player)
  updates.push(gameBody.update)
  // The flashlight comes out of the torch in the body's hand (render/lighting.ts falls back to the eye when hidden).
  renderState.torchLens = (pos, dir) => gameBody.body.root.visible && gameBody.body.torchLens(pos, dir)
  const atmosphere = createAtmosphere(ctx)
  const lighting = createLighting(ctx, player)
  const post = createPost(ctx)
  // `bootSlice` (ms, automation/A-B only): compile time allowed per frame while streaming.
  const warmup = createWarmup(renderer, scene, camera, Number(params.get("bootSlice") ?? 8))
  // Dynamic resolution would read capped/hitchy streaming frames as slow ones; paused until the world is in.
  post.setBooting(true)
  const view = options.view ?? ((params.get("view") ?? "road") as ViewpointName)
  player.teleport(VIEWPOINTS[view] ? view : "road")
  if (params.get("flashlight") === "1") player.flashlight = true
  performance.mark("rig:end")

  step("textures", 0.85)
  await materials
  step("compiling", 0.95)

  let streaming = true
  let revealed = false
  const deferred: THREE.Object3D[] = []
  const _wp = new THREE.Vector3()
  let background: Promise<void> = Promise.resolve()
  /** One frame: module updates, atmosphere, lighting and the post chain. Player input/movement is the caller's. */
  const render = (dt: number, time: number) =>
    warmup.frame(() => {
      for (const u of updates) u(dt, time, camera)
      atmosphere.update(dt, time)
      lighting.update(dt, time)
      post.render()
    })

  /**
   * Everything the player can meet, warmed behind the loading screen (the caller keeps it up until this resolves): builds
   * the remaining modules one at a time in view order, compiles each before it joins the scene, waits for every GLB the
   * builders asked for (props, vehicles, the player character and its animations) and warms those too. Compiling runs at
   * full throughput meanwhile (nothing on screen to protect). Afterwards nothing is left to stream, so play doesn't
   * hitch on shader builds and nothing pops in. The frame loop must be running (a frame now and then is enough).
   */
  const stream = async (hooks: StreamHooks = {}) => {
    for (let i = 0; i < 120 && !warmup.ready; i++) await nextFrame()
    warmup.setCovered(true)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const order = BUILD_ORDER
    const pending = wanted.filter((n) => !FIRST_FRAME.has(n))
    pending.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    // Builds run one after another (main-thread CPU); each module's warm-up starts as soon as it's built and overlaps the
    // next build (warm-ups mostly wait on the GPU process). Behind the cover the order of arrival doesn't matter.
    // Only what the game draws now is warmed here; what it hides (other storeys, far furniture) warms after the reveal.
    let done = 0
    // Progress: each stage's share is roughly what it costs on a typical boot (build ~40%, compile ~60% of a module).
    const total = pending.reduce((a, n) => a + (STAGE_WEIGHT[n] ?? 1), 0) + BODY_WEIGHT + MODELS_WEIGHT
    let progressed = 0
    let stage = ""
    const advance = (w: number, next?: string) => {
      progressed += w
      if (next) stage = next
      hooks.onProgress?.(stage, Math.min(1, progressed / total))
    }
    const warming: Promise<void>[] = []
    for (const name of pending) {
      advance(0, `building ${name}`)
      const s = await buildModule(name)
      const w = STAGE_WEIGHT[name] ?? 1
      if (!s) {
        advance(w)
        hooks.onShown?.(name, ++done, pending.length + 1)
        continue
      }
      advance(w * 0.4, `compiling shaders · ${name}`)
      warmup.track(s.root)
      // One update first so the module applies its own visibility for this view (the interior hides storeys you're not
      // near): only what it actually draws from here is warmed behind the loading screen.
      try {
        s.update?.(0, 0, camera)
      } catch (e) {
        fail(`${s.name} update: ${e instanceof Error ? e.message : e}`)
      }
      performance.mark(`queue:${s.name}:${Math.round(distanceTo(s.root, eye))}m`)
      performance.mark(`mod:${s.name}:compile:start`)
      warming.push(
        warmup
          .warm(s.root, { visibleOnly: true })
          .then((later) => void deferred.push(...later))
          .catch((e) => fail(`${s.name} warm-up: ${e instanceof Error ? e.message : e}`))
          .then(() => {
            performance.mark(`mod:${s.name}:compile:end`)
            scene.add(s.root)
            performance.mark(`mod:${s.name}:shown`)
            revealed = true
            advance(w * 0.6)
            hooks.onShown?.(name, ++done, pending.length + 1)
          }),
      )
    }
    advance(0, "compiling shaders")
    await Promise.all(warming)
    hooks.onBuilt?.()
    // The player character (model + animation library) and its torch.
    advance(0, "character")
    await gameBody.body.ready.catch(() => {})
    await warmup.warm(gameBody.body.root).catch(() => {})
    performance.mark("body:warm")
    advance(BODY_WEIGHT, "props and furniture")
    // Models still downloading, and builders' own follow-up work (the interior bakes its furniture after build),
    // land under the tracked module roots and warm on their own: wait until no GLB is in flight, nothing is warming and
    // nothing new has arrived for a while.
    const QUIET_MS = 250
    let modelsIn = false
    for (;;) {
      await warmup.idle()
      if (!modelsIn && modelLoadsPending() === 0) {
        modelsIn = true
        performance.mark("boot:models-in")
      }
      if (modelLoadsPending() === 0 && performance.now() - warmup.lastArrival > QUIET_MS) break
      await new Promise((r) => setTimeout(r, 50))
    }
    performance.mark(`boot:last-arrival:${Math.round(warmup.lastArrival)}`)
    advance(MODELS_WEIGHT)
    hooks.onShown?.("models", ++done, pending.length + 1)
    // What the game hides at the reveal inside the facility (other storeys, rooms the culling hides from the lot)
    // also compiles behind the cover (everything in the building footprint): left
    // to the background warm-up it was still queued when a fast player reached the doors, and entering compiled ~40
    // materials in one frame and stalled the GPU for ~1.8 s on their pipelines and textures.
    deferred.push(...warmup.takeHidden())
    const { min, max } = BUILDING.main
    const near = deferred.filter((o) => {
      o.getWorldPosition(_wp)
      return _wp.x > min[0] - 10 && _wp.x < max[0] + 10 && _wp.z > min[1] - 10 && _wp.z < max[1] + 15
    })
    // `entryWarm=0` (automation/A-B only) leaves it all to the background warm-up, as before.
    if (near.length && params.get("entryWarm") === "0") near.length = 0
    if (near.length) {
      const keep = new Set(near)
      deferred.splice(0, deferred.length, ...deferred.filter((o) => !keep.has(o)))
      warmup.uploadGeometry(near)
      await warmup.warmObjects(near)
    }
    performance.mark(`boot:entry-warm:${near.length}`)
    warmup.setCovered(false)
    post.setBooting(false)
    streaming = false
    performance.mark("boot:warm")
    // What the game hid at the reveal compiles now in slices around frames, nearest first, so it's ready before you
    // walk up to it (if not, it compiles when first drawn: a hitch, never a hole).
    deferred.push(...warmup.takeHidden())
    performance.mark(`boot:deferred:${deferred.length}`)
    warmup.uploadGeometry(deferred)
    performance.mark("boot:geometry-uploaded")
    background = (async () => {
      await warmup.warmObjects(deferred)
      performance.mark("boot:background")
      // Hidden objects builders add later (furniture bakes) keep warming in the background as they arrive.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000))
        const more = warmup.takeHidden()
        if (more.length) await warmup.warmObjects(more)
      }
    })()
  }

  return {
    ctx,
    renderer,
    scene,
    camera,
    player,
    atmosphere,
    lighting,
    post,
    warmup,
    errors,
    /** Names of the modules this boot builds (after `?only=`), in declaration order. */
    modules: wanted,
    get streaming() {
      return streaming
    },
    /** Resolves when what was hidden at the reveal has been warmed in the background too. */
    get background() {
      return background
    },
    /** True (once) when something new became visible since the last call: worth drawing a frame for. */
    takeReveal() {
      const r = revealed
      revealed = false
      return r
    },
    render,
    stream,
  }
}
