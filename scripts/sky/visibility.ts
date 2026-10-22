/** Display-space visibility, not catalogue counts. Same 1920×1080 sampling and ROIs for target and render.
 * bun scripts/sky/visibility.ts <clearing|lake> <image> [...images]
 * sips supplies an uncompressed BMP so this instrument needs no image-library dependency. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [view, ...files] = process.argv.slice(2)
if (!files.length || (view !== "clearing" && view !== "lake")) throw Error("Expected clearing|lake and image paths")
const scratch = await mkdtemp(join(tmpdir(), "sky-visibility-"))
const W = 1920, H = 1080
try {
  const reports = []
  for (const [index, file] of files.entries()) {
    const bmp = join(scratch, `${index}.bmp`)
    const proc = Bun.spawn(["sips", "-s", "format", "bmp", "--resampleHeightWidth", String(H), String(W), file!, "--out", bmp], { stdout: "ignore", stderr: "inherit" })
    if (await proc.exited) throw Error(`Could not decode ${file}`)
    const bytes = new Uint8Array(await Bun.file(bmp).arrayBuffer()), d = new DataView(bytes.buffer)
    const offset = d.getUint32(10, true), width = d.getInt32(18, true), height = d.getInt32(22, true)
    const bits = d.getUint16(28, true), compression = d.getUint32(30, true)
    if (width !== W || Math.abs(height) !== H || ![24, 32].includes(bits) || compression !== 0) throw Error("Expected uncompressed 24/32-bit BMP")
    const stride = Math.ceil(W * bits / 32) * 4, pixelBytes = bits / 8
    const y = new Float32Array(W * H)
    for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) {
      const p = offset + (height > 0 ? H - 1 - row : row) * stride + x * pixelBytes
      y[row * W + x] = bytes[p + 2]! * .2126 + bytes[p + 1]! * .7152 + bytes[p]! * .0722
    }
    // Exclude foreground, captions, lamps, the Moon, and image borders. These fixed
    // central upper-sky regions are shared across the registered Today/new/target frames.
    const roi = view === "clearing" ? [.20, .03, .80, .43] : [.16, .03, .84, .34]
    const [x0, y0, x1, y1] = roi.map((v, i) => Math.round(v! * (i % 2 ? H : W))) as [number, number, number, number]
    const peaks: { x: number; y: number; contrast: number }[] = []
    const field: number[] = []
    for (let row = y0; row < y1; row++) for (let x = x0; x < x1; x++) {
      const p = row * W + x, c = y[p]!
      if (x % 8 === 0 && row % 8 === 0) field.push(c)
      // Five-pixel annulus estimates the local background independently of a Galactic gradient.
      const ring = [-5, 0, 5].flatMap(dy => [-5, 0, 5].filter(dx => dx || dy).map(dx => y[p + dy * W + dx]!)).sort((a,b) => a-b)
      const bg = (ring[3]! + ring[4]!) * .5
      if (c - bg < 4 || c < 9) continue
      let peak = true, excess = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = y[p + dy * W + dx]!
        if ((dx || dy) && (n > c || (n === c && (dy < 0 || (dy === 0 && dx < 0))))) peak = false
        excess += Math.max(0, n - bg)
      }
      if (peak && excess >= 10) peaks.push({ x, y: row, contrast: c - bg })
    }
    // Robust 32px tile medians reject point sources. Contrast describes diffuse
    // structure (including the Galactic band), not a claim of photometric calibration.
    const tiles: number[] = []
    for (let row = y0; row + 32 < y1; row += 32) for (let x = x0; x + 32 < x1; x += 32) {
      const values: number[] = []
      for (let dy = 0; dy < 32; dy += 2) for (let dx = 0; dx < 32; dx += 2) values.push(y[(row + dy) * W + x + dx]!)
      values.sort((a,b) => a-b); tiles.push(values[values.length >> 1]!)
    }
    tiles.sort((a,b) => a-b); field.sort((a,b) => a-b)
    const quantile = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))]!
    const low = quantile(tiles, .1), high = quantile(tiles, .9)
    reports.push({ file, view, size: [W,H], roi, visiblePointSources: peaks.length,
      pointsPerMegapixel: peaks.length * 1e6 / ((x1-x0)*(y1-y0)),
      strongerPeaks: { contrast12: peaks.filter(p => p.contrast >= 12).length, contrast24: peaks.filter(p => p.contrast >= 24).length },
      medianSkyByte: quantile(field,.5), diffuseP10Byte: low, diffuseP90Byte: high,
      diffuseContrast: quantile(field,.5) >= 3 ? (high-low) / Math.max(high+low, 1) : null,
      pointThreshold: { peakAboveBackgroundByte: 4, absolutePeakByte: 9, integratedExcessByte: 10 } })
  }
  console.log(JSON.stringify({ method: "fixed-upper-sky ROI; 5px annular background; 3x3 peak/excess; 32px median diffuse contrast", reports }, null, 2))
} finally { await rm(scratch, { recursive: true, force: true }) }
