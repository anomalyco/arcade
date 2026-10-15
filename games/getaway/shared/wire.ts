import type { Extraction, GadgetId, JobSite, Role } from "./config"
import type { ServerMsg } from "./protocol"
import type { GadgetView, PropView } from "./sim/gadgets"
import type { Body } from "./sim/vehicle"
import type { CarView, Heli, Phase, Standing, Tip, WorldView } from "./sim/world"

type SnapshotMsg = Extract<ServerMsg, { type: "snapshot" }>

type PackedGadget = [id: GadgetId, charges: number, cooldown: number, ready: number]
type PackedCar = [
  id: number,
  ownerId: string,
  name: string,
  role: Role,
  vehicle: string,
  x: number,
  z: number,
  h: number,
  vx: number,
  vz: number,
  speed: number,
  drift: number,
  stun: number,
  boost: number,
  impact: number,
  flags: number,
  tunnels: number,
  y: number,
  vy: number,
  landing: number,
  landings: number,
  yaw: number,
  slide: number,
  slip: number,
  wheels: number,
  gadgets: PackedGadget[] | null,
]
type PackedProp = [id: number, kind: GadgetId, x: number, z: number, h: number, r: number, life: number, ttl: number]
type PackedStanding = [id: string, name: string, human: number, score: number, escapes: number, busts: number, best: number]
type PackedHeli = [active: number, x: number, y: number, z: number, h: number, sx: number, sz: number, lock: number]
type PackedSite = [id: string, name: string, kind: JobSite["kind"], value: number, x: number, z: number]
type PackedExit = [id: string, name: string, x: number, z: number]
type PackedBody = [
  x: number,
  z: number,
  h: number,
  vx: number,
  vz: number,
  yaw: number,
  boostFuel: number,
  hp: number,
  stun: number,
  tunnels: number,
  y: number,
  vy: number,
  landing: number,
  landings: number,
  landGrip: number,
  flags: number,
  drift: number,
  slip: number,
  wheels: number,
  crank: number,
  spin: number,
]

export type PackedSnapshot = {
  type: "snapshot"
  k: [tick: number, ack: number, idleIn: number | null]
  w: [
    t: number,
    round: number,
    phase: Phase,
    phaseT: number,
    robberId: string,
    site: PackedSite,
    exit: PackedExit,
    heat: number,
    stars: number,
    loot: number,
    flags: number,
    lastSeen: [x: number, z: number, t: number] | null,
    bust: number,
    extract: number,
    exitOpenIn: number | null,
    survived: number,
    tip: [x: number, z: number, r: number, t: number] | null | 0,
    best: number,
    bestName: string,
    timeLeft: number,
    roundScore: [drift: number, nearMisses: number, score: number],
    repair: number | null,
    shopCool: number[] | null,
  ]
  h: PackedHeli
  s: PackedStanding[]
  c: PackedCar[]
  p: PackedProp[] | null
  y: PackedBody | null
}

const r3 = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000)

function packCar(c: CarView): PackedCar {
  const flags =
    (c.human ? 1 : 0) |
    (c.ghost ? 2 : 0) |
    (c.airborne ? 4 : 0) |
    (c.braking ? 8 : 0) |
    (c.boosting ? 16 : 0) |
    (c.engineOff ? 32 : 0) |
    (c.radar === true ? 64 : c.radar === false ? 128 : 0)
  return [
    c.id,
    c.ownerId,
    c.name,
    c.role,
    c.vehicle,
    r3(c.x),
    r3(c.z),
    r3(c.h),
    r3(c.vx),
    r3(c.vz),
    r3(c.speed),
    r3(c.drift),
    r3(c.stun),
    r3(c.boost),
    r3(c.impact),
    flags,
    c.tunnels ?? 0,
    r3(c.y ?? 0),
    r3(c.vy ?? 0),
    r3(c.landing ?? 0),
    c.landings ?? 0,
    r3(c.yaw ?? 0),
    r3(c.slide ?? 0),
    r3(c.slip ?? 0),
    c.wheels ?? 0,
    c.gadgets ? c.gadgets.map((g): PackedGadget => [g.id, g.charges, r3(g.cooldown), g.ready ? 1 : 0]) : null,
  ]
}

function unpackCar(r: PackedCar): CarView {
  const [id, ownerId, name, role, vehicle, x, z, h, vx, vz, speed, drift, stun, boost, impact, flags, tunnels, y, vy, landing, landings, yaw, slide, slip, wheels, gadgets] = r
  const out: CarView = {
    id,
    ownerId,
    name,
    role,
    vehicle,
    x,
    z,
    h,
    vx,
    vz,
    speed,
    drift,
    tunnels,
    y,
    vy,
    airborne: !!(flags & 4),
    landing,
    landings,
    braking: !!(flags & 8),
    boosting: !!(flags & 16),
    stun,
    boost,
    human: !!(flags & 1),
    impact,
    ghost: !!(flags & 2),
    yaw,
    slide,
    slip,
    wheels,
    engineOff: !!(flags & 32),
  }
  if (flags & 64) out.radar = true
  else if (flags & 128) out.radar = false
  if (gadgets) out.gadgets = gadgets.map(([gid, charges, cooldown, ready]): GadgetView => ({ id: gid, charges, cooldown, ready: !!ready }))
  return out
}

function packBody(b: Body): PackedBody {
  const flags = (b.airborne ? 1 : 0) | (b.braking ? 2 : 0) | (b.boosting ? 4 : 0) | (b.engineOff ? 8 : 0)
  return [
    b.x,
    b.z,
    b.h,
    b.vx,
    b.vz,
    b.yaw,
    b.boostFuel,
    b.hp,
    b.stun,
    b.tunnels,
    b.y,
    b.vy,
    b.landing,
    b.landings,
    b.landGrip,
    flags,
    b.drift ?? 0,
    b.slip ?? 0,
    b.wheels ?? 0,
    b.crank ?? 0,
    b.spin ?? 0,
  ]
}

