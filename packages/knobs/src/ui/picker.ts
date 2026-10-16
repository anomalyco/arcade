import { Spring, springMotion } from "../core/spring.js"
import {
  applyLook,
  frameLoop,
  notifyLayout,
  reducedMotion,
  svg,
  syncFrame,
  type UiLook,
} from "./look.js"
import { claimsDigit, digitPick, keepPick, pickDigit, stepPick } from "./picker-model.js"

export interface PickerOption {
  readonly id: string
  readonly label: string
  /** Marked "Suggested". */
  readonly suggested?: boolean
}

export interface OptionPickerOptions extends UiLook {
  readonly options: readonly PickerOption[]
  /** The option on show, its parameters open under it; the first unless set. */
  readonly selected?: string | null
  /** The option decided on: it takes a check. */
  readonly chosen?: string | null
  /** Keys, digits and clicks moved the selection (a host's `select()` doesn't call it). */
  readonly onSelect?: (id: string, source: "key" | "digit" | "pointer") => void
  /** Enter on an option. */
  readonly onChoose?: (id: string) => void
  /**
   * Mounts an option's parameters into `element` the first time it opens (a knobs panel, say);
   * return a cleanup for when the option goes or the picker is destroyed. It stays mounted
   * while closed, so a panel keeps its state.
   */
  readonly body?: (option: PickerOption, element: HTMLElement) => (() => void) | void
  /**
   * Where 1–9 pick from: `"focus"` (the default) while focus is in the picker, its panels
   * included, `"page"` from anywhere, or `false`. A focused row that picks its own options with
   * digits, and text fields, keep them.
   */
  readonly digits?: "focus" | "page" | false
  /** The accessible name. */
  readonly label?: string
  /** The suggested mark's words ("Suggested"). */
  readonly suggestedLabel?: string
}

export interface OptionPicker {
  readonly element: HTMLElement
  /** New options: the selection stays on its option while that's still there. */
  set(options: readonly PickerOption[]): void
  /** Opens this option's parameters (closing the last one's). Doesn't call `onSelect`. */
  select(id: string): void
  readonly selected: string | null
  /** Marks the chosen option (`null` for none). */
  choose(id: string | null): void
  readonly chosen: string | null
  /** Focuses the selected option. */
  focus(): void
  destroy(): void
  dispose(): void
}

const OPEN = springMotion({ duration: 0.22, bounce: 0 })
const CLOSE = springMotion({ duration: 0.18, bounce: 0 })
const CARD = springMotion({ duration: 0.3, bounce: 0 })
const FADE = springMotion({ duration: 0.16, bounce: 0 })
/** How far the parameters drift with the opening edge (px). */
const DRIFT = 6
const CHECK = svg('<path d="m3.5 8.4 3 3 6-6.6"/>')

interface Entry {
  option: PickerOption
  el: HTMLElement
  head: HTMLElement
  key: HTMLElement
  name: HTMLElement
  suggested: HTMLElement
  body: HTMLElement
  inner: HTMLElement
  mounted: boolean
  cleanup: (() => void) | undefined
  /** The body's height while it moves; null at rest (its own height, or hidden). */
  h: Spring
  /** 0…1: the content's fade. */
  o: Spring
  moving: boolean
  open: boolean
  /** Coming in (0 → 1) or going (→ 0) as options change. */
  presence: Spring
  leaving: boolean
}

const tune = (s: Spring, m: { omega: number; zeta: number }) => {
  s.omega = m.omega
  s.zeta = m.zeta
  return s
}

/**
 * A column of options (1–n), each with a name, a "Suggested" mark and a check on the chosen one.
 * The selected option sits on a card that glides between options, and its parameters (what
 * `body` mounts, a knobs panel's rows) open under it in place while the last option's close.
 * ↑/↓, Home/End and 1–9 pick; Enter chooses; Tab goes into the parameters.
 */
