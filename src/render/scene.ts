/// <reference types="vite/client" />
// Renderer + scene host. Loaded lazily after the lobby has painted.
import {
  AmbientLight, Box3, BufferGeometry, Color, LineSegments, Vector3, DirectionalLight, Float32BufferAttribute, Fog, Group, HemisphereLight, Mesh, MeshLambertMaterial, OrthographicCamera, PerspectiveCamera,
  PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace, UnsignedByteType, Vector2, WebGLRenderer, WebGLRenderTarget, type Camera,
} from "three"
import type { Quality, TeamId, VehicleEntity, VehicleKind } from "../sim/types"
import { AIRBASES, groundHeight } from "../sim/geography"
import { createWorldView, type WorldView } from "./world-view"
import { aircraftReady, createAircraftView, preloadAircraft } from "./aircraft"
import { createEffects, type Effects } from "./effects"
import { CameraRig } from "./camera"

export interface FrameStats { fps: number; frameMs: number; drawCalls: number; triangles: number }

export interface SceneHost {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera
  world: WorldView
  effects: Effects
  rig: CameraRig
  quality: Quality
  aircraftLoaded: Promise<void>
  /** Per-frame game callback. null = menu backdrop orbit. */
  setFrame(fn: ((dt: number, time: number) => void) | null): void
  setQuality(q: Quality): void
  groundAt(x: number, z: number): number
  stats: FrameStats
  /** Studio 3/4 render of an aircraft in team livery (PNG data URL), cached. null if the model failed to load. */
  thumbnail(kind: VehicleKind, team: TeamId): Promise<string | null>
  /** Sense of speed: +6° FOV while boosting, faint speed streaks above 600 km/h. Call each frame (0 when not flying). */
  setSpeedFx(kmh: number, boost: boolean): void
}

const STREAKS_VS = /* glsl */ `
attribute vec4 aSeed; // angle, radius, phase, end (0/1)
uniform float uTime;
uniform float uSpeed;
varying float vA;
void main() {
  float L = 260.0;
  float z = -mod(aSeed.z * L + uTime * uSpeed, L) - 8.0;
  float len = 4.0 + uSpeed * 0.035;
  vec3 p = vec3(cos(aSeed.x) * aSeed.y, sin(aSeed.x) * aSeed.y * 0.7, z + aSeed.w * len);
  vA = (1.0 - smoothstep(120.0, 260.0, -z)) * smoothstep(8.0, 30.0, -z);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`
const STREAKS_FS = /* glsl */ `
uniform float uOpacity;
varying float vA;
void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, vA * uOpacity); }`

function makeStreaks(): { mesh: LineSegments; mat: ShaderMaterial } {
  const N = 90
  const seeds = new Float32Array(N * 8)
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 9 + Math.random() * 22, ph = Math.random()
    seeds.set([a, r, ph, 0, a, r, ph, 1], i * 8)
  }
  const geo = new BufferGeometry()
  geo.setAttribute("position", new Float32BufferAttribute(new Float32Array(N * 6), 3))
  geo.setAttribute("aSeed", new Float32BufferAttribute(seeds, 4))
  const mat = new ShaderMaterial({
    vertexShader: STREAKS_VS, fragmentShader: STREAKS_FS, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uSpeed: { value: 0 }, uOpacity: { value: 0 } },
  })
  const mesh = new LineSegments(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 10
  mesh.visible = false
  return { mesh, mat }
}

/**
 * Final grade pass (Balanced/High only): 4× MSAA scene target + one full-screen triangle doing a gentle
 * saturation/contrast lift and a soft lilac-tinted vignette. Low renders straight to the canvas.
 */
