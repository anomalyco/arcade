import type { Role } from "../../shared/config"
import { esc, h } from "./dom"

export type LobbyResult = { mode: "solo" | "room"; room: string | null; name: string; picks: Record<Role, string> }

const NAME_KEY = "getaway.name"
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
const PICKS: Record<Role, string> = { robber: "muscle", cop: "cruiser" }

function randomCode() {
  let s = ""
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return s
}

/** Title screen: name entry, solo play or create/join a room from the shared link. */
export async function lobby(root: HTMLElement): Promise<LobbyResult> {
  const urlRoom = new URLSearchParams(location.search).get("r")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || null
  const storedName = localStorage.getItem(NAME_KEY) ?? ""

  const el = h("div", "lobby", root)
  el.innerHTML = `
    <div class="lb-bg"><i class="streak s1"></i><i class="streak s2"></i><i class="streak s3"></i><div class="lb-siren"></div></div>
    <div class="lb-inner">
      <h1 class="wordmark">GETAWAY</h1>
      <p class="lb-tag">Stay free as long as you can.</p>
      <input class="lb-name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="YOUR NAME" value="${esc(storedName)}"/>
      ${
        urlRoom
          ? `<button class="btn primary" data-act="join">JOIN ROOM ${esc(urlRoom)}</button><button class="btn link" data-act="solo">play solo instead</button>`
          : `<button class="btn primary" data-act="solo">PLAY SOLO</button>
             <div class="lb-row"><button class="btn" data-act="create">CREATE ROOM</button><button class="btn" data-act="showjoin">JOIN ROOM</button></div>
             <div class="lb-join off"><input class="lb-code" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false"/><button class="btn" data-act="joincode">JOIN</button></div>`
      }
    </div>`

  const nameInput = el.querySelector<HTMLInputElement>(".lb-name")!
  if (!storedName) setTimeout(() => nameInput.focus(), 50)

  return new Promise<LobbyResult>((resolve) => {
    const finish = (mode: "solo" | "room", room: string | null) => {
      const name = nameInput.value.trim().slice(0, 16) || "Driver"
      localStorage.setItem(NAME_KEY, name)
      if (room) {
        const url = new URL(location.href)
        url.searchParams.set("r", room)
        history.pushState(null, "", url)
      }
      el.classList.add("out")
      setTimeout(() => el.remove(), 450)
      resolve({ mode, room, name, picks: { ...PICKS } })
    }
    el.addEventListener("click", (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act
      if (act === "solo") finish("solo", null)
      else if (act === "join" && urlRoom) finish("room", urlRoom)
      else if (act === "create") finish("room", randomCode())
      else if (act === "showjoin") {
        el.querySelector(".lb-join")!.classList.toggle("off")
        el.querySelector<HTMLInputElement>(".lb-code")!.focus()
      } else if (act === "joincode") {
        const code = el.querySelector<HTMLInputElement>(".lb-code")!.value.toUpperCase().replace(/[^A-Z0-9]/g, "")
        if (code.length >= 4) finish("room", code)
      }
    })
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return
      const t = ev.target as HTMLElement
      if (t.classList.contains("lb-code")) el.querySelector<HTMLElement>('[data-act="joincode"]')?.click()
      else if (t === nameInput) el.querySelector<HTMLElement>(".btn.primary")?.click()
    })
  })
}
