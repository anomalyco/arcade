/**
 * 2D oriented-box contacts (SAT + 2-point clipped manifold) and sequential-impulse rigid-body solver (Box2D 2x2 block
 * normal solver), shared by Getaway (ground plane x, z; forward = (sin h, cos h)) and Blackout (floor plan x, y;
 * forward = (cos h, sin h)).
 */

export type Mass = { invM: number; invI: number }
export const STATIC: Mass = { invM: 0, invI: 0 }
export const INERTIA = 0.8

export function boxMass(mass: number, length: number, width: number): Mass {
  return { invM: 1 / mass, invI: 12 / (mass * INERTIA * (length * length + width * width)) }
}

export type Response = { restitution: number; friction: number }
export const WALL: Response = { restitution: 0.25, friction: 0.2 }
export const CARS: Response = { restitution: 0.25, friction: 0.35 }

const BOUNCE_MIN = 1.5
const ITERATIONS = 6

function reach(ea: number, eb: number, ax: number, au: number, nx: number, nu: number): number {
  return ea * Math.abs(ax * nx + au * nu) + eb * Math.abs(au * nx - ax * nu)
}

function collideRaw<P>(
  ax0: number, au0: number, aax: number, aau: number, aea: number, aeb: number,
  bx0: number, bu0: number, bax: number, bau: number, bea: number, beb: number,
  makePoint: (x: number, u: number, depth: number) => P,
): { nx: number; nu: number; depth: number; points: P[] } | null {
  const dx = bx0 - ax0, du = bu0 - au0
  let best = Infinity, nx = 0, nu = 0, refB = false, refK = 0
  for (let o = 0; o < 2; o++) {
    const sx = o === 0 ? aax : bax, su = o === 0 ? aau : bau
    for (let k = 0; k < 2; k++) {
      const ux = k === 0 ? sx : su, uu = k === 0 ? su : -sx
      const d = dx * ux + du * uu
      const overlap = reach(aea, aeb, aax, aau, ux, uu) + reach(bea, beb, bax, bau, ux, uu) - Math.abs(d)
      if (overlap <= 0) return null
      if (o === 0 ? overlap < best : overlap < best * 0.95 - 0.002) {
        best = overlap
        const sign = d >= 0 ? 1 : -1
        nx = ux * sign; nu = uu * sign; refB = o === 1; refK = k
      }
    }
  }
  const rx = refB ? bx0 : ax0, ru = refB ? bu0 : au0, rax = refB ? bax : aax, rau = refB ? bau : aau, rea = refB ? bea : aea, reb = refB ? beb : aeb
  const ix = refB ? ax0 : bx0, iu = refB ? au0 : bu0, iax = refB ? aax : bax, iau = refB ? aau : bau, iea = refB ? aea : bea, ieb = refB ? aeb : beb
  const rnx = refB ? -nx : nx, rnu = refB ? -nu : nu
  const refE = refK === 0 ? rea : reb, tx = refK === 0 ? rau : rax, tu = refK === 0 ? -rax : rau, refT = refK === 0 ? reb : rea
  const da = iax * rnx + iau * rnu, db = iau * rnx - iax * rnu
  let fnx: number, fnu: number, fe: number, ftx: number, ftu: number, ft: number
  if (Math.abs(da) >= Math.abs(db)) {
    const s = da > 0 ? -1 : 1
    fnx = iax * s; fnu = iau * s; fe = iea; ftx = iau; ftu = -iax; ft = ieb
  } else {
    const s = db > 0 ? -1 : 1
    fnx = iau * s; fnu = -iax * s; fe = ieb; ftx = iax; ftu = iau; ft = iea
  }
  const cx = ix + fnx * fe, cu = iu + fnu * fe
  let p1x = cx + ftx * ft, p1u = cu + ftu * ft, p2x = cx - ftx * ft, p2u = cu - ftu * ft
  for (const side of [1, -1]) {
    const ux = tx * side, uu = tu * side, lim = refT + rx * ux + ru * uu
    const d1 = p1x * ux + p1u * uu - lim, d2 = p2x * ux + p2u * uu - lim
    if (d1 > 0 && d2 > 0) {
      p1x = p2x = (p1x + p2x) / 2; p1u = p2u = (p1u + p2u) / 2
      break
    }
    if (d1 > 0) {
      const t = d1 / (d1 - d2)
      p1x += (p2x - p1x) * t; p1u += (p2u - p1u) * t
    } else if (d2 > 0) {
      const t = d2 / (d2 - d1)
      p2x += (p1x - p2x) * t; p2u += (p1u - p2u) * t
    }
  }
  const face = refE + rx * rnx + ru * rnu
  const points: P[] = []
  let firstX = 0, firstU = 0
  for (const [px, pu] of [[p1x, p1u], [p2x, p2u]] as const) {
    const sep = px * rnx + pu * rnu - face
    if (sep < 0) {
      const qx = px - (rnx * sep) / 2, qu = pu - (rnu * sep) / 2
      if (points.length === 1 && Math.abs(firstX - qx) + Math.abs(firstU - qu) < 1e-6) continue
      if (points.length === 0) { firstX = qx; firstU = qu }
      points.push(makePoint(qx, qu, -sep))
    }
  }
  if (!points.length) points.push(makePoint((p1x + p2x) / 2, (p1u + p2u) / 2, best))
  return { nx, nu, depth: best, points }
}

