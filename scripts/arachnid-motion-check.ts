/**
 * Runs the arachnid gait headless along a route through trunks on rolling ground and feeds its displayed joints to
 * the body-motion checker (`@arcade/kit/motion-check`). The checker's thresholds are calibrated on human mocap, so
 * for the spider it measures and this script holds the creature-agnostic rules: no bad numbers, planted feet that never
 * slip, soles that neither sink nor hover, rigid leg segments, and no pops (the worst jerk per joint class is reported
 * against the body's own speed so a regression shows).
 *
 *   hivemind run --kind cargo -- bun scripts/arachnid-motion-check.ts [--size 3.5] [--legs 2.5] [--ride 0.42] [--swing 1.5] [--lift 1.6] [--seconds 40] [--out captures/arachnid]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ArachnidLegs, HARVESTMAN_SHAPE, arachnidSole, legLengths, type ArachnidShape } from "../packages/kit/creature/arachnid-legs"
import { createRoute, routeIntent } from "../packages/kit/creature/arachnid-route"
import { measureBodyMotion, type MotionFrame } from "../packages/kit/motion-check"
import { CREATURE_STEP, createCreatureMotion, stepCreatureMotion, unitDt, unitSurface, type CreatureSurface } from "../packages/kit/sim/creature-motion"

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : null
const body = arg("size", 3.5), legScale = arg("legs", 2.5), seconds = arg("seconds", 40)
const size = body * legScale
const shape: ArachnidShape = { ...HARVESTMAN_SHAPE, ride: arg("ride", HARVESTMAN_SHAPE.ride), swing: arg("swing", HARVESTMAN_SHAPE.swing), lift: arg("lift", HARVESTMAN_SHAPE.lift) }

const trunks: [number, number, number][] = []
for (let i = 0; i < 90; i++) {
  const a = i * 2.399963, r = 6 + Math.sqrt(i) * 7.5
  trunks.push([Math.cos(a) * r, Math.sin(a) * r, 0.25 + ((i * 37) % 11) / 30])
}
const world: CreatureSurface = {
  heightAt: (x, z) => 1.4 * Math.sin(x * 0.045) * Math.cos(z * 0.038) + 0.5 * Math.sin(x * 0.13 + z * 0.09) + 0.15 * Math.sin(x * 0.41 - z * 0.33),
  walkable: (x, z) => trunks.every(([tx, tz, r]) => Math.hypot(x - tx, z - tz) > r + 0.1),
}
const ground = unitSurface(world, size)
const route = createRoute([[-30, -20], [25, -28], [40, 15], [5, 38], [-35, 20]])
const motion = createCreatureMotion(-45 / size, -10 / size, 0)
const legs = new ArachnidLegs(motion, ground, size, shape)

const frames: MotionFrame[] = []
let travelled = 0, maxStretch = 0, minSupports = 8, slips = 0
let last = legs.pose()
const dt = unitDt(CREATURE_STEP, size)
for (let f = 0; f < seconds * 60; f++) {
  const share = f % 1200 < 1000 ? 0.4 : 0
  stepCreatureMotion(motion, routeIntent(route, motion.x * size, motion.z * size, share, "walk", 6), dt, ground)
  legs.step(motion, ground, dt)
  const pose = legs.pose()
  const joints: Record<string, readonly [number, number, number]> = { pelvis: pose.body }
  const contacts: Record<string, { point: readonly [number, number, number]; planted: boolean; ground: number; surfaceY: number }> = {}
  pose.legs.forEach((leg, i) => {
    joints[`hip${i}`] = leg.joints[0]
    joints[`knee${i}`] = leg.joints[1]
    joints[`ankle${i}`] = leg.joints[2]
    joints[`foot${i}`] = leg.joints[3]
    const sole = arachnidSole(leg, size)
    contacts[`foot${i}`] = { point: leg.joints[3], planted: leg.planted, ground: world.heightAt(sole[0], sole[2]), surfaceY: sole[1] }
    const prev = last.legs[i]!
    if (prev.planted && leg.planted && leg.joints[3].some((v, k) => v !== prev.joints[3][k])) slips++
    const L = legLengths(i)
    for (let s = 0; s < 3; s++) maxStretch = Math.max(maxStretch, Math.abs(Math.hypot(...leg.joints[s + 1]!.map((v, k) => v - leg.joints[s]![k]!) as [number, number, number]) - L[s]! * size))
  })
  minSupports = Math.min(minSupports, pose.legs.filter(l => l.planted).length)
  const speed = Math.hypot(motion.vx, motion.vz) * size / Math.sqrt(size)
  travelled += speed / 60
  frames.push({ dt: 1 / 60, joints, speed, contacts })
  last = pose
}

const readings = measureBodyMotion(frames, { speed: 1.4, leg: legLengths(0)[0] + legLengths(0)[1] })
const worst = new Map<string, { value: number; unit: string; frame: number }>()
for (const r of readings) {
  const key = `${r.metric}/${r.space}/${r.joint.replace(/\d+$/, "")}`
  const w = worst.get(key)
  if (!w || r.value > w.value) worst.set(key, { value: r.value, unit: r.unit, frame: r.frame })
}
const get = (k: string) => worst.get(k)?.value ?? 0
const report = {
  shape: { size: body, legs: legScale, ...shape, metresPerUnit: size, legReach: (legLengths(0)[0] + legLengths(0)[1] + legLengths(0)[2]) * size },
  seconds, travelled, minSupports, plantedSlips: slips, maxSegmentStretchM: maxStretch,
  badNumbers: readings.filter(r => r.metric === "bad-number").length,
  footSlipMps: get("foot-slip/local/foot"), footSinkM: get("foot-sink/local/foot"), footHoverM: get("foot-hover/local/foot"),
  worst: Object.fromEntries([...worst].filter(([k]) => /jerk\/world|acceleration\/world|velocity\/world/.test(k)).map(([k, v]) => [k, { ...v, value: +v.value.toFixed(3) }])),
}
const failures = [
  report.badNumbers > 0 && "bad numbers",
  report.plantedSlips > 0 && "a planted foot moved",
  report.footSlipMps > 0 && "foot-slip above zero",
  report.footSinkM > 0.005 * size && "a sole sinks",
  report.footHoverM > 0.005 * size && "a sole hovers",
  report.minSupports < 4 && "fewer than four feet down",
  report.maxSegmentStretchM > 0.025 * size && "a leg segment stretched",
  report.travelled < seconds * 0.5 && "it barely moved",
].filter(Boolean)
console.log(JSON.stringify({ ...report, failures }, null, 2))
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "arachnid-motion.json"), JSON.stringify({ ...report, failures }, null, 2))
}
if (failures.length) process.exit(1)
