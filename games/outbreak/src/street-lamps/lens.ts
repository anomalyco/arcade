import { streetCone } from "@arcade/kit/gpu/lights/physical"
import { streetProfile, type Vec3 } from "@arcade/kit/gpu/lights/street"
import type { Lamp } from "../../shared/map"
import { STREET_LAMP_POSTS, streetLampHead, type ResolvedLamp } from "../lighting"
import type { OutbreakStreetLampSettings } from "./settings"

/** Where the roads run in the repeating block (`ground.ts`, `audio/space.ts`): carriageway 40..48, sidewalks to 38 and 50. */
const BLOCK = 96
const ROAD_MID = 44
const fold = (v: number) => ((v % BLOCK) + BLOCK) % BLOCK

/**
 * Plan direction from a lamp's pole towards the road it lights: towards the carriageway's middle along the axis whose
 * road band the pole stands beside (both at a corner), else +x (the arm the streamed poles are built with).
 */
export function streetArm(x: number, z: number): [number, number] {
  const fx = fold(x)
  const fz = fold(z)
  const ax = fx >= 37 && fx <= 51.5 ? Math.sign(ROAD_MID - fx) : 0
  const az = fz >= 37 && fz <= 51.5 ? Math.sign(ROAD_MID - fz) : 0
  if (!ax && !az) return [1, 0]
  const l = Math.hypot(ax, az)
  return [ax / l, az / l]
}

/** The visible cobra-head post a remapped origin lamp stands for (`resolveLampLight`'s two hand-placed pools), or null. */
function originPost(lamp: Lamp): (typeof STREET_LAMP_POSTS)[number] | null {
  if (lamp.x === 52 && lamp.y === 39) return STREET_LAMP_POSTS[0]
  if (lamp.x === 50 && lamp.y === 8) return STREET_LAMP_POSTS[1]
  return null
}

/** Ground flux of Today's street lamp (`shaders.ts` lightAttenuation): power-free, over its plan disc of radius r. */
export function todayStreetFlux(h: number, r: number, tight: number, steps = 96): number {
  let sum = 0
  const t = Math.max(0.5, tight)
  for (let i = 0; i < steps; i++) {
    const rho = ((i + 0.5) / steps) * r
    const d = Math.hypot(rho, h)
    const dn = Math.max(d, 0.85)
    const win = (1 - (rho * rho) / (r * r)) ** 2
    sum += (0.025 + 2.25 / (1 + dn * dn * 0.62 * t)) * win * (h / d) * 2 * Math.PI * rho
  }
  return (sum * r) / steps
}

type Profile = Pick<OutbreakStreetLampSettings, "slAlong" | "slStreet" | "slHouse" | "slCutoff" | "slGlow">
const kitProfile = (s: Profile) => ({ along: s.slAlong, street: s.slStreet, house: s.slHouse, cutoff: s.slCutoff, glow: s.slGlow })

/** Ground flux of the lens lamp (profile / (d² + b²), the plan window over radius r) at nadir intensity 1. */
export function lensStreetFlux(h: number, r: number, b: number, s: Profile, steps = 48): number {
  const p = kitProfile(s)
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const rho = ((i + 0.5) / steps) * r
    const d = Math.hypot(rho, h)
    const win = (1 - (rho * rho) / (r * r)) ** 2
    for (let j = 0; j < steps; j++) {
      const ph = ((j + 0.5) / steps) * Math.PI * 2
      const dir: Vec3 = [(Math.cos(ph) * rho) / d, -h / d, (Math.sin(ph) * rho) / d]
      sum += (streetProfile(dir, [1, 0], p) / (d * d + b * b)) * win * (h / d) * rho
    }
  }
  return (sum * r * Math.PI * 2) / (steps * steps)
}

const gainCache = new Map<string, number>()

/** Multiplier on Today's power that gives the lens lamp Today's light on the ground (`slFlux` is applied to the power). */
export function streetLensGain(s: OutbreakStreetLampSettings, todayH: number, todayR: number, tight: number, h: number, r: number): number {
  const key = [todayH, todayR, tight, h, r, s.slLensB, s.slAlong, s.slStreet, s.slHouse, s.slCutoff, s.slGlow].map((v) => v.toFixed(3)).join("/")
  let g = gainCache.get(key)
  if (g === undefined) {
    if (gainCache.size > 64) gainCache.clear()
    g = todayStreetFlux(todayH, todayR, tight) / Math.max(lensStreetFlux(h, r, s.slLensB, s), 1e-6)
    gainCache.set(key, g)
  }
  return g
}

/**
 * Turns a resolved street lamp into the lens emitter (in place): the head where the visible lens is, the light radius
 * from the mounting height, the street cone the scene's lightAttenuation reads, Today's ground flux × `slFlux`, and a
 * polar shadow whose penumbra is the lens size.
 *
 * The cone is the kit's `streetCone` (arm, lens a, 7 + b) with one Outbreak change: cone.z carries the flux gain in
 * place of the lens length (the air reads the length from `OL.street2`). Power stays in Today's units (× `slFlux`), so
 * reflections, dust and smoke, which read the slot's power, see the same lamp as Today.
 */
export function applyStreetLens(lamp: Lamp, res: ResolvedLamp, s: OutbreakStreetLampSettings, tight: number, groundY = 0): void {
  if (lamp.kind !== "street" || res.power <= 0.001) return
  const post = originPost(lamp)
  let arm: [number, number]
  let hx = res.lx
  let hy = lamp.h
  let hz = res.ly
  if (post) {
    const head = streetLampHead(post)
    hx = head[0]
    hy = head[1] - 0.06
    hz = head[2]
    arm = [Math.cos(post.yaw), Math.sin(post.yaw)]
  } else arm = streetArm(lamp.x, lamp.y)
  const mh = Math.max(1, hy - groundY)
  const r = s.slReach * mh
  const gain = streetLensGain(s, Math.max(0.5, res.lh - groundY), res.r, tight, mh, r)
  res.lx = hx
  res.lh = hy
  res.ly = hz
  res.r = r
  res.rEff = r
  res.power *= s.slFlux
  const c = streetCone(arm, Math.max(0.02, s.slLensA), Math.min(0.49, Math.max(0.02, s.slLensB)))
  res.cone[0] = c[0]
  res.cone[1] = c[1]
  res.cone[2] = gain
  res.cone[3] = c[3]
  res.softness = (s.slLensA + s.slLensB) * s.slSoftness
  res.castShadows = true
}
