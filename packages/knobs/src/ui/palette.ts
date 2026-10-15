// commandPalette({ commands }): ⌘K opens a search over everything the workspace can do. Fuzzy
// matches light up in the labels; with no query it shows recent commands, then every section.
// ↑↓ move a highlight that glides, Enter runs, Esc closes. commandsFrom(controls) lists a
// store's actions, presets and fields as commands.
import { comboParts, matchesCombo } from "../core/keys.js"
import type { UiLook } from "./look.js"
import { focusReturn, layerElement, presence, pushLayer } from "./layer.js"
import { marks, rank } from "./overlay-model.js"
import { toast } from "./toast.js"

export interface Command {
  /** Stable across sessions (recents remember it); the label by default. */
  readonly id?: string
  readonly label: string
  /** The heading it sits under with no query, and its dimmed tag in results. */
  readonly section?: string
  /** A shortcut shown as key chips (the palette doesn't bind it). */
  readonly shortcut?: string
  /** Other words it answers to. */
  readonly keywords?: readonly string[]
  /** Text after the label, dimmed (a current value, say). */
  readonly hint?: string
  readonly disabled?: boolean
  /** What it does; a string or a promise of one shows as a toast. */
  run?(): unknown
}

export interface CommandPaletteOptions {
  /** The commands, or a function asked each time it opens. */
  readonly commands: readonly Command[] | (() => readonly Command[])
  /** Called after a command runs (or instead, for commands with no `run`). */
  onRun?(command: Command): void
  /** The key that toggles it, anywhere on the page (`"Mod+K"`); `false` for none. */
  readonly hotkey?: string | false
  readonly placeholder?: string
  /** Recent commands are remembered under this key in localStorage; `false` remembers nothing. */
  readonly recents?: string | false
  readonly look?: UiLook
  readonly doc?: Document
}

export interface CommandPalette {
  open(query?: string): void
  close(): void
  toggle(): void
  readonly isOpen: boolean
  dispose(): void
}

const idOf = (c: Command) => c.id ?? c.label
const MAX_RECENT = 5
const MAX_SHOWN = 200

