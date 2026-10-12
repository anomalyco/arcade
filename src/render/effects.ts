// Pooled, bounded combat effects for the STORMFRONT look, as node materials (WebGPU / WebGL2 via TSL).
// Every particle is animated analytically on the GPU from its spawn parameters (position, size, colour and
// fade are functions of age), so the CPU only writes newly spawned instances into ring buffers and there is
// no per-frame simulation cost at all — cheaper than a compute pass and identical on both backends.
//  - glow:    additive HDR billboards (flashes, sparks, muzzle stars, flare cores, missile motors) → bloom
//  - smoke:   soft noise-edged billboards, dark and heavy; fire puffs are emissive (HDR) smoke
//  - debris:  tumbling chunks on ballistic arcs with cooling embers
//  - tracers: camera-facing ribbons (bullets: CPU-positioned each frame; AA: self-animating)
// Import convention: classes from "three/webgpu", TSL from "three/tsl".
import {
  AdditiveBlending, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry,
  InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, NormalBlending, PlaneGeometry,
  Sprite, SpriteNodeMaterial, TetrahedronGeometry, Vector3, type BufferGeometry, type Camera, type Object3D,
} from "three/webgpu"
import {
  abs, cameraPosition, cross, dot, exp, float, Fn, instancedDynamicBufferAttribute, length, max, min, mix, mx_noise_float, normalize, normalLocal,
  normalView, positionGeometry, positionLocal, positionViewDirection, pow, saturate, smoothstep, step, uniform, uv, vec3, vec4,
} from "three/tsl"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type { Quality, Vec3 } from "../sim/types"

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

/** Shared clock (seconds) for every effect material. */
const uTime = uniform(0)
/** HDR gain for emissive effects: well above the bloom threshold so fire and tracers glow. */
const GLOW_GAIN = 5
/** Cap on any effect's HDR output so stacked effects can't drive bloom to white-out. */
const EFFECT_HDR_MAX = 4
const FIRE_GAIN = 3.2

/** Instanced attribute ring buffer; draws only up to the high-water mark and nothing once all have expired. */
class Ring {
  readonly arrays: Float32Array[]
  readonly attrs: InstancedBufferAttribute[]
  readonly nodes: N[]
  head = 0
  private maxEnd = 0
  private hwm = 0
  private lo = Infinity
  private hi = -1
  constructor(readonly capacity: number, layout: number[], dead: number) {
    this.arrays = layout.map(n => new Float32Array(capacity * n))
    this.attrs = layout.map((n, k) => {
      const a = new InstancedBufferAttribute(this.arrays[k], n)
      a.setUsage(DynamicDrawUsage)
      return a
    })
    this.nodes = this.attrs.map((a, k) => instancedDynamicBufferAttribute(a, (["float", "vec2", "vec3", "vec4"] as const)[layout[k] - 1]))
    // Everything starts dead (life ~0).
    for (let i = 0; i < capacity; i++) this.arrays[dead][i * 4 + 1] = 1e-3
  }
  next(end: number): number {
    if (end > this.maxEnd) this.maxEnd = end
    const i = this.head
    if (i >= this.hwm) this.hwm = i + 1
    this.head = (this.head + 1) % this.capacity
    if (i < this.lo) this.lo = i
    if (i > this.hi) this.hi = i
    return i
  }
  /** Instance count to draw this frame (0 = skip the draw). */
  flush(now: number): number {
    if (this.hi >= 0) {
      for (const a of this.attrs) {
        a.clearUpdateRanges()
        a.addUpdateRange(this.lo * a.itemSize, (this.hi - this.lo + 1) * a.itemSize)
        a.needsUpdate = true
      }
      this.lo = Infinity
      this.hi = -1
    }
    return now > this.maxEnd ? 0 : this.hwm
  }
}

const PARTICLE_LAYOUT = [3, 3, 4, 4, 4, 4] // pos, vel, t(start, life, s0, s1), c0, c1, phys(drag, gravity, seed, grow)

/** Shared kinematics: centre, normalised age and liveness. */
function kinematics(r: Ring) {
  const [pos, vel, t, , , phys] = r.nodes
  const age = uTime.sub(t.x)
  const k = age.div(t.y)
  const alive = step(0, k).mul(step(k, 1))
  const drag = max(phys.x, 1e-4)
  const disp = vel.mul(float(1).sub(exp(drag.negate().mul(age)))).div(drag)
  const center = pos.add(disp).add(vec3(0, phys.y.mul(0.5).mul(age).mul(age), 0))
  return { age, k, alive, center }
}

function glowMaterial(r: Ring): SpriteNodeMaterial {
  const [, , t, c0, c1, phys] = r.nodes
  const { k, alive, center } = kinematics(r)
  const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false })
  m.positionNode = center
  m.scaleNode = mix(t.z, t.w, float(1).sub(float(1).sub(k).mul(float(1).sub(k)))).mul(alive)
  m.rotationNode = phys.z.mul(6.2831)
  // Glows right next to the camera (hits on your own airframe) would fill the screen: fade them in from 12–45 m.
  const camFade = smoothstep(12, 45, length(center.sub(cameraPosition)))
  m.colorNode = Fn(() => {
    const p = uv().sub(0.5)
    const d = length(p).mul(2)
    const core = pow(saturate(float(1).sub(d)), 2.2)
    // Faint four-point glint: a lens-like star rather than a blurry blob.
    const star = saturate(float(1).sub(abs(p.x).mul(14))).mul(saturate(float(1).sub(abs(p.y).mul(2.2))))
      .add(saturate(float(1).sub(abs(p.y).mul(14))).mul(saturate(float(1).sub(abs(p.x).mul(2.2)))))
    const col: N = mix(c0, c1, k)
    const hot = col.rgb.add(vec3(smoothstep(0.35, 0, d).mul(0.8)))
    return vec4(min(hot.mul(GLOW_GAIN), vec3(EFFECT_HDR_MAX)) as N, core.add(star.mul(0.3)).mul(col.a).mul(camFade))
  })()
  return m
}

