// Analog-TV snow for the home screen: grey noise at a low resolution (the browser's smooth upscale softens it into
// grain), a slow rolling tracking band and a faint flicker. Runs at ~24 fps and only while visible.

export function createStatic(canvas: HTMLCanvasElement) {
  const W = 256
  const H = 144
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext("2d", { alpha: true })!
  const img = g.createImageData(W, H)
  const px = new Uint32Array(img.data.buffer)
  // A pool of random grey pixels; each frame reads it from a random offset (cheap and indistinguishable from fresh).
  const POOL = W * H * 2
  const pool = new Uint32Array(POOL)
  for (let i = 0; i < POOL; i++) {
    const v = (Math.random() ** 1.6 * 255) | 0
    pool[i] = (255 << 24) | (v << 16) | (v << 8) | v
  }
  let running = false
  let raf = 0
  let last = 0
  let band = Math.random()
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    if (now - last < 41) return
    last = now
    let o = (Math.random() * (POOL - W * H)) | 0
    // The tracking band: a few rows brighter and smeared sideways, drifting down the screen.
    band = (band + 0.0035) % 1.3
    const b0 = Math.floor((band - 0.15) * H)
    for (let y = 0; y < H; y++) {
      const inBand = y >= b0 && y < b0 + 9
      const row = y * W
      if (inBand) {
        const shift = (Math.random() * 6) | 0
        for (let x = 0; x < W; x++) px[row + x] = pool[o + ((x >> 1) << 1) + shift]! | 0x00202020
      } else for (let x = 0; x < W; x++) px[row + x] = pool[o + x]!
      o += W
    }
    g.putImageData(img, 0, 0)
    canvas.style.setProperty("--flicker", (0.92 + Math.random() * 0.08).toFixed(3))
  }
  return {
    start() {
      if (running) return
      running = true
      raf = requestAnimationFrame(frame)
    },
    stop() {
      running = false
      cancelAnimationFrame(raf)
    },
  }
}
