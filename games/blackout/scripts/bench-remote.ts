/**
 * Remote smoothness, snapshot bytes and local corrections, before and after snapshot interpolation and the packed
 * wire format. A real World (downtown, 8 soldiers, a jeep on a figure-eight) streams snapshots over a simulated link;
 * a client draws remote soldiers and vehicles at `--fps` and predicts its own soldier.
 *
 * - before: plain JSON snapshots (floats to 3 decimals); soldiers chase the newest snapshot extrapolated 50 ms
 *   (k = 16/s), vehicles dead-reckon up to 250 ms and ease (k = 14/s): the code this replaced in src/game.
 * - after: `encodeServer`/`decodeServer` (shared/wire.ts) and `src/game/remote.ts` (SnapshotBuffer at 100 ms, a cubic
 *   through each snapshot's velocity, a short coast through stalls, and `Glide` to blend out the resume).
 * Vehicles: one jeep driven along a figure-eight at 6–16 m/s (its pose is set each tick, so it never sticks on a
 * wall); the parked ones would only dilute the numbers.
 *
 * Smoothness: jerk (third difference of the drawn position) and velocity jumps between consecutive frames.
 * Lag: distance from the drawn entity to where it really is on the server at that moment.
 *
 *   bun scripts/bench-remote.ts [--seconds=60] [--seeds=3] [--fps=120] [--out=perf/blackout-remote.json]
 */
import { Predictor } from "@arcade/kit/net/prediction"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { DT, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { angleDiff } from "../shared/geom"
import { decodeServer, encodeServer } from "../shared/protocol"
import { kitSprints } from "../shared/sim/kit"
import { stepBody } from "../shared/sim/move"
import { type Snapshot, type VehicleView, buildSnapshot } from "../shared/sim/view"
import { type Intent, NO_INTENT, World } from "../shared/sim/world"
import { Glide, VEHICLE_JUMP, pushSnapshot, remoteBuffer, sampleRemote, soldierAt, vehicleAt } from "../src/game/remote"

const opt = (key: string, fallback: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const SECONDS = Number(opt("seconds", "60"))
const SEEDS = Number(opt("seeds", "3"))
const FPS = Number(opt("fps", "120"))
const OUT = opt("out", "")
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
const r3 = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v)

type Link = { label: string; delay: number; jitter: number; loss: number }
const LINKS: Link[] = [
  { label: "clean 30 ± 5 ms", delay: 0.03, jitter: 0.005, loss: 0 },
  { label: "lossy 80 ± 30 ms, 2%", delay: 0.08, jitter: 0.03, loss: 0.02 },
]
type V2 = { x: number; y: number }
/** Drawn positions per entity per frame (null when not drawn or excluded), and the truth at that moment. */
type Track = { drawn: (V2 | null)[]; truth: (V2 | null)[] }

function world(seed: number, maps: "downtown" | "office"): World {
  const w = new World(seed, null, "ffa", maps)
  w.addHuman("me", "me")
  w.botFill = 8
  w.fill()
  const car = w.vehicles[0]
  const bot = [...w.players.values()].find((p) => !p.human)
  if (car && bot) {
    car.seats[0] = bot.id
    bot.veh = car.id
    bot.seat = 0
    bot.brain = { think: () => NO_INTENT }
  }
  return w
}

/** Puts the jeep on its figure-eight for this tick, with a matching velocity, heading and yaw rate. */
function drive(w: World, path: { th: number; h: number }): void {
  const car = w.vehicles[0]
  if (!car) return
  const [cx, cy] = [w.map.size[0] / 2, w.map.size[1] / 2]
  const A = 22, B = 30
  const speed = 11 + 5 * Math.sin(w.time * 0.7)
  const dx = A * Math.cos(path.th), dy = B * Math.cos(2 * path.th)
  const rate = speed / Math.hypot(dx, dy)
  path.th += rate * DT
  const vx = A * Math.cos(path.th) * rate, vy = B * Math.cos(2 * path.th) * rate
  const h = Math.atan2(vy, vx)
  Object.assign(car, { x: cx + A * Math.sin(path.th), y: cy + (B / 2) * Math.sin(2 * path.th), vx, vy, h, w: angleDiff(h, path.h) / DT, hp: 1e5 })
  path.h = h
}

/** A link with in-order delivery (TCP): a lost segment is retransmitted 200 ms later and holds up the rest. */
function link(l: Link, rand: () => number) {
  let last = 0
  return (sent: number) => {
    let at = sent + l.delay + (rand() * 2 - 1) * l.jitter
    if (rand() < l.loss) at += 0.2
    last = Math.max(last, at)
    return last
  }
}

function stats(tracks: Map<string, Track>, dt: number) {
  const jerks: number[] = []
  let jumps = 0
  let frames = 0
  const lag: number[] = []
  for (const tr of tracks.values()) {
    const d = tr.drawn
    for (let i = 3; i < d.length; i++) {
      const [a, b, c, e] = [d[i - 3], d[i - 2], d[i - 1], d[i]]
      if (!a || !b || !c || !e) continue
      frames++
      const jx = (e.x - 3 * c.x + 3 * b.x - a.x) / dt ** 3
      const jy = (e.y - 3 * c.y + 3 * b.y - a.y) / dt ** 3
      jerks.push(Math.hypot(jx, jy))
      const dvx = (e.x - 2 * c.x + b.x) / dt
      const dvy = (e.y - 2 * c.y + b.y) / dt
      if (Math.hypot(dvx, dvy) > 1) jumps++
      const t = tr.truth[i]
      if (t) lag.push(Math.hypot(e.x - t.x, e.y - t.y))
    }
  }
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length))
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0
  return {
    jerkRms: Math.round(rms(jerks)),
    jerkP99: Math.round(pct(jerks, 0.99)),
    velocityJumpsPerMin: +((jumps / frames) * FPS * 60).toFixed(1),
    lagMeanM: +(lag.reduce((s, v) => s + v, 0) / Math.max(1, lag.length)).toFixed(3),
    lagP95M: +pct(lag, 0.95).toFixed(3),
  }
}

