import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "../world/context"
import { MATERIAL_CONTROLS, MATERIAL_SETTINGS, bindMaterialSettings, loadMaterials } from "../render/materials"
import { createAtmosphere } from "../render/atmosphere"
import { createLighting } from "../render/lighting"
import { createPost } from "../render/post"
import { Player } from "../player"
import { nextFrame, yieldToMain } from "../boot/schedule"
import { createWarmup } from "../boot/warmup"
import { distanceTo } from "../boot/priority"
import { decodeTexturesOffThread } from "../boot/textures"

// The game world exactly as src/main.ts boots it (same world modules, materials, atmosphere, lighting, post chain and
// pipeline warm-up), minus its frame loop and HUD, so the Look Lab renders the real thing under its own control.
// main.ts runs at import time and can't be imported; keep MODULES / FIRST_FRAME / LATE in step with it.

type Builder = { build: (ctx: WorldContext) => WorldModule | void | Promise<WorldModule | void> }
const MODULES: Record<string, () => Promise<Builder>> = {
  terrain: () => import("../world/terrain"),
  roads: () => import("../world/roads"),
  compound: () => import("../world/compound"),
  facility: () => import("../world/facility"),
  forest: () => import("../world/forest"),
  interior: () => import("../world/interior"),
}
const FIRST_FRAME = new Set(["terrain"])
const LATE = new Set(["forest"])

export type LookWorld = Awaited<ReturnType<typeof bootWorld>>

export async function bootWorld(canvas: HTMLCanvasElement, params: URLSearchParams, onStep: (label: string, f: number) => void) {
  const errors: string[] = []
  const fail = (message: string) => {
    errors.push(message)
    console.error(message)
  }
  const only = params.get("only")?.split(",")
  const wanted = Object.entries(MODULES).filter(([name]) => !only || only.includes(name))
  const imports = new Map(wanted.map(([name, load]) => [name, load().catch((e: unknown) => e)]))

  onStep("starting webgpu", 0.05)
  // preserveDrawingBuffer-equivalent isn't needed: stills are copied in the same task as their render.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: params.has("perf") })
  await renderer.init()
  if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) fail("WebGPU unavailable: running on the WebGL fallback")
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(68, 1.5, 0.08, 1600)
  ;(globalThis as { __afterhoursDebug?: unknown }).__afterhoursDebug = { renderer, scene, camera }
  const ctx: WorldContext = {
    scene,
    renderer,
    camera,
    colliders: [],
    floors: [],
    ladders: [],
    lamps: [],
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
  decodeTexturesOffThread()
  const materials = loadMaterials(renderer).catch((e) => fail(`materials: ${e}`))

  type Staged = { name: string; root: THREE.Object3D }
  const staged: Staged[] = []
  const updates: NonNullable<WorldModule["update"]>[] = []
  async function buildModule(name: string) {
    const m = await imports.get(name)!
    try {
      if (m instanceof Error || !m || typeof (m as Builder).build !== "function") throw m
      const root = FIRST_FRAME.has(name) ? scene : new THREE.Group()
      root.name ||= name
      const mod = await (m as Builder).build({ ...ctx, scene: root as THREE.Scene })
      if (mod?.update) updates.push(mod.update)
      if (root !== scene) staged.push({ name, root })
    } catch (e) {
      fail(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
    }
    await yieldToMain()
  }
  const early = wanted.filter(([name]) => !LATE.has(name))
  for (const [i, [name]] of early.entries()) {
    onStep(`building ${name}`, 0.1 + (0.6 * i) / early.length)
    await buildModule(name)
  }

  onStep("lighting", 0.75)
  const player = new Player(camera, canvas, ctx, !params.has("shot"))
  const atmosphere = createAtmosphere(ctx)
  const lighting = createLighting(ctx, player)
  const post = createPost(ctx)
  const warmup = createWarmup(renderer, scene, camera, Number(params.get("bootSlice") ?? 8))
  player.teleport("lot")

  onStep("textures", 0.85)
  await materials
  onStep("compiling", 0.95)

  /** Streams the remaining modules in (nearest first, each compiled before it is shown); the frame loop must run. */
  const stream = async (onLate: () => void, onStream: (done: number, total: number) => void) => {
    for (let i = 0; i < 120 && !warmup.ready; i++) await nextFrame()
    for (const [name] of wanted) if (LATE.has(name)) await buildModule(name)
    onLate()
    for (const s of staged) warmup.track(s.root)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const queue = staged.map((s) => ({ s, d: distanceTo(s.root, eye) })).sort((a, b) => a.d - b.d)
    let shown = 0
    for (const { s } of queue) {
      try {
        await warmup.warm(s.root)
      } catch (e) {
        fail(`${s.name} warm-up: ${e instanceof Error ? e.message : e}`)
      }
      scene.add(s.root)
      onStream(++shown, queue.length)
    }
    await warmup.idle()
  }

  return { ctx, renderer, scene, camera, player, atmosphere, lighting, post, warmup, updates, errors, stream }
}
