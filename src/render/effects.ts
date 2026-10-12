// Pooled, bounded visual effects in the world's low-poly pastel style.
// Everything is GPU-animated from spawn parameters (position/size/colour are functions of age in the
// vertex shader), so the CPU only writes new instances into ring buffers.
//  - glow:   additive billboards (flashes, sparks, muzzle stars, flare cores)
//  - puffs:  opaque, flat-shaded low-poly "cloud" puffs with toon banding (fireballs, smoke, trails)
//  - debris: tumbling low-poly chunks on ballistic arcs
import {
  AdditiveBlending, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry,
  InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, NormalBlending, PlaneGeometry,
  ShaderMaterial, TetrahedronGeometry, UniformsLib, UniformsUtils, Vector3, type BufferGeometry, type Camera, type Object3D,
} from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type { Quality, Vec3 } from "../sim/types"

const SUN = new Vector3(0.55, 0.55, 0.62).normalize()

const GLOW_VS = /* glsl */ `
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
void main() {
  float age = uTime - iT.x;
  float t = age / iT.y;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = iPhys.x;
  vec3 disp = k > 0.0 ? iVel * (1.0 - exp(-k * age)) / k : iVel * age;
  vec3 p = iPos + disp + vec3(0.0, 0.5 * iPhys.y * age * age, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = mix(iT.z, iT.w, 1.0 - (1.0 - t) * (1.0 - t));
  float a = iPhys.z * 6.2831;
  vec2 c = position.xy;
  mv.xy += vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * size;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vColor = mix(iC0, iC1, t);
  vUv = uv;
}`

const GLOW_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  if (d > 1.0) discard;
  // Soft core plus a faint four-point star: reads as a stylised glint rather than a blurry blob.
  float core = pow(1.0 - d, 2.2);
  float star = max(0.0, 1.0 - abs(p.x) * 14.0) * max(0.0, 1.0 - abs(p.y) * 2.2) + max(0.0, 1.0 - abs(p.y) * 14.0) * max(0.0, 1.0 - abs(p.x) * 2.2);
  vec3 col = vColor.rgb + vec3(smoothstep(0.35, 0.0, d)) * 0.7;
  gl_FragColor = vec4(col * (core + star * 0.35) * vColor.a, 1.0);
  #include <colorspace_fragment>
}`

const PUFF_VS = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iT;     // start, life, size0, size1
attribute vec4 iC0;    // rgb + emissive
attribute vec4 iC1;
attribute vec3 iPhys;  // drag, buoyancy, seed
uniform float uTime;
varying vec4 vColor;
varying vec3 vViewPos;
vec3 rotateAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void main() {
  float age = uTime - iT.x;
  float t = age / iT.y;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = iPhys.x;
  vec3 disp = k > 0.0 ? iVel * (1.0 - exp(-k * age)) / k : iVel * age;
  vec3 c = iPos + disp + vec3(0.0, 0.5 * iPhys.y * age * age, 0.0);
  // Inflate fast, linger, then shrink away (cartoon smoke dissolves by scale, never by alpha).
  float sd = fract(iPhys.z);
  float rate = floor(iPhys.z) * 0.25;
  float grow = 1.0 - pow(1.0 - min(1.0, t * max(rate, 0.25)), 3.0);
  float size = mix(iT.z, iT.w, grow) * (1.0 - smoothstep(0.55, 1.0, t));
  vec3 axis = normalize(vec3(sin(sd * 12.9898), cos(sd * 78.233), sin(sd * 37.719) + 0.3));
  vec3 lp = rotateAxis(position * vec3(1.0, 0.86, 1.0), axis, sd * 6.2831 + age * (sd - 0.5) * 1.6);
  vec4 mvPosition = modelViewMatrix * vec4(c + lp * size, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  vViewPos = mvPosition.xyz;
  vColor = mix(iC0, iC1, t);
}`

