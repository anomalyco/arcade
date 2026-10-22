import { expect, test } from "bun:test"
import { imageMipChain } from "./image-mips"

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
