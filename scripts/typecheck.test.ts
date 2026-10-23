import { expect, test } from "bun:test"
import { typecheckThreads } from "./typecheck"

test("typechecking defaults to two threads and respects fractional worker allocations", () => {
  expect(typecheckThreads({})).toBe(2)
  expect(typecheckThreads({ HIVEMIND_CPUS: "4" })).toBe(4)
  expect(typecheckThreads({ HIVEMIND_CPUS: "1.75" })).toBe(1)
  expect(typecheckThreads({ HIVEMIND_CPUS: "0.5" })).toBe(1)
})

test("invalid allocations fail instead of falling back to every host core", () => {
  for (const value of ["", "0", "-1", "NaN", "Infinity", "nope"]) {
    expect(() => typecheckThreads({ HIVEMIND_CPUS: value })).toThrow("HIVEMIND_CPUS")
  }
})