const SOLID_FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun;
uniform vec3 uSky;
varying vec4 vColor;
varying vec3 vViewPos;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  float l = dot(n, uSun);
  // Three soft bands, like the world's toon shading: lit, half, shade (cool sky-tinted).
  vec3 band = l > 0.3 ? vec3(1.0) : l > -0.15 ? vec3(0.86, 0.87, 0.92) : uSky;
  vec3 col = vColor.rgb * mix(band, vec3(1.25), vColor.a);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`

const DEBRIS_VS = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iT;     // start, life, size, spin
attribute vec3 iCol;
attribute float iSeed;
uniform float uTime;
varying vec4 vColor;
varying vec3 vViewPos;
vec3 rotateAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void main() {
  float age = uTime - iT.x;
  float t = age / iT.y;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 disp = iVel * (1.0 - exp(-0.6 * age)) / 0.6;
  vec3 c = iPos + disp + vec3(0.0, -0.5 * 28.0 * age * age, 0.0);
  vec3 axis = normalize(vec3(sin(iSeed * 91.7), cos(iSeed * 47.3), sin(iSeed * 13.1)));
  float size = iT.z * (1.0 - smoothstep(0.75, 1.0, t));
  vec3 lp = rotateAxis(position * vec3(1.0, 0.55, 1.4), axis, iSeed * 6.28 + age * iT.w);
  vec4 mvPosition = modelViewMatrix * vec4(c + lp * size, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  vViewPos = mvPosition.xyz;
  // Embers glow briefly, then cool to the body colour.
  float ember = max(0.0, 1.0 - t * 2.5);
  vColor = vec4(mix(iCol, vec3(1.0, 0.5, 0.16), ember * 0.85), ember * 0.7);
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
  float L = length(iDir);
  vec3 dir = L > 1e-4 ? iDir * (min(L, 32.0) / L) : iDir;
  vec4 h = modelViewMatrix * vec4(iPos, 1.0);
  vec4 tl = modelViewMatrix * vec4(iPos - dir, 1.0);
  float along = position.y + 0.5;
  vec4 mv = mix(tl, h, along);
  vec3 axis = h.xyz - tl.xyz;
  vec3 side = normalize(cross(axis, mv.xyz) + vec3(1e-6, 0.0, 0.0));
  float w = max(0.35, -mv.z * 0.0016);
  mv.xyz += side * position.x * 2.0 * w;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = vec2(position.x * 2.0, along);
  vColor = min(iColor, vec3(1.0));
}`

