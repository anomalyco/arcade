import { expect, test } from "bun:test"
import { parseSpec } from "./spec"

const spec = () => ({ version: 1, width: 1280, height: 720, settleFrames: 24, probeFrames: 16, states: [{ id: "today", state: {} }] })
test("rejects unsafe output names, duplicate states and unsupported probes before opening a browser", () => {
  expect(() => parseSpec({ ...spec(), states: [{ id: "../escape", state: {} }] })).toThrow()
  expect(() => parseSpec({ ...spec(), states: [...spec().states, ...spec().states] })).toThrow()
  expect(() => parseSpec({ ...spec(), states: [{ id: "today", state: {}, probes: { typo: true } }] })).toThrow()
  expect(() => parseSpec({ ...spec(), states: [{ id: "today", state: {}, probes: { shift: 2 } }] })).toThrow()
  expect(parseSpec(spec()).states).toHaveLength(1)
})
test("rejects invalid numbers and unknown limits instead of quietly skipping a gate", () => {
  expect(() => parseSpec({ ...spec(), limits: { minWeber: NaN } })).toThrow()
  expect(() => parseSpec({ ...spec(), limits: { minContrast: 0.2 } })).toThrow()
  expect(() => parseSpec({ ...spec(), probeFrames: 0 })).toThrow()
  expect(() => parseSpec({ ...spec(), states: [{ id: "today", state: { settings: { exposure: Infinity } } }] })).toThrow()
})
