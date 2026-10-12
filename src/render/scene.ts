/// <reference types="vite/client" />
// Renderer + scene host (WebGPU first, automatic WebGL2 fallback). Loaded lazily after the lobby has painted.
// Import convention for all render code: classes from "three/webgpu", TSL from "three/tsl", addons from
// "three/addons/…". Both "three" and "three/webgpu" share three.core.js, so plain math imports from "three"
// (Vector3, Quaternion…) remain identical classes — but materials must be node materials.
import {
  ACESFilmicToneMapping, AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Fog, Group, HemisphereLight,
  LineBasicNodeMaterial, LineSegments, Mesh, MeshLambertMaterial, NoToneMapping, PCFShadowMap, PerspectiveCamera, PlaneGeometry, RenderPipeline,
  RenderTarget, Scene, SRGBColorSpace, UnsignedByteType, Vector3, WebGPURenderer,
} from "three/webgpu"
import {
  attribute, cameraWorldMatrix, dot, float, Fn, hash, length, mix, mod, pass, renderOutput, screenCoordinate, smoothstep, time, uniform, uv,
  vec2, vec3, vec4,
} from "three/tsl"
import { bloom } from "three/addons/tsl/display/BloomNode.js"
import { fxaa } from "three/addons/tsl/display/FXAANode.js"
import type { Quality, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { AIRBASES, groundHeight } from "../sim/geography"
import { createWorldView, type WorldView } from "./world-view"
import { aircraftReady, createAircraftView, preloadAircraft } from "./aircraft"
import { createEffects, type Effects } from "./effects"
import { CameraRig } from "./camera"
import * as worldPalette from "./world/palette"

/** Sun direction exported by the world palette (falls back to a high overcast key). */
const SUN_DIR = (() => {
  const d = (worldPalette as unknown as Record<string, unknown>).SUN_DIRECTION as readonly number[] | undefined
  return d && d.length === 3 ? new Vector3(d[0], d[1], d[2]).normalize() : new Vector3(0.4, 0.75, 0.5).normalize()
})()

export interface FrameStats {
  fps: number; frameMs: number; drawCalls: number; triangles: number; backend: "webgpu" | "webgl2"
  /** Current render pixel ratio (base × adaptive scale) and the adaptive scale itself. */
  pixelRatio: number; resolutionScale: number
  /** GPU frame estimate (ms, queue completion latency; WebGPU only). */
  gpuMs: number
}

export interface SceneHost {
  renderer: WebGPURenderer
  scene: Scene
  camera: PerspectiveCamera
  world: WorldView
  effects: Effects
  rig: CameraRig
  quality: Quality
  aircraftLoaded: Promise<void>
  /** Per-frame game callback. null = menu backdrop. */
  setFrame(fn: ((dt: number, time: number) => void) | null): void
  setQuality(q: Quality): void
  groundAt(x: number, z: number): number
  stats: FrameStats
  /** Studio 3/4 render of an aircraft in team livery (PNG data URL), cached. null if the model failed to load. */
  thumbnail(kind: VehicleKind, team: TeamId): Promise<string | null>
  /** Speed streaks above 600 km/h and (High) speed blur. Call each frame (0 when not flying). */
  setSpeedFx(kmh: number, boost: boolean): void
  /** Point the shadow map at the player (call each frame while flying). */
  setFocus(p: readonly number[] | null): void
  /** Lightning flash (0..1+): pulses exposure and bloom; decays on its own. The world may also expose a value. */
  lightning(intensity: number): void
  /** Quick GPU benchmark (≈2 s of the menu backdrop at full rate): the preset this machine should start on. */
  benchmark(): Promise<Quality>
}

/** Base pixel ratio per preset: retina laptops never render 4× the pixels on Balanced. */
const MAX_PR: Record<Quality, number> = { low: 1, balanced: 1.25, high: 2 }
/** Adaptive resolution floor per preset (fraction of the base pixel ratio). */
const MIN_SCALE: Record<Quality, number> = { low: 0.5, balanced: 0.6, high: 0.7 }
/** The menu backdrop renders at reduced resolution and 30 fps. */
const MENU_SCALE = 0.75
const MENU_FPS = 30
/** Frame cap while playing (0 = display refresh) and when the window is unfocused. */
const PLAY_FPS: Record<Quality, number> = { low: 60, balanced: 60, high: 0 }
const BACKGROUND_FPS = 30

function pixelRatio(q: Quality): number {
  const dpr = window.devicePixelRatio || 1
  return Math.min(dpr, MAX_PR[q])
}

/** Faint speed streaks in view space (camera-attached through cameraWorldMatrix). */
function makeStreaks() {
  const N = 90
  const seeds = new Float32Array(N * 8)
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 9 + Math.random() * 22, ph = Math.random()
    seeds.set([a, r, ph, 0, a, r, ph, 1], i * 8)
  }
  const geo = new BufferGeometry()
  geo.setAttribute("position", new Float32BufferAttribute(new Float32Array(N * 6), 3))
  geo.setAttribute("aSeed", new Float32BufferAttribute(seeds, 4))
  const uSpeed = uniform(0), uOpacity = uniform(0)
  const seed = attribute<"vec4">("aSeed", "vec4")
  const L = float(260)
  const z = mod(seed.z.mul(L).add(time.mul(uSpeed)), L).negate().sub(8)
  const len = uSpeed.mul(0.035).add(4)
  const pView = vec3(seed.x.cos().mul(seed.y), seed.x.sin().mul(seed.y).mul(0.7), z.add(seed.w.mul(len)))
  const mat = new LineBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })
  mat.positionNode = cameraWorldMatrix.mul(vec4(pView, 1)).xyz
  const fade = smoothstep(260, 120, z.negate()).mul(smoothstep(8, 30, z.negate()))
  mat.colorNode = vec3(0.92, 0.94, 0.96)
  mat.opacityNode = fade.mul(uOpacity)
  const mesh = new LineSegments(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 10
  mesh.visible = false
  return { mesh, uSpeed, uOpacity }
}

