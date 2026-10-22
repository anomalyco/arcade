/** Headless body-motion lint. Sample the displayed joints, after animation/IK/retargeting. Metres, seconds, Y up. */
export type MotionPoint = readonly [number, number, number]
export type MotionFrame = {
  /** Elapsed seconds since the previous sample (also supplied on frame zero). */
  dt: number
  joints: Readonly<Record<string, MotionPoint>>
  /** Authoritative locomotion speed, not inferred from a potentially popping pelvis. */
  speed: number
  /** World-space sole contact points, separate from bone origins; supply terrain height at each point. */
  contacts?: Readonly<Record<string, { point: MotionPoint; planted: boolean; ground: number; surfaceY?: number }>>
  /** Independent prop anchor, not a copy of the hand being measured. Omit when released. */
  grips?: Readonly<Record<string, { hand: string; anchor: MotionPoint }>>
  /** Actual rigid-frame yaw, if available; otherwise inferred from hip/shoulder bars. */
  yaw?: { pelvis: number; torso: number }
  /** Extra production channels (e.g. all skin-bone positions/quaternions), checked for bad numbers without calibration. */
  numbers?: Readonly<Record<string, readonly number[]>>
  /** Reset derivative/contact/grip history on an intentional teleport or spawn. */
  reset?: boolean
}
export type MotionMetric = "displacement" | "velocity" | "acceleration" | "jerk" | "bone-length" | "width"
  | "hinge-reverse" | "hinge-flexion" | "hinge-rate" | "yaw-rate" | "yaw-acceleration"
  | "foot-slip" | "foot-sink" | "foot-hover" | "contact-snap" | "grip" | "bad-number"
export type MotionReading = {
  joint: string; frame: number; time: number; metric: MotionMetric; space: "world" | "pelvis" | "local"
  value: number; unit: string
  /** Divisor for calibration: stature × speed factor^derivative order (displacement includes dt). */
  scale: number
}
export type MotionViolation = MotionReading & { threshold: number; ratio: number; reason: string }
export type MotionCalibration = {
  version: 1
  sources: string[]
  /** Measured median reference ground speed, m/s. */
  speed: number
  /** Measured median reference leg length, m. */
  leg: number
  /** Each entry is a measured maximum, with provenance; margin is a declared policy, not anatomy. */
  limits: Record<string, { max: number; source: string }>
  margin: number
}

const sub = (a: MotionPoint, b: MotionPoint): MotionPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: MotionPoint, s: number): MotionPoint => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: MotionPoint, b: MotionPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: MotionPoint) => Math.hypot(...a)
const dist = (a: MotionPoint, b: MotionPoint) => len(sub(a, b))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const finite = (p: MotionPoint | undefined): p is MotionPoint => !!p && p.length === 3 && p.every(Number.isFinite)
const median = (a: number[]) => { const b = a.toSorted((x, y) => x - y); return b[b.length >> 1] ?? 0 }
const sides = ["L", "R"] as const
export const MOTION_BONES: readonly (readonly [string, string])[] = sides.flatMap(s => [
  [`hip${s}`, `knee${s}`], [`knee${s}`, `ankle${s}`], [`ankle${s}`, `ball${s}`], [`ball${s}`, `toe${s}`],
  [`shoulder${s}`, `elbow${s}`], [`elbow${s}`, `wrist${s}`],
] as const)
const bars = [["hipL", "hipR"], ["shoulderL", "shoulderR"]] as const
const canonical = (joint: string) => joint.replace(/[LR](?=$|:)/g, "Side")
export const motionKey = (r: Pick<MotionReading, "joint" | "metric" | "space">) => `${r.metric}/${r.space}/${canonical(r.joint)}`

function legLength(f: MotionFrame): number {
  const j = f.joints
  return median(sides.flatMap(s => finite(j[`hip${s}`]) && finite(j[`knee${s}`]) && finite(j[`ankle${s}`])
    ? [dist(j[`hip${s}`]!, j[`knee${s}`]!) + dist(j[`knee${s}`]!, j[`ankle${s}`]!)] : []))
}

