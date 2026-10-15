import type { Gun } from "./gun"
import { GUNPTS, RIG } from "./soldier"
import type { Body } from "./anim"
import { at, moved, type V3 } from "../rig"

/** Same joint order for pose differencing and Verlet initialization. */
export function bodyJoints(b: Body, gun: Gun): V3[] {
  const g = b.gun ?? moved(b.torso, at(b.torso, 0.3, 0.2, 0))
  return [b.th[0].p, b.th[1].p, b.ua[0].p, b.ua[1].p,
    at(b.torso, -0.25, 0.27, 0), at(b.torso, 0.17, 0.28, 0), at(b.head, 0, 0.18, 0),
    b.sh[0].p, b.sh[1].p, b.ft[0].p, b.ft[1].p, b.fa[0].p, b.fa[1].p,
    at(b.fa[0], 0, -RIG.fore, 0), at(b.fa[1], 0, -RIG.fore, 0), g.p, at(g, GUNPTS[gun].muzzle, 0, 0)]
}