function smokeMaterial(r: Ring): SpriteNodeMaterial {
  const [, , t, c0, c1, phys] = r.nodes
  const { age, k, alive, center } = kinematics(r)
  const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: NormalBlending })
  m.positionNode = center
  // Inflate fast, keep growing slowly; the puff dissolves by alpha (soft billboards).
  const rate = max(phys.w, 0.25)
  const grow = float(1).sub(pow(float(1).sub(min(k.mul(rate), 1)), 3))
  m.scaleNode = mix(t.z, t.w, grow).mul(alive)
  m.colorNode = Fn(() => {
    const p = uv().sub(0.5)
    const d = length(p).mul(2)
    const n: N = (mx_noise_float as N)((vec3 as N)(uv().mul(2.6).add(phys.z.mul(17)), age.mul(0.35).add(phys.z.mul(5))))
    const edge = smoothstep(1, 0.15, d.add(n.mul(0.22)))
    // Overcast light from above: tops a little lighter, undersides dark.
    const shade = mix(float(0.55), float(1.05), saturate(uv().y.add(n.mul(0.25))))
    const col: N = mix(c0, c1, k)
    const emissive = col.a
    const rgb = col.rgb.mul(mix(shade, float(FIRE_GAIN), emissive))
    const fade = smoothstep(0, 0.06, k).mul(float(1).sub(smoothstep(0.5, 1, k)))
    // Fire stays dense; smoke a touch lighter in density so stacked puffs stay readable.
    return vec4(rgb, edge.mul(fade).mul(mix(float(0.82), float(1), emissive)))
  })()
  return m
}

/** Camera-facing ribbon between tail and head (world space); `x` across ∈ [-0.5, 0.5], `along` ∈ [0, 1]. */
function ribbon(head: N, tail: N, width: N, distWidth = 0.0014): N {
  const along = positionGeometry.y.add(0.5)
  const p = mix(tail, head, along)
  const side = normalize(cross(head.sub(tail), p.sub(cameraPosition)).add(vec3(1e-5, 0, 0)))
  const w = max(width, length(p.sub(cameraPosition)).mul(distWidth))
  return p.add(side.mul(positionGeometry.x.mul(2).mul(w)))
}

function tracerColor(color: N, gain = GLOW_GAIN): N {
  const f = float(1).sub(abs(positionGeometry.x.mul(2)))
  const along = positionGeometry.y.add(0.5)
  const core = smoothstep(0.45, 0.95, f)
  const fade = smoothstep(0, 0.75, along)
  const col = mix(color, vec3(1, 0.93, 0.78).mul(1.6), core)
  return vec4(min(col.mul(f.mul(f).mul(f)).mul(fade).mul(gain), vec3(EFFECT_HDR_MAX)), 1)
}

const c = (hex: string) => new Color(hex)
// Storm palette: fire is the brightest thing on screen; smoke is dark and heavy.
const FIRE_A = c("#fff1c4"), FIRE_B = c("#ffae3a"), FIRE_C = c("#ff5a14")
const BALL_A = c("#ffd060"), BALL_B = c("#ff8c1f")
const SMOKE_BLACK = c("#1d1f20"), SMOKE_DARK = c("#2c2f30"), SMOKE_MID = c("#4a4e4f"), SMOKE_PALE = c("#6b7072")
const SMOKE_TRAIL = c("#8a8f90"), SMOKE_TRAIL_END = c("#5e6365")
const SPARK = c("#ffd88a"), SPARK_B = c("#ff8a2a")
const FLARE_A = c("#fff6dc"), FLARE_B = c("#ffb060")
const WHITE = c("#ffffff")
const WATER_WHITE = c("#dfe6e4"), WATER_FADE = c("#a9b4b2"), DIRT = c("#5a5144"), DUST = c("#9a9282")
const DEBRIS_COLS = [c("#3e4244"), c("#55595b"), c("#2b2e30"), c("#6a6e70")]
const _tmp = new Color()

export interface TracerSource { position: Vec3; velocity: Vec3; color: Color }