function solveImpulses<P extends { x: number }>(
  ax: number, au: number, avx: number, avu: number, aw: number, ma: Mass,
  hasB: boolean, bx: number, bu: number, bvx: number, bvu: number, bw: number, mb: Mass,
  nx: number, nu: number, pts: readonly P[], uOf: (p: P) => number, res: Response, handedness: 1 | -1,
) {
  const tx = nu, tu = -nx, n = pts.length
  const ra: [number, number][] = [], rb: [number, number][] = []
  const kn: number[] = [], kt: number[] = [], bias: number[] = [], accN: number[] = [], accT: number[] = []
  let impact = 0, hx = 0, hu = 0, vax = avx, vau = avu, wa = aw, vbx = bvx, vbu = bvu, wb = bw
  const lever = (rx: number, ru: number, ux: number, uu: number) => (handedness === 1 ? rx * uu - ru * ux : ru * ux - rx * uu)
  const vel = (i: number) => {
    const [rax, rau] = ra[i]!, [rbx, rbu] = rb[i]!
    return [
      (hasB ? vbx - handedness * wb * rbu : 0) - (vax - handedness * wa * rau),
      (hasB ? vbu + handedness * wb * rbx : 0) - (vau + handedness * wa * rax),
    ] as const
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i]!, pu = uOf(p)
    ra.push([p.x - ax, pu - au]); rb.push([p.x - bx, pu - bu])
    const an = lever(ra[i]![0], ra[i]![1], nx, nu), bn = lever(rb[i]![0], rb[i]![1], nx, nu)
    const at = lever(ra[i]![0], ra[i]![1], tx, tu), bt = lever(rb[i]![0], rb[i]![1], tx, tu)
    kn.push(ma.invM + mb.invM + ma.invI * an * an + mb.invI * bn * bn)
    kt.push(ma.invM + mb.invM + ma.invI * at * at + mb.invI * bt * bt)
    const [rvx, rvu] = vel(i), vn0 = rvx * nx + rvu * nu
    bias.push(vn0 < -BOUNCE_MIN ? -res.restitution * vn0 : 0)
    accN.push(0); accT.push(0)
    if (-vn0 > impact) impact = -vn0
    hx += p.x / n; hu += pu / n
  }
  const apply = (i: number, px: number, pu: number) => {
    const [rax, rau] = ra[i]!, [rbx, rbu] = rb[i]!
    vax -= px * ma.invM; vau -= pu * ma.invM; wa -= ma.invI * lever(rax, rau, px, pu)
    if (hasB && (mb.invM > 0 || mb.invI > 0)) {
      vbx += px * mb.invM; vbu += pu * mb.invM; wb += mb.invI * lever(rbx, rbu, px, pu)
    }
  }
  const vn = (i: number) => { const [rvx, rvu] = vel(i); return rvx * nx + rvu * nu }
  const setN = (i: number, next: number) => { const dn = next - accN[i]!; accN[i] = next; apply(i, nx * dn, nu * dn) }
  let k12 = 0
  if (n === 2) {
    const a1 = lever(ra[0]![0], ra[0]![1], nx, nu), a2 = lever(ra[1]![0], ra[1]![1], nx, nu)
    const b1 = lever(rb[0]![0], rb[0]![1], nx, nu), b2 = lever(rb[1]![0], rb[1]![1], nx, nu)
    k12 = ma.invM + mb.invM + ma.invI * a1 * a2 + mb.invI * b1 * b2
  }
  const blockSolve = () => {
    const k11 = kn[0]!, k22 = kn[1]!, x1 = accN[0]!, x2 = accN[1]!
    const r1 = k11 * x1 + k12 * x2 + bias[0]! - vn(0), r2 = k12 * x1 + k22 * x2 + bias[1]! - vn(1)
    const det = k11 * k22 - k12 * k12
    const ok = (y1: number, y2: number) => {
      const w1 = k11 * y1 + k12 * y2 - r1, w2 = k12 * y1 + k22 * y2 - r2
      return y1 >= 0 && y2 >= 0 && (y1 > 0 || w1 >= -1e-9) && (y2 > 0 || w2 >= -1e-9)
    }
    const tries: [number, number][] = []
    if (Math.abs(det) > 1e-9 * k11 * k22) tries.push([(k22 * r1 - k12 * r2) / det, (k11 * r2 - k12 * r1) / det])
    tries.push([r1 / k11, 0], [0, r2 / k22], [0, 0])
    for (const [y1, y2] of tries) if (ok(y1, y2)) { setN(0, y1); setN(1, y2); return }
    setN(0, Math.max(0, accN[0]! - (vn(0) - bias[0]!) / k11))
    setN(1, Math.max(0, accN[1]! - (vn(1) - bias[1]!) / k22))
  }
  for (let it = 0; it < ITERATIONS; it++) {
    if (n === 2) blockSolve()
    else setN(0, Math.max(0, accN[0]! - (vn(0) - bias[0]!) / kn[0]!))
    for (let i = 0; i < n; i++) {
      const [rvx, rvu] = vel(i), vt = rvx * tx + rvu * tu, lim = res.friction * accN[i]!
      const nt = Math.max(-lim, Math.min(lim, accT[i]! - vt / kt[i]!)), dt = nt - accT[i]!
      accT[i] = nt; apply(i, tx * dt, tu * dt)
    }
  }
  return { impact, hx, hu, vax, vau, wa, vbx, vbu, wb }
}

