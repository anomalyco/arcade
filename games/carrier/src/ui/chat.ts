import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { CHAT, type ChatChannel, type ChatLine } from "../../shared/chat"
import { type Crew, playerOf, teamCss } from "../../shared/crew"
import { chatInputKey, chatOpenKey } from "./chat-keys"

/** A line fades this long after it arrived; opening the input shows every kept line again. */
export const CHAT_FADE_MS = 10_000
/** Lines kept in the feed. */
const KEEP = 8

const CSS = `
#ct { position: fixed; left: 22px; top: 58px; z-index: 12; width: min(460px, 42vw); display: grid; gap: 4px; pointer-events: none;
  font-weight: 300; font-size: 13px; letter-spacing: 0.06em; zoom: var(--hud, 1); }
body.mn-open #ct { display: none; }
#ct .log { display: grid; gap: 4px; justify-items: start; }
#ct .ln { max-width: 100%; padding: 3px 9px; overflow-wrap: anywhere; background: rgba(6, 16, 30, 0.5); transition: opacity 0.6s;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.35); }
#ct .ln.old { opacity: 0; }
#ct.open .ln.old { opacity: 0.85; transition: none; }
#ct .ln b { font-weight: 300; text-transform: uppercase; letter-spacing: 0.16em; color: var(--team, var(--ink)); margin-right: 0.7em; }
#ct .ln i { font-style: normal; letter-spacing: 0.2em; opacity: 0.7; margin-right: 0.6em; }
#ct .ln.sys { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; opacity: 0.8; background: none; padding: 1px 9px; }
#ct .ln.sys.old { opacity: 0; }
#ct.open .ln.sys.old { opacity: 0.7; }
#ct .ln.note { color: #ffd34a; }
#ct .bar { display: flex; align-items: center; gap: 0.7em; padding: 4px 9px; background: rgba(6, 16, 30, 0.72);
  box-shadow: 0 0 0 1px rgba(244, 247, 251, 0.12) inset; pointer-events: auto; }
#ct .bar[hidden] { display: none; }
#ct .ch { font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--team, var(--ink)); white-space: nowrap; }
#ct input { flex: 1; min-width: 0; border: 0; outline: 0; padding: 2px 0; background: none; color: var(--ink); font: inherit; letter-spacing: inherit;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7); caret-color: var(--ink); }
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
    this.log = document.createElement("div")
    this.log.className = "log"
    this.bar = document.createElement("label")
    this.bar.className = "bar"
    this.bar.hidden = true
    this.ch = document.createElement("span")
    this.ch.className = "ch"
    this.input = document.createElement("input")
    this.input.maxLength = CHAT.max * 2
    this.input.autocomplete = "off"
    this.input.spellcheck = false
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
    this.ch.style.setProperty("--team", channel === "crew" ? teamCss(this.team < 0 ? undefined : this.team) : "")
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
    const el = this.add("ln")
    if (l.channel === "crew") {
      const tag = document.createElement("i")
      tag.textContent = "[CREW]"
      el.append(tag)
    }
    const name = document.createElement("b")
    name.textContent = l.name
    name.style.setProperty("--team", teamCss(l.team))
    el.append(name, document.createTextNode(l.text))
  }

  /** A quiet line (joins, leaves, refusals). */
  private note(text: string, cls = "note"): void {
    this.add(`ln sys ${cls}`).textContent = text
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