export interface Effects {
  root: Object3D
  /** Call once per frame; time = seconds (monotonic). */
  update(dt: number, time: number, camera: Camera): void
  explosion(p: Vec3, size: number): void
  hit(p: Vec3): void
  muzzle(p: Vec3, dir: Vec3): void
  /** Ship anti-air fire from `muzzle` toward `aim`: CIWS = burst of short bright tracers, gun = flash + shell. */
  aa(muzzle: Vec3, aim: Vec3, kind: "ciws" | "gun"): void
  /** Flak burst (5-inch AA shell): flash + dark smoke. */
  flak(p: Vec3): void
  /** Hit on a ship hull: heavy flash, fireball scaled by damage, dark smoke column, sparks. */
  shipHit(p: Vec3, damage: number): void
  /** Shell/missile/aircraft impact on water: white column + spray, ripple rings and a fading foam patch. */
  splash(p: Vec3, size: number): void
  /** Impact on land: dirt and dust, a small flash and a short fire. */
  groundHit(p: Vec3, size: number): void
  /** Small spray puff (bullet into water) or dust puff (bullet into ground). */
  spray(p: Vec3, water: boolean): void
  pulse(p: Vec3, radius: number, color: string): void
  /** Persistent smoke trail emitter (missiles). Call each frame with the current position. */
  trail(id: number, p: Vec3, heavy: boolean): void
  flare(p: Vec3, dt: number): void
  /** Damage smoke from a burning airframe. */
  damageSmoke(p: Vec3, vel: Vec3, severity: number, dt: number): void
  /** Set this frame's tracers (bullets). Up to the tracer capacity; extra are dropped. */
  setTracers(count: number, write: (i: number, pos: Float32Array, dir: Float32Array, col: Float32Array) => void): void
  setMissiles(count: number, write: (i: number, m: Matrix4) => void): void
  /** Falling bombs (dark finned bodies). */
  setBombs(count: number, write: (i: number, m: Matrix4) => void): void
  setQuality(q: Quality): void
  dispose(): void
}

function missileGeometry(): BufferGeometry {
  const body = new CylinderGeometry(0.2, 0.2, 2.6, 8)
  const nose = new ConeGeometry(0.2, 0.6, 8)
  nose.translate(0, 1.6, 0)
  const parts: BufferGeometry[] = [body, nose]
  for (let i = 0; i < 4; i++) {
    const fin = new BoxGeometry(0.05, 0.5, 0.36)
    fin.translate(0, -1.05, 0.3)
    fin.rotateY((i * Math.PI) / 2 + Math.PI / 4)
    parts.push(fin)
  }
  const g = mergeGeometries(parts.map(p => p.toNonIndexed()))!
  parts.forEach(p => p.dispose())
  // The game orients instances with lookAt(behind, position): local +Z points backwards, so the nose goes to -Z.
  g.rotateX(-Math.PI / 2)
  return g
}

/** Rodrigues rotation of v about unit axis k by angle a. */
const rotateAxis = (v: N, k: N, a: N): N => v.mul(a.cos()).add(cross(k, v).mul(a.sin())).add(k.mul(dot(k, v)).mul(float(1).sub(a.cos())))

