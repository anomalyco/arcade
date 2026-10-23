import { expect, test } from "bun:test"
import { indexForestMesh } from "./index-mesh"

test("indexing reconstructs every packed bit and preserves UV/normal seams", () => {
  const vertices = [new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]), new Uint32Array([0, 1, 2, 3, 4, 5, 6, 8]), new Uint32Array([0, 1, 2, 9, 4, 5, 6, 7])]
  const original = new Uint32Array([vertices[0]!, vertices[1]!, vertices[0]!, vertices[2]!, vertices[0]!, vertices[1]!].flatMap(v => Array.from(v)))
  const indexed = indexForestMesh(original.buffer)
  expect(indexed.vertices.length).toBe(24)
  const expanded = Array.from(indexed.indices).flatMap(i => Array.from(indexed.vertices.subarray(i * 8, i * 8 + 8)))
  expect(expanded).toEqual(Array.from(original))
})