/** Measurements are separate from verdicts so calibration, regression baselines and overlays use identical maths. */
export function measureBodyMotion(frames: readonly MotionFrame[], reference: { speed: number; leg: number }): MotionReading[] {
  if (!(reference.speed > 0) || !(reference.leg > 0) || !Number.isFinite(reference.speed) || !Number.isFinite(reference.leg))
    throw new Error("Motion reference speed and leg must be finite and positive")
  const out: MotionReading[] = []
  let time = 0, start = 0
  const times: number[] = []
  let rest = new Map<string, number>(), gripRest = new Map<string, number>()
  let history = new Map<string, MotionPoint[]>(), yawHistory = new Map<string, number[]>(), hingeHistory = new Map<string, number>()
  let stature = 1
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!, prev = i > start ? frames[i - 1] : undefined
    const emit = (joint: string, metric: MotionMetric, value: number, unit: string, scale = 1, space: MotionReading["space"] = "local") => {
      if ((!Number.isFinite(value) || !Number.isFinite(scale)) && metric !== "bad-number") {
        out.push({ joint, frame: i, time, metric: "bad-number", space, value: Infinity, unit: `non-finite ${metric}`, scale: 1 })
        return
      }
      out.push({ joint, frame: i, time, metric, space, value, unit, scale })
    }
    if (!(f.dt > 0) || !Number.isFinite(f.dt) || !Number.isFinite(f.speed) || f.speed < 0) {
      emit("input", "bad-number", Infinity, "invalid dt/speed")
      start = i + 1; history.clear(); yawHistory.clear(); hingeHistory.clear(); gripRest.clear(); rest.clear()
      continue
    }
    time += f.dt; times[i] = time
    if (f.reset || i === start) {
      start = i; rest = new Map(); gripRest = new Map(); history = new Map(); yawHistory = new Map(); hingeHistory = new Map()
      stature = (legLength(f) || reference.leg) / reference.leg
    }
    // Use the fastest input in the derivative stencil: a hard stop must not shrink a running jerk's allowance.
    const speed = Math.max(...frames.slice(Math.max(start, i - 3), i + 1).map(x => x.speed))
    const rate = Math.max(1, speed / stature / reference.speed)
    let bad = false
    for (const [id, p] of Object.entries(f.joints)) if (!finite(p)) { emit(id, "bad-number", Infinity, "non-finite joint"); bad = true }
    if (!finite(f.joints.pelvis)) { emit("pelvis", "bad-number", Infinity, "missing/invalid pelvis"); bad = true }
    for (const [id, c] of Object.entries(f.contacts ?? {})) if (!finite(c.point) || !Number.isFinite(c.ground) || (c.surfaceY !== undefined && !Number.isFinite(c.surfaceY))) { emit(id, "bad-number", Infinity, "invalid contact"); bad = true }
    for (const [id, g] of Object.entries(f.grips ?? {})) if (!finite(g.anchor) || !finite(f.joints[g.hand])) { emit(id, "bad-number", Infinity, "invalid grip"); bad = true }
    if (f.yaw && !Object.values(f.yaw).every(Number.isFinite)) { emit("yaw", "bad-number", Infinity, "invalid yaw"); bad = true }
    for (const [id, values] of Object.entries(f.numbers ?? {})) if (!values.every(Number.isFinite)) { emit(id, "bad-number", Infinity, "non-finite production channel"); bad = true }
    if (bad) { start = i + 1; continue }
    for (const key of history.keys()) if (!f.joints[key.split("/")[0]!]) history.delete(key)
    for (const [id, p] of Object.entries(f.joints)) for (const space of ["world", "pelvis"] as const) {
      const key = `${id}/${space}`, point = space === "world" ? p : sub(p, f.joints.pelvis!)
      const old = history.get(key), derivatives = [point]
      if (old && i > start) {
        const delta = dist(point, old[0]!)
        emit(id, "displacement", delta, "m", stature * rate * f.dt, space)
        for (let order = 1; order <= 3 && order <= i - start && old[order - 1]; order++) {
          const d = mul(sub(derivatives[order - 1]!, old[order - 1]!), order / (time - times[i - order]!))
          derivatives.push(d)
          emit(id, (["velocity", "acceleration", "jerk"] as const)[order - 1]!, len(d), ["m/s", "m/s²", "m/s³"][order - 1]!, stature * rate ** order, space)
        }
      }
      history.set(key, derivatives)
    }
    for (const [a, b] of [...MOTION_BONES, ...bars]) {
      if (!f.joints[a] || !f.joints[b]) continue
      const key = `${a}:${b}`, d = dist(f.joints[a]!, f.joints[b]!)
      if (!rest.has(key)) rest.set(key, d)
      emit(key, bars.some(x => x[0] === a && x[1] === b) ? "width" : "bone-length", Math.abs(d - rest.get(key)!), "m", stature)
    }
    for (const side of sides) for (const kind of ["knee", "elbow"] as const) {
      const id = `${kind}${side}`, j = f.joints
      const a = j[`${kind === "knee" ? "hip" : "shoulder"}${side}`], b = j[id], c = j[`${kind === "knee" ? "ankle" : "wrist"}${side}`]
      if (!a || !b || !c) { hingeHistory.delete(id); continue }
      const u = sub(b, a), v = sub(c, b), chord = sub(c, a)
      const flex = Math.acos(Math.max(-1, Math.min(1, dot(u, v) / Math.max(1e-12, len(u) * len(v)))))
      emit(id, "hinge-flexion", flex, "rad")
      // Knee forward follows the boot; elbow back follows torso. This is a signed bend-plane check, not axial rotation.
      const bar = j.shoulderR && j.shoulderL ? sub(j.shoulderR, j.shoulderL) : [0, 0, 1] as const
      const forward: MotionPoint = kind === "knee" && j[`toe${side}`] && j[`ball${side}`]
        ? sub(j[`toe${side}`]!, j[`ball${side}`]!) : [bar[2], 0, -bar[0]]
      const offset = sub(u, mul(chord, dot(u, chord) / Math.max(1e-12, dot(chord, chord))))
      const signed = dot(offset, forward) / Math.max(1e-12, len(forward)) * (kind === "knee" ? 1 : -1)
      emit(id, "hinge-reverse", Math.max(0, -signed), "m", stature)
      const old = hingeHistory.get(id)
      if (old !== undefined && i > start) emit(id, "hinge-rate", Math.abs(flex - old) / f.dt, "rad/s", rate)
      hingeHistory.set(id, flex)
    }
    for (const [id, bar] of [["pelvis", bars[0]], ["torso", bars[1]]] as const) {
      if (!f.yaw && (!f.joints[bar[0]] || !f.joints[bar[1]])) { yawHistory.delete(id); continue }
      const axis = f.yaw ? [0, 0, 1] as const : sub(f.joints[bar[1]]!, f.joints[bar[0]]!)
      const yaw = f.yaw?.[id] ?? Math.atan2(-axis[0], axis[2]), old = yawHistory.get(id)
      const h = [yaw]
      if (old && i > start) {
        const velocity = wrap(yaw - old[0]!) / f.dt; h.push(velocity)
        emit(id, "yaw-rate", Math.abs(velocity), "rad/s", rate)
        if (old[1] !== undefined && i - start > 1) emit(id, "yaw-acceleration", Math.abs(2 * (velocity - old[1]) / (time - times[i - 2]!)), "rad/s²", rate ** 2)
      }
      yawHistory.set(id, h)
    }
    for (const [id, c] of Object.entries(f.contacts ?? {})) {
      const p = i > start ? prev?.contacts?.[id] : undefined
      if (c.planted) {
        emit(id, "foot-sink", Math.max(0, c.ground - (c.surfaceY ?? c.point[1])), "m", stature)
        emit(id, "foot-hover", Math.max(0, (c.surfaceY ?? c.point[1]) - c.ground), "m", stature)
        if (p?.planted) emit(id, "foot-slip", Math.hypot(c.point[0] - p.point[0], c.point[2] - p.point[2]) / f.dt, "m/s", stature * rate)
      }
      if (p && c.planted !== p.planted) {
        // Include ankle, ball and toe displacement on either contact edge.
        const suffix = id.endsWith("R") ? "R" : "L"
        for (const joint of [`ankle${suffix}`, `ball${suffix}`, `toe${suffix}`]) if (f.joints[joint] && prev?.joints[joint])
          emit(joint, "contact-snap", dist(f.joints[joint]!, prev.joints[joint]!) / f.dt, "m/s", stature * rate)
      }
    }
    for (const id of gripRest.keys()) if (!f.grips?.[id]) gripRest.delete(id)
    for (const [id, g] of Object.entries(f.grips ?? {})) {
      const d = dist(f.joints[g.hand]!, g.anchor)
      if (!gripRest.has(id)) gripRest.set(id, d)
      emit(g.hand, "grip", Math.abs(d - gripRest.get(id)!), "m", stature)
    }
  }
  return out
}

