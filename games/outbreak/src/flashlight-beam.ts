import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import type { VolumeLightShader } from "@arcade/kit/gpu/renderer"
import { common } from "@arcade/kit/gpu/shaders"
import { raycast } from "@arcade/kit/sim/geom"
import { outbreakLightingStructWgsl } from "./lighting"

/** The flashlight's softened, windowed inverse-square falloff and its cone with a hot core (the surface shading's shape). */
export const beamShapeWgsl = /* wgsl */ `
fn falloff(d2: f32) -> f32 {
  let r = max(OL.u4.y, 1.0);
  let x2 = d2 / (r * r);
  let tight = clamp(OL.beamLook.y, 0.0, 2.0);
  let soft = mix(max(OL.u13.z, 0.1), min(max(OL.u13.z, 0.1), 1.35), clamp(tight, 0.0, 1.0));
  if (OL.rampOn.x > 0.5) { return select(0.0, outbreakRamp(0u, sqrt(x2)), x2 < 1.0) / (1.0 + d2 / (soft * soft)); }
  let win = clamp(1.0 - x2 * x2, 0.0, 1.0);
  let tightWin = pow(clamp(1.0 - x2, 0.0, 1.0), 2.8);
  return mix(win * win, tightWin, clamp(tight, 0.0, 1.0)) / (1.0 + d2 / (soft * soft));
}

/** Cone and hot core, by angle off the axis as a share of the outer half-angle. */
fn profile(cosT: f32) -> f32 {
  let t = acos(clamp(cosT, -1.0, 1.0)) * OL.u17.y;
  let tight = clamp(OL.beamLook.y, 0.0, 2.0);
  let legacyCone = 1.0 - smoothstep(OL.u11.z, 1.15, t);
  let tightCone = (1.0 - smoothstep(0.14, 0.68, t)) * 0.18;
  let cone = mix(legacyCone, tightCone, clamp(tight, 0.0, 1.0));
  let coreW = mix(max(OL.u12.x, 0.05), min(max(OL.u12.x, 0.05), 0.26), clamp(tight, 0.0, 1.0)) / max(1.0, tight);
  let tc = t / max(coreW, 0.04);
  let coreAmp = mix(OL.u11.w, max(OL.u11.w, 1.35), clamp(tight, 0.0, 1.0));
  return cone + coreAmp * exp(-tc * tc);
}
`

/**
 * Visibility of a 3D point from a light's polar shadow row (`lensVis(slot * RAYS, point - lens, lens height)`):
 * walls and closed doors cut it, low props and actors only below their height, interpolated between two rays.
 */
export const lensVisibilityWgsl = /* wgsl */ `
fn lowShadow(t0: f32, t1: f32, h: f32, d: f32, y: f32, hl: f32) -> f32 {
  if (t0 >= FAR || y >= h - 0.03 || d <= t0) { return 1.0; }
  let lift = hl + 0.6;
  let end = min(t1 * (lift - y) / max(lift - h, 0.05), t1 + 6.0);
  let s = smoothstep(t0 - 0.03, t0 + 0.03, d) * (1.0 - smoothstep(end - 0.1, end + 0.1, d));
  return 1.0 - s * 0.9;
}

fn rayVis(base: u32, ray: u32, d: f32, y: f32, hl: f32) -> f32 {
  let p0 = polar[(base + ray) * 2u];
  var v = 1.0 - smoothstep(p0.x - 0.03, p0.x + 0.06, d);
  let p1 = polar[(base + ray) * 2u + 1u];
  if (v <= 0.0 || d <= min(p0.y, p1.w) - 0.04) { return v; }
  // p1.w: the nearest body cast only for the shaft while soft capsule shadows draw it on surfaces (0.27 m, 1.72 m).
  return v * lowShadow(p0.y, p0.z, p0.w, d, y, hl) * lowShadow(p1.x, p1.y, p1.z, d, y, hl) * lowShadow(p1.w, p1.w + 0.54, min(1.72, hl - 0.25), d, y, hl);
}

/** Visibility of a 3D point from the lens, interpolated between the two nearest polar rays. */
fn lensVis(base: u32, rel: vec3f, hl: f32) -> f32 {
  let d = length(rel.xz);
  if (d < 0.05) { return 1.0; }
  let f = (atan2(rel.z, rel.x) / TAU + 1.0) * f32(RAYS) - 0.5;
  let r0 = u32(floor(f)) % RAYS;
  let r1 = (r0 + 1u) % RAYS;
  return mix(rayVis(base, r0, d, rel.y + hl, hl), rayVis(base, r1, d, rel.y + hl, hl), fract(f));
}
`

/**
 * Volumetric flashlight shaft: single scattering marched through the beam cone along each view ray at reduced
 * resolution. The ray is clipped analytically to the cone (a little wider than the lit cone), the beam range and the
 * ground, then sampled at a few points with a static per-pixel offset. Each sample takes the beam's own angular
 * profile and softened inverse-square falloff, visibility from the flashlight's polar shadow row (walls, props and
 * actors, at the sample's height, so door frames and silhouettes cut the shaft), slowly drifting dust and a mild
 * forward-scattering phase. Rain, mist and interiors thicken the air. A small glare sits on the lens.
 */
