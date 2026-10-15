/**
 * Headless Chrome for captures. By default it throttles requestAnimationFrame to about 15 fps, so clips stutter and
 * the game steps several ticks per frame. These flags lift the cap, and `PACE_60` (an init script) holds frames to
 * 60 Hz so the GPU isn't rendering a thousand frames a second.
 */
export const CHROME_ARGS = ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--disable-frame-rate-limit", "--disable-gpu-vsync"]

export const PACE_60 = `(() => {
  const raf = window.requestAnimationFrame.bind(window)
  let next = 0
  window.requestAnimationFrame = (cb) => raf(function wait(t) {
    if (t < next) return raf(wait)
    next = Math.max(next + 1000 / 60, t - 1000 / 60)
    cb(t)
  })
})()`
