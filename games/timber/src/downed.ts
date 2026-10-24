// The downed: a body face down on the forest floor, propped on its forearms and dragging itself along, one elbow
// reaching past the other, a knee drawing up on the opposite side. It drives the game's ragdoll points (so the people
// rig and the blocky fallback pose the same body), blending in from the fall.
import type { Ragdoll } from "@arcade/kit/avatar/ragdoll"
import type { V3 } from "@arcade/kit/rig"

// The ragdoll's points, in its order.
const HIP_L = 0, HIP_R = 1, SH_L = 2, SH_R = 3, BACK = 4, CHEST = 5, HEAD = 6
const KNEE_L = 7, KNEE_R = 8, ANK_L = 9, ANK_R = 10, ELB_L = 11, ELB_R = 12, HAND_L = 13, HAND_R = 14
const RIGID = [HIP_L, HIP_R, SH_L, SH_R, BACK, CHEST, HEAD]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1))
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const mid = (a: V3, b: V3): V3 => mul(add(a, b), 0.5)

/** Two-bone reach from `root` to `end` with `a`, `b` long, bending towards `pole`: the middle joint. */
function bend(root: V3, end: V3, a: number, b: number, pole: V3): { joint: V3; end: V3 } {
  const to = sub(end, root)
  const d = Math.max(1e-3, Math.min(len(to), (a + b) * 0.995))
  const dir = norm(to)
  const along = (a * a - b * b + d * d) / (2 * d)
  const up = norm(sub(pole, mul(dir, dot(pole, dir))))
  const h = Math.sqrt(Math.max(0, a * a - along * along))
  return { joint: add(add(root, mul(dir, along)), mul(up, h)), end: add(root, mul(dir, d)) }
}

export type Crawl = {
  /** The body's points when it went down: its rigid torso and limb lengths come from them. */
  rest: V3[]
  /** Crawl cycle (rad), advanced by distance; heading (rad, plan); when it went down (s). */
  phase: number
  heading: number
  at: number
  x: number
  y: number
  /** The points last drawn, handed back to the ragdoll if they die down here. */
  last: V3[] | null
}

export function newCrawl(rd: Ragdoll, heading: number, t: number, x: number, y: number): Crawl {
  return { rest: rd.pos.map((p): V3 => [p[0], p[1], p[2]]), phase: 0, heading, at: t, x, y, last: null }
}

export type CrawlLook = {
  /** Shoulders' height off the ground (m), propped on the forearms; metres crawled per cycle. */
  crawlShoulder: number
  crawlStride: number
}

/**
 * The downed body's points this frame at (x, y) facing `aim`, blended in from the ragdoll's fall over the first second.
 * Returns a ragdoll to pose from (the live one's constraints, these points).
 */