export const flashlightVolumeShader: VolumeLightShader = {
  code: /* wgsl */ `
${common}
${foliageWindDeclarationsWgsl}
${outbreakLightingStructWgsl}

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn unproject(ndc: vec2f, z: f32) -> vec3f {
  let h = OL.invViewProj * vec4f(ndc, z, 1.0);
  return h.xyz / h.w;
}

${beamShapeWgsl}
${lensVisibilityWgsl}
fn dust(p: vec3f) -> f32 {
  let t = F.cam.w;
  let a = noise2(p.xz * 1.3 + vec2f(t * 0.06, -t * 0.035) + vec2f(p.y * 1.7, -p.y * 0.9));
  let b = noise2(p.xz * 3.9 + vec2f(-t * 0.09, t * 0.05) + vec2f(-p.y * 3.1, p.y * 2.3));
  return mix(1.0, 0.35 + 1.3 * (a * 0.65 + b * 0.35), OL.u18.y);
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  let power = OL.u4.z * 9.0;
  let density = OL.u18.x;
  if (OL.u4.w < 0.5 || power <= 0.001 || (density <= 0.001 && OL.u18.z <= 0.001)) { return vec4f(0.0); }
  let slot = u32(round(OL.u4.w));
  let lens = vec3f(OL.u3.x, OL.u11.x, OL.u3.y);
  let axis = vec3f(OL.u3.z * OL.u13.y, OL.u13.x, OL.u3.w * OL.u13.y);
  let ndc = vec2f(o.uv.x * 2.0 - 1.0, 1.0 - o.uv.y * 2.0);
  let ro = unproject(ndc, 0.0);
  let rd = normalize(unproject(ndc, 1.0) - ro);
  var col = vec3f(0.0);

  // Ray against the slightly widened cone: (v.a)^2 >= c^2 (v.v) on the forward nappe.
  let cosV = cos(min(1.45, 1.15 / max(OL.u17.y, 1e-3)));
  let c2 = cosV * cosV;
  let co = ro - lens;
  let dv = dot(rd, axis);
  let cv = dot(co, axis);
  let qa = dv * dv - c2;
  let qb = 2.0 * (dv * cv - c2 * dot(rd, co));
  let qc = cv * cv - c2 * dot(co, co);
  let disc = qb * qb - 4.0 * qa * qc;
  var t0 = 0.0;
  var t1 = -1.0;
  if (disc >= 0.0 && abs(qa) > 1e-6) {
    let s = sqrt(disc);
    let ra = min((-qb - s) / (2.0 * qa), (-qb + s) / (2.0 * qa));
    let rb = max((-qb - s) / (2.0 * qa), (-qb + s) / (2.0 * qa));
    if (qa < 0.0) {
      t0 = ra;
      t1 = rb;
    } else if (dot(co + rd * (rb + 0.01), axis) > 0.0) {
      t0 = rb;
      t1 = 1e5;
    } else {
      t0 = -1e5;
      t1 = ra;
    }
    if (dot(co + rd * (0.5 * (t0 + t1)), axis) <= 0.0 && qa < 0.0) { t1 = -1.0; }
  }
  // Clip to the beam range and the ground under the survivor.
  let r = OL.u4.y;
  let sb = dot(co, rd);
  let sd = sb * sb - (dot(co, co) - r * r);
  if (sd > 0.0) {
    let ss = sqrt(sd);
    t0 = max(t0, -sb - ss);
    t1 = min(t1, -sb + ss);
  } else {
    t1 = -1.0;
  }
  if (rd.y < -1e-4) { t1 = min(t1, (OL.u19.z - ro.y) / rd.y); }
  t0 = max(t0, 0.0);

  let samples = max(1.0, OL.u18.w);
  if (t1 > t0 && density > 0.001) {
    let dt = (t1 - t0) / samples;
    let jitter = fract(52.9829189 * fract(dot(floor(o.pos.xy), vec2f(0.06711056, 0.00583715))));
    let base = slot * RAYS;
    var acc = 0.0;
    for (var i = 0.0; i < samples; i += 1.0) {
      let p = ro + rd * (t0 + (i + jitter) * dt);
      let lv = p - lens;
      let d2 = dot(lv, lv);
      let d = sqrt(max(d2, 1e-6));
      let cosT = dot(lv, axis) / d;
      let w = profile(cosT) * falloff(d2);
      if (w > 1e-4) {
        let vis = lensVis(base, lv, lens.y);
        let cosA = dot(lv / d, -rd);
        let phase = 0.91 / pow(1.09 - 0.6 * cosA, 1.5);
        let nearAxisFade = mix(1.0, exp(-d * 0.24), clamp(OL.beamLook.y, 0.0, 1.0));
        acc += w * vis * dust(p) * phase * nearAxisFade * smoothstep(0.0, 0.35, d) * (1.0 - smoothstep(OL.u19.w * 0.6, OL.u19.w, d));
      }
    }
    let clearAirScale = mix(1.0, 0.28 + 0.32 * clamp(OL.u19.x + OL.u19.y * 0.5, 0.0, 1.0), clamp(OL.beamLook.y, 0.0, 1.0));
    let air = density * clearAirScale * (1.0 + 1.5 * OL.u19.x + 0.5 * OL.u19.y);
    col += OL.u5.rgb * acc * dt * power * air * 0.06;
  }

  // Glare on the lens, stronger when it faces the camera.
  if (OL.u18.z > 0.001) {
    let clip = F.viewProj * vec4f(lens, 1.0);
    if (clip.w > 0.0) {
      let aspect = F.screen.x / max(F.screen.y, 1.0);
      let q = (ndc - clip.xy / clip.w) * vec2f(aspect, 1.0);
      let r2 = dot(q, q);
      let facing = max(0.0, dot(axis, normalize(F.cam.xyz - lens)));
      let g = exp(-r2 / 0.00015) * 2.0 + exp(-sqrt(r2) / 0.04) * 0.3;
      col += OL.u5.rgb * vec3f(1.0, 0.95, 0.88) * g * OL.u18.z * OL.u4.z * (0.35 + 0.65 * facing);
    }
  }
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(col, 1.0 - exp(-lum * 5.0));
}
`,
}

