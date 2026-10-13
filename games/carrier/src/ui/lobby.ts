import { crewName, randomCode, roomCode } from "../../shared/crew"
import { roomName } from "../../shared/protocol"

/**
 * Where a session starts. `offline`: `?seed=N`, a fixed world on the local clock, no menu. `room`: a room code or name,
 * from the menu or straight from a `?room=` link. `private` asks the room to stay out of quick join (Create game).
 */
export type Start = { mode: "offline"; seed: number } | { mode: "room"; room: string; name: string; via: "quick" | "create" | "code" | "link"; private: boolean }

export type RoomInfo = { code: string; players: number; full: boolean; live: boolean }
export type LobbyStats = { players: number; games: number }

/** What the menu asks the server; the preview swaps in fakes. */
export type LobbyClient = {
  quick(): Promise<string>
  create(): Promise<string>
  info(code: string): Promise<RoomInfo | null>
  stats(): Promise<LobbyStats | null>
}

const NAME_KEY = "carrier.name"
const api = (path: string) => `${location.pathname.replace(/[^/]*$/, "")}api/${path}`

async function getJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(api(path), { cache: "no-store", ...init })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/** The lobby API (server/lobby.ts). Quick join and create fall back to a fresh local code if the server can't answer. */
export const lobbyClient: LobbyClient = {
  quick: async () => roomCode((await getJson<{ room?: string }>("quick"))?.room) ?? randomCode(),
  create: async () => roomCode((await getJson<{ room?: string }>("create", { method: "POST" }))?.room) ?? randomCode(),
  info: (code) => getJson<RoomInfo>(`room/${encodeURIComponent(code)}`),
  stats: () => getJson<LobbyStats>("stats"),
}

/** The remembered name, or "" the first time. */
export const storedName = (): string => localStorage.getItem(NAME_KEY) ?? ""

export function rememberName(name: string): string {
  const n = crewName(name)
  localStorage.setItem(NAME_KEY, n)
  return n
}

/** Puts the room in the address bar (so a reload rejoins it) without reloading. */
export function setRoomParam(room: string, replace = false): void {
  const url = new URL(location.href)
  url.searchParams.set("room", room)
  if (replace) history.replaceState(null, "", url)
  else history.pushState(null, "", url)
}

/** A link that drops a friend straight into `room`. */
export function inviteUrl(room: string): string {
  const url = new URL(location.href)
  url.search = ""
  url.hash = ""
  url.searchParams.set("room", room)
  return url.toString()
}

/**
 * What the URL decides before any menu: `?seed=N` plays offline, `?room=` joins that room once the player has a name.
 * Null: show the menu (it reads `?room=` itself to prefill the code, so a first-time invitee types a name first).
 */
export function startFromUrl(params: URLSearchParams): Start | null {
  const seed = params.get("seed")
  if (seed !== null && seed !== "" && Number.isFinite(Number(seed))) return { mode: "offline", seed: Number(seed) >>> 0 }
  const room = params.get("room")
  if (room && storedName()) return { mode: "room", room: roomName(room), name: crewName(storedName()), via: "link", private: false }
  return null
}
