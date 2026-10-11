// Pooled, bounded visual effects. Particles are fully GPU-animated (position/size/colour are
// functions of age in the vertex shader), so the CPU only writes new particles into a ring buffer.
import {
  AdditiveBlending, Color, CylinderGeometry, DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute,
  InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry,
  ShaderMaterial, type Camera, type Object3D,
} from "three"
import type { Quality, Vec3 } from "../sim/types"

const PARTICLE_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iT;     // start, life, size0, size1
attribute vec4 iC0;
attribute vec4 iC1;
attribute vec3 iPhys;  // drag, gravity, seed
uniform float uTime;
varying vec4 vColor;
varying vec2 vUv;
varying float vT;
void main() {
  float age = uTime - iT.x;
  float t = age / iT.y;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = iPhys.x;
  vec3 disp = k > 0.0 ? iVel * (1.0 - exp(-k * age)) / k : iVel * age;
  vec3 p = iPos + disp + vec3(0.0, 0.5 * iPhys.y * age * age, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = mix(iT.z, iT.w, 1.0 - (1.0 - t) * (1.0 - t));
  float a = iPhys.z * 6.2831 + age * (iPhys.z - 0.5);
  vec2 c = position.xy;
  mv.xy += vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * size;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vColor = mix(iC0, iC1, t);
  vUv = uv;
  vT = t;
}`

const GLOW_FS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
varying vec2 vUv;
varying float vT;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(vUv - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(1.0, 0.0, d);
  core = core * core;
  vec3 col = vColor.rgb + vec3(smoothstep(0.45, 0.0, d)) * 0.6;
  gl_FragColor = vec4(col * core * vColor.a, 1.0);
}`

const SMOKE_FS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
varying vec2 vUv;
varying float vT;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  float edge = 0.92 - vT * 0.25;
  if (d > 1.0) discard;
  float a = smoothstep(1.0, edge, d);
  // Cartoon puff: lit from above with a soft banded shade.
  float shade = 0.72 + 0.38 * step(-0.08, p.y + p.x * 0.3) + 0.12 * smoothstep(0.2, 0.5, p.y);
  gl_FragColor = vec4(vColor.rgb * shade, vColor.a * a);
}`

const TRACER_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec3 iColor;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 h = modelViewMatrix * vec4(iPos, 1.0);
  vec4 tl = modelViewMatrix * vec4(iPos - iDir, 1.0);
  float along = position.y + 0.5;
  vec4 mv = mix(tl, h, along);
  vec3 axis = h.xyz - tl.xyz;
  vec3 side = normalize(cross(axis, mv.xyz) + vec3(1e-6, 0.0, 0.0));
  float w = max(0.35, -mv.z * 0.0022);
  mv.xyz += side * position.x * 2.0 * w;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = vec2(position.x * 2.0, along);
  vColor = iColor;
}`

const TRACER_FS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float f = 1.0 - abs(vUv.x);
  float core = pow(f, 3.0);
  float fade = smoothstep(0.0, 0.7, vUv.y);
  vec3 col = mix(vColor, vec3(1.0, 1.0, 0.92), core);
  gl_FragColor = vec4(col * (f * 1.3) * fade, 1.0);
}`

const SHELL_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vW = position;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`