function unpackBody(r: PackedBody): Body {
  const [x, z, h, vx, vz, yaw, boostFuel, hp, stun, tunnels, y, vy, landing, landings, landGrip, flags, drift, slip, wheels, crank, spin] = r
  return {
    tunnels,
    y,
    vy,
    airborne: !!(flags & 1),
    landing,
    landings,
    landGrip,
    braking: !!(flags & 2),
    boosting: !!(flags & 4),
    x,
    z,
    h,
    vx,
    vz,
    yaw,
    boostFuel,
    hp,
    stun,
    drift,
    slip,
    wheels,
    engineOff: !!(flags & 8),
    crank,
    spin,
  }
}

export function packSnapshot(m: SnapshotMsg): PackedSnapshot {
  const v = m.view
  const flags = (v.seen ? 1 : 0) | (v.boxed ? 2 : 0) | (v.busted ? 4 : 0) | (v.escaped ? 8 : 0) | (v.newBest ? 16 : 0)
  const h = v.heli
  return {
    type: "snapshot",
    k: [m.tick, m.ack, m.idleIn ?? null],
    w: [
      r3(v.t),
      v.round,
      v.phase,
      v.phaseT,
      v.robberId,
      [v.site.id, v.site.name, v.site.kind, r3(v.site.value), r3(v.site.x), r3(v.site.z)],
      [v.exit.id, v.exit.name, r3(v.exit.x), r3(v.exit.z)],
      r3(v.heat),
      v.stars,
      r3(v.loot),
      flags,
      v.lastSeen ? [r3(v.lastSeen.x), r3(v.lastSeen.z), r3(v.lastSeen.t)] : null,
      r3(v.bust),
      r3(v.extract),
      v.exitOpenIn === undefined ? null : r3(v.exitOpenIn),
      r3(v.survived),
      v.tip === undefined ? 0 : v.tip ? [r3(v.tip.x), r3(v.tip.z), r3(v.tip.r), r3(v.tip.t)] : null,
      r3(v.best),
      v.bestName,
      r3(v.timeLeft),
      [r3(v.roundScore.drift), v.roundScore.nearMisses, r3(v.roundScore.score)],
      v.repair === undefined ? null : r3(v.repair),
      v.shopCool ? v.shopCool.map(r3) : null,
    ],
    h: [h.active ? 1 : 0, r3(h.x), r3(h.y), r3(h.z), r3(h.h), r3(h.sx), r3(h.sz), r3(h.lock)],
    s: v.standings.map((s): PackedStanding => [s.id, s.name, s.human ? 1 : 0, r3(s.score), s.escapes, s.busts, r3(s.best)]),
    c: v.cars.map(packCar),
    p: v.props ? v.props.map((p): PackedProp => [p.id, p.kind, r3(p.x), r3(p.z), r3(p.h), r3(p.r), r3(p.life), r3(p.ttl)]) : null,
    y: m.you ? packBody(m.you) : null,
  }
}

export function unpackSnapshot(p: PackedSnapshot): SnapshotMsg {
  const [tick, ack, idleIn] = p.k
  const [t, round, phase, phaseT, robberId, siteArr, exitArr, heat, stars, loot, flags, lastSeen, bust, extract, exitOpenIn, survived, tip, best, bestName, timeLeft, roundScore, repair, shopCool] = p.w
  const [hActive, hx, hy, hz, hh, hsx, hsz, hlock] = p.h
  const heli: Heli = { active: !!hActive, x: hx, y: hy, z: hz, h: hh, sx: hsx, sz: hsz, lock: hlock }
  const site: JobSite = { id: siteArr[0], name: siteArr[1], kind: siteArr[2], value: siteArr[3], x: siteArr[4], z: siteArr[5] }
  const exit: Extraction = { id: exitArr[0], name: exitArr[1], x: exitArr[2], z: exitArr[3] }
  const view: WorldView = {
    t,
    round,
    phase,
    phaseT,
    robberId,
    site,
    exit,
    heat,
    stars,
    loot,
    seen: !!(flags & 1),
    lastSeen: lastSeen ? { x: lastSeen[0], z: lastSeen[1], t: lastSeen[2] } : null,
    bust,
    boxed: !!(flags & 2),
    busted: !!(flags & 4),
    escaped: !!(flags & 8),
    extract,
    ...(exitOpenIn === null ? {} : { exitOpenIn }),
    survived,
    ...(tip === 0 ? {} : { tip: tip ? ({ x: tip[0], z: tip[1], r: tip[2], t: tip[3] } satisfies Tip) : null }),
    ...(repair === null ? {} : { repair }),
    ...(shopCool === null ? {} : { shopCool }),
    best,
    bestName,
    newBest: !!(flags & 16),
    timeLeft,
    roundScore: { drift: roundScore[0], nearMisses: roundScore[1], score: roundScore[2] },
    standings: p.s.map(([id, name, human, score, escapes, busts, sBest]): Standing => ({ id, name, human: !!human, score, escapes, busts, best: sBest })),
    heli,
    cars: p.c.map(unpackCar),
    ...(p.p === null ? {} : { props: p.p.map(([id, kind, x, z, h, r, life, ttl]): PropView => ({ id, kind, x, z, h, r, life, ttl })) }),
  }
  return {
    type: "snapshot",
    tick,
    ack,
    view,
    you: p.y ? unpackBody(p.y) : null,
    ...(idleIn === null ? {} : { idleIn }),
  }
}
