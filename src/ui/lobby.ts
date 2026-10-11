import type { Role } from "../../shared/config"
import { randomCode } from "../../shared/protocol"
import { esc, h } from "./dom"

/** `via` says how the room was chosen: quick join retries once on a full room, create makes it private. */
export type LobbyResult = { mode: "solo" | "room"; room: string | null; name: string; picks: Record<Role, string>; via?: "quick" | "create" | "code" }

const NAME_KEY = "getaway.name"
const PICKS: Record<Role, string> = { robber: "muscle", cop: "cruiser" }
const STATS_MS = 10_000

const api = (path: string) => `${location.pathname.replace(/[^/]*$/, "")}api/${path}`

async function askRoom(path: "quick" | "create"): Promise<string> {
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

/** Title screen: name, then quick join, create a private game, or join one by code (or from the shared link). */
export async function lobby(root: HTMLElement): Promise<LobbyResult> {
  const urlRoom = new URLSearchParams(location.search).get("r")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || null
  const storedName = localStorage.getItem(NAME_KEY) ?? ""

  const el = h("div", "lobby", root)
  el.innerHTML = `
    <div class="lb-bg"><i class="streak s1"></i><i class="streak s2"></i><i class="streak s3"></i><div class="lb-siren"></div></div>
    <div class="lb-inner">
      <h1 class="wordmark">GETAWAY</h1>
      <p class="lb-tag">One driver. Everyone else is a cop. Stay free.</p>
      <input class="lb-name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="YOUR NAME" value="${esc(storedName)}"/>
      ${urlRoom ? `<button class="btn primary" data-act="join">JOIN ROOM ${esc(urlRoom)}</button>` : ""}
      <button class="btn ${urlRoom ? "strong" : "primary"}" data-act="quick">QUICK JOIN</button>
      <button class="btn" data-act="create">CREATE GAME</button>
      <div class="lb-join"><input class="lb-code" maxlength="4" placeholder="ROOM CODE" autocomplete="off" spellcheck="false"/><button class="btn" data-act="code">JOIN</button></div>
      <p class="lb-stats"></p>
    </div>`

  const nameInput = el.querySelector<HTMLInputElement>(".lb-name")!
  const codeInput = el.querySelector<HTMLInputElement>(".lb-code")!
  const quickBtn = el.querySelector<HTMLElement>('[data-act="quick"]')!
  const statsEl = el.querySelector<HTMLElement>(".lb-stats")!
  if (!storedName) setTimeout(() => nameInput.focus(), 50)

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const loadStats = async () => {
    try {
      const res = await fetch(api("stats"), { cache: "no-store" })
      if (!res.ok) return
      const s = (await res.json()) as { players: number; games: number }
      statsEl.textContent = `${plural(s.players, "player", "players")} online · ${plural(s.games, "open game", "open games")}`
    } catch {}
  }
  void loadStats()
  const statsTimer = setInterval(loadStats, STATS_MS)

  codeInput.addEventListener("input", () => {
    const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)
    if (v !== codeInput.value) codeInput.value = v
  })

  return new Promise<LobbyResult>((resolve) => {
    let busy = false
    const finish = (room: string, via: NonNullable<LobbyResult["via"]>) => {
      clearInterval(statsTimer)
      const name = nameInput.value.trim().slice(0, 16) || "Driver"
      localStorage.setItem(NAME_KEY, name)
      setRoomParam(room)
      el.classList.add("out")
      setTimeout(() => el.remove(), 450)
      resolve({ mode: "room", room, name, picks: { ...PICKS }, via })
    }
    const ask = async (path: "quick" | "create", label: string) => {
      busy = true
      el.classList.add("busy")
      const btn = el.querySelector<HTMLElement>(`[data-act="${path}"]`)!
      btn.textContent = label
      btn.classList.add("going")
      finish(await askRoom(path), path)
    }
    el.addEventListener("click", (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act
      if (busy || !act) return
      if (act === "join" && urlRoom) finish(urlRoom, "code")
      else if (act === "quick") void ask("quick", "FINDING A GAME…")
      else if (act === "create") void ask("create", "CREATING…")
      else if (act === "code") {
        if (codeInput.value.length === 4) finish(codeInput.value, "code")
        else {
          codeInput.focus()
          codeInput.classList.remove("bad")
          void codeInput.offsetWidth
          codeInput.classList.add("bad")
        }
      }
    })
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return
      if (ev.target === codeInput) el.querySelector<HTMLElement>('[data-act="code"]')!.click()
      else if (ev.target === nameInput) (el.querySelector<HTMLElement>('[data-act="join"]') ?? quickBtn).click()
    })
  })
}
