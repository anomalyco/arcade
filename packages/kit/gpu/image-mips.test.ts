import { expect, test } from "bun:test"
import { imageMipChain } from "./image-mips"
import { linearToSrgbByte, srgbByteToLinear } from "../textures/loader"

test("mip zero preserves dilated transparent RGB without a full-size copy", () => {
  const rgba = new Uint8ClampedArray([255,0,0,255, 0,190,255,0])
  const levels = imageMipChain(2,1,rgba,true)
  expect(levels[0]!.data.buffer).toBe(rgba.buffer)
  expect([...levels[0]!.data]).toEqual([...rgba])
  expect([...levels[1]!.data]).toEqual([255,0,0,128])
})

test("colour minification conserves light, data maps stay linear", () => {
  const pixels = [0,0,0,255, 255,255,255,255]
  expect(imageMipChain(2,1,pixels,true).at(-1)!.data[0]).toBe(188)
  expect(imageMipChain(2,1,pixels,false).at(-1)!.data[0]).toBe(128)
})
test("odd dimensions retain edge texels and transparent colour does not bleed", () => {
  expect(imageMipChain(3,1,[0,0,0,255, 0,0,0,255, 255,255,255,255],false).at(-1)!.data[0]).toBe(85)
  expect([...imageMipChain(2,1,[255,0,0,255, 0,0,255,0],true).at(-1)!.data]).toEqual([255,0,0,128])
})

// The general area filter as it was before the even-size fast path; the fast path must match it byte for byte.
function referenceMipChain(width: number, height: number, source: Uint8Array, srgb: boolean) {
  const levels = [{ width, height, data: source }]
  let values: ArrayLike<number> = source, encoded = true
  while (width > 1 || height > 1) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1), next = new Float32Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = x * width / w, x1 = (x + 1) * width / w, y0 = y * height / h, y1 = (y + 1) * height / h
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
        const weight = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy)) / ((x1 - x0) * (y1 - y0))
        const i = (yy * width + xx) * 4
        for (let c = 0; c < 4; c++) next[(y * w + x) * 4 + c]! += (encoded ? (srgb && c < 3 ? srgbByteToLinear(values[i + c]!) * values[i + 3]! / 255 : values[i + c]! / 255) : values[i + c]!) * weight
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

test("even-size fast path matches the general area filter exactly", () => {
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (const [w, h] of [[64, 64], [32, 8], [16, 2], [6, 10]] as const) for (const srgb of [true, false]) for (const alpha of ["opaque", "mixed"]) {
    const source = new Uint8Array(w * h * 4)
    for (let i = 0; i < source.length; i++) source[i] = i % 4 === 3 && alpha === "opaque" ? 255 : Math.floor(random() * 256)
    const fast = imageMipChain(w, h, source, srgb), reference = referenceMipChain(w, h, source, srgb)
    expect(fast.length).toBe(reference.length)
    for (let l = 1; l < fast.length; l++) expect([...fast[l]!.data]).toEqual([...reference[l]!.data])
  }
})
