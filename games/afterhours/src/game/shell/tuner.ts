// The loading screen as a TV tuning in. One small 2D canvas (480×270, smoothly upscaled) composites, per frame: the
// world's latest frame (a snapshot of the WebGPU canvas, taken right after the boot draws it: every ~0.5 s while the
// world streams, every frame during the lock) in sync-wobbling strips with a ghost and a rolling vertical hold, then
// pre-rendered snow over it, tear lines and the odd colour-burst flicker. `signal` (0..1, the boot's progress, eased)
// thins the snow and brings the picture up; `lock()` plays the settle: a quick damped vertical roll and the snow gone.
// Only drawImage/fillRect calls on a small canvas (~0.2 ms a frame), capped at 30 fps; nothing touches the GPU device.

const W = 480
const H = 270
const TILES = 6
const FRAME_MS = 33

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

function noiseTile() {
  const c = document.createElement("canvas")
  c.width = W
  c.height = H
  const g = c.getContext("2d")!
  const img = g.createImageData(W, H)
  const px = new Uint32Array(img.data.buffer)
  for (let i = 0; i < px.length; i++) {
    const v = (Math.random() ** 1.4 * 255) | 0
    px[i] = (255 << 24) | (v << 16) | (v << 8) | v
  }
  g.putImageData(img, 0, 0)
  return c
}