export function optionPicker(container: HTMLElement, options: OptionPickerOptions): OptionPicker {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  let list = options.options
  let selected: string | null = keepPick(
    list.map((o) => o.id),
    options.selected ?? null,
  )
  let chosen: string | null = options.chosen ?? null
  const digits = options.digits ?? "focus"

  const root = doc.createElement("div")
  root.className = "knobs-picker"
  root.setAttribute("role", "radiogroup")
  if (options.label) root.setAttribute("aria-label", options.label)
  applyLook(root, options)
  const card = doc.createElement("div")
  card.className = "knobs-picker-card"
  card.setAttribute("aria-hidden", "true")
  root.append(card)
  container.append(root)

  const entries = new Map<string, Entry>()
  const uid = `kp${Math.random().toString(36).slice(2, 7)}`
  let serial = 0

  const make = (option: PickerOption): Entry => {
    const el = doc.createElement("div")
    el.className = "knobs-picker-option"
    el.dataset.id = option.id
    const head = doc.createElement("button")
    head.type = "button"
    head.className = "knobs-picker-head"
    head.setAttribute("role", "radio")
    head.id = `${uid}-${serial++}`
    const key = doc.createElement("span")
    key.className = "knobs-picker-key"
    key.setAttribute("aria-hidden", "true")
    const name = doc.createElement("span")
    name.className = "knobs-picker-name knobs-scroll-fade-x"
    const suggested = doc.createElement("span")
    suggested.className = "knobs-picker-suggested"
    const check = doc.createElement("span")
    check.className = "knobs-picker-check"
    check.innerHTML = CHECK
    check.setAttribute("aria-hidden", "true")
    head.append(key, name, suggested, check)
    const body = doc.createElement("div")
    body.className = "knobs-picker-body"
    body.hidden = true
    body.setAttribute("role", "group")
    body.setAttribute("aria-labelledby", head.id)
    const inner = doc.createElement("div")
    inner.className = "knobs-picker-inner"
    body.append(inner)
    el.append(head, body)
    const entry: Entry = {
      option,
      el,
      head,
      key,
      name,
      suggested,
      body,
      inner,
      mounted: false,
      cleanup: undefined,
      h: new Spring(0, OPEN.omega, OPEN.zeta, 0.05),
      o: new Spring(0, OPEN.omega, OPEN.zeta, 0.002),
      moving: false,
      open: false,
      presence: new Spring(1, OPEN.omega, OPEN.zeta, 0.002),
      leaving: false,
    }
    entries.set(option.id, entry)
    return entry
  }

  const bind = (e: Entry, i: number) => {
    e.option = list[i]!
    e.key.textContent = pickDigit(i)
    if (e.name.textContent !== e.option.label) e.name.textContent = e.option.label
    e.suggested.textContent = e.option.suggested ? (options.suggestedLabel ?? "Suggested") : ""
    e.suggested.hidden = !e.option.suggested
    const on = e.option.id === selected
    e.el.toggleAttribute("data-selected", on)
    e.head.setAttribute("aria-checked", String(on))
    e.head.tabIndex = on ? 0 : -1
    e.el.toggleAttribute("data-chosen", e.option.id === chosen)
    e.head.setAttribute(
      "aria-label",
      [
        e.option.label,
        e.option.suggested ? (options.suggestedLabel ?? "Suggested") : "",
        e.option.id === chosen ? "chosen" : "",
      ]
        .filter(Boolean)
        .join(", "),
    )
  }

  const mount = (e: Entry) => {
    if (e.mounted || !options.body) return
    e.mounted = true
    const out = options.body(e.option, e.inner)
    if (typeof out === "function") e.cleanup = out
  }

  // The card: at rest it sits exactly on the selected option; after a change it glides there on
  // a spring, following the option's live height as the bodies open and close.
  const cardY = new Spring(0, CARD.omega, CARD.zeta, 0.05)
  const cardH = new Spring(0, CARD.omega, CARD.zeta, 0.05)
  let gliding = false
  const cardTarget = () => {
    const e = selected ? entries.get(selected) : undefined
    return e && !e.leaving ? { y: e.el.offsetTop, h: e.el.offsetHeight } : null
  }
  const placeCard = () => {
    card.style.transform = `translate3d(0,${Math.round(cardY.x * 2) / 2}px,0)`
    card.style.height = `${Math.max(0, cardH.x).toFixed(2)}px`
    card.hidden = cardH.x < 0.5
  }

  const natural = (e: Entry) => e.inner.offsetHeight

  /** Opens or closes an option's body: height on the reveal springs, its content fading. */
  const setOpen = (e: Entry, open: boolean, animate: boolean) => {
    if (e.open === open && (e.moving || e.body.hidden === !open)) return
    e.open = open
    const reduced = reducedMotion(win)
    if (open && !e.mounted) {
      // Mounted in the page at its width (a panel measures itself), shut until it opens.
      if (animate && e.body.hidden) {
        e.body.hidden = false
        e.body.style.height = "0px"
        e.body.dataset.moving = ""
        e.h.snap(0)
        e.o.snap(0)
        e.moving = true
      }
      mount(e)
    }
    if (!animate) {
      e.body.hidden = !open
      e.moving = false
      e.body.style.height = ""
      delete e.body.dataset.moving
      e.inner.style.opacity = ""
      e.inner.style.transform = ""
      return
    }
    if (!e.moving) {
      // From rest: from its own height when open, nothing when shut.
      const from = e.body.hidden ? 0 : e.body.offsetHeight
      e.h.snap(from)
      e.o.snap(e.body.hidden ? 0 : 1)
    }
    e.body.hidden = false
    e.moving = true
    e.body.dataset.moving = ""
    if (reduced) {
      // No travel: the height goes at once and the content fades.
      e.h.snap(open ? natural(e) : 0)
      tune(e.o, FADE).set(open ? 1 : 0)
    } else {
      tune(e.h, open ? OPEN : CLOSE).set(open ? natural(e) : 0)
      tune(e.o, open ? OPEN : CLOSE).set(open ? 1 : 0)
    }
    loop.wake()
  }

  const loop = frameLoop(win, (dt) => {
    let moving = false
    for (const e of [...entries.values()]) {
      if (e.moving) {
        // Opening follows the content's height as it comes (a panel that's still laying out).
        if (e.open && !reducedMotion(win)) e.h.set(natural(e))
        e.h.step(dt)
        e.o.step(dt)
        const fade = Math.max(0, Math.min(1, e.o.x))
        e.body.style.height = `${Math.max(0, e.h.x).toFixed(2)}px`
        // Closing, the content has faded out by 60% of the way, so nothing lingers cropped.
        const shown = e.open ? fade : Math.max(0, (fade - 0.4) / 0.6)
        e.inner.style.opacity = shown < 0.999 ? shown.toFixed(3) : ""
        const drift = reducedMotion(win) ? 0 : (1 - fade) * -DRIFT
        e.inner.style.transform = Math.abs(drift) > 0.05 ? `translateY(${drift.toFixed(2)}px)` : ""
        if (e.h.resting && e.o.resting) {
          e.moving = false
          delete e.body.dataset.moving
          e.body.style.height = ""
          e.inner.style.opacity = ""
          e.inner.style.transform = ""
          e.body.hidden = !e.open
        } else moving = true
      }
      if (e.leaving || !e.presence.resting) {
        e.presence.step(dt)
        const p = Math.max(0, Math.min(1, e.presence.x))
        e.el.style.opacity = p < 0.999 ? p.toFixed(3) : ""
        e.el.style.height = p < 0.999 ? `${(p * e.head.offsetHeight).toFixed(2)}px` : ""
        e.el.style.overflow = p < 0.999 ? "hidden" : ""
        if (e.presence.resting) {
          if (e.leaving) {
            e.cleanup?.()
            e.el.remove()
            entries.delete(e.option.id)
          }
        } else moving = true
      }
    }
    const t = cardTarget()
    if (t) {
      if (gliding) {
        cardY.set(t.y)
        cardH.set(t.h)
        cardY.step(dt)
        cardH.step(dt)
        if (cardY.resting && cardH.resting && !moving) gliding = false
        else moving = true
      } else {
        cardY.snap(t.y)
        cardH.snap(t.h)
      }
    }
    placeCard()
    notifyLayout(doc)
    return moving
  })

  /** Selects `id`: its body opens, the last one's closes, the card glides between them. */
  const pick = (id: string, animate = true) => {
    if (id === selected || !entries.has(id)) return
    const was = selected ? entries.get(selected) : undefined
    selected = id
    list.forEach((o, i) => {
      const e = entries.get(o.id)
      if (e) bind(e, i)
    })
    const now = entries.get(id)!
    const smooth = animate && !reducedMotion(win)
    if (was) setOpen(was, false, animate)
    setOpen(now, true, animate)
    if (smooth) {
      tune(cardY, CARD)
      tune(cardH, CARD)
      gliding = true
    }
    loop.wake()
  }

  const select = (id: string | undefined, source: "key" | "digit" | "pointer") => {
    if (!id || id === selected) return
    // Focus inside the picker (on an option, or in the parameters that are closing) moves to
    // the option picked.
    const inside = root.contains(doc.activeElement)
    pick(id)
    if (source !== "pointer" && inside) entries.get(id)?.head.focus({ preventScroll: true })
    options.onSelect?.(id, source)
  }

  /** Brings the entries in line with `list`, in order; new ones come in, gone ones go. */
  const sync = (animate: boolean) => {
    const ids = list.map((o) => o.id)
    const was = selected
    selected = keepPick(ids, selected)
    if (animate && was !== selected && !reducedMotion(win)) gliding = true
    const reduced = reducedMotion(win)
    const live = new Set(ids)
    for (const e of entries.values()) {
      if (live.has(e.option.id) || e.leaving) continue
      if (!animate) {
        e.cleanup?.()
        e.el.remove()
        entries.delete(e.option.id)
        continue
      }
      e.leaving = true
      e.el.setAttribute("aria-hidden", "true")
      e.head.tabIndex = -1
      if (e.open) setOpen(e, false, true)
      tune(e.presence, reduced ? FADE : CLOSE).set(0)
    }
    let before: Element = card
    list.forEach((o, i) => {
      let e = entries.get(o.id)
      if (e?.leaving) {
        e.leaving = false
        e.el.removeAttribute("aria-hidden")
        tune(e.presence, OPEN).set(1)
      }
      if (!e) {
        e = make(o)
        ro.observe(e.el)
        if (animate)
          tune(e.presence, reduced ? FADE : OPEN)
            .snap(0)
            .set(1)
      }
      if (before.nextElementSibling !== e.el) before.after(e.el)
      before = e.el
      bind(e, i)
    })
    // Leaving options stay where they were until they've gone.
    const open = selected ? entries.get(selected) : undefined
    for (const e of entries.values())
      if (e !== open && e.open && !e.leaving) setOpen(e, false, animate)
    if (open && !open.open) setOpen(open, true, animate)
    loop.wake()
  }

  // Keys: ↑/↓, Home/End on an option; Enter chooses; digits from the picker or the page.
  const typing = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (t.isContentEditable ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLInputElement &&
        !t.readOnly &&
        !["range", "checkbox", "radio", "button"].includes(t.type)))
  const ids = () => list.map((o) => o.id).filter((id) => !entries.get(id)?.leaving)
  const onDigit = (e: KeyboardEvent) => {
    if (!claimsDigit({ ...pickKeys(e), typing: typing(e.target) })) return
    if (!root.getClientRects().length) return
    const id = digitPick(ids(), e.key)
    if (!id) return
    e.preventDefault()
    select(id, "digit")
  }
  root.addEventListener("keydown", (e) => {
    const head = (e.target as Element).closest?.(".knobs-picker-head")
    if (head && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
        e.preventDefault()
        select(stepPick(ids(), selected, e.key), "key")
        return
      }
      if (e.key === "Enter" && selected) {
        e.preventDefault()
        options.onChoose?.(selected)
        return
      }
    }
    if (digits === "focus") onDigit(e)
  })
  if (digits === "page") win.addEventListener("keydown", onDigit)
  root.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>(".knobs-picker-head")
    const id = el?.closest<HTMLElement>(".knobs-picker-option")?.dataset.id
    if (!id || entries.get(id)?.leaving) return
    select(id, e.detail === 0 ? "key" : "pointer")
  })

  // The content's own changes (a panel folding a group) move the card with it, at once.
  const ro = new ResizeObserver(() => loop.wake())
  ro.observe(root)
  root.addEventListener("knobs-restyle", () => {
    syncFrame(root)
    loop.wake()
  })

  sync(false)
  const first = cardTarget()
  if (first) {
    cardY.snap(first.y)
    cardH.snap(first.h)
  }
  placeCard()
  loop.wake()

  const handle: OptionPicker = {
    element: root,
    set(next) {
      list = next
      sync(true)
    },
    select: (id) => pick(id),
    get selected() {
      return selected
    },
    choose(id) {
      chosen = id
      list.forEach((o, i) => {
        const e = entries.get(o.id)
        if (e) bind(e, i)
      })
    },
    get chosen() {
      return chosen
    },
    focus() {
      ;(selected ? entries.get(selected)?.head : undefined)?.focus({ preventScroll: true })
    },
    destroy() {
      loop.stop()
      ro.disconnect()
      if (digits === "page") win.removeEventListener("keydown", onDigit)
      for (const e of entries.values()) e.cleanup?.()
      entries.clear()
      root.remove()
    },
    dispose: () => handle.destroy(),
  }
  return handle
}

const pickKeys = (e: KeyboardEvent) => ({
  key: e.key,
  defaultPrevented: e.defaultPrevented,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  repeat: e.repeat,
})
