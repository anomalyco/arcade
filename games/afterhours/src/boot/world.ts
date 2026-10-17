import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "../world/context"
import { VIEWPOINTS, type ViewpointName } from "../world/layout"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "../render/materials"
import { createAtmosphere, insideBuilding } from "../render/atmosphere"
import { createLighting } from "../render/lighting"
import { createPost } from "../render/post"
import { Player } from "../player"
import { Doors } from "../world/doors"
import { nextFrame, yieldToMain } from "./schedule"
import { createWarmup } from "./warmup"
import { distanceTo } from "./priority"

// The world boot, shared by the game (src/main.ts) and the Look Lab. Progressive: `bootWorld` builds only terrain plus
// the render rig and resolves when the first frame can be drawn (terrain, sky, fog). The caller starts its frame loop
// (calling `render`) and then `stream()`, which builds the remaining modules after the first frame (the light rig
// adopts their lamps as they register) and shows each one once its pipelines are compiled in the background, so no
// frame stalls on shader compilation.

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
/** Build and stream order after the first frame, by where the player starts. */
const OUTDOOR_ORDER = ["forest", "roads", "compound", "facility", "interior"]
const INDOOR_ORDER = ["interior", "facility", "compound", "roads", "forest"]

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
    settings: { "player.walk": 1.9, "player.sensitivity": 1 },
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

  type Staged = { name: string; root: THREE.Object3D }
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
      if (root !== scene) staged = { name, root }
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
  const firstShown = new Set<string>()
  /** One frame: module updates, atmosphere, lighting and the post chain. Player input/movement is the caller's. */
  const render = (dt: number, time: number) =>
    warmup.frame(() => {
      for (const u of updates) u(dt, time, camera)
      atmosphere.update(dt, time)
      lighting.update(dt, time)
      post.render()
    })

  /**
   * Builds and shows the remaining modules one at a time, in view order: each is built only after the previous one is
   * shown, so its CPU build never competes with the nearer module's shader compile. The frame loop must be running.
   * Resolves when everything (including models that arrived meanwhile) is in.
   */
  const stream = async (hooks: StreamHooks = {}) => {
    for (let i = 0; i < 120 && !warmup.ready; i++) await nextFrame()
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const order = insideBuilding(eye) ? INDOOR_ORDER : OUTDOOR_ORDER
    const pending = wanted.filter((n) => !FIRST_FRAME.has(n))
    pending.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    let done = 0
    for (const name of pending) {
      const s = await buildModule(name)
      if (s) {
        warmup.track(s.root)
        performance.mark(`queue:${s.name}:${Math.round(distanceTo(s.root, eye))}m`)
        performance.mark(`mod:${s.name}:compile:start`)
        // Progressive: the module joins the scene now with everything hidden, and each object appears as soon as its
        // pipelines are ready, in-view and nearest first.
        const progressive = params.get("bootProgressive") !== "0"
        const warming = warmup.warm(s.root, {
          // `bootProgressive=0` (automation/A-B only): show whole modules once compiled.
          progressive,
          onReveal: () => {
            revealed = true
            if (!firstShown.has(s.name)) {
              firstShown.add(s.name)
              performance.mark(`mod:${s.name}:first`)
            }
          },
        })
        if (progressive) scene.add(s.root)
        try {
          await warming
        } catch (e) {
          fail(`${s.name} warm-up: ${e instanceof Error ? e.message : e}`)
        }
        performance.mark(`mod:${s.name}:compile:end`)
        if (!progressive) scene.add(s.root)
        performance.mark(`mod:${s.name}:shown`)
        revealed = true
      }
      hooks.onShown?.(name, ++done, pending.length)
    }
    hooks.onBuilt?.()
    // Models that already arrived are warming on their own; let them land before calling the world complete.
    await warmup.idle()
    post.setBooting(false)
    streaming = false
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
