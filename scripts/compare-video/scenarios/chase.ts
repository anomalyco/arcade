/** A 12-second night chase. Functions run in the recorder, never on a wall clock. */
export default {
  name: "chase",
  input(frame: number, fps: number, car?: { x: number; h: number; yaw?: number }) {
    const t = frame / fps
    const target = 228 + Math.sin(t * 2.55) * 3.4
    return {
      throttle: 1,
      brake: 0,
      steer: Math.max(-1, Math.min(1, (target - (car?.x ?? 226)) * 0.18 - (car?.h ?? 0.1) * 2.2 - (car?.yaw ?? 0) * 0.35)),
      handbrake: (t >= 0.1 && t < 0.3) || (t >= 5.5 && t < 5.8),
      boost: (t >= 0.75 && t < 1.75) || (t >= 3.85 && t < 5) || (t >= 8 && t < 9.5),
      gadget: null,
      engine: false,
    }
  },
}
