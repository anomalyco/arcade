/** Shared by the lot reprojection measurement and the read-only Ashwood capture. */
export type MotionPose = { x: number; z: number; yaw: number; pitch: number }
export const matchedPaths: Record<string, { frames: number; pose(t: number): MotionPose }> = {
  kit: { frames: 150, pose: t => ({ x: -5 + .2*t, z: 102 - 2.1*t, yaw: -.1 + .03*Math.sin(t*1.7), pitch: -.02 }) },
  lamp: { frames: 150, pose: t => ({ x: 1, z: 138 - 2.1*t, yaw: .05, pitch: -.02 }) },
  turn: { frames: 150, pose: t => ({ x: 2, z: 112, yaw: -1 + .8*t, pitch: .02 }) },
}
