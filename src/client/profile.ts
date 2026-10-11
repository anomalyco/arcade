import type { Profile } from "./contracts"

const KEY = "salvo.profile.v1"

export function defaultProfile(): Profile {
  return { name: "" }
}

export function loadProfile(): Profile {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string") return { name: raw.name.slice(0, 16) }
  } catch {
    // corrupt or unavailable storage; start fresh
  }
  return defaultProfile()
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage full or disabled; the profile simply won't persist
  }
}