// --- Floor-plan (x, y) convention (Blackout) ---

export type ShapeXY = { x: number; y: number; ax: number; ay: number; ea: number; eb: number }
export type PointXY = { x: number; y: number; depth: number }
export type ContactXY = { nx: number; ny: number; depth: number; points: PointXY[] }
export type RigidXY = { x: number; y: number; h: number; vx: number; vy: number; w: number }
export type HitXY = { impact: number; x: number; y: number }

export const orientedShapeXY = (x: number, y: number, h: number, hl: number, hw: number): ShapeXY => ({
  x, y, ax: Math.cos(h), ay: Math.sin(h), ea: hl, eb: hw,
})

export const rectShapeXY = (r: readonly [number, number, number, number]): ShapeXY => ({
  x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, ax: 1, ay: 0, ea: (r[2] - r[0]) / 2, eb: (r[3] - r[1]) / 2,
})

export function collideShapesXY(a: ShapeXY, b: ShapeXY): ContactXY | null {
  const hit = collideRaw(a.x, a.y, a.ax, a.ay, a.ea, a.eb, b.x, b.y, b.ax, b.ay, b.ea, b.eb, (x, y, depth) => ({ x, y, depth }))
  return hit ? { nx: hit.nx, ny: hit.nu, depth: hit.depth, points: hit.points } : null
}