export function crawlPose(c: Crawl, rd: Ragdoll, x: number, y: number, aim: number, t: number, look: CrawlLook): Ragdoll {
  const moved = Math.hypot(x - c.x, y - c.y)
  if (moved > 1e-4) {
    c.phase += (moved / Math.max(0.1, look.crawlStride)) * Math.PI * 2
    // Facing where they drag themselves, turning slowly.
    const want = Math.atan2(y - c.y, x - c.x)
    let d = want - c.heading
    d = Math.atan2(Math.sin(d), Math.cos(d))
    c.heading += d * Math.min(1, moved * 3)
  } else if (t - c.at < 0.05) c.heading = aim
  c.x = x
  c.y = y
  const r = c.rest
  // The torso, rigid, as it stood: origin mid-hip, up to the shoulders, forward to the chest.
  const mh0 = mid(r[HIP_L]!, r[HIP_R]!)
  const u0 = norm(sub(mid(r[SH_L]!, r[SH_R]!), mh0))
  const f0 = norm(sub(sub(r[CHEST]!, r[BACK]!), mul(u0, dot(sub(r[CHEST]!, r[BACK]!), u0))))
  const r0 = cross(f0, u0)
  const torsoLen = len(sub(mid(r[SH_L]!, r[SH_R]!), mh0))
  const sway = Math.sin(c.phase) * 0.07
  const h = c.heading + sway
  const F: V3 = [Math.cos(h), 0, Math.sin(h)]
  const R: V3 = [-Math.sin(h), 0, Math.cos(h)]
  const Up: V3 = [0, 1, 0]
  const hipY = 0.13
  const shY = look.crawlShoulder + 0.03 * Math.cos(c.phase * 2)
  const incl = Math.asin(Math.max(-0.9, Math.min(0.9, (shY - hipY) / Math.max(0.2, torsoLen))))
  const u1 = add(mul(F, Math.cos(incl)), mul(Up, Math.sin(incl)))
  const f1 = add(mul(Up, -Math.cos(incl)), mul(F, Math.sin(incl)))
  const mh1: V3 = [x - F[0] * torsoLen * 0.55, hipY, y - F[2] * torsoLen * 0.55]
  const out: V3[] = rd.pos.map((p): V3 => [p[0], p[1], p[2]])
  for (const i of RIGID) {
    const d = sub(r[i]!, mh0)
    out[i] = add(add(add(mh1, mul(f1, dot(d, f0))), mul(u1, dot(d, u0))), mul(R, dot(d, r0)))
  }
  const lng = (a: number, b: number) => len(sub(r[a]!, r[b]!))
  const limbs = [
    { sh: SH_L, elb: ELB_L, hand: HAND_L, hip: HIP_L, knee: KNEE_L, ank: ANK_L, off: 0 },
    { sh: SH_R, elb: ELB_R, hand: HAND_R, hip: HIP_R, knee: KNEE_R, ank: ANK_R, off: Math.PI },
  ]
  for (const l of limbs) {
    const side = Math.sign(dot(sub(r[l.sh]!, mh0), r0)) || (l.off ? 1 : -1)
    const ph = c.phase + l.off
    // 0 pulling back under the shoulder .. 1 reached out ahead; the hand lifts as it swings forward.
    const reach = 0.5 - 0.5 * Math.cos(ph)
    const swing = Math.max(0, Math.sin(ph))
    const sh = out[l.sh]!
    const hand: V3 = add(add([sh[0], 0.035 + swing * 0.07, sh[2]], mul(F, 0.14 + reach * 0.32)), mul(R, side * (0.07 + reach * 0.05)))
    const arm = bend(sh, hand, lng(l.sh, l.elb), lng(l.elb, l.hand), add(add(mul(R, side * 0.7), mul(Up, -0.3)), mul(F, -0.4)))
    out[l.elb] = arm.joint
    out[l.hand] = arm.end
    // Legs drag behind; the knee on the side whose arm is pulling draws up and out.
    const draw = Math.max(0, -Math.cos(ph)) * 0.8
    const hip = out[l.hip]!
    const legLen = lng(l.hip, l.knee) + lng(l.knee, l.ank)
    const ank: V3 = add(add([hip[0], 0.09, hip[2]], mul(F, -legLen * (0.92 - draw * 0.35))), mul(R, side * (0.1 + draw * 0.22)))
    const leg = bend(hip, ank, lng(l.hip, l.knee), lng(l.knee, l.ank), add(mul(Up, -0.8), mul(R, side * 0.5)))
    out[l.knee] = leg.joint
    out[l.ank] = leg.end
  }
  // In from the fall.
  const k = Math.min(1, Math.max(0, (t - c.at - 0.35) / 0.8))
  const e = k * k * (3 - 2 * k)
  const pos = rd.pos.map((p, i): V3 => (i > HAND_R ? [p[0], p[1], p[2]] : [p[0] + (out[i]![0] - p[0]) * e, p[1] + (out[i]![1] - p[1]) * e, p[2] + (out[i]![2] - p[2]) * e]))
  c.last = pos
  return { ...rd, pos }
}

/** They died down here: the ragdoll takes over from the crawl, at rest. */
export function handBack(c: Crawl, rd: Ragdoll): void {
  if (!c.last) return
  rd.pos = c.last.map((p): V3 => [p[0], p[1], p[2]])
  rd.prev = c.last.map((p): V3 => [p[0], p[1], p[2]])
  rd.still = 0
}
