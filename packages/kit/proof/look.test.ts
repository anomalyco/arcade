import { expect, test } from "bun:test"
import { LabNavigation, type LabSettings } from "../lab-navigation"
import { controlPatch } from "./look"

test("invalid control patches never partially change settings or run callbacks", () => {
  let calls = 0
  const settings = { exposure: 1, mode: "normal", visible: true }
  const nav = new LabNavigation(settings, [
    { key: "exposure", label: "Exposure", min: 0, max: 4, change: () => calls++ },
    { key: "mode", label: "Mode", options: [{ value: "normal", label: "Normal" }] },
    { key: "visible", label: "Visible", type: "toggle" },
  ])
  const invalid: LabSettings[] = [{ exposure: 2, unknown: 1 }, { exposure: 2, mode: "invalid" }, { exposure: 2, visible: 1 }, { exposure: 5 }]
  for (const bad of invalid) {
    expect(() => controlPatch(nav, bad)).toThrow()
    expect(settings.exposure).toBe(1)
    expect(calls).toBe(0)
  }
  const commit = controlPatch(nav, { exposure: 2 })
  expect(settings.exposure).toBe(1)
  commit()
  expect(settings.exposure).toBe(2)
  expect(calls).toBe(1)
})