export function resolveXY(a: RigidXY, ma: Mass, b: RigidXY | null, mb: Mass, c: ContactXY, res: Response): HitXY {
  const o = solveImpulses(a.x, a.y, a.vx, a.vy, a.w, ma, b !== null, b?.x ?? 0, b?.y ?? 0, b?.vx ?? 0, b?.vy ?? 0, b?.w ?? 0, mb, c.nx, c.ny, c.points, (p) => p.y, res, 1)
  a.vx = o.vax; a.vy = o.vau; a.w = o.wa
  if (b) { b.vx = o.vbx; b.vy = o.vbu; b.w = o.wb }
  return { impact: o.impact, x: o.hx, y: o.hu }
}

export function separateXY(a: RigidXY, ma: Mass, b: RigidXY | null, mb: Mass, c: ContactXY, slop: number): void {
  const push = c.depth - slop, total = ma.invM + mb.invM
  if (push <= 0 || total <= 0) return
  const ka = (push * ma.invM) / total
  a.x -= c.nx * ka; a.y -= c.ny * ka
  if (b && mb.invM > 0) { const kb = (push * mb.invM) / total; b.x += c.nx * kb; b.y += c.ny * kb }
}

// --- Ground-plane (x, z) convention (Getaway) ---

export type ShapeXZ = { x: number; z: number; ax: number; az: number; ea: number; eb: number }
export type PointXZ = { x: number; z: number; depth: number }
export type ContactXZ = { nx: number; nz: number; depth: number; points: PointXZ[] }
export type RigidXZ = { x: number; z: number; h: number; vx: number; vz: number; yaw: number }
export type HitXZ = { impact: number; x: number; z: number; nx: number; nz: number; dvA: number; dwA: number; dvB: number; dwB: number }

export function shapeGapXZ(a: ShapeXZ, b: ShapeXZ): number {
  const dx = b.x - a.x, dz = b.z - a.z
  let gap = -Infinity
  for (const s of [a, b])
    for (const [nx, nz] of [[s.ax, s.az], [s.az, -s.ax]] as const)
      gap = Math.max(gap, Math.abs(dx * nx + dz * nz) - reach(a.ea, a.eb, a.ax, a.az, nx, nz) - reach(b.ea, b.eb, b.ax, b.az, nx, nz))
  return gap
}

export function collideShapesXZ(a: ShapeXZ, b: ShapeXZ): ContactXZ | null {
  const hit = collideRaw(a.x, a.z, a.ax, a.az, a.ea, a.eb, b.x, b.z, b.ax, b.az, b.ea, b.eb, (x, z, depth) => ({ x, z, depth }))
  return hit ? { nx: hit.nx, nz: hit.nu, depth: hit.depth, points: hit.points } : null
}

export function resolveXZ(a: RigidXZ, ma: Mass, b: RigidXZ | null, mb: Mass, c: ContactXZ, res: Response): HitXZ {
  const v0x = a.vx, v0z = a.vz, w0 = a.yaw, u0x = b?.vx ?? 0, u0z = b?.vz ?? 0, q0 = b?.yaw ?? 0
  const o = solveImpulses(a.x, a.z, a.vx, a.vz, a.yaw, ma, b !== null, b?.x ?? 0, b?.z ?? 0, b?.vx ?? 0, b?.vz ?? 0, b?.yaw ?? 0, mb, c.nx, c.nz, c.points, (p) => p.z, res, -1)
  a.vx = o.vax; a.vz = o.vau; a.yaw = o.wa
  if (b) { b.vx = o.vbx; b.vz = o.vbu; b.yaw = o.wb }
  return {
    impact: o.impact, x: o.hx, z: o.hu, nx: c.nx, nz: c.nz,
    dvA: Math.hypot(a.vx - v0x, a.vz - v0z), dwA: Math.abs(a.yaw - w0),
    dvB: b ? Math.hypot(b.vx - u0x, b.vz - u0z) : 0, dwB: b ? Math.abs(b.yaw - q0) : 0,
  }
}

export function separateXZ(a: RigidXZ, ma: Mass, b: RigidXZ | null, mb: Mass, c: ContactXZ, slop: number): void {
  const push = c.depth - slop, total = ma.invM + mb.invM
  if (push <= 0 || total <= 0) return
  const ka = (push * ma.invM) / total
  a.x -= c.nx * ka; a.z -= c.nz * ka
  if (b && mb.invM > 0) { const kb = (push * mb.invM) / total; b.x += c.nx * kb; b.z += c.nz * kb }
}