export function createTuner(canvas: HTMLCanvasElement, onFrame?: (signal: number) => void) {
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext("2d", { alpha: false })!
  const tiles = Array.from({ length: TILES }, noiseTile)
  const pic = document.createElement("canvas")
  pic.width = W
  pic.height = H
  const pg = pic.getContext("2d", { alpha: false })!
  pg.fillStyle = "#000"
  pg.fillRect(0, 0, W, H)
  let havePicture = false

  let target = 0
  let signal = 0
  let roll = 0
  let rollV = 0
  let locking = -1
  let lockDone: (() => void) | null = null
  let burst = 0
  let running = false
  let raf = 0
  let last = 0
  let time = 0

  function draw(dt: number) {
    time += dt
    // The eased signal follows the boot's progress (which arrives in steps) at a steady pace.
    signal += (target - signal) * (1 - Math.exp(-dt * 1.6))
    let s = ease(signal)
    let noise = 1 - 0.86 * ease(signal / 0.95)
    if (locking >= 0) {
      locking += dt
      const k = Math.min(1, locking / 0.35)
      s = 1
      noise *= 1 - k
      // Vertical roll: a damped spring back to the frame's top.
      rollV += (-roll * 160 - rollV * 12) * dt
      roll += rollV * dt
      if (locking > 0.9 && lockDone) {
        lockDone()
        lockDone = null
      }
    } else {
      // Vertical hold: rolls while the signal is weak, slows and catches as it strengthens.
      const speed = (1 - s) ** 2 * 0.9 + (Math.sin(time * 0.7) > 0.6 ? 0.25 * (1 - s) : 0)
      roll = (roll + speed * dt) % 1
      if (s > 0.6) roll *= Math.exp(-dt * 2.5 * s)
    }

    g.globalCompositeOperation = "source-over"
    g.globalAlpha = 1
    g.fillStyle = "#000"
    g.fillRect(0, 0, W, H)

    const picA = havePicture ? Math.min(1, s * 1.15) ** 1.3 : 0
    const rollPx = (((roll % 1) + 1) % 1) * H
    if (picA > 0.002) {
      // Horizontal sync wobble, strip by strip, strongest while the signal is weak.
      const wob = 16 * (1 - s) ** 1.5 + (locking >= 0 ? 6 * Math.max(0, 1 - locking / 0.6) : 0.6)
      const STRIP = 6
      g.globalAlpha = picA
      for (let y = 0; y < H; y += STRIP) {
        const dx = wob * Math.sin(y * 0.045 + time * 6.3) + wob * 0.35 * Math.sin(y * 0.21 - time * 17)
        const yy = (y + rollPx) % H
        g.drawImage(pic, 0, y, W, STRIP, dx, yy, W, STRIP)
        if (yy + STRIP > H) g.drawImage(pic, 0, y, W, STRIP, dx, yy - H, W, STRIP)
      }
      // Ghost: a faint echo a few pixels to the right.
      const ghost = 0.3 * (1 - s * 0.7) * picA
      if (ghost > 0.01) {
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = ghost
        g.drawImage(pic, 9, rollPx)
        g.drawImage(pic, 9, rollPx - H)
        g.globalCompositeOperation = "source-over"
      }
      // The blanking bar where the rolling frame wraps.
      if (rollPx > 1 && rollPx < H - 1) {
        g.globalAlpha = 0.85
        g.fillStyle = "#000"
        g.fillRect(0, rollPx - 5, W, 9)
      }
    }

    // Snow: over black it's the picture; over the picture, screened on.
    if (noise > 0.004) {
      const tile = tiles[(Math.random() * TILES) | 0]!
      const ox = (Math.random() * W) | 0
      const oy = (Math.random() * H) | 0
      g.globalCompositeOperation = picA > 0.05 ? "screen" : "source-over"
      g.globalAlpha = noise
      g.drawImage(tile, ox, oy)
      g.drawImage(tile, ox - W, oy)
      g.drawImage(tile, ox, oy - H)
      g.drawImage(tile, ox - W, oy - H)
      g.globalCompositeOperation = "source-over"
    }

    // Rolling dark band (vertical hold) while weak.
    const band = 0.4 * (1 - s)
    if (band > 0.02) {
      const by = ((time * 0.18) % 1.4) * H - 0.2 * H
      const grad = g.createLinearGradient(0, by, 0, by + H * 0.22)
      grad.addColorStop(0, "rgba(0,0,0,0)")
      grad.addColorStop(0.5, `rgba(0,0,0,${band.toFixed(3)})`)
      grad.addColorStop(1, "rgba(0,0,0,0)")
      g.globalAlpha = 1
      g.fillStyle = grad
      g.fillRect(0, by, W, H * 0.22)
    }

    // Tear lines: a few rows yanked sideways, with a bright edge.
    const tears = Math.random() < 0.55 * (1 - s) + (locking >= 0 && locking < 0.3 ? 0.6 : 0) ? 1 + ((Math.random() * 3) | 0) : 0
    for (let i = 0; i < tears; i++) {
      const y = (Math.random() * H) | 0
      const h = 1 + ((Math.random() * 5) | 0)
      const dx = (Math.random() - 0.3) * 70
      g.globalAlpha = 1
      g.drawImage(canvas, 0, y, W, h, dx, y, W, h)
      g.fillStyle = "rgba(235,240,232,0.35)"
      g.fillRect(0, y, W, 1)
    }

    // Colour burst: a frame or two tinted as the chroma loses lock.
    if (burst <= 0 && Math.random() < 0.035 * (1 - s) && s < 0.85) burst = 2
    if (burst > 0) {
      burst--
      g.globalCompositeOperation = "color"
      g.globalAlpha = 0.45
      g.fillStyle = ["#ff2bd0", "#21ff8a", "#2bc8ff", "#ffb02b"][(Math.random() * 4) | 0]!
      g.fillRect(0, 0, W, H)
      g.globalCompositeOperation = "source-over"
    }
    g.globalAlpha = 1
  }

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    if (now - last < FRAME_MS) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    draw(dt)
    onFrame?.(locking >= 0 ? 1 : signal)
  }

  return {
    get signal() {
      return locking >= 0 ? 1 : signal
    },
    start() {
      if (running) return
      running = true
      last = performance.now()
      draw(0)
      raf = requestAnimationFrame(frame)
    },
    stop() {
      running = false
      cancelAnimationFrame(raf)
    },
    /** Boot progress 0..1. */
    progress(f: number) {
      target = Math.max(target, Math.min(1, f))
    },
    /** Copies the world's frame (call right after it was drawn, in the same task). */
    snapshot(source: HTMLCanvasElement) {
      if (!running) return
      try {
        pg.drawImage(source, 0, 0, W, H)
        havePicture = true
      } catch {}
    },
    /** The settle: resolves once the roll has caught (~0.9 s). */
    lock() {
      locking = 0
      roll = 0.32
      rollV = 0
      return new Promise<void>((resolve) => (lockDone = resolve))
    },
  }
}