export function commandPalette(options: CommandPaletteOptions): CommandPalette {
  const doc = options.doc ?? document
  const win = doc.defaultView!
  const hotkey = options.hotkey === undefined ? "Mod+K" : options.hotkey
  const storeKey = options.recents === false ? null : `knobs-palette:${options.recents ?? "recent"}`
  const readRecents = (): string[] => {
    if (!storeKey) return []
    try {
      const v = JSON.parse(win.localStorage.getItem(storeKey) ?? "[]")
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
    } catch {
      return []
    }
  }
  const remember = (id: string) => {
    if (!storeKey) return
    const next = [id, ...readRecents().filter((r) => r !== id)].slice(0, MAX_RECENT)
    try {
      win.localStorage.setItem(storeKey, JSON.stringify(next))
    } catch {}
  }

  let el: HTMLElement | null = null
  let pointer = { x: Number.NaN, y: Number.NaN }
  let state: {
    input: HTMLInputElement
    list: HTMLElement
    hl: HTMLElement
    items: { command: Command; row: HTMLElement }[]
    active: number
    commands: readonly Command[]
    motion: ReturnType<typeof presence>
    unstack: () => void
    giveBack: () => void
  } | null = null

  const render = () => {
    if (!state) return
    const { input, list, commands } = state
    const query = input.value.trim()
    list.parentElement?.toggleAttribute("data-query", query !== "")
    list
      .querySelectorAll(".knobs-palette-item,.knobs-palette-section,.knobs-palette-empty")
      .forEach((n) => n.remove())
    const items: { command: Command; row: HTMLElement }[] = []
    const row = (command: Command, indices: readonly number[], tag?: string) => {
      const r = doc.createElement("div")
      r.className = "knobs-palette-item"
      r.setAttribute("role", "option")
      r.id = `knobs-palette-${items.length}`
      if (command.disabled) r.setAttribute("aria-disabled", "true")
      const label = doc.createElement("span")
      label.className = "knobs-palette-label"
      for (const run of marks(command.label, indices)) {
        if (run.hit) {
          const m = doc.createElement("mark")
          m.textContent = run.text
          label.append(m)
        } else label.append(run.text)
      }
      r.append(label)
      if (command.hint) {
        const h = doc.createElement("span")
        h.className = "knobs-palette-hint"
        h.textContent = command.hint
        r.append(h)
      }
      const fill = doc.createElement("span")
      fill.className = "knobs-palette-fill"
      r.append(fill)
      if (tag) {
        const t = doc.createElement("span")
        t.className = "knobs-palette-tag"
        t.textContent = tag
        r.append(t)
      }
      if (command.shortcut) {
        const keys = doc.createElement("span")
        keys.className = "knobs-palette-keys"
        for (const k of comboParts(command.shortcut)) {
          const kbd = doc.createElement("kbd")
          kbd.className = "knobs-kbd"
          kbd.textContent = k
          keys.append(kbd)
        }
        r.append(keys)
      }
      const index = items.length
      // Only a pointer that really moves takes the highlight (not a list scrolling under it).
      r.addEventListener("pointermove", (e) => {
        if (e.clientX === pointer.x && e.clientY === pointer.y) return
        pointer = { x: e.clientX, y: e.clientY }
        if (state && state.active !== index) setActive(index, true)
      })
      r.addEventListener("click", () => runAt(index))
      list.append(r)
      items.push({ command, row: r })
    }
    const section = (name: string) => {
      const h = doc.createElement("div")
      h.className = "knobs-palette-section"
      h.setAttribute("role", "presentation")
      h.textContent = name
      list.append(h)
    }
    if (!query) {
      const byId = new Map(commands.map((c) => [idOf(c), c]))
      const recent = readRecents()
        .map((id) => byId.get(id))
        .filter((c): c is Command => !!c && !c.disabled)
      if (recent.length) {
        section("Recent")
        for (const c of recent) row(c, [], c.section)
      }
      const sections = new Map<string, Command[]>()
      for (const c of commands) {
        const s = c.section ?? ""
        let list = sections.get(s)
        if (!list) sections.set(s, (list = []))
        list.push(c)
      }
      for (const [name, cs] of sections) {
        if (name) section(name)
        for (const c of cs) row(c, [])
      }
    } else {
      const ranked = rank(commands, query).slice(0, MAX_SHOWN)
      for (const r of ranked) row(r.item, r.indices, r.item.section)
      if (!ranked.length) {
        const empty = doc.createElement("div")
        empty.className = "knobs-palette-empty"
        empty.textContent = "No matching commands"
        list.append(empty)
      }
    }
    state.items = items
    const first = items.findIndex((i) => !i.command.disabled)
    setActive(first, false)
  }

  const setActive = (index: number, glide: boolean) => {
    if (!state) return
    const { items, hl, list, input } = state
    state.active = index
    items.forEach((it, i) => it.row.toggleAttribute("data-active", i === index))
    const it = items[index]
    if (!it) {
      hl.style.opacity = "0"
      input.removeAttribute("aria-activedescendant")
      return
    }
    input.setAttribute("aria-activedescendant", it.row.id)
    const top = it.row.offsetTop
    const h = it.row.offsetHeight
    hl.style.transition = glide ? "" : "none"
    hl.style.opacity = "1"
    hl.style.transform = `translateY(${top}px)`
    hl.style.height = `${h}px`
    if (!glide) void hl.offsetWidth
    hl.style.transition = ""
    // Keep it in view, a row's margin from the edges.
    const pad = 4
    if (top - pad < list.scrollTop) list.scrollTop = Math.max(0, top - pad)
    else if (top + h + pad > list.scrollTop + list.clientHeight)
      list.scrollTop = top + h + pad - list.clientHeight
  }

  const move = (by: number) => {
    if (!state || !state.items.length) return
    const n = state.items.length
    let i = state.active
    for (let k = 0; k < n; k++) {
      i = by === Infinity ? n - 1 - k : by === -Infinity ? k : (i + Math.sign(by) + n) % n
      if (!state.items[i]!.command.disabled) break
    }
    setActive(i, true)
  }

  const runAt = (index: number) => {
    const it = state?.items[index]
    if (!it || it.command.disabled) return
    const command = it.command
    remember(idOf(command))
    close()
    const say = (v: unknown) => {
      if (typeof v === "string" && v)
        toast(v, { doc, ...(options.look ? { look: options.look } : {}) })
    }
    try {
      const result = command.run?.()
      if (result instanceof Promise)
        result.then(say, (e) =>
          toast(e instanceof Error ? e.message : String(e), { doc, tone: "error" }),
        )
      else say(result)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { doc, tone: "error" })
    }
    options.onRun?.(command)
  }

  const open = (query = "") => {
    if (state) {
      state.input.value = query
      render()
      state.input.focus()
      return
    }
    el = layerElement(doc, "knobs-layer knobs-palette", options.look)
    el.setAttribute("role", "dialog")
    el.setAttribute("aria-label", "Commands")
    const field = doc.createElement("div")
    field.className = "knobs-palette-field"
    field.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>'
    const input = doc.createElement("input")
    input.className = "knobs-palette-input"
    input.type = "text"
    input.spellcheck = false
    input.autocomplete = "off"
    input.placeholder = options.placeholder ?? "Search commands"
    input.setAttribute("role", "combobox")
    input.setAttribute("aria-expanded", "true")
    input.setAttribute("aria-autocomplete", "list")
    input.value = query
    field.append(input)
    const list = doc.createElement("div")
    list.className = "knobs-palette-list"
    list.setAttribute("role", "listbox")
    list.id = `knobs-palette-list-${Math.random().toString(36).slice(2, 8)}`
    input.setAttribute("aria-controls", list.id)
    const hl = doc.createElement("div")
    hl.className = "knobs-palette-hl"
    hl.setAttribute("aria-hidden", "true")
    list.append(hl)
    el.append(field, list)
    const layer = el
    const giveBack = focusReturn(doc, layer)
    const commands = typeof options.commands === "function" ? options.commands() : options.commands
    const motion = presence(layer, { scale: 0.96, blur: 8, dy: -8, duration: 0.34 })
    state = {
      input,
      list,
      hl,
      items: [],
      active: -1,
      commands,
      motion,
      giveBack,
      unstack: pushLayer(doc, { el: layer, dismiss: () => close() }),
    }
    render()
    input.addEventListener("input", render)
    input.addEventListener("keydown", (e) => {
      const keys: Record<string, number> = {
        ArrowDown: 1,
        ArrowUp: -1,
        PageDown: 8,
        PageUp: -8,
      }
      if (e.key in keys && !e.metaKey && !e.altKey) {
        e.preventDefault()
        const by = keys[e.key]!
        if (Math.abs(by) > 1) for (let i = 0; i < Math.abs(by); i++) move(Math.sign(by))
        else move(by)
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.metaKey) {
        e.preventDefault()
        move(e.key === "ArrowDown" ? Infinity : -Infinity)
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault()
        if (state) runAt(state.active)
      }
    })
    motion.show()
    input.focus({ preventScroll: true })
    input.select()
  }

  const close = () => {
    if (!state || !el) return
    const s = state
    const layer = el
    state = null
    el = null
    s.unstack()
    s.giveBack()
    void s.motion.hide().then(() => layer.remove())
  }

  const onKey = (e: KeyboardEvent) => {
    if (!hotkey || !matchesCombo(hotkey, e)) return
    e.preventDefault()
    e.stopPropagation()
    if (state) close()
    else open()
  }
  doc.addEventListener("keydown", onKey, true)

  return {
    open,
    close,
    toggle: () => (state ? close() : open()),
    get isOpen() {
      return state !== null
    },
    dispose() {
      doc.removeEventListener("keydown", onKey, true)
      close()
    },
  }
}
