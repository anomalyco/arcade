import { expect, test } from "bun:test"
import { normalMipChain } from "../../../packages/kit/gpu/normal-mips"

test("minified normal maps keep variance instead of normalizing opposing slopes into a mirror", () => {
  const mips=normalMipChain(2,2,new Uint8ClampedArray([255,128,128,255,0,128,128,255,255,128,128,255,0,128,128,255]))
  expect(mips.map(m=>[m.width,m.height])).toEqual([[2,2],[1,1]])
  const avg=mips[1]!.data
  expect(Math.hypot(...[0,1,2].map(c=>avg[c]!/127.5-1))).toBeLessThan(0.02)
  const flat=normalMipChain(3,1,new Uint8ClampedArray([128,128,255,255,128,128,255,255,128,128,255,255]))
  expect(flat.at(-1)!.data[2]).toBe(255)
})
