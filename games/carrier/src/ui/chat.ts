import "@arcade/kit/client/chat.css"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { CHAT, type ChatChannel, type ChatLine } from "../../shared/chat"
import { type Crew, playerOf, teamCss } from "../../shared/crew"
import { chatInputKey, chatOpenKey } from "./chat-keys"

/** A line fades this long after it arrived; opening the input shows every kept line again. */
export const CHAT_FADE_MS = 10_000
/** Lines kept in the feed. */
const KEEP = 8

/** Getaway's chat look (@arcade/kit/client/chat.css); carrier only places it and adds the channel tag. */
const CSS = `
#ct { position: fixed; left: 22px; top: 58px; z-index: 12; width: min(380px, 40vw); pointer-events: none; zoom: var(--hud, 1); }
body.mn-open #ct { display: none; }
#ct .achat-input { display: flex; align-items: center; }
#ct .achat-input[hidden] { display: none; }
#ct .achat-tag { margin-right: 6px; font-size: 13px; letter-spacing: 0.08em; color: var(--achat-accent); opacity: 0.8; }
#ct .achat-line.note { color: #ffd34a; }
`

/**
 * Text chat, top left under the brand. T opens the input to everyone, Y to my carrier's crew (Tab inside switches);
 * Enter sends (an empty line just closes), Esc or a click elsewhere cancels. While it is open the input owns the
 * keyboard: its keys never reach the game's handlers (all on `window`), and `onToggle` lets main.ts pause the game,
 * free the cursor and close the other menus; the lock comes back with them closed. Lines show the sender in their
 * carrier's colour (CREW lines tagged), fade after CHAT_FADE_MS and all come back while the input is open. Text goes
 * in with textContent only.
 */
export class Chat {
  private el: HTMLElement
  private log: HTMLElement
  private bar: HTMLElement
  private ch: HTMLElement
  private input: HTMLInputElement
  private channel: ChatChannel = "all"
  private team = -1
  /** Who was in the room at the last crew, for the quiet join/leave lines (null: no baseline yet). */
  private roster: Map<number, string> | null = null
  private rosterNet: unknown = null
  private rosterCrew: Crew | null = null
  /** Whether a key may open it (main.ts: not under the load screen). */
  enabled = true
  /** Called on open and close (main.ts pauses the game and frees the cursor). */
  onToggle: ((open: boolean) => void) | null = null
  /** Sends a line; false: over the rate limit. */
  send: ((text: string, channel: ChatChannel) => boolean) | null = null

  constructor(parent: HTMLElement) {
    if (!document.getElementById("ct-css")) {
      const style = document.createElement("style")
      style.id = "ct-css"
      style.textContent = CSS
      document.head.append(style)
    }
    this.el = document.createElement("div")
    this.el.id = "ct"
    this.el.className = "achat"
    this.log = document.createElement("div")
    this.log.className = "achat-log"
    this.bar = document.createElement("label")
    this.bar.className = "achat-input"
    this.bar.hidden = true
    this.ch = document.createElement("span")
    this.ch.className = "achat-channel"
    this.input = document.createElement("input")
    this.input.maxLength = CHAT.max * 2
    this.input.autocomplete = "off"
    this.input.spellcheck = false
    this.input.className = "achat-field"
    this.input.placeholder = "Say something…"
    this.input.setAttribute("aria-label", "Chat message")
    this.bar.append(this.ch, this.input)
    this.el.append(this.log, this.bar)
    parent.append(this.el)

    addEventListener("keydown", (e) => {
      if (this.open || !this.enabled || isEditableEventTarget(e.target)) return
      const channel = chatOpenKey(e)
      if (!channel) return
      // Not typed into the input that takes focus now.
      e.preventDefault()
      this.show(channel)
    })
    this.input.addEventListener("keydown", (e) => {
      // Every key stays here: nothing on `window` (flight, helm, guns, boat, menus, mute, debug) sees it.
      e.stopPropagation()
      const act = chatInputKey(e.code)
      if (act === "type") return
      e.preventDefault()
      if (act === "channel") return this.setChannel(this.channel === "all" ? "crew" : "all")
      if (act === "send" && this.input.value.trim() && this.send && !this.send(this.input.value, this.channel)) {
        this.note("TOO FAST")
        return
      }
      this.hide()
    })
    this.input.addEventListener("keyup", (e) => e.stopPropagation())
    this.input.addEventListener("blur", () => this.hide())
  }

  get open(): boolean {
    return !this.bar.hidden
  }

  /** Opens the input on `channel`. */
  show(channel: ChatChannel): void {
    if (this.open) return
    this.setChannel(channel)
    this.bar.hidden = false
    this.el.classList.add("open")
    this.input.value = ""
    this.input.focus({ preventScroll: true })
    this.onToggle?.(true)
  }

  /** Closes the input, dropping anything unsent. */
  hide(): void {
    if (!this.open) return
    this.bar.hidden = true
    this.el.classList.remove("open")
    this.input.value = ""
    if (document.activeElement === this.input) this.input.blur()
    this.onToggle?.(false)
  }

  private setChannel(channel: ChatChannel): void {
    this.channel = channel
    this.ch.textContent = channel === "crew" ? "CREW" : "ALL"
    this.bar.style.setProperty("--achat-accent", channel === "crew" ? teamCss(this.team < 0 ? undefined : this.team) : "")
  }

  /** Per frame: new lines from the room, join/leave lines from the crew, my team's colour for the CREW label. */
  update(lines: ChatLine[], crew: Crew | null, me: number, net: unknown): void {
    for (const l of lines.splice(0)) this.line(l)
    const team = crew ? (playerOf(crew, me)?.team ?? -1) : -1
    if (team !== this.team) {
      this.team = team
      this.setChannel(this.channel)
    }
    this.roll(crew, me, net)
  }

  private line(l: ChatLine): void {
    const el = this.add("achat-line")
    el.style.setProperty("--achat-accent", teamCss(l.team))
    if (l.channel === "crew") {
      const tag = document.createElement("span")
      tag.className = "achat-tag"
      tag.textContent = "[CREW]"
      el.append(tag)
    }
    const name = document.createElement("span")
    name.className = "achat-name"
    name.textContent = l.name
    el.append(name, document.createTextNode(l.text))
  }

  /** A quiet line (joins, leaves, refusals). */
  private note(text: string, cls = "note"): void {
    this.add(`achat-line system ${cls}`).textContent = text
  }

  private add(cls: string): HTMLElement {
    const el = document.createElement("div")
    el.className = cls
    this.log.append(el)
    while (this.log.children.length > KEEP) this.log.firstElementChild!.remove()
    setTimeout(() => el.classList.add("old"), CHAT_FADE_MS)
    return el
  }

  /** Joins and leaves since the last crew (none for the first crew of a connection, or for me). */
  private roll(crew: Crew | null, me: number, net: unknown): void {
    if (net !== this.rosterNet) {
      this.rosterNet = net
      this.roster = null
    }
    if (!crew || crew === this.rosterCrew) return
    this.rosterCrew = crew
    const now = new Map(crew.players.map((p) => [p.id, p.name]))
    const was = this.roster
    this.roster = now
    if (!was) return
    for (const [id, name] of now) if (!was.has(id) && id !== me) this.note(`${name} joined`, "")
    for (const [id, name] of was) if (!now.has(id) && id !== me) this.note(`${name} left`, "")
  }
}
