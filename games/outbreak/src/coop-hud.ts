import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { SURVIVOR_COLOURS, type NetSession } from "./net-session"
import "./coop.css"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The invite link for a room: this page with only `?room=` (automation flags are not shared). */
export function inviteLink(room: string): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export type NameTag = { index: number; name: string; x: number; y: number; visible: boolean }

/**
 * Co-op menu and name tags. Offline it is a single "Host co-op" button that creates a room, copies its link and
 * joins it. In a room it lists the survivors with their seat colours and offers the invite link again.
 */
export class CoopHud {
  readonly root: HTMLElement
  private list: HTMLElement | null = null
  private note: HTMLElement | null = null
  private tags = new Map<number, HTMLElement>()
  private lastKey = ""

  constructor(private readonly net: NetSession | null, private readonly room: string | null) {
    this.root = document.createElement("div")
    this.root.id = "coop"
    document.body.append(this.root)
    if (!net || !room) {
      const host = document.createElement("button")
      host.type = "button"
      host.textContent = "Host co-op"
      host.title = "Create a room for up to 4 survivors and copy its invite link"
      host.addEventListener("click", async () => {
        const code = randomRoomCode(undefined, Math.random, 5)
        const link = inviteLink(code)
        await copy(link)
        sessionStorage.setItem("outbreak.coop.copied", code)
        location.assign(link)
      })
      this.root.append(host)
      return
    }
    this.root.dataset.room = room
    this.root.innerHTML = `<div class="head"><b>Co-op</b><span class="code">${esc(room)}</span><button type="button" data-copy>Copy invite link</button><a href="${esc(location.pathname)}" title="Leave the room and play offline">Leave</a></div><ul></ul><div class="note" role="status"></div>`
    this.list = this.root.querySelector("ul")
    this.note = this.root.querySelector(".note")
    const button = this.root.querySelector<HTMLButtonElement>("[data-copy]")!
    button.addEventListener("click", async () => {
      button.blur()
      button.textContent = (await copy(inviteLink(room))) ? "Link copied" : inviteLink(room)
      setTimeout(() => (button.textContent = "Copy invite link"), 2400)
    })
    if (sessionStorage.getItem("outbreak.coop.copied") === room) {
      sessionStorage.removeItem("outbreak.coop.copied")
      this.flash("Invite link copied. Send it to up to three friends.")
    }
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
      const colour = SURVIVOR_COLOURS[r.index % SURVIVOR_COLOURS.length]!.css
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

  /** Positions one name tag per remote survivor; hidden when outside your line of sight. */
  nameTags(tags: readonly NameTag[]): void {
    const seen = new Set<number>()
    for (const t of tags) {
      seen.add(t.index)
      let el = this.tags.get(t.index)
      if (!el) {
        el = document.createElement("div")
        el.className = "coop-tag"
        el.style.setProperty("--seat", SURVIVOR_COLOURS[t.index % SURVIVOR_COLOURS.length]!.css)
        document.body.append(el)
        this.tags.set(t.index, el)
      }
      if (el.textContent !== t.name) el.textContent = t.name
      el.hidden = !t.visible
      if (t.visible) el.style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -100%)`
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
    localStorage.setItem("outbreak.name", fromUrl)
    return fromUrl
  }
  const saved = localStorage.getItem("outbreak.name")
  if (saved) return saved
  const names = ["Ash", "Birch", "Cedar", "Elm", "Hazel", "Juniper", "Maple", "Rowan", "Sorrel", "Wren"]
  const name = names[Math.floor(Math.random() * names.length)]!
  localStorage.setItem("outbreak.name", name)
  return name
}
