import { CHAT_MAX, type ChatMsg } from "../../shared/protocol"
import { audio } from "../audio/audio"
import type { Controls } from "../game/input"
import type { Session } from "../game/session"
import { h } from "./dom"

const MAX_LINES = 6
const FADE_MS = 10_000

/** Room chat above the minimap. ENTER or T opens the input; ENTER sends, ESC closes. The car idles while typing. */
export class Chat {
  private el: HTMLElement
  private log: HTMLElement
  private input: HTMLInputElement

  constructor(
    root: HTMLElement,
    private controls: Controls,
    private session: Session,
  ) {
    this.el = h("div", "h-chat", root)
    this.log = h("div", "c-log", this.el)
    this.input = h("input", "c-input off", this.el)
    this.input.maxLength = CHAT_MAX
    this.input.placeholder = "Say something…"
    this.input.autocomplete = "off"
    this.input.spellcheck = false
    addEventListener("keydown", (e) => {
      if (this.isOpen() || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code !== "Enter" && e.code !== "NumpadEnter" && e.code !== "KeyT") return
      e.preventDefault()
      this.open()
    })
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault()
        const text = this.input.value.trim()
        if (text) this.session.chat?.(text)
        this.close()
      } else if (e.code === "Escape") {
        e.preventDefault()
        this.close()
      }
    })
    this.input.addEventListener("blur", () => this.close())
  }

  private isOpen() {
    return !this.input.classList.contains("off")
  }

  private open() {
    this.controls.release()
    this.controls.paused = true
    this.el.classList.add("open")
    this.input.classList.remove("off")
    this.input.focus()
  }

  private close() {
    if (!this.isOpen()) return
    this.controls.paused = false
    this.el.classList.remove("open")
    this.input.classList.add("off")
    this.input.value = ""
    this.input.blur()
  }

  /** Call once per frame: adds lines received since the last frame. */
  update() {
    for (const m of this.session.drainChat?.() ?? []) this.add(m)
  }

  private add(m: ChatMsg) {
    const line = h("div", `c-line ${m.role}`, this.log)
    const name = h("span", "c-name", line)
    name.textContent = m.name
    const body = h("span", "c-text", line)
    body.textContent = m.role === "system" ? ` ${m.text}` : m.text
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild!.remove()
    setTimeout(() => line.classList.add("old"), FADE_MS)
    if (m.role !== "system" && m.from !== this.session.myId) audio.play("ui_click", { bus: "sting", gain: 0.4 })
  }
}