const TRACER_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float f = 1.0 - abs(vUv.x);
  float core = smoothstep(0.45, 0.95, f);
  float fade = smoothstep(0.0, 0.75, vUv.y);
  // Additive glow with a white-hot core; the warm halo is strong enough to read on bright sky.
  vec3 col = mix(vColor * 1.4, vec3(1.0, 0.98, 0.9) * 2.0, core);
  gl_FragColor = vec4(col * (f * f) * fade, 1.0);
  #include <colorspace_fragment>
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
#include <common>
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
  rim = pow(rim, 3.0);
  float bands = uBands > 0.0 ? 0.55 + 0.45 * step(0.0, sin(vW.y * uBands * 6.0 - uTime * 5.0)) : 1.0;
  gl_FragColor = vec4(uColor, clamp(rim * bands * uOpacity, 0.0, 1.0));
  #include <colorspace_fragment>
}`

interface Shell { mesh: Mesh; mat: ShaderMaterial; start: number; life: number; radius: number; active: boolean; opacity: number }

/** Ring buffer of GPU-animated instances over a shared base geometry. */
class InstancePool {
  readonly mesh: Mesh
  readonly mat: ShaderMaterial
  private geo: InstancedBufferGeometry
  private attrs: InstancedBufferAttribute[]
  readonly arrays: Float32Array[]
  head = 0
  /** Latest death time of anything emitted, and the highest slot ever used: bounds the instanced draw. */
  private maxEnd = 0
  private hwm = 0
  private dirtyMin = Infinity
  private dirtyMax = -1

  constructor(readonly capacity: number, base: BufferGeometry, layout: [string, number][], mat: ShaderMaterial, tIndex: number) {
    const geo = new InstancedBufferGeometry()
    geo.index = base.index
    for (const name of ["position", "uv", "normal"]) { const a = base.getAttribute(name); if (a) geo.setAttribute(name, a) }
    this.arrays = []
    this.attrs = layout.map(([name, size]) => {
      const arr = new Float32Array(capacity * size)
      this.arrays.push(arr)
      const a = new InstancedBufferAttribute(arr, size)
      a.setUsage(DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    })
    // Start every slot dead (life ~0).
    const t = this.arrays[tIndex]
    for (let i = 0; i < capacity; i++) t[i * 4 + 1] = 1e-3
    geo.instanceCount = 0
    this.geo = geo
    this.mat = mat
    this.mesh = new Mesh(geo, mat)
    this.mesh.frustumCulled = false
  }

  /** Reserve the next slot (alive until `end`); returns its index. */
  next(end: number): number {
    if (end > this.maxEnd) this.maxEnd = end
    const i = this.head
    if (i >= this.hwm) this.hwm = i + 1
    this.head = (this.head + 1) % this.capacity
    if (i < this.dirtyMin) this.dirtyMin = i
    if (i > this.dirtyMax) this.dirtyMax = i
    return i
  }

  flush(now: number): void {
    this.mat.uniforms.uTime.value = now
    this.geo.instanceCount = now > this.maxEnd ? 0 : this.hwm
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

const PARTICLE_LAYOUT: [string, number][] = [["iPos", 3], ["iVel", 3], ["iT", 4], ["iC0", 4], ["iC1", 4], ["iPhys", 3]]

/** Billboards + puffs share the same emit signature. */
class Emitter {
  private a: Float32Array[]
  constructor(readonly pool: InstancePool) { this.a = pool.arrays }
  emit(now: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    c0: Color, a0: number, c1: Color, a1: number, drag: number, gravity: number, grow = 2.5): void {
    const i = this.pool.next(now + life)
    const a = this.a
    const pos = a[0], vel = a[1], t = a[2], col0 = a[3], col1 = a[4], phys = a[5]
    const i3 = i * 3, i4 = i * 4
    pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z
    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz
    t[i4] = now; t[i4 + 1] = life; t[i4 + 2] = s0; t[i4 + 3] = s1
    col0[i4] = c0.r; col0[i4 + 1] = c0.g; col0[i4 + 2] = c0.b; col0[i4 + 3] = a0
    col1[i4] = c1.r; col1[i4 + 1] = c1.g; col1[i4 + 2] = c1.b; col1[i4 + 3] = a1
    phys[i3] = drag; phys[i3 + 1] = gravity; phys[i3 + 2] = Math.round(grow * 4) + Math.random() * 0.999
  }
}

const c = (hex: string) => new Color(hex)
// Pastel fire: butter → peach → coral, cooling to warm charcoal smoke that lightens as it dissipates.
const FIRE_A = c("#fff4c4"), FIRE_B = c("#ffb066"), FIRE_C = c("#f0705a")
const BALL_A = c("#ffe08a"), BALL_B = c("#ff8a3d"), SMOKE_WARM = c("#b9aea6"), SMOKE_WARM_PALE = c("#e4ddd6")
const SMOKE_DARK = c("#85818a"), SMOKE_MID = c("#aeaab2"), SMOKE_PALE = c("#e6e4ea"), SMOKE_WHITE = c("#f7f6f9")
const SPARK = c("#ffe0a0"), SPARK_B = c("#ff8a3c")
const FLARE_A = c("#fffbe8"), FLARE_B = c("#ffc070")
const WHITE = c("#ffffff")
const TRAIL = c("#ffffff"), TRAIL_END = c("#e6e3ee")
const DEBRIS_COLS = [c("#8d939c"), c("#a3a8b0"), c("#767c86"), c("#c9ccd0")]
const SKY_SHADE = c("#b4bfd6")
const _tmp = new Color()
const _sun = new Vector3()

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
  /** Damage smoke from a burning airframe. */
  damageSmoke(p: Vec3, vel: Vec3, severity: number, dt: number): void
  /** Set this frame's tracers (bullets). Up to the tracer capacity; extra are dropped. */
  setTracers(count: number, write: (i: number, pos: Float32Array, dir: Float32Array, col: Float32Array) => void): void
  setMissiles(count: number, write: (i: number, m: Matrix4) => void): void
  setQuality(q: Quality): void
  dispose(): void
}

function solidMaterial(vs: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: vs,
    fragmentShader: SOLID_FS,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uSun: { value: new Vector3() }, uSky: { value: SKY_SHADE.clone() } }]),
    fog: true,
  })
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

export function createEffects(quality: Quality): Effects {
  const root = new Group()
  root.name = "effects"
  let density = quality === "low" ? 0.5 : quality === "balanced" ? 0.8 : 1

  const quad = new PlaneGeometry(1, 1)
  const glowPool = new InstancePool(quality === "low" ? 1536 : 3072, quad, PARTICLE_LAYOUT, new ShaderMaterial({
    vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: AdditiveBlending,
  }), 2)
  glowPool.mesh.renderOrder = 3
  const glow = new Emitter(glowPool)

  // Rounder 80-face puffs on Balanced/High; 20-face on Low.
  const puffGeo = new IcosahedronGeometry(1, quality === "low" ? 0 : 1)
  const puffPool = new InstancePool(quality === "low" ? 1536 : 3072, puffGeo, PARTICLE_LAYOUT, solidMaterial(PUFF_VS), 2)
  const puffs = new Emitter(puffPool)

  const debrisGeo = new TetrahedronGeometry(1, 0)
  const DEBRIS = 384
  const debrisPool = new InstancePool(DEBRIS, debrisGeo, [["iPos", 3], ["iVel", 3], ["iT", 4], ["iCol", 3], ["iSeed", 1]], solidMaterial(DEBRIS_VS), 2)
  root.add(puffPool.mesh, debrisPool.mesh, glowPool.mesh)

  // Tracers
  const TRACERS = 1024
  const tgeo = new InstancedBufferGeometry()
  tgeo.index = quad.index
  tgeo.setAttribute("position", quad.getAttribute("position"))
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

  // Missile bodies: little white darts with fins.
  const MISSILES = 96
  const mgeo = missileGeometry()
  const mmat = new MeshLambertMaterial({ color: "#f3f0e8", flatShading: true })
  const missiles = new InstancedMesh(mgeo, mmat, MISSILES)
  missiles.instanceMatrix.setUsage(DynamicDrawUsage)
  missiles.count = 0
  missiles.frustumCulled = false
  root.add(missiles)

  // Expanding shells: shockwaves + radar pulses
  const shellGeo = new IcosahedronGeometry(1, 3)
  const shells: Shell[] = []
  for (let i = 0; i < 10; i++) {
    const mat = new ShaderMaterial({
      vertexShader: SHELL_VS, fragmentShader: SHELL_FS, transparent: true, depthWrite: false, blending: NormalBlending, side: DoubleSide,
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

  interface Wreck { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; last: number }
  const wrecks: Wreck[] = []
  function debrisOne(p: Vec3, vx: number, vy: number, vz: number, life: number, size: number) {
    const da = debrisPool.arrays
    const i = debrisPool.next(now + life)
    const i3 = i * 3, i4 = i * 4
    da[0][i3] = p[0]; da[0][i3 + 1] = p[1]; da[0][i3 + 2] = p[2]
    da[1][i3] = vx; da[1][i3 + 1] = vy; da[1][i3 + 2] = vz
    da[2][i4] = now; da[2][i4 + 1] = life; da[2][i4 + 2] = size; da[2][i4 + 3] = 3 + Math.random() * 3
    const cc = DEBRIS_COLS[2]
    da[3][i3] = cc.r; da[3][i3 + 1] = cc.g; da[3][i3 + 2] = cc.b
    da[4][i] = Math.random()
  }
  /** Same ballistic path as the debris vertex shader, so trails stay glued to the chunk. */
  const wreckPos = (w: Wreck, age: number, out: number[]) => {
    const k = (1 - Math.exp(-0.6 * age)) / 0.6
    out[0] = w.x + w.vx * k; out[1] = w.y + w.vy * k - 14 * age * age; out[2] = w.z + w.vz * k
  }
  const _wp = [0, 0, 0]

  function debris(p: Vec3, n: number, speed: number, size: number) {
    const da = debrisPool.arrays
    const pos = da[0], vel = da[1], t = da[2], col = da[3], seed = da[4]
    for (let k = 0; k < n; k++) {
      const life = 1.6 + Math.random() * 1.4
      const i = debrisPool.next(now + life)
      const i3 = i * 3, i4 = i * 4
      pos[i3] = p[0]; pos[i3 + 1] = p[1]; pos[i3 + 2] = p[2]
      vel[i3] = rnd(speed); vel[i3 + 1] = rnd(speed) * 0.6 + speed * 0.45; vel[i3 + 2] = rnd(speed)
      t[i4] = now; t[i4 + 1] = life; t[i4 + 2] = size * (0.5 + Math.random()); t[i4 + 3] = 4 + Math.random() * 8
      const cc = DEBRIS_COLS[(Math.random() * DEBRIS_COLS.length) | 0]
      col[i3] = cc.r; col[i3 + 1] = cc.g; col[i3 + 2] = cc.b
      seed[i] = Math.random()
    }
  }

  return {
    root,
    update(_dt, time, camera) {
      now = time
      frame++
      // Sun direction in view space for the flat-shaded puffs.
      _sun.copy(SUN).transformDirection(camera.matrixWorldInverse)
      puffPool.mat.uniforms.uSun.value.copy(_sun)
      debrisPool.mat.uniforms.uSun.value.copy(_sun)
      glowPool.flush(now)
      puffPool.flush(now)
      debrisPool.flush(now)
      for (const s of shells) {
        if (!s.active) continue
        const t = (now - s.start) / s.life
        if (t >= 1) { s.active = false; s.mesh.visible = false; continue }
        const e = 1 - Math.pow(1 - t, 3)
        s.mesh.scale.setScalar(Math.max(0.01, s.radius * e))
        s.mat.uniforms.uOpacity.value = s.opacity * (1 - t) * (1 - t)
        s.mat.uniforms.uTime.value = now
      }
      for (let i = wrecks.length - 1; i >= 0; i--) {
        const w = wrecks[i]
        const age = now - w.t0
        if (age > w.life * 0.92) { wrecks.splice(i, 1); continue }
        if (now - w.last < 0.035) continue
        w.last = now
        wreckPos(w, age, _wp)
        const burn = 1 - age / w.life
        puffs.emit(now, _wp[0], _wp[1], _wp[2], rnd(0.6), 0.5, rnd(0.6), 0.35, 1.2 * burn + 0.4, 1.8 * burn + 0.5, BALL_A, 1, BALL_B, 1, 1, 0, 8)
        if (Math.random() < density) puffs.emit(now, _wp[0], _wp[1], _wp[2], rnd(0.8), 1.5, rnd(0.8), 1.8 + Math.random(), 0.8, 2.6, SMOKE_WARM, 0, SMOKE_WARM_PALE, 0, 0.8, 1.2, 1.5)
      }
      if (frame % 30 === 0) for (const [id, t] of trails) if (now - t.seen > 1) trails.delete(id)
    },

    explosion(p, size) {
      const air = size >= 12 || size <= 1
      const s = air ? 9 : Math.max(4, Math.min(16, size))
      // Flash + unshaded fireball held near full size for ~0.35 s, then smoke rolls in 0.3 s later.
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.14, s * 2, s * 3.6, WHITE, 1, BALL_A, 0, 0, 0)
      const nf = Math.round((air ? 12 : 7 + s * 0.4) * density) + 3
      for (let i = 0; i < nf; i++) {
        const v = s * 0.9
        const r = s * (0.38 + Math.random() * 0.3)
        puffs.emit(now, p[0] + rnd(s * 0.35), p[1] + rnd(s * 0.3), p[2] + rnd(s * 0.35), rnd(v), rnd(v) + s * 0.2, rnd(v),
          0.62 + Math.random() * 0.12, r * 0.85, r, i % 2 ? BALL_A : BALL_B, 1, BALL_B, 1, 4, 0, 12)
      }
      const ns = Math.round((air ? 12 : 5 + s * 0.4) * density) + 3
      for (let i = 0; i < ns; i++) {
        const v = s * 0.55
        const r = s * (0.22 + Math.random() * 0.2)
        puffs.emit(now + 0.3 + Math.random() * 0.12, p[0] + rnd(s * 0.45), p[1] + rnd(s * 0.35), p[2] + rnd(s * 0.45), rnd(v), rnd(v * 0.5) + s * 0.25, rnd(v),
          1.8 + Math.random() * 1.4, r * 0.6, r * 1.4, SMOKE_WARM, 0, SMOKE_WARM_PALE, 0, 1.2, 1.5, 1.2)
      }
      const nk = Math.round((8 + s) * density)
      for (let i = 0; i < nk; i++) {
        const v = 35 + s * 5
        glow.emit(now, p[0], p[1], p[2], rnd(v), rnd(v) + 10, rnd(v), 0.45 + Math.random() * 0.6, 0.9, 0.25, SPARK, 1, SPARK_B, 0, 1, -25)
      }
      if (air) {
        debris(p, Math.round(8 * density) + 3, 30, 0.7)
        // 2–3 big burning chunks that fall trailing fire and smoke for 2–3 s.
        const n = 2 + (Math.random() < 0.5 ? 1 : 0)
        for (let i = 0; i < n; i++) {
          const life = 2.2 + Math.random() * 0.8
          const vx = rnd(22), vy = 8 + Math.random() * 14, vz = rnd(22)
          debrisOne(p, vx, vy, vz, life, 1.8 + Math.random() * 0.8)
          if (wrecks.length < 12) wrecks.push({ x: p[0], y: p[1], z: p[2], vx, vy, vz, t0: now, life, last: now })
        }
      } else debris(p, Math.round(4 * density) + 1, 18 + s, 0.45)
      shell(p, s * 3.5, 0.3, "#fff3e2", 0, 0.18)
    },

    hit(p) {
      // Bright 3–5 m flash (also reads as the "target flashed white" cue), sparks, a lingering gray puff.
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.06, 5, 6.5, WHITE, 1, WHITE, 0.6, 0, 0)
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.16, 3, 4.5, FIRE_A, 1, SPARK, 0, 0, 0)
      const n = Math.round(6 * density) + 3
      for (let i = 0; i < n; i++) glow.emit(now, p[0], p[1], p[2], rnd(50), rnd(50), rnd(50), 0.25 + Math.random() * 0.3, 1.1, 0.25, SPARK, 1, SPARK_B, 0, 1, -20)
      puffs.emit(now, p[0], p[1], p[2], rnd(1.5), 1.2, rnd(1.5), 1.6, 0.5, 1.4, SMOKE_MID, 0.1, SMOKE_PALE, 0, 0.8, 0.8, 1.5)
      if (Math.random() < 0.35 * density) debris(p, 1, 14, 0.25)
    },

    muzzle(p, dir) {
      glow.emit(now, p[0] + dir[0] * 2, p[1] + dir[1] * 2, p[2] + dir[2] * 2, 0, 0, 0, 0.055, 2.4, 1.3, FIRE_A, 1, FIRE_B, 0, 0, 0)
    },

    pulse(p, radius, color) {
      shell(p, radius, 3.2, color, 0.02, 0.85)
      shell(p, radius * 0.6, 2.4, "#cdf2dc", 0.05, 0.5)
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.6, 20, 120, _tmp.set(color), 1, WHITE, 0, 0, 0)
    },

    trail(id, p, heavy) {
      let t = trails.get(id)
      if (!t) { t = { x: p[0], y: p[1], z: p[2], seen: now }; trails.set(id, t) }
      t.seen = now
      const dx = p[0] - t.x, dy = p[1] - t.y, dz = p[2] - t.z
      const d = Math.hypot(dx, dy, dz)
      const spacing = (heavy ? 1.4 : 2) / density
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.07, heavy ? 2.6 : 2, 1, FIRE_A, 0.9, FIRE_B, 0, 0, 0)
      if (d < spacing) return
      const steps = Math.min(16, Math.floor(d / spacing))
      for (let i = 1; i <= steps; i++) {
        const f = i / steps
        // Soft pastel puffs: start warm-white near the motor, inflate, drift, shrink away.
        puffs.emit(now, t.x + dx * f, t.y + dy * f, t.z + dz * f, rnd(0.5), rnd(0.5) + 0.4, rnd(0.5),
          heavy ? 2.2 : 1.4, 0.9, heavy ? 1.5 : 1.15, TRAIL, 0.5, TRAIL_END, 0, 0.6, 0.4, 1.1)
      }
      t.x = p[0]; t.y = p[1]; t.z = p[2]
    },

    flare(p, _dt) {
      glow.emit(now, p[0], p[1], p[2], 0, 0, 0, 0.09, 6, 3, FLARE_A, 1, FLARE_B, 0.4, 0, 0)
      if (Math.random() < 0.5 * density) puffs.emit(now, p[0], p[1], p[2], rnd(0.5), 0.5, rnd(0.5), 1.4, 0.5, 1.8, SMOKE_WHITE, 0.3, SMOKE_PALE, 0, 0.5, 0.5)
    },

    damageSmoke(p, vel, severity, dt) {
      if (Math.random() > severity * density * dt * 40) return
      _tmp.copy(SMOKE_MID).lerp(SMOKE_DARK, severity)
      puffs.emit(now, p[0], p[1], p[2], vel[0] * 0.2 + rnd(1), vel[1] * 0.2 + 1.5, vel[2] * 0.2 + rnd(1), 2, 0.6, 2.6 + severity * 2, _tmp, 0, SMOKE_PALE, 0, 0.6, 1.5)
      if (severity > 0.6) puffs.emit(now, p[0], p[1], p[2], vel[0] * 0.1, vel[1] * 0.1, vel[2] * 0.1, 0.35, 0.5, 1.4, FIRE_A, 1, FIRE_C, 0.8, 1, 0)
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
      glowPool.dispose(); puffPool.dispose(); debrisPool.dispose(); tgeo.dispose(); tmat.dispose(); mgeo.dispose(); mmat.dispose(); shellGeo.dispose()
      quad.dispose(); puffGeo.dispose(); debrisGeo.dispose()
      shells.forEach(s => s.mat.dispose())
    },
  }
}

const _mat = new Matrix4()