export async function createSceneHost(canvas: HTMLCanvasElement, quality: Quality, onStatus: (s: string) => void): Promise<SceneHost> {
  const forceWebGL = new URLSearchParams(location.search).has("webgl")
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false, // MSAA lives on the post scene pass
    // Reversed-Z float depth: precise from 0.3 m (cockpit) to the 18 km far plane, keeps early-Z (unlike log depth).
    reversedDepthBuffer: true,
    powerPreference: "high-performance",
    forceWebGL,
  })
  await renderer.init()
  // WebGL2 without EXT_clip_control can't do reversed Z; fall back to a logarithmic depth buffer.
  if (!renderer.reversedDepthBuffer) (renderer as unknown as { logarithmicDepthBuffer: boolean }).logarithmicDepthBuffer = true
  const backend: FrameStats["backend"] = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2"
  renderer.setPixelRatio(pixelRatio(quality) * MENU_SCALE)
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.info.autoReset = false
  renderer.shadowMap.type = PCFShadowMap
  renderer.shadowMap.enabled = quality !== "low"
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping

  const scene = new Scene()
  scene.background = new Color("#1e2a28")
  const camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 20_000)
  camera.position.set(4000, 900, 4000)
  camera.lookAt(0, 0, 0)

  const aircraftLoaded = preloadAircraft(import.meta.env.BASE_URL).then(
    () => onStatus("aircraft"),
    err => { console.warn("aircraft preload failed", err) },
  )

  const world = createWorldView(renderer, scene, quality)
  scene.add(world.root)
  camera.far = world.far
  camera.updateProjectionMatrix()

  // Stand-in sea + light while the world module is still empty.
  let fallback: Group | null = null
  const hasContent = () => world.root.children.length > 0 || scene.children.some(o => o !== world.root && o !== fallback && o.name !== "effects")
  if (!hasContent()) {
    fallback = new Group()
    fallback.name = "fallback-world"
    const sea = new Mesh(new PlaneGeometry(60_000, 60_000), new MeshLambertMaterial({ color: "#1f2b2a" }))
    sea.rotation.x = -Math.PI / 2
    fallback.add(sea)
    for (const b of AIRBASES) {
      const rw = new Mesh(new PlaneGeometry(b.runwayWidth, b.runwayLength), new MeshLambertMaterial({ color: "#3a3d44" }))
      rw.rotation.x = -Math.PI / 2
      rw.rotation.z = b.heading
      rw.position.set(b.center[0], b.center[1] - 1.5, b.center[2])
      fallback.add(rw)
    }
    fallback.add(new HemisphereLight("#6f7f7c", "#141a19", 1.2))
    const key = new DirectionalLight("#cfd8d6", 1.2)
    key.position.set(1000, 5000, 600)
    fallback.add(key)
    scene.add(fallback)
    scene.fog = new Fog("#2a3532", 800, 6000)
  }

  const effects = createEffects(quality)
  scene.add(effects.root)
  const rig = new CameraRig(camera)

  // ---- post pipeline: scene (MSAA) → speed blur (High) → bloom → exposure/ACES → grade, vignette, grain.
  const uExposure = uniform(1.0)
  const uBloom = uniform(0.9)
  const uSat = uniform(0.86)
  const uVignette = uniform(0.42)
  const uGrain = uniform(0.035)
  const uBlur = uniform(0)
  const uAspect = uniform(16 / 9)
  let pipeline: RenderPipeline | null = null
  let bloomNode: ReturnType<typeof bloom> | null = null

  const buildPipeline = (q: Quality) => {
    pipeline?.dispose()
    pipeline = null
    bloomNode = null
    if (q === "low") return // Low renders straight to the canvas (renderer tone mapping only, no bloom/grain).
    // MSAA only on High (WebGPU; WebGL2 can't blit-resolve the MSAA float depth used by reversed Z).
    // Balanced resolves edges with FXAA, which is far cheaper than a multisampled HDR target.
    const msaa = backend === "webgpu" && q === "high" ? (window.devicePixelRatio >= 2 ? 2 : 4) : 0
    const scenePass = pass(scene, camera, { samples: msaa })
    const col = scenePass.getTextureNode("output")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let hdr: any = col
    if (q === "high") {
      // Speed blur: a short zoom blur from the screen centre, weighted toward the edges.
      hdr = Fn(() => {
        const st = uv()
        const dir = st.sub(0.5)
        const w = smoothstep(0.1, 0.55, length(dir)).mul(uBlur)
        const acc = vec3(0).toVar()
        for (let i = 0; i < 6; i++) acc.addAssign(col.sample(st.sub(dir.mul(w).mul(i * 0.012))).rgb)
        return vec4(acc.div(6), 1)
      })()
    }
    // Bloom on HDR emissives (afterburners, tracers, fire, lightning); the dim storm scene stays below threshold.
    bloomNode = bloom(hdr, 0.9, 0.5, 0.82)
    bloomNode.strength = uBloom as never
    // Bloom is a soft glow: a quarter-res chain on Balanced is indistinguishable and much cheaper.
    if (q !== "high") bloomNode.setResolutionScale(0.35)
    const lit = hdr.add(bloomNode).mul(uExposure)
    const toned = renderOutput(vec4(lit.rgb, 1), ACESFilmicToneMapping, SRGBColorSpace)
    const ldr: any = msaa ? toned : fxaa(toned)
    const graded = Fn(() => {
      const c = ldr.rgb.toVar()
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722))
      c.assign(mix(vec3(l), c, uSat))
      // Cool split: teal-blue in the shadows, a faint warmth only in the brightest highlights.
      c.mulAssign(mix(vec3(0.95, 1.0, 1.03), vec3(1.02, 1.0, 0.98), smoothstep(0.25, 0.85, l)))
      const d = length(uv().sub(0.5).mul(vec2(uAspect, 1)))
      c.mulAssign(float(1).sub(smoothstep(0.45, 1.15, d).mul(uVignette)))
      const n = hash(screenCoordinate.x.add(screenCoordinate.y.mul(1931.7)).add(time.mul(613.1).fract().mul(4096))).sub(0.5)
      c.addAssign(n.mul(uGrain))
      return vec4(c, 1)
    })()
    pipeline = new RenderPipeline(renderer)
    pipeline.outputColorTransform = false
    pipeline.outputNode = graded
  }
  buildPipeline(quality)
  renderer.toneMapping = quality === "low" ? ACESFilmicToneMapping : NoToneMapping

  let frameFn: ((dt: number, time: number) => void) | null = null
  const stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, backend, pixelRatio: renderer.getPixelRatio(), resolutionScale: 1, gpuMs: 0 }
  let last = performance.now()
  let fpsFrames = 0
  let fpsT = last
  let frame = 0
  let worldReadyReported = false
  let flash = 0
  // Dev (?nocap): no frame cap, menu scale or adaptive resolution — for GPU A/B measurements.
  const devNoCap = import.meta.env.DEV && new URLSearchParams(location.search).has("nocap")
  let dynScale = 1, benchmarking = false, okSeconds = 0, adaptAt = performance.now(), lastProbe = 0, gpuProbe = false
  const intervals: number[] = []
  const gpuSamples: number[] = []
  const device = (renderer.backend as unknown as { device?: { queue: { onSubmittedWorkDone(): Promise<unknown> } } }).device ?? null

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false)
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight)
    uAspect.value = camera.aspect
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener("resize", resize)

  const host: SceneHost = {
    renderer, scene, camera, world, effects, rig, quality, aircraftLoaded, stats,
    setFrame(fn) {
      frameFn = fn
      if (!fn) rig.setMode("menu")
      applyPixelRatio()
    },
    setQuality(q) {
      host.quality = q
      dynScale = 1
      applyPixelRatio()
      if (renderer.shadowMap.enabled !== (q !== "low")) renderer.shadowMap.enabled = q !== "low"
      resize()
      buildPipeline(q)
      renderer.toneMapping = q === "low" ? ACESFilmicToneMapping : NoToneMapping
      world.setQuality(q)
      effects.setQuality(q)
      camera.far = world.far
      camera.updateProjectionMatrix()
    },
    groundAt: groundHeight,
    thumbnail(kind, team) {
      const key = `${kind}:${team}`
      let p = thumbs.get(key)
      if (!p) { p = aircraftLoaded.then(() => renderThumb(kind, team)).catch(err => { console.warn("thumbnail", err); return null }); thumbs.set(key, p) }
      return p
    },
    setFocus(p) {
      if (!p) return
      _focus.set(p[0], p[1], p[2])
      ;(world as unknown as { setShadowFocus?: (v: Vector3) => void }).setShadowFocus?.(_focus)
    },
    setSpeedFx(kmh, boost) {
      speedKmh = kmh
      boosting = boost
    },
    lightning(intensity) {
      flash = Math.max(flash, intensity)
    },
    benchmark() {
      return new Promise<Quality>(resolve => {
        const q = host.quality
        benchmarking = true
        dynScale = 1
        // Measure the current preset at full game resolution and rate (not the cheaper menu backdrop).
        applyPixelRatio()
        gpuSamples.length = 0
        const intervals: number[] = []
        let prev = performance.now()
        const t0 = prev
        const tick = () => {
          const n = performance.now()
          intervals.push(n - prev)
          prev = n
          if (n - t0 < 2200) { requestAnimationFrame(tick); return }
          benchmarking = false
          const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0
          // Skip the first ~0.6 s (pipeline/shader warm-up).
          const gpu = med(gpuSamples.slice(Math.floor(gpuSamples.length / 3)))
          const frame = med(intervals.slice(Math.floor(intervals.length / 3)))
          // Low costs roughly 40% of Balanced on the GPU.
          const limit = q === "low" ? 4.5 : 11
          const slow = gpu > 0 ? gpu > limit : frame > (q === "low" ? 17.5 : 20)
          dynScale = 1
          applyPixelRatio()
          resolve(q === "low" ? (slow ? "low" : "balanced") : slow ? "low" : q)
        }
        requestAnimationFrame(tick)
      })
    },
  }

  // ---- aircraft thumbnails (offscreen render target, same renderer; one-off per kind+team)
  const thumbs = new Map<string, Promise<string | null>>()
  let thumbChain: Promise<unknown> = Promise.resolve()
  const renderThumb = (kind: VehicleKind, team: TeamId): Promise<string | null> => {
    const job = thumbChain.then(async () => {
      if (!aircraftReady(kind)) return null
      const W = 480, H = 300
      const sc = new Scene()
      sc.add(new HemisphereLight("#c9d4d6", "#3a403e", 1.6), new AmbientLight("#ffffff", 0.25))
      const key = new DirectionalLight("#f2f0ea", 2.4)
      key.position.set(-0.6, 0.8, -0.5).multiplyScalar(100)
      sc.add(key)
      const view = createAircraftView(kind, team, "high")
      sc.add(view.root)
      const cam = new PerspectiveCamera(30, W / H, 0.5, 2000)
      const fake = {
        id: "thumb", kind, team, hp: 1, maxHp: 1, seats: ["a", "b"], aim: [null, null], weapons: [[], []], flaresReadyAt: 0, flareCount: 0,
        abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
        flight: { kind, position: [0, 0, 0], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], angularVelocity: [0, 0, 0], throttle: 0.6, onGround: false, gearDown: false, crashed: null, tick: 0 },
      } as unknown as VehicleEntity
      view.update(fake, [], 0.016, cam)
      view.update(fake, [], 0.016, cam)
      const box = new Box3().setFromObject(view.root)
      const c = box.getCenter(new Vector3())
      const size = box.getSize(c.clone()).length()
      cam.position.set(c.x - size * 0.72, c.y + size * 0.42, c.z - size * 0.92)
      cam.lookAt(c)
      cam.updateMatrixWorld()
      const rt = new RenderTarget(W, H, { samples: 4, type: UnsignedByteType, colorSpace: SRGBColorSpace })
      const prevClear = renderer.getClearColor(new Color()), prevAlpha = renderer.getClearAlpha()
      renderer.setRenderTarget(rt)
      renderer.setClearColor(0x000000, 0)
      renderer.clear()
      renderer.render(sc, cam)
      renderer.setRenderTarget(null)
      renderer.setClearColor(prevClear, prevAlpha)
      const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H) as Uint8Array
      rt.dispose()
      view.dispose()
      const cv = document.createElement("canvas")
      cv.width = W; cv.height = H
      const g = cv.getContext("2d")!
      const img = g.createImageData(W, H)
      // WebGPU reads top-down with rows padded to 256 bytes; WebGL bottom-up, tightly packed.
      if (backend === "webgpu") {
        const stride = Math.ceil((W * 4) / 256) * 256
        for (let y = 0; y < H; y++) img.data.set(px.subarray(y * stride, y * stride + W * 4), y * W * 4)
      } else for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4)
      g.putImageData(img, 0, 0)
      return cv.toDataURL("image/png")
    })
    thumbChain = job.catch(() => null)
    return job
  }

  // Dev-only: screenshot tooling can take the camera after the game frame (window.__wingsCam).
  let camOverride: ((c: PerspectiveCamera, t: number) => void) | null = null
  const _focus = new Vector3()
  let menuT = 0
  const menuFov = 58
  const _wd = new Vector3(), _side = new Vector3(), _look = new Vector3(), _target = new Vector3()

  // ---- sense of speed
  let speedKmh = 0
  let boosting = false
  let streakAmt = 0
  const streaks = makeStreaks()
  scene.add(streaks.mesh)

  const loop = () => {
    const now = performance.now()
    // Frame pacing: cap to 60 fps (Low/Balanced; 120 Hz panels otherwise double the GPU work), 30 fps for
    // the menu backdrop or an unfocused window. Skipped rAF ticks cost nothing (the canvas keeps its image).
    const cap = benchmarking || devNoCap ? 0 : !frameFn ? MENU_FPS : !document.hasFocus() ? BACKGROUND_FPS : PLAY_FPS[host.quality]
    if (cap > 0 && now - last < 1000 / cap - 2.5) return
    const interval = now - last
    const dt = Math.min(0.1, interval / 1000)
    last = now
    adapt(now, interval, cap)
    const t = now / 1000
    frame++
    if (frameFn) {
      frameFn(dt, t)
      if (import.meta.env.DEV && camOverride) camOverride(camera, t)
    } else {
      // Menu: a slow, low pass over the storm sea toward the brighter horizon.
      rig.setMode("menu")
      menuT += dt
      _look.set(-SUN_DIR.x, 0, -SUN_DIR.z)
      if (_look.lengthSq() < 1e-4) _look.set(0, 0, -1)
      _look.normalize()
      _side.set(-_look.z, 0, _look.x)
      const yaw = 0.35 + Math.sin(menuT * 0.03) * 0.12
      _wd.copy(_look).multiplyScalar(Math.cos(yaw)).addScaledVector(_side, Math.sin(yaw))
      camera.position.set(0, 0, 0).addScaledVector(_look, -3200).addScaledVector(_side, ((menuT * 14) % 5000) - 2500)
      camera.position.y = Math.max(groundHeight(camera.position.x, camera.position.z) + 160, 260 + Math.sin(menuT * 0.1) * 20)
      const pitch = -0.06
      _target.copy(camera.position).add(_wd.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)))
      camera.up.set(0, 1, 0)
      camera.lookAt(_target)
      if (Math.abs(camera.fov - menuFov) > 0.01) { camera.fov = menuFov; camera.updateProjectionMatrix() }
    }
    const speedK = frameFn ? Math.min(1, Math.max(0, (speedKmh - 600) / 300)) : 0
    streakAmt += (speedK - streakAmt) * (1 - Math.exp(-dt * 4))
    streaks.mesh.visible = streakAmt > 0.01
    streaks.uSpeed.value = speedKmh / 3.6
    streaks.uOpacity.value = streakAmt * 0.18
    uBlur.value = streakAmt * (boosting ? 1.4 : 0.8)
    world.update(camera.position, dt, t)
    effects.update(dt, t, camera)

    // Lightning: the world may expose a 0..1 value; pulse exposure and bloom with it.
    const wl = (world as unknown as { lightning?: number | (() => number) }).lightning
    const worldFlash = typeof wl === "function" ? wl() : typeof wl === "number" ? wl : 0
    flash = Math.max(flash * Math.exp(-dt * 9), worldFlash)
    uExposure.value = 1 + flash * 0.9
    uBloom.value = 0.9 + flash * 1.6

    renderer.info.reset()
    if (pipeline) pipeline.render()
    else renderer.render(scene, camera)
    sampleGpu(now)
    const t1 = performance.now()
    stats.frameMs += (t1 - now - stats.frameMs) * 0.05
    fpsFrames++
    if (t1 - fpsT >= 1000) {
      stats.fps = (fpsFrames * 1000) / (t1 - fpsT)
      fpsFrames = 0
      fpsT = t1
      stats.drawCalls = renderer.info.render.drawCalls
      stats.triangles = renderer.info.render.triangles
    }
    if (fallback && frame % 60 === 0 && world.root.children.length > 0) {
      scene.remove(fallback)
      fallback = null
    }
    if (!worldReadyReported && world.ready()) {
      worldReadyReported = true
      canvas.classList.add("ready")
      document.getElementById("backdrop")?.classList.add("fade")
      onStatus("world")
    }
  }
  // ---- adaptive resolution: keep frames under budget by scaling the pixel ratio (hysteresis, slow to rise).
  function applyPixelRatio() {
    const menu = !frameFn && !benchmarking && !devNoCap
    const pr = Math.max(0.5, pixelRatio(host.quality) * dynScale * (menu ? MENU_SCALE : 1))
    const rounded = Math.round(pr * 20) / 20
    stats.resolutionScale = dynScale
    if (Math.abs(rounded - renderer.getPixelRatio()) < 0.01) return
    renderer.setPixelRatio(rounded)
    stats.pixelRatio = rounded
    resize()
  }
  function sampleGpu(now: number) {
    // Queue-completion latency of this frame's submission ≈ GPU frame time (upper bound). One probe in flight.
    if (!device || gpuProbe || now - lastProbe < 60) return
    gpuProbe = true
    lastProbe = now
    const t0 = performance.now()
    device.queue.onSubmittedWorkDone().then(() => {
      gpuProbe = false
      const ms = performance.now() - t0
      gpuSamples.push(ms)
      if (gpuSamples.length > 64) gpuSamples.shift()
      stats.gpuMs += (ms - stats.gpuMs) * 0.2
    }, () => { gpuProbe = false })
  }
  function adapt(now: number, interval: number, cap: number) {
    if (benchmarking || devNoCap) return
    if (interval < 200) intervals.push(interval) // ignore stalls (tab switches, shader compiles)
    if (now - adaptAt < 1000) return
    adaptAt = now
    if (intervals.length < 10) { intervals.length = 0; return }
    const budget = 1000 / (cap > 0 ? cap : 60)
    intervals.sort((a, b) => a - b)
    const med = intervals[intervals.length >> 1]
    intervals.length = 0
    const gpu = gpuSamples.length >= 4 ? [...gpuSamples.slice(-12)].sort((a, b) => a - b)[Math.min(gpuSamples.length, 12) >> 1] : 0
    const min = MIN_SCALE[host.quality]
    if (med > budget * 1.2 || gpu > budget * 1.1) {
      okSeconds = 0
      if (dynScale > min + 1e-3) { dynScale = Math.max(min, dynScale - (med > budget * 1.7 ? 0.2 : 0.1)); applyPixelRatio(); gpuSamples.length = 0 }
    } else if (dynScale < 1 && med < budget * 1.08 && (device ? gpu > 0 && gpu < budget * 0.55 : true)) {
      if (++okSeconds >= (device ? 3 : 8)) { okSeconds = 0; dynScale = Math.min(1, dynScale + 0.05); applyPixelRatio() }
    } else okSeconds = 0
  }
  applyPixelRatio()
  renderer.setAnimationLoop(loop)
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    w.__wingsHost = host
    w.__wingsCam = (fn: typeof camOverride) => { camOverride = fn }
    w.__wingsPost = (on: boolean) => buildPipeline(on ? host.quality : "low")
  }
  return host
}