/** Rig pose of the flashlight for one frame (see `Survivor.light`). */
export type RigLight = { p: readonly [number, number, number]; d: readonly [number, number, number]; mounted: boolean }

/**
 * Lens position and beam direction from the posed rig. A pistol light follows the barrel's yaw and pitch, but never
 * dips further than the pool-distance tilt, so low-ready lights the street ahead instead of the survivor's boots; a
 * hand-held light points along the aim at that tilt. The lens is pulled back out of any wall the hand reaches into.
 */
export function beamPose(
  light: RigLight,
  bodyX: number,
  bodyY: number,
  aim: number,
  groundY: number,
  poolDistance: number,
  blockers: readonly (readonly [number, number, number, number])[],
): { x: number; y: number; h: number; yaw: number; pitch: number } {
  const h = Math.max(groundY + 0.6, light.p[1])
  const maxDown = Math.atan2(Math.max(0.3, h - groundY), Math.max(0.5, poolDistance))
  const planLen = Math.hypot(light.d[0], light.d[2])
  const yaw = light.mounted && planLen > 0.2 ? Math.atan2(light.d[2], light.d[0]) : aim
  const pitch = light.mounted ? Math.max(-maxDown, Math.min(0.2, Math.atan2(light.d[1], planLen))) : -maxDown
  let x = light.p[0]
  let y = light.p[2]
  const reach = Math.hypot(x - bodyX, y - bodyY)
  if (reach > 1e-3) {
    const ux = (x - bodyX) / reach
    const uy = (y - bodyY) / reach
    const hit = raycast(bodyX, bodyY, ux, uy, blockers, reach + 0.05)
    if (hit < reach + 0.05) {
      x = bodyX + ux * Math.max(0, hit - 0.06)
      y = bodyY + uy * Math.max(0, hit - 0.06)
    }
  }
  return { x, y, h, yaw, pitch }
}

/** Extra air density for the shaft from the live weather (rain and mist). */
export function beamWeatherAir(weather: { intensity: number; mist: number }): number {
  return Math.min(2, weather.intensity * 0.6 + weather.mist * 1.2)
}

/**
 * Screen rect (0..1, top-left origin) bounding the visible shaft and lens glare: the lens plus the widened cone's
 * corners at a few distances up to `reach`, between the ground and just above the lens.
 */
export function beamScreenRect(
  project: (x: number, y: number, z: number) => { x: number; y: number; ok: boolean },
  lens: readonly [number, number, number],
  yaw: number,
  pitch: number,
  halfAngle: number,
  reach: number,
  groundY: number,
): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number, z: number) => {
    const q = project(x, y, z)
    if (!q.ok) {
      x0 = y0 = 0
      x1 = y1 = 1
      return
    }
    x0 = Math.min(x0, q.x)
    y0 = Math.min(y0, q.y)
    x1 = Math.max(x1, q.x)
    y1 = Math.max(y1, q.y)
  }
  add(lens[0], lens[1], lens[2])
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const spreadTan = Math.tan(Math.min(1.45, halfAngle * 1.15))
  for (const k of [0.25, 0.5, 1]) {
    const d = reach * k
    const cx = lens[0] + c * Math.cos(pitch) * d
    const cz = lens[2] + s * Math.cos(pitch) * d
    const spread = d * spreadTan + 0.3
    for (const side of [-1, 1]) {
      for (const y of [groundY, lens[1] + 0.4]) add(cx - s * spread * side, y, cz + c * spread * side)
    }
  }
  const m = 0.03
  return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(1, x1 + m), Math.min(1, y1 + m)]
}