function run(seed: number, l: Link) {
  const rand = mulberry32(seed)
  const w = world(seed, "downtown")
  const deliver = link(l, rand)
  const ticks = SECONDS * TICK_HZ
  const truthAt = new Map<string, V2[]>()
  const inflight: { at: number; plain: string; packed: string }[] = []
  const up: { at: number; seq: number; i: Intent }[] = []
  // Before: chase state per soldier, dead-reckoning per vehicle.
  const chase = new Map<string, { x: number; y: number; tx: number; ty: number; tvx: number; tvy: number; alive: boolean }>()
  const reckon = new Map<number, { x: number; y: number; h: number; s: VehicleView; at: number }>()
  // After: the snapshot buffer.
  const buf = remoteBuffer()
  const glides = new Map<string, Glide>()
  const glide = (id: string, jump?: number) => {
    let g = glides.get(id)
    if (!g) glides.set(id, (g = new Glide(10, jump)))
    return g
  }
  const driven = w.vehicles[0]?.id
  let latestNew: Snapshot | null = null
  const tracks = { before: new Map<string, Track>(), after: new Map<string, Track>() }
  const track = (m: Map<string, Track>, id: string) => {
    let t = m.get(id)
    if (!t) m.set(id, (t = { drawn: [], truth: [] }))
    return t
  }
  // Local prediction, once per wire format.
  const local = { before: { pred: new Predictor<Intent>(), body: null as null | { x: number; y: number; vx: number; vy: number }, corr: [] as number[] }, after: { pred: new Predictor<Intent>(), body: null as null | { x: number; y: number; vx: number; vy: number }, corr: [] as number[] } }
  const bytes = { plain: 0, packed: 0, n: 0 }
  const frameDt = 1 / FPS
  let nextFrame = 0
  let frame = 0
  const kit = w.players.get("me")!.kit
  const path = { th: 0, h: 0 }

  for (let tick = 0; tick < ticks; tick++) {
    const now = tick * DT
    // Client input for its own soldier: deterministic wandering with sprints.
    const i: Intent = { ...NO_INTENT, mx: Math.sin(now * 0.7), my: Math.cos(now * 0.45), sprint: Math.sin(now * 0.3) > 0.4, aim: now }
    for (const side of ["before", "after"] as const) {
      const c = local[side]
      const seq = c.pred.record(i) + 1
      if (side === "before") up.push({ at: deliver(now), seq, i })
      if (c.body) stepBody(c.body, i.mx, i.my, kitSprints(i, kit) ? kit.run : kit.walk, w.solids, DT)
    }
    while (up.length && up[0]!.at <= now) {
      const m = up.shift()!
      w.push("me", m.seq, m.i)
    }
    w.step()
    drive(w, path)
    w.takeEvents()
    for (const p of w.players.values()) {
      const list = truthAt.get(p.id) ?? []
      list[tick] = { x: p.x, y: p.y }
      truthAt.set(p.id, list)
    }
    for (const v of w.vehicles) {
      const list = truthAt.get(`v${v.id}`) ?? []
      list[tick] = { x: v.x, y: v.y }
      truthAt.set(`v${v.id}`, list)
    }
    if (w.tick % SNAP_EVERY === 0) {
      const s = buildSnapshot(w, "me")
      const plain = JSON.stringify(s, r3)
      const packed = encodeServer(s)
      bytes.plain += plain.length
      bytes.packed += packed.length
      bytes.n++
      inflight.push({ at: deliver(w.time), plain, packed })
    }
    // Client frames until the next server tick.
    while (nextFrame < now + DT) {
      const t = nextFrame
      while (inflight.length && inflight[0]!.at <= t) {
        const m = inflight.shift()!
        const before = JSON.parse(m.plain) as Snapshot
        const after = decodeServer(m.packed) as Snapshot
        for (const p of before.players) {
          if (p.id === "me") continue
          let a = chase.get(p.id)
          if (!a) chase.set(p.id, (a = { x: p.x, y: p.y, tx: p.x, ty: p.y, tvx: 0, tvy: 0, alive: p.alive }))
          if (p.alive && (!a.alive || Math.hypot(p.x - a.x, p.y - a.y) > 4)) Object.assign(a, { x: p.x, y: p.y })
          Object.assign(a, { tx: p.x, ty: p.y, tvx: p.vx, tvy: p.vy, alive: p.alive })
        }
        for (const v of before.vehicles ?? []) {
          const d = reckon.get(v.id)
          if (!d) reckon.set(v.id, { x: v.x, y: v.y, h: v.h, s: v, at: t })
          else Object.assign(d, { s: v, at: t })
        }
        pushSnapshot(buf, after, t)
        latestNew = after
        // Own soldier: restore the server's state and replay what it hasn't seen (game.ts reconcile).
        for (const [side, snap] of [["before", before], ["after", after]] as const) {
          const c = local[side]
          const mine = snap.players.find((p) => p.id === "me")
          if (!mine?.alive) {
            c.body = null
            c.pred.reset()
            continue
          }
          const b = { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy }
          c.pred.reconcile(snap.ack - 1, () => {}, (cmd) => stepBody(b, cmd.mx, cmd.my, kitSprints(cmd, kit) ? kit.run : kit.walk, w.solids, DT))
          if (c.body) c.corr.push(Math.hypot(b.x - c.body.x, b.y - c.body.y))
          c.body = b
        }
      }
      // Truth at frame time t (server ticks are 30 Hz; linear between them).
      const truth = (id: string): V2 | null => {
        const list = truthAt.get(id)
        const k = t / DT - 1
        const i0 = Math.floor(k)
        const a = list?.[i0], b = list?.[i0 + 1] ?? a
        if (!a || !b) return null
        const f = k - i0
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      }
      const bracket = sampleRemote(buf, t)
      // Soldiers on foot, alive in the newest snapshot both ways; frames near a respawn or death are left out.
      for (const p of latestNew?.players ?? []) {
        if (p.id === "me") continue
        const a = chase.get(p.id)
        const live = !!a?.alive && p.alive && !p.veh
        const tb = track(tracks.before, p.id)
        const ta = track(tracks.after, p.id)
        if (a && live) {
          const k = 1 - Math.exp(-frameDt * 16)
          a.x += (a.tx + a.tvx * 0.05 - a.x) * k
          a.y += (a.ty + a.tvy * 0.05 - a.y) * k
        }
        const at = bracket ? soldierAt(bracket, p.id) : null
        const steady = live && !!at
        tb.drawn[frame] = steady ? { x: a!.x, y: a!.y } : null
        if (steady) ta.drawn[frame] = glide(p.id).step(at!.x, at!.y, at!.vx, at!.vy, frameDt)
        else {
          glide(p.id).reset()
          ta.drawn[frame] = null
        }
        tb.truth[frame] = ta.truth[frame] = truth(p.id)
      }
      for (const [id, d] of reckon) {
        if (id !== driven) continue
        const s = d.s
        const ahead = Math.min(0.25, t - d.at)
        const tx = s.x + s.vx * ahead, ty = s.y + s.vy * ahead, th = s.h + s.w * ahead
        const k = 1 - Math.exp(-frameDt * 14)
        if (Math.hypot(tx - d.x, ty - d.y) > 6) Object.assign(d, { x: tx, y: ty, h: th })
        else {
          d.x += (tx - d.x) * k
          d.y += (ty - d.y) * k
          d.h += angleDiff(th, d.h) * k
        }
        const at = bracket ? vehicleAt(bracket, id) : null
        const tb = track(tracks.before, `v${id}`)
        const ta = track(tracks.after, `v${id}`)
        tb.drawn[frame] = at ? { x: d.x, y: d.y } : null
        ta.drawn[frame] = at ? glide(`v${id}`, VEHICLE_JUMP).step(at.x, at.y, at.vx, at.vy, frameDt) : null
        tb.truth[frame] = ta.truth[frame] = truth(`v${id}`)
      }
      frame++
      nextFrame += frameDt
    }
  }
  const moving = (m: Map<string, Track>, vehicles: boolean) =>
    new Map([...m].filter(([id]) => id.startsWith("v") === vehicles))
  const corr = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return { meanMm: +((a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)) * 1000).toFixed(2), p99Mm: +((s[Math.floor(s.length * 0.99)] ?? 0) * 1000).toFixed(1) }
  }
  return {
    soldiers: { before: stats(moving(tracks.before, false), frameDt), after: stats(moving(tracks.after, false), frameDt) },
    vehicles: { before: stats(moving(tracks.before, true), frameDt), after: stats(moving(tracks.after, true), frameDt) },
    local: { before: corr(local.before.corr), after: corr(local.after.corr) },
    bytes: { before: Math.round(bytes.plain / bytes.n), after: Math.round(bytes.packed / bytes.n) },
  }
}

