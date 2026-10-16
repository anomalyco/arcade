export type BodyPose = { height?: number; roll?: number; pitch?: number }

/** Car-local to world, matching instWorld: roll (Z), pitch (X), yaw (Y), translation.
 * Height is the complete rendered body height, including ground, flight and springs. */
export function bodyPoint(car: { x: number; z: number; h: number }, pose: BodyPose, local: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = local
  const cr = Math.cos(pose.roll ?? 0), sr = Math.sin(pose.roll ?? 0)
  const cp = Math.cos(pose.pitch ?? 0), sp = Math.sin(pose.pitch ?? 0)
  const cy = Math.cos(car.h), sy = Math.sin(car.h)
  const rx = x * cr - y * sr, ry = x * sr + y * cr
  const py = ry * cp - z * sp, pz = ry * sp + z * cp
  return [car.x + rx * cy + pz * sy, (pose.height ?? 0) + py, car.z - rx * sy + pz * cy]
}

/**
 * Re-expresses Kit's Z/X/Y vehicle rotations in the Kit renderer's Z/X/-Y instance convention
 * (used by Outbreak and Blackout). Converts the full basis so combined pitch and roll adjust Euler yaw.
 */
export function instanceRotation(out: { yaw: number; roll: number; pitch: number }, yaw: number, roll: number, pitch: number): void {
  const c = { x: 0, z: 0, h: yaw }
  const pose = { roll, pitch }
  const x = bodyPoint(c, pose, [0, 0, 1])
  const y = bodyPoint(c, pose, [0, 1, 0])
  const z = bodyPoint(c, pose, [-1, 0, 0])
  out.roll = Math.asin(Math.max(-1, Math.min(1, -z[1])))
  out.pitch = Math.atan2(x[1], y[1])
  out.yaw = Math.atan2(-z[0], z[2])
}
