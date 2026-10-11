import type { Profile } from "./contracts"
import type { ClassId } from "../sim/protocol"
import { CLASSES } from "../sim/classes"

const KEY = "salvo.profile.v1"

export function defaultProfile(): Profile {
  return { name: "", cls: "crawler" }
}

export function loadProfile(): Profile {
  const base = defaultProfile()
  let raw: unknown = null
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null")
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== "object") return base
  const r = raw as Record<string, unknown>
  return {
    name: typeof r.name === "string" ? r.name.slice(0, 16) : "",
    cls: typeof r.cls === "string" && r.cls in CLASSES ? (r.cls as ClassId) : base.cls,
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage full or disabled; the profile simply won't persist
  }
}
