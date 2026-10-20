import { Fn as TslFn, cameraPosition, float, floor, fract, max, min, mix, normalWorld, positionWorld, smoothstep, vec3, abs, exp, hash } from "three/tsl"
import { BUILDING } from "../world/layout"

// Interior mapping for lit window panes: the glass shows a room behind it (ceiling, floor, back and side walls) by
// intersecting the view ray with a box in world space, so the room has depth and parallax as you walk past instead
// of being a flat glowing card. Works for any vertical pane on an axis-aligned facade; storeys from the layout.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N

const STOREY = BUILDING.main.storeyHeight
const FLOOR0 = BUILDING.floorY
const CEIL = 3.1
const DEPTH = 6.5
const BAY = 3.6

/**
 * Brightness (×tint) of the fake room seen through the pane at the current fragment, plus a 0..1 "furniture" mask.
 * `seed` varies the room per pane (fixture position, desk silhouettes).
 */
export const windowRoom = Fn(([seed]: [N]) => {
  const n = (normalWorld as N).normalize()
  const up = vec3(0, 1, 0)
  const t = up.cross(n).normalize()
  const P = positionWorld as N
  const V = P.sub(cameraPosition).normalize()
  // Local ray: x along the facade, y up, z into the room (away from the outward normal).
  const dx = V.dot(t)
  const dy = V.y
  const dz = V.dot(n).negate().max(0.02)
  const px = P.dot(t)
  const storey = floor(P.y.sub(FLOOR0).div(STOREY))
  const y0 = storey.mul(STOREY).add(FLOOR0)
  const fy = P.y.sub(y0)
  const bayX = fract(px.div(BAY))
  // Distances along the ray to each wall of the bay box.
  const tBack = float(DEPTH).div(dz)
  const tCeil = dy.greaterThan(0).select(float(CEIL).sub(fy).div(dy.max(1e-4)), float(1e4))
  const tFloor = dy.lessThan(0).select(fy.div(dy.negate().max(1e-4)), float(1e4))
  const tSideR = dx.greaterThan(0).select(float(1).sub(bayX).mul(BAY).div(dx.max(1e-4)), float(1e4))
  const tSideL = dx.lessThan(0).select(bayX.mul(BAY).div(dx.negate().max(1e-4)), float(1e4))
  const tSide = min(tSideL, tSideR)
  const tHit = min(min(tBack, tCeil), min(tFloor, tSide))
  const hx = bayX.mul(BAY).add(dx.mul(tHit))
  const hy = fy.add(dy.mul(tHit))
  const hz = dz.mul(tHit)
  // Fixture: a troffer in the ceiling, off-centre per pane; light falls off from it.
  const fx = mix(float(0.8), float(BAY - 0.8), fract(seed.mul(7.3)))
  const fz = mix(float(1.5), float(4.5), fract(seed.mul(3.9)))
  const dl = vec3(hx.sub(fx), float(CEIL).sub(hy), hz.sub(fz)).length()
  const lit = exp(dl.mul(-0.38)).mul(1.1).add(0.08)
  const isCeil = tCeil.lessThanEqual(tHit.add(1e-3))
  const isFloor = tFloor.lessThanEqual(tHit.add(1e-3))
  const isSide = tSide.lessThanEqual(tHit.add(1e-3))
  // Surface albedo: pale ceiling with the fixture itself, mid walls, dark floor; back wall dimmer with depth.
  const panel = isCeil.select(smoothstep(0.35, 0.2, abs(hx.sub(fx))).mul(smoothstep(0.7, 0.55, abs(hz.sub(fz)))).mul(2.5), float(0))
  const albedo = isCeil.select(float(0.75), isFloor.select(float(0.28), isSide.select(float(0.5), float(0.42))))
  // Desks and cabinets: dark blocks along the floor of the back wall and sides (seeded per bay).
  const cell = floor(hx.div(0.9)).add(storey.mul(31)).add(seed.mul(97))
  const block = hash(cell).greaterThan(0.45).and(hy.lessThan(mix(float(0.75), float(1.4), hash(cell.add(7))))).and(isFloor.not())
  const furn = block.select(float(0.25), float(1))
  return max(albedo.mul(lit).mul(furn).add(panel), float(0))
})
