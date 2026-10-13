// Stormy ocean (TSL / WebGPU): Gerstner swells displaced on a camera-following radial grid, per-pixel
// chop normals, crest + wind-streak foam, shore surf from the baked depth map, ship wakes and calm
// water around hulls, sky reflections from the shared storm sky, lightning. Physics water stays at y=0.
import {
  BufferAttribute, BufferGeometry, DataTexture, Group, LinearFilter, Mesh, RedFormat, UnsignedByteType, Vector2, Vector3, Vector4,
} from "three"
import { MeshBasicNodeMaterial } from "three/webgpu"
import {
  Fn, If, Loop, abs, cameraPosition, clamp, cos, dot, exp, float, length, max, min, mix, normalize, positionLocal, positionWorld, pow,
  reflect, sin, smoothstep, sqrt, texture, time, uniform, uniformArray, varying, vec2, vec3,
} from "three/tsl"
import { FLEET, SHIP_SPECS } from "../../sim/fleet"
import { WORLD_HALF, WORLD_SIZE, deckVelocity, fleetState, posedShip } from "../../sim/geography"
import { STORM, fbm, horizonColor, linear, stormSky, vnoise, type N } from "./atmosphere"
import { BREAK_DIRECTION, HEMI_INTENSITY, PALETTE, SUN_COLOR, SUN_DIRECTION, SUN_INTENSITY } from "./palette"
import type { WorldQualitySettings } from "./settings"
import { SHORE_MAX, SHORE_MIN, SHORE_SIZE } from "./tile-gen"

const MAX_SHIPS = 16
const G = 9.81

interface Wave { dir: [number, number]; length: number; amp: number; steep: number; fade: number; phase: number }

/** Deterministic storm wave spectrum around the wind direction. */
function spectrum(count: number, chop: boolean): Wave[] {
  const out: Wave[] = []
  const wind = Math.atan2(4, 9)
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1)
    // Irrational ratios between lengths/directions avoid regular interference (checkerboards).
    const length = chop ? 23 * Math.pow(0.71, i) * (1 + 0.13 * Math.sin(i * 7.1)) + 2.2 : 190 * Math.pow(0.7, i) * (1 + 0.1 * Math.sin(i * 5.3)) + 9
    const amp = chop ? length * 0.008 : Math.min(3.2, length * 0.016) * (1 - t * 0.25)
    // Golden-angle scatter of directions (no two waves near-parallel) for an irregular sea.
    const spread = chop ? 1.4 * Math.sin(i * 2.39996 + 2.1) : ((i * 2.39996) % (Math.PI * 2) - Math.PI) * 0.42
    const a = wind + spread
    out.push({ dir: [Math.cos(a), Math.sin(a)], length, amp, steep: chop ? 0 : 0.55 - t * 0.2, fade: chop ? Math.max(500, length * 16) : Math.min(2600, Math.max(700, length * 9)), phase: (i * 1.618 + (chop ? 0.37 : 0)) % 1 * Math.PI * 2 })
  }
  return out
}

/** Radial grid (rings × segments) with spacing growing with distance; positions are offsets from the camera. */
function radialGrid(segments: number, rings: number, far: number): BufferGeometry {
  const verts = 1 + rings * segments
  const pos = new Float32Array(verts * 3)
  const idx: number[] = []
  let v = 1
  for (let r = 1; r <= rings; r++) {
    const radius = far * Math.pow(r / rings, 2.35) + r * 0.6
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2
      pos[v * 3] = Math.cos(a) * radius
      pos[v * 3 + 2] = Math.sin(a) * radius
      v++
    }
  }
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s)
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segments, b0 = 1 + r * segments
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new BufferAttribute(pos, 3))
  g.setIndex(verts > 65535 ? new BufferAttribute(new Uint32Array(idx), 1) : new BufferAttribute(new Uint16Array(idx), 1))
  return g
}

