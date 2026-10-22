import { linearToSrgbByte, srgbByteToLinear } from "../textures/loader"

/** Area-filter in linear light; weight transparent colour by coverage to avoid dark fringes.
 * Data maps stay linear. Float intermediates avoid accumulated byte rounding. */
export function imageMipChain(width: number, height: number, rgba: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer> | readonly number[], srgb: boolean) {
  // Keep authored/dilated RGB even at alpha zero, and avoid a full-size float intermediate.
  const source = ArrayBuffer.isView(rgba) ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : Uint8Array.from(rgba)
  const levels = [{ width, height, data: source }]
  let values: ArrayLike<number> = source, encoded = true
  while (width > 1 || height > 1) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1), next = new Float32Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = x * width / w, x1 = (x + 1) * width / w, y0 = y * height / h, y1 = (y + 1) * height / h
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
        const weight = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy)) / ((x1 - x0) * (y1 - y0))
        const i = (yy * width + xx) * 4
        for (let c = 0; c < 4; c++) {
          const v = encoded ? (srgb && c < 3 ? srgbByteToLinear(values[i + c]!) * values[i + 3]! / 255 : values[i + c]! / 255) : values[i + c]!
          next[(y * w + x) * 4 + c]! += v * weight
        }
      }
    }
    values = next; width = w; height = h; encoded = false
    const data = new Uint8Array(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
      const a = values[i + 3]!
      for (let c = 0; c < 3; c++) data[i + c] = srgb ? linearToSrgbByte(a > 0 ? values[i + c]! / a : 0) : Math.round(values[i + c]! * 255)
      data[i + 3] = Math.round(a * 255)
    }
    levels.push({ width, height, data })
  }
  return levels
}
