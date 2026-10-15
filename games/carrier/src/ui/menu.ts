import { keyCapHtml } from "@arcade/kit/client/key-cap"
import "./menu.css"
import { CREW, roomCode } from "../../shared/crew"
import { type LobbyClient, type Start, lobbyClient, rememberName, setRoomParam, storedName } from "./lobby"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STATS_MS = 10_000

/**
 * The load screen, over the live sea: a callsign (required, never made up), then QUICK JOIN (the fullest open room), CREATE GAME (a fresh private
 * room to share), or JOIN GAME by code. Resolves once a room is chosen and puts it in the address bar. `body.mn-open`
 * is set while it shows, so the HUD can stay out of the way.
 */
export function showMenu(root: HTMLElement, opts: { notice?: string; lobby?: LobbyClient } = {}): Promise<Extract<Start, { mode: "room" }>> {
  const lobby = opts.lobby ?? lobbyClient
  const name = storedName()
  const el = document.createElement("div")
  el.className = "mn"
  el.innerHTML = `<div class="mn-col">
    <h1 class="mn-logo">CARRIER</h1>
    ${opts.notice ? `<p class="mn-note">${esc(opts.notice)}</p>` : ""}
    <label class="mn-field"><span>CALLSIGN</span><input class="mn-name" maxlength="${CREW.nameMax}" autocomplete="off" spellcheck="false" placeholder="TYPE A CALLSIGN" value="${esc(name)}" /></label>
    <button class="mn-btn primary" data-act="quick">QUICK JOIN</button>
    <button class="mn-btn" data-act="create">CREATE GAME</button>
    <div class="mn-join"><input class="mn-code" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="ROOM CODE" /><button class="mn-btn" data-act="code">JOIN GAME</button></div>
    <p class="mn-stats"></p>
  </div>
  <div class="mn-foot">${keyCapHtml("Tab")} TEAMS &nbsp;·&nbsp; ${keyCapHtml("KeyE")} SHIP OPERATIONS</div>`
  root.append(el)
  document.body.classList.add("mn-open")

  const nameInput = el.querySelector<HTMLInputElement>(".mn-name")!
  const codeInput = el.querySelector<HTMLInputElement>(".mn-code")!
  const statsEl = el.querySelector<HTMLElement>(".mn-stats")!
  // An invite link for someone without a callsign lands here with the room filled in.
  const linked = roomCode(new URLSearchParams(location.search).get("room"))
  if (linked) codeInput.value = linked.toUpperCase()
  if (!name) setTimeout(() => nameInput.focus(), 50)
  nameInput.addEventListener("input", () => nameInput.classList.remove("bad"))

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "S"}`
  const loadStats = async () => {
    const s = await lobby.stats()
    statsEl.textContent = s && s.players ? `${plural(s.players, "SAILOR")} AT SEA · ${plural(s.games, "OPEN GAME")}` : ""
  }
  void loadStats()
  const statsTimer = setInterval(loadStats, STATS_MS)

  codeInput.addEventListener("input", () => {
    const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
    if (v !== codeInput.value) codeInput.value = v
    codeInput.classList.remove("bad")
  })

  const shake = (input: HTMLInputElement, placeholder?: string) => {
    if (placeholder) input.placeholder = placeholder
    input.focus()
    input.classList.remove("bad")
    void input.offsetWidth
    input.classList.add("bad")
  }

  return new Promise((resolve) => {
    let busy = false
    const finish = (room: string, via: "quick" | "create" | "code") => {
      clearInterval(statsTimer)
      const n = rememberName(nameInput.value.trim())
      setRoomParam(room)
      el.classList.add("out")
      document.body.classList.remove("mn-open")
      setTimeout(() => el.remove(), 450)
      resolve({ mode: "room", room, name: n, via, private: via === "create" })
    }
    const going = (act: string, label: string) => {
      busy = true
      el.classList.add("busy")
      const btn = el.querySelector<HTMLElement>(`[data-act="${act}"]`)!
      btn.textContent = label
      btn.classList.add("going")
    }
    const idle = (act: string, label: string) => {
      busy = false
      el.classList.remove("busy")
      const btn = el.querySelector<HTMLElement>(`[data-act="${act}"]`)!
      btn.textContent = label
      btn.classList.remove("going")
    }
    const act = async (a: string) => {
      if (busy) return
      if (!nameInput.value.trim()) return shake(nameInput, "TYPE A CALLSIGN")
      if (a === "quick") {
        going(a, "FINDING A GAME…")
        finish(await lobby.quick(), "quick")
      } else if (a === "create") {
        going(a, "COMMISSIONING…")
        finish(await lobby.create(), "create")
      } else if (a === "code") {
        const code = roomCode(codeInput.value)
        if (!code) return shake(codeInput)
        going(a, "BOARDING…")
        const info = await lobby.info(code)
        if (info?.full) {
          idle(a, "JOIN GAME")
          return shake(codeInput, "ROOM FULL")
        }
        finish(code, "code")
      }
    }
    el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act
      if (a) void act(a)
    })
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      if (e.target === codeInput) void act("code")
      else if (e.target === nameInput) void act(codeInput.value ? "code" : "quick")
    })
  })
}