export function createWater(settings: WorldQualitySettings) {
  const data = new Uint8Array(SHORE_SIZE * SHORE_SIZE) // 0 = deep until the worker fills it in
  const shore = new DataTexture(data, SHORE_SIZE, SHORE_SIZE, RedFormat, UnsignedByteType)
  shore.minFilter = LinearFilter
  shore.magFilter = LinearFilter
  shore.generateMipmaps = false
  shore.needsUpdate = true

  const origin = uniform(new Vector2())
  const shipsA = uniformArray(Array.from({ length: MAX_SHIPS }, () => new Vector4(1e7, 1e7, 1, 1)), "vec4")
  const shipsB = uniformArray(Array.from({ length: MAX_SHIPS }, () => new Vector4(0, -1, 0, 0)), "vec4")
  const keyDir = uniform(new Vector3(...SUN_DIRECTION).normalize())
  const keyCol = uniform(linear(SUN_COLOR).multiplyScalar(SUN_INTENSITY * 0.35))
  const ambient = uniform(HEMI_INTENSITY * 0.55)
  const breakDir3 = uniform(new Vector3(BREAK_DIRECTION[0], 0.12, BREAK_DIRECTION[1]).normalize())
  const cDeep = uniform(linear(PALETTE.deep)), cWater = uniform(linear(PALETTE.water)), cShallow = uniform(linear(PALETTE.shallow))
  const cFoam = uniform(linear(PALETTE.foam))
  const shoreTex = texture(shore)

  let mesh: Mesh | null = null
  let material: MeshBasicNodeMaterial | null = null

  function build(s: WorldQualitySettings) {
    const swells = spectrum(s.oceanWaves, false)
    const chop = spectrum(s.oceanChop, true)
    const ampSum = swells.reduce((a, w) => a + w.amp, 0)

    // ---- vertex stage ----
    const worldXZ: N = positionLocal.xz.add(origin)
    const camD: N = length(worldXZ.sub(cameraPosition.xz))
    const uvShore: N = worldXZ.add(WORLD_HALF).div(WORLD_SIZE)
    const depthV: N = (shoreTex as N).sample(uvShore).level(float(0)).r.mul(SHORE_MAX - SHORE_MIN).add(SHORE_MIN).negate()
    const shoreCalm: N = smoothstep(0.5, 9, depthV)
    const shipCalm = Fn(() => {
      const c = float(1).toVar()
      Loop(MAX_SHIPS, ({ i }: { i: N }) => {
        const a: N = shipsA.element(i)
        const d: N = length(worldXZ.sub(a.xy))
        c.assign(min(c, smoothstep(a.z, a.z.mul(2.2), d)))
      })
      return c
    })()
    const calm: N = shoreCalm.mul(shipCalm.mul(0.45).add(0.55))
    let disp: N = vec3(0, 0, 0)
    for (const w of swells) {
      const k = (2 * Math.PI) / w.length, om = Math.sqrt(G * k)
      const amp: N = calm.mul(w.amp).mul(smoothstep(w.fade, w.fade * 0.25, camD))
      const ph: N = dot(worldXZ, vec2(w.dir[0], w.dir[1])).mul(k).sub(time.mul(om)).add(w.phase)
      const qa: N = amp.mul(w.steep / (k * w.amp * swells.length))
      disp = disp.add((vec3 as N)(cos(ph).mul(qa).mul(w.dir[0]), sin(ph).mul(amp), cos(ph).mul(qa).mul(w.dir[1])))
    }
    const vHeight: N = varying(disp.y.div(ampSum * 0.75), "vWaveHeight")
    const vCalm: N = varying(calm, "vWaveCalm")

    // ---- fragment stage ----
    const p: N = positionWorld.xz
    const toEye: N = cameraPosition.sub(positionWorld)
    const dist: N = length(toEye)
    const eye: N = toEye.div(dist)
    const detail: N = smoothstep(3500, 300, dist)
    // Analytic normal: swell slopes + per-pixel chop.
    let nx: N = float(0), nz: N = float(0)
    for (const w of swells) {
      const k = (2 * Math.PI) / w.length, om = Math.sqrt(G * k)
      const amp: N = vCalm.mul(w.amp).mul(smoothstep(w.fade * 1.6, w.fade * 0.15, dist))
      const ph: N = dot(p, vec2(w.dir[0], w.dir[1])).mul(k).sub(time.mul(om)).add(w.phase)
      const c: N = cos(ph).mul(amp).mul(k)
      nx = nx.add(c.mul(w.dir[0]))
      nz = nz.add(c.mul(w.dir[1]))
    }
    // Near field (chop + rain ripples) fades out by ~600 m: a dynamic branch skips it beyond.
    const nearReach = Math.max(600, ...chop.map(w => w.fade * 0.9))
    const nearSlope = Fn(() => {
      const r = vec3(0, 0, 0).toVar()
      If(dist.lessThan(nearReach), () => {
        // Chop comes in patches (gusts), which also breaks up any remaining regularity.
        const gust: N = fbm(p.mul(0.006).add(STORM.wind.mul(time).mul(0.003)), 2).mul(1.4).add(0.2)
        let cx: N = float(0), cz: N = float(0)
        for (const w of chop) {
          const k = (2 * Math.PI) / w.length, om = Math.sqrt(G * k)
          const amp: N = vCalm.mul(w.amp).mul(smoothstep(w.fade * 0.9, w.fade * 0.15, dist)).mul(gust)
          const ph: N = dot(p, vec2(w.dir[0], w.dir[1])).mul(k).sub(time.mul(om)).add(w.phase)
          const c: N = cos(ph).mul(amp).mul(k)
          cx = cx.add(c.mul(w.dir[0]))
          cz = cz.add(c.mul(w.dir[1]))
        }
        // Fine noise ripples on top (rain-pocked surface near the camera).
        const rip: N = vnoise(p.mul(0.25).add(vec2(time.mul(0.9), time.mul(-0.6)))).sub(0.5).mul(smoothstep(600, 60, dist)).mul(0.12)
        r.assign(vec3(cx, cz, rip))
      })
      return r
    })()
    nx = nx.add(nearSlope.x)
    nz = nz.add(nearSlope.y)
    // Far field: the regular swell normals fade out (see `fade`) and a domain-warped noise slope
    // takes over, so there is no repeating stripe pattern from altitude.
    // Perf: evaluated only where it shows (dynamic branch), with a lighter warp/octave count below High.
    const farT: N = smoothstep(900, 3000, dist)
    const farSlope = Fn(() => {
      const r = vec2(0, 0).toVar()
      If(farT.greaterThan(0.001), () => {
        const fq: N = p.mul(0.0045).add(STORM.wind.mul(time).mul(0.0012))
        const wo = s.oceanDetail >= 2 ? 2 : 1
        const warp: N = s.oceanDetail >= 1 ? vec2(fbm(fq.add(vec2(3.7, 1.1)), wo), fbm(fq.add(vec2(-2.3, 8.9)), wo)).mul(2.2) : vec2(0, 0)
        const o = s.oceanDetail >= 2 ? 3 : s.oceanDetail >= 1 ? 2 : 1
        const fA: N = fbm(fq.add(warp), o), fB: N = fbm(fq.add(warp).add(vec2(0.37, 0)), o), fC: N = fbm(fq.add(warp).add(vec2(0, 0.37)), o)
        r.assign(vec2(fB.sub(fA), fC.sub(fA)).mul(farT).mul(0.9))
      })
      return r
    })()
    nx = nx.add(farSlope.x)
    nz = nz.add(farSlope.y)
    const rip: N = nearSlope.z
    const n: N = normalize(vec3(nx.negate().mul(1.2).add(rip), 1, nz.negate().mul(1.2).sub(rip)))
    const depth: N = (shoreTex as N).sample(p.add(WORLD_HALF).div(WORLD_SIZE)).r.mul(SHORE_MAX - SHORE_MIN).add(SHORE_MIN).negate()

    // Body colour: deep → mid on crests (light through the wave), murky shallows near land.
    let col: N = mix(cDeep, cWater, clamp(vHeight.mul(0.5).add(0.45), 0, 1))
    col = mix(cShallow, col, smoothstep(1.5, 14, depth))
    const lambert: N = max(dot(n, keyDir), 0)
    col = col.mul((keyCol as N).mul(lambert).add(ambient))

    // Reflections: fresnel toward the storm sky; a sheen from the bright break; lightning.
    const r: N = reflect(eye.negate(), n)
    const rUp: N = vec3(r.x, max(r.y, 0.0), r.z)
    const sky: N = s.cloudLayers > 0 ? stormSky(normalize(rUp), 2) : horizonColor(normalize(rUp))
    const fres: N = pow(float(1).sub(max(dot(n, eye), 0)), 5).mul(0.6).add(0.02)
    col = mix(col, sky, fres)
    const sheen: N = pow(max(dot(r, breakDir3), 0), 70).mul(0.55).add(pow(max(dot(r, breakDir3), 0), 12).mul(0.12))
    col = col.add(STORM.fogBreak.mul(sheen).mul(detail.mul(0.6).add(0.4)))
    const fl: N = max(dot(r, STORM.flashDir), 0)
    const flashFade: N = smoothstep(4000, 600, dist).mul(0.6).add(0.4)
    col = col.add(STORM.lightning.mul(STORM.flash).mul(pow(fl, 40).mul(0.8).add(fres.mul(0.08)).add(0.015)).mul(flashFade))

    // Foam: crests (stretched along the wind), wind streaks, shore surf, ship wakes.
    const w2: N = normalize(STORM.wind)
    const along: N = dot(p, w2), across: N = dot(p, vec2(w2.y.negate(), w2.x))
    const streak: N = vnoise(vec2(along.mul(0.012), across.mul(0.11)).add(vec2(time.mul(0.05), 0)))
    const blot: N = fbm(p.mul(0.045).add(STORM.wind.mul(time).mul(0.004)), s.oceanDetail >= 2 ? 3 : 2)
    const grain: N = vnoise(p.mul(0.12).add(vec2(time.mul(0.2), 0)))
    // Whitecaps: only on the highest crests, broken up by two noise scales.
    const crest: N = smoothstep(0.55, 0.95, vHeight.add(blot.mul(0.35)).sub(0.1))
    let foam: N = crest.mul(smoothstep(0.58, 0.85, blot)).mul(smoothstep(0.45, 0.8, grain)).mul(vCalm).mul(0.6)
    // Thin wind streaks (lines of old foam), faint.
    foam = max(foam, smoothstep(0.8, 0.97, streak).mul(smoothstep(0.55, 0.85, grain)).mul(0.07).mul(detail))
    const surfLine: N = smoothstep(0.0, 1.0, depth).mul(smoothstep(3.0, 1.2, depth))
    const surfBands: N = smoothstep(0.6, 0.95, sin(depth.mul(0.9).sub(time.mul(1.1)).add(blot.mul(6))).mul(0.5).add(0.5)).mul(smoothstep(6, 2, depth)).mul(smoothstep(0.3, 0.7, grain))
    foam = max(foam, max(surfLine, surfBands.mul(0.7)).mul(smoothstep(-0.5, 0.2, depth)))
    const wake = Fn(() => {
      const f = float(0).toVar()
      Loop(MAX_SHIPS, ({ i }: { i: N }) => {
        const a: N = shipsA.element(i), b: N = shipsB.element(i)
        const rel: N = p.sub(a.xy)
        // Perf: skip ships whose wake can't reach this pixel (most of the sea, and unused slots).
        const reach: N = a.z.div(2.2).add(b.z.mul(110)).add(90)
        If(dot(rel, rel).lessThan(reach.mul(reach)), () => {
        const aft: N = dot(rel, b.xy.negate())
        const side: N = abs(dot(rel, vec2(b.y.negate(), b.x)))
        const halfLen: N = a.z.div(2.2), halfWid: N = a.w
        const stern: N = aft.sub(halfLen)
        const len: N = b.z.mul(110).add(60)
        const behind: N = smoothstep(halfLen.negate().mul(1.1), halfLen.negate().mul(0.6), stern).mul(smoothstep(len, 0, stern))
        const width: N = halfWid.mul(1.1).add(max(stern, 0).mul(0.045))
        const trail: N = smoothstep(width, width.mul(0.35), side).mul(behind)
        const arm: N = smoothstep(4, 0.5, abs(side.sub(halfWid.add(max(stern, 0).mul(0.36))))).mul(behind).mul(0.6).mul(smoothstep(-5, 20, stern))
        const hull: N = smoothstep(halfWid.add(5), halfWid, side).mul(smoothstep(halfLen.add(6), halfLen, abs(aft))).mul(0.25)
        f.assign(max(f, max(max(trail.mul(0.55), arm.mul(0.8)), hull)))
        })
      })
      return f
    })()
    foam = max(foam, wake.mul(smoothstep(0.45, 0.85, blot.mul(0.6).add(grain.mul(0.6)))))
    const foamLit: N = (cFoam as N).mul((keyCol as N).mul(lambert.mul(0.5).add(0.5)).add(ambient)).mul(0.75).add(STORM.lightning.mul(STORM.flash).mul(0.35))
    col = mix(col, foamLit, clamp(foam, 0, 1))
    // Distance darkening before the fog takes over.
    col = col.mul(mix(float(1), float(0.72), smoothstep(800, 6000, dist)))

    const mat = new MeshBasicNodeMaterial({ fog: true })
    mat.name = "World · storm ocean"
    // Sink the surface slightly over land/shallows so it never z-fights low beaches.
    const sink: N = smoothstep(2.5, -0.5, depthV).mul(0.9)
    mat.positionNode = vec3(worldXZ.x.add(disp.x), disp.y.sub(sink), worldXZ.y.add(disp.z))
    mat.colorNode = col
    const geo = radialGrid(s.oceanSegments, s.oceanRings, s.far * 1.15)
    const m = new Mesh(geo, mat)
    m.name = "World · ocean"
    m.frustumCulled = false
    m.renderOrder = -10
    return { m, mat }
  }

  const holder = new Group()
  holder.name = "World · ocean holder"
  function rebuild(s: WorldQualitySettings) {
    if (mesh) { holder.remove(mesh); mesh.geometry.dispose(); material?.dispose() }
    const b = build(s)
    mesh = b.m
    material = b.mat
    holder.add(mesh)
  }
  rebuild(settings)

  let dirty = false, lastUpload = 0
  return {
    mesh: holder,
    setQuality(s: WorldQualitySettings) { rebuild(s) },
    writeRows(z0: number, rows: Uint8Array) {
      data.set(rows, z0 * SHORE_SIZE)
      dirty = true
    },
    update(time: number, camera: Vector3) {
      // Snap the grid origin so near vertices don't swim.
      origin.value.set(Math.round(camera.x / 4) * 4, Math.round(camera.z / 4) * 4)
      const teams = fleetState().teams
      FLEET.forEach((sh, i) => {
        if (i >= MAX_SHIPS) return
        const a = shipsA.array[i] as Vector4, b = shipsB.array[i] as Vector4
        const p = posedShip(sh.id)
        if (!p || sh.team >= teams) { a.set(1e7, 1e7, 1, 1); return }
        const sp = SHIP_SPECS[sh.kind]
        const v = deckVelocity(p.position[0], p.position[2])
        const speed = v ? Math.hypot(v[0], v[2]) : 0
        a.set(p.position[0], p.position[2], sp.halfLength * 2.2, sp.halfWidth)
        b.set(-Math.sin(p.heading), -Math.cos(p.heading), Math.min(1, speed / 14) * 0.7 + 0.3, 0)
      })
      if (dirty && time - lastUpload > 0.3) { shore.needsUpdate = true; dirty = false; lastUpload = time }
    },
    dispose() { mesh?.geometry.dispose(); material?.dispose(); shore.dispose() },
  }
}

// Silence unused-import lints for helpers kept for tuning.
void exp; void sqrt