/** Calibrate on reference clips only. A 10% envelope margin tolerates resampling, never a procedural outlier. */
export function calibrateMotion(references: readonly { name: string; frames: readonly MotionFrame[] }[], margin = 1.1): MotionCalibration {
  const all = references.flatMap(x => [...x.frames])
  const speed = median(all.map(x => x.speed).filter(x => x > 0)), leg = median(references.map(x => legLength(x.frames[0]!)))
  if (!all.length || margin < 1 || !Number.isFinite(margin)) throw new Error("Invalid motion calibration")
  const result: MotionCalibration = { version: 1, sources: references.map(x => x.name), speed, leg, limits: {}, margin }
  for (const ref of references) for (const r of measureBodyMotion(ref.frames, result)) {
    if (r.metric === "bad-number" || !Number.isFinite(r.value)) throw new Error(`${ref.name}: invalid reference at frame ${r.frame}`)
    const key = motionKey(r), value = r.value / r.scale
    if (!result.limits[key] || result.limits[key]!.max < value) result.limits[key] = { max: value, source: ref.name }
  }
  return result
}

/** Throws for uncalibrated channels instead of silently skipping checks. Grip uses the reference rigid-link residual. */
export function checkBodyMotion(frames: readonly MotionFrame[], calibration: MotionCalibration): MotionViolation[] {
  const rigid = Math.max(0, ...Object.entries(calibration.limits).filter(([k]) => k.startsWith("bone-length/")).map(([, x]) => x.max))
  return measureBodyMotion(frames, calibration).flatMap(r => {
    if (r.metric === "bad-number") return [{ ...r, threshold: 0, ratio: Infinity, reason: "Non-finite or invalid input; history reset" }]
    const entry = calibration.limits[motionKey(r)]
    if (!entry && r.metric !== "grip") throw new Error(`No mocap calibration for ${motionKey(r)}`)
    // 1 µm numerical floor prevents floating-point FK residuals being treated as visible stretch.
    const threshold = Math.max(1e-6, (entry?.max ?? rigid) * calibration.margin) * r.scale
    if (r.value <= threshold) return []
    return [{ ...r, threshold, ratio: r.value / threshold, reason: `${r.metric} exceeds ${entry?.source ?? "CMU rigid-link residual"} envelope` }]
  })
}