const SHELL_FS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uBands;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
void main() {
  #include <logdepthbuf_fragment>
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  rim = pow(rim, 2.5);
  float bands = uBands > 0.0 ? 0.65 + 0.35 * sin(vW.y * uBands + uTime * 6.0) : 1.0;
  gl_FragColor = vec4(uColor * rim * bands * uOpacity, 1.0);
}`

interface Shell { mesh: Mesh; mat: ShaderMaterial; start: number; life: number; radius: number; active: boolean; opacity: number }

class ParticleSystem {
  readonly mesh: Mesh
  private geo: InstancedBufferGeometry
  private attrs: InstancedBufferAttribute[]
  private pos: Float32Array
  private vel: Float32Array
  private t: Float32Array
  private c0: Float32Array
  private c1: Float32Array
  private phys: Float32Array
  private head = 0
  private dirtyMin = Infinity
  private dirtyMax = -1
  readonly mat: ShaderMaterial

  constructor(readonly capacity: number, additive: boolean) {
    const quad = new PlaneGeometry(1, 1)
    const geo = new InstancedBufferGeometry()
    geo.index = quad.index
    geo.setAttribute("position", quad.getAttribute("position"))
    geo.setAttribute("uv", quad.getAttribute("uv"))
    this.pos = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.t = new Float32Array(capacity * 4)
    this.c0 = new Float32Array(capacity * 4)
    this.c1 = new Float32Array(capacity * 4)
    this.phys = new Float32Array(capacity * 3)
    for (let i = 0; i < capacity; i++) this.t[i * 4 + 1] = 1e-3 // dead: life ~0, start 0
    const mk = (name: string, arr: Float32Array, size: number) => {
      const a = new InstancedBufferAttribute(arr, size)
      a.setUsage(DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    }
    this.attrs = [mk("iPos", this.pos, 3), mk("iVel", this.vel, 3), mk("iT", this.t, 4), mk("iC0", this.c0, 4), mk("iC1", this.c1, 4), mk("iPhys", this.phys, 3)]
    geo.instanceCount = capacity
    this.geo = geo
    this.mat = new ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: additive ? GLOW_FS : SMOKE_FS,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    })
    this.mesh = new Mesh(geo, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = additive ? 3 : 2
  }

  emit(now: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    c0: Color, a0: number, c1: Color, a1: number, drag: number, gravity: number): void {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    if (i < this.dirtyMin) this.dirtyMin = i
    if (i > this.dirtyMax) this.dirtyMax = i
    const i3 = i * 3, i4 = i * 4
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz
    this.t[i4] = now; this.t[i4 + 1] = life; this.t[i4 + 2] = s0; this.t[i4 + 3] = s1
    this.c0[i4] = c0.r; this.c0[i4 + 1] = c0.g; this.c0[i4 + 2] = c0.b; this.c0[i4 + 3] = a0
    this.c1[i4] = c1.r; this.c1[i4 + 1] = c1.g; this.c1[i4 + 2] = c1.b; this.c1[i4 + 3] = a1
    this.phys[i3] = drag; this.phys[i3 + 1] = gravity; this.phys[i3 + 2] = Math.random()
  }

  flush(now: number): void {
    this.mat.uniforms.uTime.value = now
    if (this.dirtyMax < 0) return
    const lo = this.dirtyMin, hi = this.dirtyMax
    for (const a of this.attrs) {
      a.clearUpdateRanges()
      a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize)
      a.needsUpdate = true
    }
    this.dirtyMin = Infinity
    this.dirtyMax = -1
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}

const c = (hex: string) => new Color(hex)
const FIRE_A = c("#fff3b0"), FIRE_B = c("#ff7a1a"), FIRE_C = c("#c0261a")
const SMOKE_A = c("#7a7682"), SMOKE_B = c("#55525e"), SMOKE_LIGHT = c("#d8d6dc"), SMOKE_WHITE = c("#f4f4f8")
const SPARK = c("#ffd27a"), SPARK_B = c("#ff6a00")
const FLARE_A = c("#fffbe8"), FLARE_B = c("#ffb347")
const WHITE = c("#ffffff")
const _tmp = new Color()

export interface TracerSource { position: Vec3; velocity: Vec3; color: Color }

export interface Effects {
  root: Object3D
  /** Call once per frame; time = seconds (monotonic). */
  update(dt: number, time: number, camera: Camera): void
  explosion(p: Vec3, size: number): void
  hit(p: Vec3): void
  muzzle(p: Vec3, dir: Vec3): void
  pulse(p: Vec3, radius: number, color: string): void
  /** Persistent smoke trail emitter (missiles). Call each frame with the current position. */
  trail(id: number, p: Vec3, heavy: boolean): void
  flare(p: Vec3, dt: number): void
  /** White wingtip vapour (high-G). */
  vapour(p: Vec3, intensity: number): void
  /** Damage smoke from a burning airframe. */
  damageSmoke(p: Vec3, vel: Vec3, severity: number, dt: number): void
  /** Set this frame's tracers (bullets). Up to the tracer capacity; extra are dropped. */
  setTracers(count: number, write: (i: number, pos: Float32Array, dir: Float32Array, col: Float32Array) => void): void
  setMissiles(count: number, write: (i: number, m: Matrix4) => void): void
  setQuality(q: Quality): void
  dispose(): void
}

export function createEffects(quality: Quality): Effects {
  const root = new Group()
  root.name = "effects"
  const scale = quality === "low" ? 0.5 : quality === "balanced" ? 0.8 : 1
  let density = scale
  const glow = new ParticleSystem(quality === "low" ? 2048 : 4096, true)
  const smoke = new ParticleSystem(quality === "low" ? 2048 : 4096, false)
  root.add(smoke.mesh, glow.mesh)

  // Tracers
  const TRACERS = 1024
  const tquad = new PlaneGeometry(1, 1)
  const tgeo = new InstancedBufferGeometry()
  tgeo.index = tquad.index
  tgeo.setAttribute("position", tquad.getAttribute("position"))
  const tPos = new Float32Array(TRACERS * 3), tDir = new Float32Array(TRACERS * 3), tCol = new Float32Array(TRACERS * 3)
  const tAttrs = [new InstancedBufferAttribute(tPos, 3), new InstancedBufferAttribute(tDir, 3), new InstancedBufferAttribute(tCol, 3)]
  tAttrs.forEach(a => a.setUsage(DynamicDrawUsage))
  tgeo.setAttribute("iPos", tAttrs[0]); tgeo.setAttribute("iDir", tAttrs[1]); tgeo.setAttribute("iColor", tAttrs[2])
  tgeo.instanceCount = 0
  const tmat = new ShaderMaterial({ vertexShader: TRACER_VS, fragmentShader: TRACER_FS, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide })
  const tracers = new Mesh(tgeo, tmat)
  tracers.frustumCulled = false
  tracers.renderOrder = 4
  root.add(tracers)

  // Missile bodies
  const MISSILES = 96
  const mgeo = new CylinderGeometry(0.22, 0.22, 3.2, 8)
  mgeo.rotateX(Math.PI / 2)
  const missiles = new InstancedMesh(mgeo, new MeshBasicMaterial({ color: "#eceff4" }), MISSILES)
  missiles.instanceMatrix.setUsage(DynamicDrawUsage)
  missiles.count = 0
  missiles.frustumCulled = false
  root.add(missiles)

  // Expanding shells: shockwaves + radar pulses
  const shellGeo = new IcosahedronGeometry(1, 3)
  const shells: Shell[] = []
  for (let i = 0; i < 10; i++) {
    const mat = new ShaderMaterial({
      vertexShader: SHELL_VS, fragmentShader: SHELL_FS, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
      uniforms: { uColor: { value: new Color() }, uOpacity: { value: 1 }, uBands: { value: 0 }, uTime: { value: 0 } },
    })
    const mesh = new Mesh(shellGeo, mat)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 5
    root.add(mesh)
    shells.push({ mesh, mat, start: 0, life: 1, radius: 1, active: false, opacity: 1 })
  }
  let shellNext = 0

  const trails = new Map<number, { x: number; y: number; z: number; seen: number }>()
  let now = 0
  let frame = 0
  const rnd = (a: number) => (Math.random() * 2 - 1) * a

  function shell(p: Vec3, radius: number, life: number, color: Color | string, bands: number, opacity: number) {
    const s = shells[shellNext]
    shellNext = (shellNext + 1) % shells.length
    s.active = true
    s.start = now
    s.life = life
    s.radius = radius
    s.opacity = opacity
    s.mesh.position.set(p[0], p[1], p[2])
    s.mesh.visible = true
    s.mat.uniforms.uColor.value.set(color)
    s.mat.uniforms.uBands.value = bands
  }

  return {
    root,
    update(dt, time, camera) {
      now = time
      frame++
      glow.flush(now)
      smoke.flush(now)
      for (const s of shells) {
        if (!s.active) continue
        const t = (now - s.start) / s.life
        if (t >= 1) { s.active = false; s.mesh.visible = false; continue }
        const e = 1 - Math.pow(1 - t, 3)
        s.mesh.scale.setScalar(Math.max(0.01, s.radius * e))
        s.mat.uniforms.uOpacity.value = s.opacity * (1 - t) * (1 - t)
        s.mat.uniforms.uTime.value = now
      }
      if (frame % 30 === 0) for (const [id, t] of trails) if (now - t.seen > 1) trails.delete(id)
    },

    explosion(p, size) {
      const n = Math.round((14 + size * 1.5) * density)
      const s = Math.max(4, size)
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.18, s * 2.5, s * 4, WHITE, 1, FIRE_A, 0, 0, 0)
      for (let i = 0; i < n; i++) {
        const v = s * 2.2
        glow.emit(now, p[0] + rnd(s * 0.3), p[1] + rnd(s * 0.3), p[2] + rnd(s * 0.3), rnd(v), rnd(v) + s * 0.4, rnd(v),
          0.5 + Math.random() * 0.6, s * 0.6, s * (1.2 + Math.random()), FIRE_A, 1, i % 3 ? FIRE_B : FIRE_C, 0, 2.5, 4)
      }
      for (let i = 0; i < n * 0.6; i++) {
        const v = s * 1.4
        _tmp.copy(SMOKE_A).lerp(SMOKE_B, Math.random())
        smoke.emit(now, p[0] + rnd(s * 0.5), p[1] + rnd(s * 0.5), p[2] + rnd(s * 0.5), rnd(v), rnd(v) + s * 0.3, rnd(v),
          2.5 + Math.random() * 2, s * 0.4, s * (1.1 + Math.random() * 0.8), _tmp, 0.8, SMOKE_B, 0, 1.4, 2.5)
      }
      for (let i = 0; i < n; i++) {
        const v = 40 + s * 6
        glow.emit(now, p[0], p[1], p[2], rnd(v), rnd(v) + 10, rnd(v), 0.6 + Math.random() * 0.8, 0.9, 0.3, SPARK, 1, SPARK_B, 0, 0.8, -25)
      }
      shell(p, s * 9, 0.7, "#ffb070", 0, 0.9)
    },

    hit(p) {
      const n = Math.round(6 * density) + 2
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.12, 2.5, 4, WHITE, 1, SPARK, 0, 0, 0)
      for (let i = 0; i < n; i++) glow.emit(now, p[0], p[1], p[2], rnd(45), rnd(45), rnd(45), 0.35 + Math.random() * 0.3, 0.6, 0.15, SPARK, 1, SPARK_B, 0, 1, -20)
      smoke.emit(now, p[0], p[1], p[2], rnd(3), 2, rnd(3), 1.2, 1.2, 4, SMOKE_A, 0.7, SMOKE_B, 0, 1, 1)
    },

    muzzle(p, dir) {
      glow.emit(now, p[0] + dir[0] * 2, p[1] + dir[1] * 2, p[2] + dir[2] * 2, 0, 0, 0, 0.06, 2.2, 1.2, FIRE_A, 1, FIRE_B, 0, 0, 0)
    },

    pulse(p, radius, color) {
      shell(p, radius, 3.2, color, 0.02, 0.9)
      shell(p, radius * 0.6, 2.4, "#9dffcf", 0.05, 0.5)
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.6, 20, 120, _tmp.set(color), 1, WHITE, 0, 0, 0)
    },

    trail(id, p, heavy) {
      let t = trails.get(id)
      if (!t) { t = { x: p[0], y: p[1], z: p[2], seen: now }; trails.set(id, t) }
      t.seen = now
      const dx = p[0] - t.x, dy = p[1] - t.y, dz = p[2] - t.z
      const d = Math.hypot(dx, dy, dz)
      const spacing = heavy ? 3 / density : 5 / density
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.08, 2.4, 1.2, FIRE_A, 1, FIRE_B, 0, 0, 0)
      if (d < spacing) return
      const steps = Math.min(16, Math.floor(d / spacing))
      for (let i = 1; i <= steps; i++) {
        const f = i / steps
        smoke.emit(now, t.x + dx * f, t.y + dy * f, t.z + dz * f, rnd(0.8), rnd(0.8) + 0.4, rnd(0.8),
          heavy ? 3.2 : 2.2, 1.2, heavy ? 6 : 4.5, SMOKE_WHITE, 0.85, SMOKE_LIGHT, 0, 0.5, 0.4)
      }
      t.x = p[0]; t.y = p[1]; t.z = p[2]
    },

    flare(p, dt) {
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.09, 6, 3, FLARE_A, 1, FLARE_B, 0.4, 0, 0)
      if (Math.random() < 0.5 * density) smoke.emit(now, p[0], p[1], p[2], rnd(0.5), 0.5, rnd(0.5), 1.4, 1, 3.5, SMOKE_LIGHT, 0.6, SMOKE_LIGHT, 0, 0.5, 0.5)
    },

    vapour(p, intensity) {
      if (Math.random() > density) return
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.5, 0.5, 1.4, SMOKE_WHITE, 0.25 * intensity, SMOKE_WHITE, 0, 0, 0)
    },

    damageSmoke(p, vel, severity, dt) {
      if (Math.random() > severity * density * dt * 40) return
      smoke.emit(now, p[0], p[1], p[2], vel[0] * 0.2 + rnd(1), vel[1] * 0.2 + 1.5, vel[2] * 0.2 + rnd(1), 2.2, 1.5, 7, SMOKE_B, 0.85, SMOKE_A, 0, 0.6, 1.5)
      if (severity > 0.6) glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.12, 2.5, 1, FIRE_A, 1, FIRE_B, 0, 0, 0)
    },

    setTracers(count, write) {
      const n = Math.min(count, TRACERS)
      for (let i = 0; i < n; i++) write(i, tPos, tDir, tCol)
      tgeo.instanceCount = n
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

    setQuality(q) {
      density = q === "low" ? 0.5 : q === "balanced" ? 0.8 : 1
    },

    dispose() {
      glow.dispose(); smoke.dispose(); tgeo.dispose(); tmat.dispose(); mgeo.dispose(); shellGeo.dispose()
      shells.forEach(s => s.mat.dispose())
      ;(missiles.material as MeshBasicMaterial).dispose()
    },
  }
}

const _mat = new Matrix4()