function officeBytes(seed: number) {
  const w = world(seed, "office")
  let plain = 0, packed = 0, n = 0
  for (let t = 0; t < 60 * TICK_HZ; t++) {
    w.step()
    w.takeEvents()
    if (w.tick % SNAP_EVERY) continue
    const s = buildSnapshot(w, "me")
    plain += JSON.stringify(s, r3).length
    packed += encodeServer(s).length
    n++
  }
  return { before: Math.round(plain / n), after: Math.round(packed / n) }
}

const results: Record<string, unknown> = { seconds: SECONDS, seeds: SEEDS, fps: FPS, tickHz: TICK_HZ, snapshotHz: TICK_HZ / SNAP_EVERY }
for (const l of LINKS) {
  const runs = Array.from({ length: SEEDS }, (_, i) => run(1000 + i * 7919, l))
  const avg = (f: (r: (typeof runs)[number]) => Record<string, number>) => {
    const keys = Object.keys(f(runs[0]!))
    return Object.fromEntries(keys.map((k) => [k, +(runs.reduce((s, r) => s + f(r)[k]!, 0) / runs.length).toFixed(3)]))
  }
  const row = {
    soldiers: { before: avg((r) => r.soldiers.before), after: avg((r) => r.soldiers.after) },
    vehicles: { before: avg((r) => r.vehicles.before), after: avg((r) => r.vehicles.after) },
    local: { before: avg((r) => r.local.before), after: avg((r) => r.local.after) },
    downtownBytes: avg((r) => r.bytes),
  }
  results[l.label] = row
  console.log(l.label)
  console.table({ "soldiers before": row.soldiers.before, "soldiers after": row.soldiers.after, "vehicles before": row.vehicles.before, "vehicles after": row.vehicles.after })
  console.table({ "local correction before": row.local.before, "local correction after": row.local.after })
}
results.officeBytes = officeBytes(1000)
results.downtownBytes = (results[LINKS[0]!.label] as { downtownBytes: unknown }).downtownBytes
console.log("snapshot bytes", { office: results.officeBytes, downtown: results.downtownBytes })
if (OUT) await Bun.write(OUT, JSON.stringify(results, null, 2) + "\n")
