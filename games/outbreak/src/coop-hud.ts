import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { SURVIVOR_COLOURS, type NetSession } from "./net-session"
import "./coop.css"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Normalizes this page's directory pathname so invite links and WebSockets always use `<base>/` (never missing a trailing slash or keeping `/index.html`). */
export function coopBasePath(pathname = typeof location !== "undefined" ? location.pathname : "/arcade/outbreak/"): string {
  const withoutIndex = pathname.replace(/\/index\.html$/i, "/")
  return withoutIndex.endsWith("/") ? withoutIndex : `${withoutIndex}/`
}

/** The invite link for a room: public origin + normalized base path with only `?room=` (automation flags are not shared). */
export function inviteLink(
  room: string,
  loc: { origin?: string; pathname?: string } = typeof location !== "undefined" ? location : {},
): string {
  const origin = loc.origin && loc.origin !== "null" ? loc.origin : "https://anoma.ly"
  const path = coopBasePath(loc.pathname ?? "/arcade/outbreak/")
  return `${origin}${path}?room=${encodeURIComponent(room)}`
}

export async function copyInviteLink(room: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(inviteLink(room))
    return true
  } catch {
    return false
  }
}

export type NameTag = { index: number; variant?: number; name: string; x: number; y: number; visible: boolean }

/**
 * Co-op menu and name tags. Offline it offers a "Co-op · Loadout" button that opens the start/loadout screen.
 * In a room it lists the survivors with their chosen look colours and offers the invite link and lobby controls.
 */
export class CoopHud {
  readonly root: HTMLElement
  private list: HTMLElement | null = null
  private note: HTMLElement | null = null
  private tags = new Map<number, HTMLElement>()
  private lastKey = ""
  private net: NetSession | null = null
  private room: string | null = null
  private onOpenLobby?: () => void
  private onLeaveRoom?: () => void

  constructor(
    net: NetSession | null,
    room: string | null,
    callbacks?: { onOpenLobby?: () => void; onLeaveRoom?: () => void },
  ) {
    this.root = document.createElement("div")
    this.root.id = "coop"
    this.onOpenLobby = callbacks?.onOpenLobby
    this.onLeaveRoom = callbacks?.onLeaveRoom
    document.body.append(this.root)
    this.bind(net, room)
  }

  bind(net: NetSession | null, room: string | null): void {
    this.net = net
    this.room = room
    this.lastKey = ""
    this.root.replaceChildren()
    if (!net || !room) {
      delete this.root.dataset.room
      this.list = null
      this.note = null
      const host = document.createElement("button")
      host.type = "button"
      host.dataset.openLobby = "true"
      host.textContent = "Co-op · Loadout"
      host.title = "Choose your survivor, starting kit, or host a 1–4 survivor co-op room"
      host.addEventListener("click", () => {
        if (this.onOpenLobby) {
          this.onOpenLobby()
          return
        }
        const code = randomRoomCode(undefined, Math.random, 5)
        const link = inviteLink(code)
        location.assign(link)
      })
      this.root.append(host)
      return
    }
    this.root.dataset.room = room
    this.root.innerHTML = `<div class="head"><b>Co-op</b><span class="code">${esc(room)}</span><button type="button" data-copy>Copy invite link</button><a href="${esc(coopBasePath())}" data-leave title="Leave the room and play offline">Leave</a></div><ul></ul><div class="note" role="status"></div>`
    this.list = this.root.querySelector("ul")
    this.note = this.root.querySelector(".note")
    const button = this.root.querySelector<HTMLButtonElement>("[data-copy]")!
    button.addEventListener("click", async () => {
      button.blur()
      button.textContent = (await copyInviteLink(room)) ? "Link copied" : inviteLink(room)
      setTimeout(() => (button.textContent = "Copy invite link"), 2400)
    })
    const leave = this.root.querySelector<HTMLAnchorElement>("[data-leave]")!
    leave.addEventListener("click", (e) => {
      if (!this.onLeaveRoom) return
      e.preventDefault()
      this.onLeaveRoom()
    })
  }

  private flashUntil = 0
  private flashText = ""

  flash(text: string): void {
    this.flashText = text
    this.flashUntil = performance.now() + 5000
  }

  /** Refreshes the player list and status (cheap: rebuilds DOM only when something changed). */
  update(): void {
    const net = this.net
    if (!net || !this.list || !this.note) return
    const rows = net.roster.map((r) => {
      const variant = r.variant ?? r.index
      const colour = SURVIVOR_COLOURS[variant % SURVIVOR_COLOURS.length]!.css
      const you = r.id === net.id ? " (you)" : ""
      return `<li data-connected="${r.connected}"><i style="background:${colour}"></i>${esc(r.name)}${you}${r.connected ? "" : " · reconnecting"}</li>`
    })
    const status = net.status ?? (performance.now() < this.flashUntil ? this.flashText : net.connected ? `${Math.round(net.rtt * 1000)} ms` : "")
    const key = rows.join("") + "|" + status
    if (key === this.lastKey) return
    this.lastKey = key
    this.list.innerHTML = rows.join("")
    this.note.textContent = status
  }

  /** Positions one name tag per survivor; remote tags hide when outside your line of sight. */
  nameTags(tags: readonly NameTag[]): void {
    const seen = new Set<number>()
    for (const t of tags) {
      seen.add(t.index)
      let el = this.tags.get(t.index)
      const variantIdx = Math.max(0, t.variant ?? t.index) % SURVIVOR_COLOURS.length
      const colour = SURVIVOR_COLOURS[variantIdx]!.css
      if (!el) {
        el = document.createElement("div")
        el.className = "coop-tag"
        document.body.append(el)
        this.tags.set(t.index, el)
      }
      el.dataset.local = t.index < 0 ? "true" : "false"
      el.dataset.variant = String(variantIdx)
      el.style.setProperty("--seat", colour)
      if (el.textContent !== t.name) {
        el.textContent = t.name
        el.dataset.w = ""
      }
      el.hidden = !t.visible
      if (t.visible) {
        // Placed by its top-left corner on whole device pixels, so the name stays crisp.
        if (!el.dataset.w) {
          el.dataset.w = String(el.offsetWidth)
          el.dataset.h = String(el.offsetHeight)
        }
        const r = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
        const x = Math.round((t.x - Number(el.dataset.w) / 2) * r) / r
        const y = Math.round((t.y - Number(el.dataset.h)) * r) / r
        el.style.transform = `translate(${x}px, ${y}px)`
      }
    }
    for (const [index, el] of this.tags) {
      if (seen.has(index)) continue
      el.remove()
      this.tags.delete(index)
    }
  }
}

/** A short survivor name for this browser: `?name=`, then the last one used, then a seat-free default. */
export function playerName(params: URLSearchParams): string {
  const fromUrl = params.get("name")
  if (fromUrl) {
    savePlayerName(fromUrl)
    return fromUrl
  }
  try {
    const saved = localStorage.getItem("outbreak.name")
    if (saved) return saved
  } catch {}
  const names = ["Ash", "Birch", "Cedar", "Elm", "Hazel", "Juniper", "Maple", "Rowan", "Sorrel", "Wren"]
  const name = names[Math.floor(Math.random() * names.length)]!
  savePlayerName(name)
  return name
}

export function savePlayerName(name: string): void {
  try {
    localStorage.setItem("outbreak.name", name)
  } catch {}
}
