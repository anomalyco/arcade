import { DEFAULT_LIMITS, type Limits } from "../../packages/kit/proof/legibility"
import type { LookState } from "../../packages/kit/proof/look"

export type SweepState = { id: string; state: LookState; limits?: Limits; probes?: { subject?: boolean; shift?: number; albedo?: boolean } }
export type SweepSpec = { version: 1; width: number; height: number; settleFrames: number; probeFrames: number; limits?: Limits; states: SweepState[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function keys(v: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`Unknown spec key: ${k}`)
}
function limits(v: unknown) {
  if (v === undefined) return
  if (!object(v)) throw new Error("limits must be an object")
  keys(v, Object.keys(DEFAULT_LIMITS))
  for (const [k, n] of Object.entries(v)) if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`Invalid limit ${k}`)
}
export function parseSpec(value: unknown): SweepSpec {
  if (!object(value)) throw new Error("Sweep must be an object")
  keys(value, ["version", "width", "height", "settleFrames", "probeFrames", "limits", "states"])
  if (value.version !== 1) throw new Error("Unsupported sweep version")
  for (const [k, min, max] of [["width", 64, 3840], ["height", 64, 2160], ["settleFrames", 4, 600], ["probeFrames", 4, 600]] as const) {
    const n = value[k]
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be ${min}–${max}`)
  }
  limits(value.limits)
  if (!Array.isArray(value.states) || !value.states.length || value.states.length > 100) throw new Error("Expected 1–100 states")
  const ids = new Set<string>()
  for (const row of value.states) {
    if (!object(row)) throw new Error("Invalid state")
    keys(row, ["id", "state", "limits", "probes"])
    if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.id) || ids.has(row.id)) throw new Error("State ids must be unique safe filenames")
    ids.add(row.id)
    if (!object(row.state)) throw new Error("state must be an object")
    keys(row.state, ["look", "camera", "torch", "time", "settings"])
    for (const k of ["look", "camera"]) if (row.state[k] !== undefined && typeof row.state[k] !== "string") throw new Error(`${k} must be a string`)
    if (row.state.torch !== undefined && typeof row.state.torch !== "boolean") throw new Error("torch must be boolean")
    if (row.state.time !== undefined && (typeof row.state.time !== "number" || !Number.isFinite(row.state.time) || row.state.time < 0)) throw new Error("Invalid time")
    if (row.state.settings !== undefined && (!object(row.state.settings) || Object.values(row.state.settings).some(v => !["string", "number", "boolean"].includes(typeof v) || typeof v === "number" && !Number.isFinite(v)))) throw new Error("Invalid settings")
    limits(row.limits)
    if (row.probes !== undefined) {
      if (!object(row.probes)) throw new Error("Invalid probes")
      keys(row.probes, ["subject", "shift", "albedo"])
      for (const k of ["subject", "albedo"]) if (row.probes[k] !== undefined && typeof row.probes[k] !== "boolean") throw new Error(`${k} must be boolean`)
      if (row.probes.shift !== undefined && (typeof row.probes.shift !== "number" || !Number.isFinite(row.probes.shift) || row.probes.shift <= 0 || row.probes.shift > 0.5)) throw new Error("Shift must be >0 and ≤0.5 metres")
    }
  }
  return value as SweepSpec
}