export function createEffects(quality: Quality): Effects {
  const root = new Group()
  root.name = "effects"
  let density = quality === "low" ? 0.5 : quality === "balanced" ? 0.8 : 1
  const rnd = (a: number) => (Math.random() * 2 - 1) * a
  let now = 0
  let frame = 0

  // ---- particle pools
  const glowR = new Ring(quality === "low" ? 1536 : 3072, PARTICLE_LAYOUT, 2)
  const glowSprite = new Sprite(glowMaterial(glowR))
  const smokeR = new Ring(quality === "low" ? 1536 : 3072, PARTICLE_LAYOUT, 2)
  const smokeSprite = new Sprite(smokeMaterial(smokeR))
  for (const s of [glowSprite, smokeSprite]) { s.frustumCulled = false; s.count = 0 }
  smokeSprite.renderOrder = 2
  glowSprite.renderOrder = 3

  const emitTo = (r: Ring) => (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    c0: Color, a0: number, c1: Color, a1: number, drag: number, gravity: number, grow = 2.5, delay = 0) => {
    const i = r.next(now + delay + life)
    const [pos, vel, t, col0, col1, phys] = r.arrays
    const i3 = i * 3, i4 = i * 4
    pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z
    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz
    t[i4] = now + delay; t[i4 + 1] = life; t[i4 + 2] = s0; t[i4 + 3] = s1
    col0[i4] = c0.r; col0[i4 + 1] = c0.g; col0[i4 + 2] = c0.b; col0[i4 + 3] = a0
    col1[i4] = c1.r; col1[i4 + 1] = c1.g; col1[i4 + 2] = c1.b; col1[i4 + 3] = a1
    phys[i4] = drag; phys[i4 + 1] = gravity; phys[i4 + 2] = Math.random(); phys[i4 + 3] = grow
  }
  const glow = emitTo(glowR)
  const smoke = emitTo(smokeR)

  // ---- debris: tumbling chunks with cooling embers
  const DEBRIS = 384
  const debrisR = new Ring(DEBRIS, [3, 3, 4, 3, 1], 2)
  const debrisMat = new MeshBasicNodeMaterial()
  {
    const [pos, vel, t, col, seed] = debrisR.nodes
    const age = uTime.sub(t.x)
    const k = age.div(t.y)
    const alive = step(0, k).mul(step(k, 1))
    const center = pos.add(vel.mul(float(1).sub(exp(age.mul(-0.6)))).div(0.6)).add(vec3(0, age.mul(age).mul(-14), 0))
    const axis = normalize(vec3(seed.mul(91.7).sin(), seed.mul(47.3).cos(), seed.mul(13.1).sin()))
    const ang = seed.mul(6.28).add(age.mul(t.w))
    const size = t.z.mul(float(1).sub(smoothstep(0.75, 1, k))).mul(alive)
    debrisMat.positionNode = center.add(rotateAxis(positionLocal.mul(vec3(1, 0.55, 1.4)), axis, ang).mul(size))
    const n = rotateAxis(normalLocal, axis, ang)
    const lit = float(0.25).add(saturate(n.y).mul(0.55))
    const ember = saturate(float(1).sub(k.mul(2.5)))
    debrisMat.colorNode = vec4(mix(col.mul(lit), vec3(1, 0.45, 0.12).mul(FIRE_GAIN), ember.mul(ember).mul(0.7)), 1)
  }
  const debrisMesh = new Mesh(new TetrahedronGeometry(1, 0), debrisMat)
  debrisMesh.frustumCulled = false
  debrisMesh.count = 0

  // ---- bullet tracers (CPU positions per frame)
  const TRACERS = 1024
  const tPos = new Float32Array(TRACERS * 3), tDir = new Float32Array(TRACERS * 3), tCol = new Float32Array(TRACERS * 3)
  const tAttrs = [tPos, tDir, tCol].map(a => { const b = new InstancedBufferAttribute(a, 3); b.setUsage(DynamicDrawUsage); return b })
  const [tpN, tdN, tcN] = tAttrs.map(a => instancedDynamicBufferAttribute(a, "vec3")) as N[]
  const tracerMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false })
  {
    const L = length(tdN)
    const dir = tdN.mul(min(L, 32).div(max(L, 1e-4)))
    tracerMat.positionNode = ribbon(tpN, tpN.sub(dir), float(0.35))
    tracerMat.colorNode = tracerColor(min(tcN, vec3(1)))
  }
  const tracers = new Mesh(new PlaneGeometry(1, 1), tracerMat)
  tracers.frustumCulled = false
  tracers.renderOrder = 4
  tracers.count = 0

  // ---- AA tracers (CIWS streams, gun shells): self-animating
  const aaR = new Ring(768, [3, 3, 4], 2)
  const aaMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false })
  {
    const [pos, vel, t] = aaR.nodes
    const age = uTime.sub(t.x)
    const alive = step(0, age).mul(step(age, t.y))
    const head = pos.add(vel.mul(age))
    const sp = max(length(vel), 1)
    const tail = head.sub(vel.div(sp).mul(min(t.z, sp.mul(age).add(0.01))))
    // Hidden within 40 m of the camera (never a streak across the lens or through the near plane).
    const near = min(length(head.sub(cameraPosition)), length(tail.sub(cameraPosition)))
    const vis = alive.mul(step(40, near))
    aaMat.positionNode = ribbon(head, tail, t.w, 0.0005).mul(vis).add(vec3(0, float(1).sub(vis).mul(-1e5), 0))
    // Just above the bloom threshold: readable streaks, not light sabres.
    aaMat.colorNode = tracerColor(vec3(1, 0.62, 0.28), 1.3).mul(vec4(vec3(smoothstep(40, 120, near)), 1))
  }
  const aaMesh = new Mesh(new PlaneGeometry(1, 1), aaMat)
  aaMesh.frustumCulled = false
  aaMesh.renderOrder = 4
  aaMesh.count = 0
  const aaTracer = (p: Vec3, vx: number, vy: number, vz: number, life: number, len: number, width: number, delay = 0) => {
    const i = aaR.next(now + delay + life)
    const [a0, a1, a2] = aaR.arrays
    a0[i * 3] = p[0]; a0[i * 3 + 1] = p[1]; a0[i * 3 + 2] = p[2]
    a1[i * 3] = vx; a1[i * 3 + 1] = vy; a1[i * 3 + 2] = vz
    a2[i * 4] = now + delay; a2[i * 4 + 1] = life; a2[i * 4 + 2] = len; a2[i * 4 + 3] = width
  }

  // ---- missile bodies: matte gray darts with fins
  const MISSILES = 96
  const mgeo = missileGeometry()
  const mmat = new MeshStandardNodeMaterial({ color: "#9a9e9f", roughness: 0.55, metalness: 0.2 })
  const missiles = new InstancedMesh(mgeo, mmat, MISSILES)
  missiles.instanceMatrix.setUsage(DynamicDrawUsage)
  missiles.count = 0
  missiles.frustumCulled = false
  const BOMBS = 48
  const bgeo = missileGeometry()
  bgeo.scale(2.2, 2.2, 1.5)
  const bmat = new MeshStandardNodeMaterial({ color: "#3a3e3c", roughness: 0.6, metalness: 0.2 })
  const bombsMesh = new InstancedMesh(bgeo, bmat, BOMBS)
  bombsMesh.instanceMatrix.setUsage(DynamicDrawUsage)
  bombsMesh.count = 0
  bombsMesh.frustumCulled = false

  // ---- expanding shells: radar pulses and shockwaves (rim-lit)
  const shellGeo = new IcosahedronGeometry(1, 3)
  interface Shell { mesh: Mesh; uColor: N; uOpacity: N; start: number; life: number; radius: number; active: boolean; opacity: number }
  const shells: Shell[] = []
  for (let i = 0; i < 10; i++) {
    const uColor = uniform(new Color()), uOpacity = uniform(0)
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false })
    const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3)
    mat.colorNode = vec4(uColor.mul(rim).mul(uOpacity).mul(2), 1)
    const mesh = new Mesh(shellGeo, mat)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 5
    root.add(mesh)
    shells.push({ mesh, uColor, uOpacity, start: 0, life: 1, radius: 1, active: false, opacity: 1 })
  }
  let shellNext = 0
  const shell = (p: Vec3, radius: number, life: number, color: Color | string, opacity: number) => {
    const s = shells[shellNext]
    shellNext = (shellNext + 1) % shells.length
    Object.assign(s, { active: true, start: now, life, radius, opacity })
    s.mesh.position.set(p[0], p[1], p[2])
    s.mesh.visible = true
    s.uColor.value.set(color)
  }

  // ---- water decals: expanding ripple rings + fading foam patches lying on the sea surface.
  const decalR = new Ring(128, [3, 4], 1) // pos, t(start, life, size, kind 0 = ring / 1 = foam)
  const decalMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide })
  {
    const [pos, t] = decalR.nodes
    const age = uTime.sub(t.x)
    const k = age.div(t.y)
    const alive = step(0, k).mul(step(k, 1))
    const foam = t.w
    // Rings expand fast and ease out; foam spreads a little and lingers.
    const r = t.z.mul(mix(float(1).sub(pow(float(1).sub(k), 2)).mul(1.0).add(0.15), k.mul(0.5).add(0.6), foam))
    decalMat.positionNode = pos.add(vec3(positionGeometry.x, 0, positionGeometry.y).mul(r.mul(2)).mul(alive))
    decalMat.colorNode = Fn(() => {
      const d = length(uv().sub(0.5)).mul(2)
      const ring = smoothstep(0.78, 0.9, d).mul(smoothstep(1, 0.92, d))
      const n: N = (mx_noise_float as N)((vec3 as N)(uv().mul(7), t.x))
      const patch = smoothstep(1, 0.2, d.add(n.mul(0.35))).mul(smoothstep(-0.2, 0.4, n.add(0.2)))
      const a = mix(ring.mul(0.55), patch.mul(0.4), foam).mul(float(1).sub(k)).mul(alive)
      return vec4(vec3(0.82, 0.86, 0.85), a)
    })()
  }
  const decalMesh = new Mesh(new PlaneGeometry(1, 1), decalMat)
  decalMesh.frustumCulled = false
  decalMesh.count = 0
  decalMesh.renderOrder = 1
  const decal = (p: Vec3, size: number, life: number, foam: boolean, delay = 0) => {
    const i = decalR.next(now + delay + life)
    const [pos, t] = decalR.arrays
    pos[i * 3] = p[0]; pos[i * 3 + 1] = 0.6; pos[i * 3 + 2] = p[2]
    t[i * 4] = now + delay; t[i * 4 + 1] = life; t[i * 4 + 2] = size; t[i * 4 + 3] = foam ? 1 : 0
  }

  root.add(decalMesh, smokeSprite, debrisMesh, missiles, bombsMesh, glowSprite, tracers, aaMesh)

  function debris(p: Vec3, n: number, speed: number, size: number) {
    const [pos, vel, t, col, seed] = debrisR.arrays
    for (let k = 0; k < n; k++) {
      const life = 1.6 + Math.random() * 1.4
      const i = debrisR.next(now + life)
      const i3 = i * 3, i4 = i * 4
      pos[i3] = p[0]; pos[i3 + 1] = p[1]; pos[i3 + 2] = p[2]
      vel[i3] = rnd(speed); vel[i3 + 1] = rnd(speed) * 0.6 + speed * 0.45; vel[i3 + 2] = rnd(speed)
      t[i4] = now; t[i4 + 1] = life; t[i4 + 2] = size * (0.5 + Math.random()); t[i4 + 3] = 4 + Math.random() * 8
      const cc = DEBRIS_COLS[(Math.random() * DEBRIS_COLS.length) | 0]
      col[i3] = cc.r; col[i3 + 1] = cc.g; col[i3 + 2] = cc.b
      seed[i] = Math.random()
    }
  }

  // Burning wrecks: big chunks that fall trailing fire and smoke (same arc as the debris shader).
  interface Wreck { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; last: number }
  const wrecks: Wreck[] = []
  const _wp = [0, 0, 0]
  const wreckPos = (w: Wreck, age: number) => {
    const k = (1 - Math.exp(-0.6 * age)) / 0.6
    _wp[0] = w.x + w.vx * k; _wp[1] = w.y + w.vy * k - 14 * age * age; _wp[2] = w.z + w.vz * k
  }

  const trails = new Map<number, { x: number; y: number; z: number; seen: number }>()

  return {
    root,
    update(_dt, time, _camera) {
      now = time
      uTime.value = time
      frame++
      glowSprite.count = glowR.flush(now)
      smokeSprite.count = smokeR.flush(now)
      debrisMesh.count = debrisR.flush(now)
      aaMesh.count = aaR.flush(now)
      decalMesh.count = decalR.flush(now)
      for (const s of shells) {
        if (!s.active) continue
        const t = (now - s.start) / s.life
        if (t >= 1) { s.active = false; s.mesh.visible = false; continue }
        s.mesh.scale.setScalar(Math.max(0.01, s.radius * (1 - Math.pow(1 - t, 3))))
        s.uOpacity.value = s.opacity * (1 - t) * (1 - t)
      }
      for (let i = wrecks.length - 1; i >= 0; i--) {
        const w = wrecks[i]
        const age = now - w.t0
        if (age > w.life * 0.92) { wrecks.splice(i, 1); continue }
        if (now - w.last < 0.035) continue
        w.last = now
        wreckPos(w, age)
        const burn = 1 - age / w.life
        smoke(_wp[0], _wp[1], _wp[2], rnd(0.6), 0.5, rnd(0.6), 0.35, 1.4 * burn + 0.6, 2.2 * burn + 0.8, BALL_B, 1, FIRE_C, 0.8, 1, 0, 8)
        if (Math.random() < density) smoke(_wp[0], _wp[1], _wp[2], rnd(0.8), 1.5, rnd(0.8), 2.4 + Math.random(), 1.2, 4.5, SMOKE_DARK, 0, SMOKE_MID, 0, 0.8, 1.2, 1.5)
      }
      if (frame % 30 === 0) for (const [id, t] of trails) if (now - t.seen > 1) trails.delete(id)
    },

    explosion(p, size) {
      const air = size >= 12 || size <= 1
      const s = air ? 9 : Math.max(4, Math.min(16, size))
      glow(p[0], p[1], p[2], 0, 0, 0, 0.12, s * 1.6, s * 2.8, WHITE, 0.7, BALL_A, 0, 0, 0)
      // Fireball: emissive puffs held near full size, then heavy dark smoke rolls in 0.3 s later.
      const nf = Math.round((air ? 12 : 7 + s * 0.4) * density) + 3
      for (let i = 0; i < nf; i++) {
        const v = s * 0.9
        const r = s * (0.5 + Math.random() * 0.4)
        smoke(p[0] + rnd(s * 0.35), p[1] + rnd(s * 0.3), p[2] + rnd(s * 0.35), rnd(v), rnd(v) + s * 0.2, rnd(v),
          0.6 + Math.random() * 0.15, r * 0.9, r * 1.25, i % 3 === 0 ? BALL_A : i % 3 === 1 ? BALL_B : FIRE_C, 1, FIRE_C, 1, 4, 0, 12)
      }
      const ns = Math.round((air ? 18 : 9 + s * 0.6) * density) + 3
      for (let i = 0; i < ns; i++) {
        const v = s * 0.6
        const r = s * (0.3 + Math.random() * 0.25)
        _tmp.copy(SMOKE_BLACK).lerp(SMOKE_DARK, Math.random())
        smoke(p[0] + rnd(s * 0.5), p[1] + rnd(s * 0.35), p[2] + rnd(s * 0.5), rnd(v), rnd(v * 0.5) + s * 0.25, rnd(v),
          3 + Math.random() * 2.5, r * 0.8, r * 2.2, _tmp, 0, SMOKE_MID, 0, 1.2, 1.5, 1.2, 0.3 + Math.random() * 0.15)
      }
      const nk = Math.round((5 + s * 0.5) * density)
      for (let i = 0; i < nk; i++) {
        const v = 35 + s * 5
        glow(p[0], p[1], p[2], rnd(v), rnd(v) + 10, rnd(v), 0.4 + Math.random() * 0.4, 0.7, 0.2, SPARK, 0.8, SPARK_B, 0, 1, -25)
      }
      if (air) {
        debris(p, Math.round(8 * density) + 3, 30, 0.7)
        const n = 2 + (Math.random() < 0.5 ? 1 : 0)
        for (let i = 0; i < n; i++) {
          const life = 2.2 + Math.random() * 0.8
          const vx = rnd(22), vy = 8 + Math.random() * 14, vz = rnd(22)
          debris(p, 1, 0, 0.9)
          const j = (debrisR.head - 1 + DEBRIS) % DEBRIS
          const [, vel, t] = debrisR.arrays
          vel[j * 3] = vx; vel[j * 3 + 1] = vy; vel[j * 3 + 2] = vz; t[j * 4 + 1] = life
          if (wrecks.length < 12) wrecks.push({ x: p[0], y: p[1], z: p[2], vx, vy, vz, t0: now, life, last: now })
        }
      } else debris(p, Math.round(4 * density) + 1, 18 + s, 0.45)
      shell(p, s * 3.5, 0.3, "#ffd8a8", 0.25)
    },

    hit(p) {
      glow(p[0], p[1], p[2], 0, 0, 0, 0.06, 3.5, 4.5, WHITE, 0.8, WHITE, 0.4, 0, 0)
      glow(p[0], p[1], p[2], 0, 0, 0, 0.12, 2, 3, FIRE_A, 0.8, SPARK, 0, 0, 0)
      const n = Math.round(4 * density) + 2
      for (let i = 0; i < n; i++) glow(p[0], p[1], p[2], rnd(55), rnd(55), rnd(55), 0.25 + Math.random() * 0.3, 0.9, 0.2, SPARK, 1, SPARK_B, 0, 1, -20)
      smoke(p[0], p[1], p[2], rnd(1.5), 1.2, rnd(1.5), 1.8, 1, 3, SMOKE_MID, 0, SMOKE_PALE, 0, 0.8, 0.8, 1.5)
      if (Math.random() < 0.35 * density) debris(p, 1, 14, 0.25)
    },

    muzzle(p, dir) {
      glow(p[0] + dir[0] * 2, p[1] + dir[1] * 2, p[2] + dir[2] * 2, 0, 0, 0, 0.05, 2.8, 1.5, FIRE_A, 1, FIRE_B, 0, 0, 0)
    },

    aa(m, aim, kind) {
      const dx = aim[0] - m[0], dy = aim[1] - m[1], dz = aim[2] - m[2]
      const d = Math.hypot(dx, dy, dz) || 1
      const ux = dx / d, uy = dy / d, uz = dz / d
      if (kind === "ciws") {
        // The stream is ~70 rds/s; draw only every third round, thin (0.25 m) and short.
        const speed = 1100, n = 2 + (Math.random() < 0.4 ? 1 : 0)
        for (let k = 0; k < n; k++) {
          const sp = 0.01
          aaTracer(m, (ux + rnd(sp)) * speed, (uy + rnd(sp)) * speed, (uz + rnd(sp)) * speed, Math.min(2.2, (d / speed) * 1.1), 10, 0.25, k * 0.035)
        }
        glow(m[0] + ux * 2, m[1] + uy * 2, m[2] + uz * 2, 0, 0, 0, 0.05, 1.6, 0.8, FIRE_A, 0.7, FIRE_B, 0, 0, 0)
      } else {
        const speed = 800
        aaTracer(m, ux * speed, uy * speed, uz * speed, Math.min(3, d / speed), 14, 0.3)
        glow(m[0] + ux * 4, m[1] + uy * 4, m[2] + uz * 4, 0, 0, 0, 0.1, 4, 2.5, FIRE_A, 0.8, FIRE_B, 0, 0, 0)
        smoke(m[0] + ux * 6, m[1] + uy * 6, m[2] + uz * 6, ux * 6, uy * 6 + 1, uz * 6, 1.8, 2, 6, SMOKE_MID, 0, SMOKE_PALE, 0, 0.8, 0.6, 1.5)
      }
    },

    shipHit(p, damage) {
      if (damage < 40) { this.hit(p); return }
      const s = Math.max(6, Math.min(22, 5 + damage / 60))
      this.explosion(p, s)
      const n = Math.round((6 + s * 0.4) * density)
      for (let i = 0; i < n; i++) {
        _tmp.copy(SMOKE_BLACK).lerp(SMOKE_DARK, Math.random())
        smoke(p[0] + rnd(s * 0.4), p[1] + rnd(2), p[2] + rnd(s * 0.4), rnd(2), 6 + Math.random() * 6, rnd(2), 5 + Math.random() * 3, s * 0.5, s * 2.6, _tmp, 0, SMOKE_MID, 0, 0.5, 1.2, 1, 0.25 + i * 0.05)
      }
    },

    splash(p, size) {
      const s = Math.max(3, Math.min(30, size))
      const x = p[0], z = p[2]
      // White water column: tall, fast-rising spray puffs that fall back under gravity.
      const nc = Math.round((10 + s * 0.8) * density) + 4
      for (let i = 0; i < nc; i++) {
        const up = s * (2.2 + Math.random() * 2.2)
        smoke(x + rnd(s * 0.25), 0.5, z + rnd(s * 0.25), rnd(s * 0.6), up, rnd(s * 0.6), 1.6 + Math.random() * 0.8, s * 0.25, s * (0.55 + Math.random() * 0.4), WATER_WHITE, 0, WATER_FADE, 0, 0.4, -9.8, 3)
      }
      // Low spray skirt.
      const ns = Math.round((8 + s * 0.5) * density) + 3
      for (let i = 0; i < ns; i++) {
        const a = Math.random() * Math.PI * 2, v = s * (1.2 + Math.random())
        smoke(x, 0.6, z, Math.cos(a) * v, s * 0.4 + Math.random() * s * 0.3, Math.sin(a) * v, 1.2 + Math.random() * 0.6, s * 0.2, s * 0.6, WATER_WHITE, 0, WATER_FADE, 0, 1.2, -6, 2)
      }
      glow(x, 1, z, 0, 0, 0, 0.08, s * 0.8, s * 1.4, WHITE, 0.25, WHITE, 0, 0, 0)
      decal(p, s * 2.2, 1.6, false)
      decal(p, s * 3.4, 2.4, false, 0.25)
      decal(p, s * 1.5, 7, true)
    },

    groundHit(p, size) {
      const s = Math.max(3, Math.min(28, size))
      glow(p[0], p[1] + 1, p[2], 0, 0, 0, 0.1, s * 1.2, s * 2.2, FIRE_A, 1, FIRE_B, 0, 0, 0)
      const nd = Math.round((8 + s * 0.6) * density) + 3
      for (let i = 0; i < nd; i++) {
        _tmp.copy(DIRT).lerp(DUST, Math.random())
        // Lifted above the surface so the soft billboards aren't half-buried in the slope.
        smoke(p[0] + rnd(s * 0.3), p[1] + s * 0.4, p[2] + rnd(s * 0.3), rnd(s * 0.9), s * (1 + Math.random() * 1.6), rnd(s * 0.9), 2.2 + Math.random() * 1.5, s * 0.5, s * (1 + Math.random() * 0.7), _tmp, 0, DUST, 0, 1.4, -3, 2)
      }
      const nf = Math.round(3 * density) + 2
      for (let i = 0; i < nf; i++) smoke(p[0] + rnd(s * 0.3), p[1] + 0.5, p[2] + rnd(s * 0.3), rnd(1), 1.5 + Math.random(), rnd(1), 0.9 + Math.random() * 0.6, s * 0.2, s * 0.45, BALL_A, 1, FIRE_C, 0.8, 1, 0, 6)
      smoke(p[0], p[1] + 1, p[2], rnd(1), 2.5, rnd(1), 4, s * 0.4, s * 1.4, SMOKE_DARK, 0, SMOKE_MID, 0, 0.6, 0.8, 1.2, 0.4)
      debris(p, Math.round(4 * density) + 1, 12 + s, 0.35)
    },

    spray(p, water) {
      if (water) {
        for (let i = 0; i < 3; i++) smoke(p[0] + rnd(0.6), 0.4, p[2] + rnd(0.6), rnd(1.5), 5 + Math.random() * 4, rnd(1.5), 0.8 + Math.random() * 0.3, 0.4, 1.4, WATER_WHITE, 0, WATER_FADE, 0, 0.6, -9.8, 3)
        if (Math.random() < 0.35 * density) decal(p, 2.2, 1.1, false)
      } else smoke(p[0], p[1] + 0.3, p[2], rnd(1), 2, rnd(1), 1.2, 0.5, 2, DUST, 0, DIRT, 0, 1, -1, 2)
    },

    flak(p) {
      glow(p[0], p[1], p[2], 0, 0, 0, 0.08, 2.5, 4, FIRE_A, 0.5, FIRE_B, 0, 0, 0)
      const n = Math.round(7 * density) + 3
      for (let i = 0; i < n; i++) {
        _tmp.copy(SMOKE_BLACK).lerp(SMOKE_DARK, Math.random())
        smoke(p[0] + rnd(3), p[1] + rnd(3), p[2] + rnd(3), rnd(5), rnd(4) + 1, rnd(5), 3 + Math.random() * 2, 3, 9 + Math.random() * 4, _tmp, 0, SMOKE_MID, 0, 0.9, 0.3, 2)
      }
      for (let i = 0; i < 3; i++) glow(p[0], p[1], p[2], rnd(60), rnd(60), rnd(60), 0.25 + Math.random() * 0.2, 0.6, 0.15, SPARK, 0.8, SPARK_B, 0, 1, -20)
    },

    pulse(p, radius, color) {
      shell(p, radius, 3.2, color, 0.8)
      shell(p, radius * 0.6, 2.4, "#cfe2dc", 0.45)
      glow(p[0], p[1], p[2], 0, 0, 0, 0.6, 20, 120, _tmp.set(color), 1, WHITE, 0, 0, 0)
    },

    trail(id, p, heavy) {
      let t = trails.get(id)
      if (!t) { t = { x: p[0], y: p[1], z: p[2], seen: now }; trails.set(id, t) }
      t.seen = now
      const dx = p[0] - t.x, dy = p[1] - t.y, dz = p[2] - t.z
      const d = Math.hypot(dx, dy, dz)
      // Bright motor.
      glow(p[0], p[1], p[2], 0, 0, 0, 0.07, heavy ? 3.2 : 2.4, 1.2, FIRE_A, 1, FIRE_B, 0, 0, 0)
      const spacing = (heavy ? 1.2 : 1.6) / density
      if (d < spacing) return
      const steps = Math.min(16, Math.floor(d / spacing))
      for (let i = 1; i <= steps; i++) {
        const f = (i * spacing) / d
        smoke(t.x + dx * f, t.y + dy * f, t.z + dz * f, rnd(0.5), rnd(0.5) + 0.4, rnd(0.5),
          (heavy ? 2.6 : 1.8) * (0.8 + Math.random() * 0.4), 0.9 + Math.random() * 0.4, (heavy ? 3.4 : 2.4) * (0.7 + Math.random() * 0.6), SMOKE_TRAIL, 0, SMOKE_TRAIL_END, 0, 0.6, 0.4, 1.4)
      }
      if (steps >= 16) { t.x = p[0]; t.y = p[1]; t.z = p[2] }
      else { const f = (steps * spacing) / d; t.x += dx * f; t.y += dy * f; t.z += dz * f }
    },

    flare(p, _dt) {
      glow(p[0], p[1], p[2], 0, 0, 0, 0.09, 7, 3.5, FLARE_A, 1, FLARE_B, 0.4, 0, 0)
      if (Math.random() < 0.5 * density) smoke(p[0], p[1], p[2], rnd(0.5), 0.5, rnd(0.5), 1.8, 0.8, 3, SMOKE_PALE, 0, SMOKE_MID, 0, 0.5, 0.5)
    },

    damageSmoke(p, vel, severity, dt) {
      if (Math.random() > severity * density * dt * 40) return
      _tmp.copy(SMOKE_MID).lerp(SMOKE_BLACK, severity)
      smoke(p[0], p[1], p[2], vel[0] * 0.2 + rnd(1), vel[1] * 0.2 + 1.5, vel[2] * 0.2 + rnd(1), 2.4, 1, 4 + severity * 3, _tmp, 0, SMOKE_MID, 0, 0.6, 1.5)
      if (severity > 0.6) smoke(p[0], p[1], p[2], vel[0] * 0.1, vel[1] * 0.1, vel[2] * 0.1, 0.35, 0.6, 1.6, FIRE_A, 1, FIRE_C, 0.8, 1, 0)
    },

    setTracers(count, write) {
      const n = Math.min(count, TRACERS)
      for (let i = 0; i < n; i++) write(i, tPos, tDir, tCol)
      tracers.count = n
      if (n > 0) for (const a of tAttrs) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 3); a.needsUpdate = true }
    },

    setMissiles(count, write) {
      const n = Math.min(count, MISSILES)
      for (let i = 0; i < n; i++) {
        write(i, _mat)
        missiles.setMatrixAt(i, _mat)
      }
      missiles.count = n
      if (n) missiles.instanceMatrix.needsUpdate = true
    },

    setBombs(count, write) {
      const n = Math.min(count, BOMBS)
      for (let i = 0; i < n; i++) { write(i, _mat); bombsMesh.setMatrixAt(i, _mat) }
      bombsMesh.count = n
      if (n) bombsMesh.instanceMatrix.needsUpdate = true
    },

    setQuality(q) {
      density = q === "low" ? 0.5 : q === "balanced" ? 0.8 : 1
    },

    dispose() {
      for (const o of [glowSprite, smokeSprite, debrisMesh, tracers, aaMesh, missiles]) {
        ;(o.material as { dispose(): void }).dispose()
        if (o !== glowSprite && o !== smokeSprite) o.geometry.dispose()
      }
      shellGeo.dispose()
      shells.forEach(s => (s.mesh.material as { dispose(): void }).dispose())
    },
  }
}

const _mat = new Matrix4()
void Vector3
