import type { Role } from "../../shared/config"
import { randomCode } from "../../shared/protocol"
import { h } from "./dom"

/** `via` says how the room was chosen: quick join retries once on a full room, create makes it private. */
export type LobbyResult = { mode: "solo" | "room"; room: string | null; name: string; picks: Record<Role, string>; via?: "quick" | "create" | "code" }

export const PICKS: Record<Role, string> = { robber: "muscle", cop: "cruiser" }
const STATS_MS = 10_000

const api = (path: string) => `${location.pathname.replace(/[^/]*$/, "")}api/${path}`

/** A room from the matchmaker (`quick`) or a fresh private one (`create`); a random code if the server can't be asked. */
export async function askRoom(path: "quick" | "create"): Promise<string> {
  try {
    const res = await fetch(api(path), { cache: "no-store" })
    const body = (await res.json()) as { room?: unknown }
    if (res.ok && typeof body.room === "string" && body.room) return body.room
  } catch {}
  return randomCode()
}

/** A room for quick join from the matchmaker (falls back to a fresh code if the server can't be asked). */
export const quickRoom = () => askRoom("quick")

export function setRoomParam(room: string, replace = false) {
  const url = new URL(location.href)
  url.searchParams.set("r", room)
  if (replace) history.replaceState(null, "", url)
  else history.pushState(null, "", url)
}

/**
 * Getaway's art behind the shell's title card: the night-road backdrop with passing streaks and sirens, and the live
 * player count for the title slot. `remove()` fades the backdrop out once a session starts.
 */
export function titleArt(root: HTMLElement): { stats: HTMLElement; remove(): void } {
  const el = h("div", "lobby", root)
  el.innerHTML = `<div class="lb-bg"><i class="streak s1"></i><i class="streak s2"></i><i class="streak s3"></i><div class="lb-siren"></div></div>`
  const stats = document.createElement("p")
  stats.className = "lb-stats"
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const load = async () => {
    try {
      const res = await fetch(api("stats"), { cache: "no-store" })
      if (!res.ok) return
      const s = (await res.json()) as { players: number; games: number }
      stats.textContent = `${plural(s.players, "player", "players")} online · ${plural(s.games, "open game", "open games")}`
    } catch {}
  }
  void load()
  const timer = setInterval(load, STATS_MS)
  return {
    stats,
    remove() {
      clearInterval(timer)
      el.classList.add("out")
      setTimeout(() => el.remove(), 450)
    },
  }
}
