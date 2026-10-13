export type BodyPose = { height: number; roll: number; pitch: number }

/** Car-local to world, matching instWorld: roll (Z), pitch (X), yaw (Y), translation.
 * Height is the complete rendered body height, including ground, flight and springs. */
export function bodyPoint(car: { x: number; z: number; h: number }, pose: BodyPose, local: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = local
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll)
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch)
  const cy = Math.cos(car.h), sy = Math.sin(car.h)
  const rx = x * cr - y * sr, ry = x * sr + y * cr
  const py = ry * cp - z * sp, pz = ry * sp + z * cp
  return [car.x + rx * cy + pz * sy, pose.height + py, car.z - rx * sy + pz * cy]
}
