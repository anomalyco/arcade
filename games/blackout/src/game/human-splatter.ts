import { limbIds, pointVelocity, type BoneId, type PartMotion } from "@arcade/kit/human-pose"
import type { V3 } from "@arcade/kit/rig"
import type { SplatterImpact } from "@arcade/kit/fx/splatter"

/** One caller-selected wound, not one burst per descendant. All positions/directions are world Y-up. */
export function detachedSplatter(
  emit: (impact: SplatterImpact) => boolean,
  part: PartMotion & { bone: BoneId },
  impact: { id: number; seed: number; direction: V3; point?: V3; amount?: number },
): boolean {
  const [x, y, z] = impact.point ?? part.frame.p
  const [vx, vy, vz] = pointVelocity(part, [x, y, z])
  const [dx, dy, dz] = impact.direction
  return emit({ id: impact.id, limbId: limbIds[part.bone], seed: impact.seed, x, y, z,
    dx, dy, dz, vx, vy, vz, amount: impact.amount })
}
