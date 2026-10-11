// Boundary parsing for untrusted WebSocket input. Everything past here is a typed ClientMsg.
import type { ClassId, ClientMsg, Mode } from "../sim/protocol"
import { WEAPONS, type WeaponId } from "../sim/weapons"

export const BASE = "/labs/salvo"
export const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
export const MAX_MESSAGE_BYTES = 2048
export const MAX_HUMANS = 12

const ROOM_RE = /^[a-z0-9]{3,24}$/
const PID_RE = /^[A-Za-z0-9_-]{8,40}$/
const CLASSES: readonly ClassId[] = ["crawler", "rail", "walker", "howitzer", "drone", "siege", "catapult", "buggy"]
const MODES: readonly Mode[] = ["ffa", "teams"]

export function validRoom(room: string): boolean {
  return ROOM_RE.test(room)
}

export function validPid(pid: string): boolean {
  return PID_RE.test(pid)
}

export function randomRoom(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ""
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length]
  return out
}

export function randomPid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20)
}

function num(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

function int(value: unknown, min: number, max: number): number | null {
  const n = num(value, min, max)
  return n === null ? null : Math.round(n)
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  return value.slice(0, max)
}

function cls(value: unknown): ClassId | null {
  return CLASSES.find((c) => c === value) ?? null
}

function weapon(value: unknown): WeaponId | null {
  return typeof value === "string" && Object.hasOwn(WEAPONS, value) ? (value as WeaponId) : null
}

function cleanName(value: unknown): string {
  // strip control characters, collapse whitespace
  const raw = str(value, 64) ?? ""
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 16)
  return name || "Pilot"
}

export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > MAX_MESSAGE_BYTES) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  switch (m.type) {
    case "join": {
      const c = cls(m.cls) ?? "crawler"
      return { type: "join", name: cleanName(m.name), cls: c, level: int(m.level, 1, 999) ?? 1 }
    }
    case "aim": {
      const angle = num(m.angle, -720, 720)
      const power = num(m.power, 0, 100000)
      const w = weapon(m.weapon)
      if (angle === null || power === null || !w) return null
      return { type: "aim", angle, power, weapon: w }
    }
    case "move":
      return m.dir === 1 || m.dir === -1 ? { type: "move", dir: m.dir } : null
    case "lock":
      return { type: "lock" }
    case "ready":
      return { type: "ready" }
    case "buy": {
      const item = str(m.item, 32)
      return item ? { type: "buy", item } : null
    }
    case "start": {
      const mode = MODES.find((x) => x === m.mode) ?? "ffa"
      return { type: "start", mode, bots: int(m.bots, 0, 11) ?? 0, battles: int(m.battles, 1, 15) ?? 3 }
    }
    case "class": {
      const c = cls(m.cls)
      return c ? { type: "class", cls: c } : null
    }
    case "ping": {
      const t = num(m.t, 0, Number.MAX_SAFE_INTEGER)
      return t === null ? null : { type: "ping", t }
    }
    default:
      return null
  }
}