const POST_FS = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uAspect;
uniform float uSat;
uniform float uContrast;
uniform float uVignette;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  c = 0.18 * pow(c / 0.18 + 1e-5, vec3(uContrast));
  vec2 d = (vUv - 0.5) * uAspect;
  float v = smoothstep(0.42, 1.05, length(d));
  c *= mix(vec3(1.0), vec3(0.86, 0.84, 0.94), v * uVignette);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`

class PostPass {
  readonly target: WebGLRenderTarget
  private scene = new Scene()
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mat: ShaderMaterial
  private size = new Vector2()

  constructor(renderer: WebGLRenderer) {
    renderer.getDrawingBufferSize(this.size)
    // At ≥2× pixel ratio aliasing is already small: 2× MSAA keeps the fill cost down on retina laptops.
    this.target = new WebGLRenderTarget(this.size.x, this.size.y, { samples: renderer.getPixelRatio() >= 2 ? 2 : 4, type: UnsignedByteType, colorSpace: SRGBColorSpace, depthBuffer: true })
    const geo = new BufferGeometry()
    geo.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geo.setAttribute("uv", new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.mat = new ShaderMaterial({
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: POST_FS,
      uniforms: { tScene: { value: this.target.texture }, uAspect: { value: new Vector2(1, 1) }, uSat: { value: 1.06 }, uContrast: { value: 1.03 }, uVignette: { value: 1 } },
      depthTest: false, depthWrite: false,
    })
    const tri = new Mesh(geo, this.mat)
    tri.frustumCulled = false
    this.scene.add(tri)
  }

  resize(renderer: WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size)
    this.target.setSize(this.size.x, this.size.y)
    const a = this.size.x / Math.max(1, this.size.y)
    this.mat.uniforms.uAspect.value.set(a > 1 ? a : 1, a > 1 ? 1 : 1 / a)
  }

  set menu(on: boolean) {
    this.mat.uniforms.uSat.value = on ? 0.98 : 1.06
    this.mat.uniforms.uVignette.value = on ? 1.5 : 1
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    renderer.setRenderTarget(this.target)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.target.dispose()
    this.mat.dispose()
  }
}

function pixelRatio(q: Quality): number {
  const dpr = window.devicePixelRatio || 1
  return Math.min(dpr, q === "low" ? 1 : q === "balanced" ? 1.5 : 2)
}

export async function createSceneHost(canvas: HTMLCanvasElement, quality: Quality, onStatus: (s: string) => void): Promise<SceneHost> {
  const renderer = new WebGLRenderer({
    canvas,
    // Balanced/High antialias through the multisampled post target instead of the default framebuffer.
    antialias: false,
    logarithmicDepthBuffer: true,
    powerPreference: "high-performance",
    stencil: false,
  })
  renderer.setPixelRatio(pixelRatio(quality))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.info.autoReset = false
  let post: PostPass | null = quality === "low" ? null : new PostPass(renderer)
  post?.resize(renderer)

  const scene = new Scene()
  scene.background = new Color("#0b0e1a")
  const camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 20_000)
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

  // Stand-in sea + light while the world module is still a stub / empty.
  let fallback: Group | null = null
  const hasContent = () => world.root.children.length > 0 || scene.children.some(o => o !== world.root && o !== fallback && o.name !== "effects")
  if (!hasContent()) {
    fallback = new Group()
    fallback.name = "fallback-world"
    const sea = new Mesh(new PlaneGeometry(60_000, 60_000), new MeshLambertMaterial({ color: "#16324a" }))
    sea.rotation.x = -Math.PI / 2
    fallback.add(sea)
    for (const b of AIRBASES) {
      const rw = new Mesh(new PlaneGeometry(b.runwayWidth, b.runwayLength), new MeshLambertMaterial({ color: "#3a3d44" }))
      rw.rotation.x = -Math.PI / 2
      rw.rotation.z = b.heading
      rw.position.set(b.center[0], b.center[1] - 1.5, b.center[2])
      const pad = new Mesh(new PlaneGeometry(900, 900), new MeshLambertMaterial({ color: "#2c4a2c" }))
      pad.rotation.x = -Math.PI / 2
      pad.position.set(b.center[0], b.center[1] - 2, b.center[2])
      fallback.add(pad, rw)
    }
    fallback.add(new HemisphereLight("#bcd0ff", "#1a1a22", 1.6))
    const sun = new DirectionalLight("#fff1dd", 2.2)
    sun.position.set(3000, 5000, 2000)
    fallback.add(sun)
    scene.add(fallback)
    scene.fog = new Fog("#1a2236", 2000, 18_000)
    scene.background = new Color("#1a2236")
  }

  const effects = createEffects(quality)
  scene.add(effects.root)
  const rig = new CameraRig(camera)

  let frameFn: ((dt: number, time: number) => void) | null = null
  const stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 }
  let last = performance.now()
  let fpsFrames = 0
  let fpsT = last
  let frame = 0
  let worldReadyReported = false

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false)
    post?.resize(renderer)
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight)
    camera.updateProjectionMatrix()
  }
  window.addEventListener("resize", resize)

  const host: SceneHost = {
    renderer, scene, camera, world, effects, rig, quality, aircraftLoaded, stats,
    setFrame(fn) {
      frameFn = fn
      if (!fn) rig.setMode("menu")
    },
    setQuality(q) {
      host.quality = q
      post?.dispose()
      post = null
      renderer.setPixelRatio(pixelRatio(q))
      if (q !== "low") post = new PostPass(renderer)
      resize()
      world.setQuality(q)
      effects.setQuality(q)
      camera.far = world.far
      camera.updateProjectionMatrix()
    },
    groundAt: groundHeight,
    thumbnail(kind, team) {
      const key = `${kind}:${team}`
      let p = thumbs.get(key)
      if (!p) { p = aircraftLoaded.then(() => renderThumb(kind, team)).catch(() => null); thumbs.set(key, p) }
      return p
    },
    setSpeedFx(kmh, boost) {
      speedKmh = kmh
      boosting = boost
    },
  }

  // ---- aircraft thumbnails (offscreen, same renderer; one-off per kind+team)
  const thumbs = new Map<string, Promise<string | null>>()
  const renderThumb = async (kind: VehicleKind, team: TeamId): Promise<string | null> => {
    if (!aircraftReady(kind)) return null
    const W = 480, H = 300
    const sc = new Scene()
    sc.add(new HemisphereLight("#c9dcf2", "#d9cdb0", 1.3), new AmbientLight("#ffffff", 0.15))
    const sun = new DirectionalLight("#ffe9cc", 2.6)
    sun.position.set(0.55, 0.55, 0.62).multiplyScalar(100)
    sc.add(sun)
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
    // 3/4 front view from slightly above (nose = -Z).
    cam.position.set(c.x - size * 0.72, c.y + size * 0.42, c.z - size * 0.92)
    cam.lookAt(c)
    cam.updateMatrixWorld()
    const rt = new WebGLRenderTarget(W, H, { samples: 4, type: UnsignedByteType, colorSpace: SRGBColorSpace })
    const prevBg = sc.background
    const prevClear = renderer.getClearColor(new Color()), prevAlpha = renderer.getClearAlpha()
    renderer.setRenderTarget(rt)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(sc, cam)
    renderer.setRenderTarget(null)
    renderer.setClearColor(prevClear, prevAlpha)
    sc.background = prevBg
    const px = new Uint8Array(W * H * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, px)
    rt.dispose()
    view.dispose()
    const cv = document.createElement("canvas")
    cv.width = W; cv.height = H
    const g = cv.getContext("2d")!
    const img = g.createImageData(W, H)
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4)
    g.putImageData(img, 0, 0)
    return cv.toDataURL("image/png")
  }

  // ---- sense of speed
  let speedKmh = 0
  let boosting = false
  let fovBoost = 0
  let streakAmt = 0
  const streaks = makeStreaks()
  scene.add(streaks.mesh)

  const loop = () => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const time = now / 1000
    frame++
    if (frameFn) frameFn(dt, time)
    else {
      rig.setMode("menu")
      rig.orbit(dt, [0, 0, 0], 7000, 1400, 0.018)
      rig.apply(dt)
    }
    fovBoost += ((boosting && frameFn ? 6 : 0) - fovBoost) * (1 - Math.exp(-dt * 3))
    rig.baseFov = 62 + fovBoost
    streakAmt += ((frameFn ? Math.min(1, Math.max(0, (speedKmh - 600) / 300)) : 0) - streakAmt) * (1 - Math.exp(-dt * 4))
    streaks.mesh.visible = streakAmt > 0.01
    if (streaks.mesh.visible) {
      streaks.mat.uniforms.uTime.value = time
      streaks.mat.uniforms.uSpeed.value = speedKmh / 3.6
      streaks.mat.uniforms.uOpacity.value = streakAmt * 0.22
    }
    world.update(camera.position, dt, time)
    effects.update(dt, time, camera)
    renderer.info.reset()
    if (post) {
      post.menu = !frameFn
      post.render(renderer, scene, camera)
    } else renderer.render(scene, camera)
    const t1 = performance.now()
    stats.frameMs += (t1 - now - stats.frameMs) * 0.05
    fpsFrames++
    if (t1 - fpsT >= 1000) {
      stats.fps = (fpsFrames * 1000) / (t1 - fpsT)
      fpsFrames = 0
      fpsT = t1
      stats.drawCalls = renderer.info.render.calls
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
  renderer.setAnimationLoop(loop)
  if (import.meta.env.DEV) {
    const w = window as unknown as { __wingsHost: SceneHost; __wingsPost: (on: boolean) => void }
    w.__wingsHost = host
    w.__wingsPost = on => { if (!on && post) { post.dispose(); post = null } else if (on && !post) { post = new PostPass(renderer); post.resize(renderer) } }
  }
  return host
}
