/// <reference types="vite/client" />
// Renderer + scene host. Loaded lazily after the lobby has painted.
import {
  BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Fog, Group, HemisphereLight, Mesh, MeshLambertMaterial, OrthographicCamera, PerspectiveCamera,
  PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace, UnsignedByteType, Vector2, WebGLRenderer, WebGLRenderTarget, type Camera,
} from "three"
import type { Quality } from "../sim/types"
import { AIRBASES, groundHeight } from "../sim/geography"
import { createWorldView, type WorldView } from "./world-view"
import { preloadAircraft } from "./aircraft"
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
  }

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
