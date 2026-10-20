import { expect, test } from "bun:test"
import { DEFAULT_VEGETATION_SETTINGS } from "../src/vegetation/settings"
import { packVegetationTrees, VEG_TREE_UNIFORM_FLOATS } from "../src/vegetation/trees"
import { makeTown } from "../shared/map"

test("streamed props on the same Town get burn slots for the new trees", () => {
  const town = makeTown(7, 7, 0, 1)
  const s = { ...DEFAULT_VEGETATION_SETTINGS, vegBurnTest: 1 }
  const out = new Float32Array(VEG_TREE_UNIFORM_FLOATS)
  town.props = [{ x: 10, y: 10, kind: "tree", variant: 0 }]
  packVegetationTrees(s, town, 10, 10, out, 0)
  expect([out[3], out[4], out[5]]).toEqual([1, 10, 10])
  town.props = [{ x: 200, y: 200, kind: "tree", variant: 0 }]
  packVegetationTrees(s, town, 200, 200, out, 0)
  expect([out[3], out[4], out[5]]).toEqual([1, 200, 200])
})
