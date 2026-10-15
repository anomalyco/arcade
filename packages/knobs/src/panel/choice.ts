import { tick } from "./haptics.js"
import { iconSvg } from "./icons.js"
import { openMenu, type Menu } from "./menu.js"
import { placeSegPill } from "./seg.js"
import { smearPill } from "./smear.js"
import { onPan, panOptions } from "./swipe.js"

export interface ChoiceItem {
  readonly value: string
  readonly label: string
}
/** `auto` is segmented while it fits and has at most `COMPACT_CHOICES` options; else a menu. */
export type ChoiceDisplay = "auto" | "menu" | "segmented"

/** More options than this always drop down a menu (unless `display: "segmented"`). */
export const COMPACT_CHOICES = 4
/** A menu of more options than this opens with a search field. */
export const SEARCH_CHOICES = 8
/** The least room (px) either side of a segment's label before the row turns into a menu. */
const MIN_PAD = 6
/** How much of a menu's value (em, beside its chrome) shows before the row's label gives way. */
const VALUE_FLOOR_EM = 4
/** Finger travel (px) per option when panning over the menu button. */
const MENU_PAN_STEP = 28

export interface ChoiceControl {
  /** The segmented control and the menu button; one is hidden at a time. */
  readonly seg: HTMLElement
  readonly buttons: readonly HTMLButtonElement[]
  readonly menu: HTMLButtonElement
  readonly menuValue: HTMLElement
  /** Whichever of the two is showing: the row's ↑↓ stop. */
  focusTarget(): HTMLElement
  isMenu(): boolean
  /**
   * Shows `value` (the pill under its segment and the menu's label); `mixed` shows none of them
   * (no pill, "—"), for a multi-selection whose items differ.
   */
  show(value: string, instant?: boolean, mixed?: boolean): void
  /** New labels for the same options. */
  relabel(items: readonly ChoiceItem[]): void
  /** Steps one option (←/→), stopping at the ends unless `wrap`. */
  step(direction: number, wrap: boolean): void
  dispose(): void
}

/**
 * One choice control for every segmented row (fields and custom cards): segments while their
 * labels fit with room to spare, a compact button that drops down a menu when they don't or when
 * there are many. It measures on resize, so it switches both ways as the width changes. ←/→ on
 * either steps through the options; Enter or Space opens the menu.
 */
export function createChoice(
  doc: Document,
  row: HTMLElement,
  o: {
    readonly label?: string
    readonly items: readonly ChoiceItem[]
    readonly display?: ChoiceDisplay
    /** The current value (the store's, or the card's own). */
    value(): string
    /** `coalesce`: a later change in the same pan, folded into its undo step. */
    choose(value: string, coalesce?: boolean): void
    wake?(): void
    /** The width (px) the segments may take; the row's, less its label, by default. */
    room?(): number
    /** What a resize is watched on, when not the row (the room depends on more than it). */
    observe?: HTMLElement
    /** Most options shown as segments under `auto`; `COMPACT_CHOICES` by default. */
    compact?: number
    /** Menu items show their 1-based number as a key equivalent. */
    numbered?: boolean
    /** The menu's label when no option matches the value. */
    none?: string
  },
): ChoiceControl {
  let items = o.items
  const display = o.display ?? "auto"
  const compact = o.compact ?? COMPACT_CHOICES
  const seg = doc.createElement("div")
  seg.className = "knobs-seg"
  const pill = doc.createElement("span")
  pill.className = "knobs-seg-pill"
  pill.setAttribute("aria-hidden", "true")
  smearPill(pill, 6)
  seg.append(pill)
  seg.tabIndex = 0
  seg.setAttribute("role", "radiogroup")
  if (o.label) seg.setAttribute("aria-label", o.label)
  const buttons = items.map((item) => {
    const b = doc.createElement("button")
    b.type = "button"
    b.tabIndex = -1
    b.dataset.value = item.value
    b.textContent = item.label
    b.setAttribute("role", "radio")
    b.onclick = () => {
      o.choose(item.value)
      seg.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    }
    seg.append(b)
    return b
  })
  const menu = doc.createElement("button")
  menu.type = "button"
  menu.className = "knobs-select"
  menu.setAttribute("aria-haspopup", "menu")
  menu.setAttribute("aria-expanded", "false")
  if (o.label) menu.setAttribute("aria-label", o.label)
  const menuValue = doc.createElement("span")
  menuValue.className = "knobs-select-value"
  menu.append(menuValue, iconSvg(doc, "caret"))
  row.append(seg, menu)

  const labelOf = (value: string) => items.find((i) => i.value === value)?.label ?? o.none ?? value
  let open: Menu | undefined
  const openMenuAt = (keyboard: boolean) => {
    const current = o.value()
    const r = menu.getBoundingClientRect()
    open?.close(false)
    menu.setAttribute("aria-expanded", "true")
    open = openMenu(
      doc,
      (row.closest(".knobs-panel") as HTMLElement | null) ?? row,
      items.map((item, i) => ({
        label: item.label,
        ...(o.numbered && i < 9 ? { shortcut: String(i + 1) } : {}),
        checked: item.value === current,
        run: () => o.choose(item.value),
      })),
      { x: r.left, y: r.bottom + 4 },
      {
        keyboard,
        returnTo: menu,
        active: items.findIndex((i) => i.value === current),
        minWidth: r.width,
        search: !o.numbered && items.length > SEARCH_CHOICES,
        onClose: () => {
          open = undefined
          menu.setAttribute("aria-expanded", "false")
          o.wake?.()
        },
      },
    )
    o.wake?.()
  }
  menu.onclick = (event) => openMenuAt(event.detail === 0)

  const step = (direction: number, wrap: boolean) => {
    const at = items.findIndex((i) => i.value === o.value())
    const next = wrap
      ? (at + direction + items.length) % items.length
      : Math.max(0, Math.min(items.length - 1, at + direction))
    const item = items[next]
    if (item && item.value !== o.value()) o.choose(item.value)
  }
  // A sideways pan drags the pill across the segments, or steps the menu's value, as one undo step.
  panOptions(seg, {
    box: seg,
    pill,
    buttons: () => buttons,
    selected: () => items.findIndex((i) => i.value === o.value()),
    select: (i, coalesce) => o.choose(items[i]!.value, coalesce),
    rest: () => placeSegPill(seg, buttons, o.value()),
    wake: () => o.wake?.(),
  })
  let travel = 0
  let panned = false
  onPan(menu, {
    move(dx) {
      travel += dx
      while (Math.abs(travel) >= MENU_PAN_STEP) {
        const d = Math.sign(travel)
        travel -= d * MENU_PAN_STEP
        const at = items.findIndex((i) => i.value === o.value())
        const item = items[Math.max(0, Math.min(items.length - 1, at + d))]
        if (item && item.value !== o.value()) {
          o.choose(item.value, panned)
          panned = true
          tick(menu)
        }
      }
    },
    end() {
      travel = 0
      panned = false
    },
    step: (d) => step(d, false),
  })

  // Segmented or menu: decided from the labels' natural widths against the room the row leaves.
  let canvas: CanvasRenderingContext2D | null | undefined
  const measure = (text: string, font: string) => {
    if (canvas === undefined) canvas = doc.createElement("canvas").getContext("2d")
    if (!canvas) return text.length * 7
    canvas.font = font
    return canvas.measureText(text).width
  }
  let asMenu = display === "menu" || (display === "auto" && items.length > compact)
  const apply = (next: boolean) => {
    const focused = doc.activeElement
    const had = focused === seg || seg.contains(focused) || focused === menu
    asMenu = next
    seg.hidden = next
    menu.hidden = !next
    row.dataset.display = next ? "menu" : "segmented"
    if (!next) placeSegPill(seg, buttons, o.value(), true)
    if (had) (next ? menu : seg).focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    o.wake?.()
  }
  /** The segments' natural width: every label with its padding, the gaps and the tray's own. */
  const segNeed = () => {
    const cs = getComputedStyle(buttons[0] ?? seg)
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const segCs = getComputedStyle(seg)
    const gap = parseFloat(segCs.columnGap) || 0
    const tray = (parseFloat(segCs.paddingLeft) || 0) + (parseFloat(segCs.paddingRight) || 0)
    return (
      items.reduce((sum, i) => sum + measure(i.label, font) + MIN_PAD * 2, 0) +
      gap * Math.max(0, items.length - 1) +
      tray
    )
  }
  const label = o.room ? null : row.querySelector<HTMLElement>(":scope > span:first-child")
  const watched = new WeakSet<Element>()
  /** The shares last set (--k-label-cap, --k-acc-over). */
  let shared = ""
  const range = doc.createRange()
  /** A node's text at its natural width, wherever its box cuts it. */
  const textWidth = (node: HTMLElement) => {
    range.selectNodeContents(node)
    return range.getBoundingClientRect().width
  }
  /**
   * The row's room, shared out (see .knobs-row[data-display]). The label keeps its words, and the
   * control gives way first: a menu's value truncates (its whole text shows on hover) down to a
   * few letters, and only then does the label, never below half the row. A row accessory (a
   * host's pin, often hidden at rest) takes room from the value too, never from the label: where
   * there's none left it lies over the label's end, which fades under it while the row is hovered
   * or focused. Returns whether segments fit beside the label.
   */
  const arrange = (): boolean => {
    const need = segNeed()
    if (o.room) return need <= o.room()
    if (!row.clientWidth) return !asMenu
    const rowCs = getComputedStyle(row)
    const inner =
      row.clientWidth - (parseFloat(rowCs.paddingLeft) || 0) - (parseFloat(rowCs.paddingRight) || 0)
    const gap = parseFloat(rowCs.columnGap) || 0
    const after = label && getComputedStyle(label, "::after")
    const labelW = label
      ? Math.ceil(
          textWidth(label) + (parseFloat(after!.width) || 0) + (parseFloat(after!.marginLeft) || 0),
        ) + 1
      : 0
    const capFor = (control: number) => Math.max(inner / 2, inner - gap - control)
    // The tray's own cap (.knobs-seg's max-width) counts too.
    const segCs = getComputedStyle(seg)
    const segCap = segCs.maxWidth.endsWith("%")
      ? (parseFloat(segCs.maxWidth) / 100) * inner
      : parseFloat(segCs.maxWidth) || Infinity
    const segFits = need <= Math.min(segCap, inner - gap - Math.min(labelW, capFor(need)))
    if (!label) return segFits
    let control = need
    if (asMenu) {
      const chrome = menu.offsetWidth - menuValue.clientWidth
      const floor =
        chrome + VALUE_FLOOR_EM * (parseFloat(getComputedStyle(menuValue).fontSize) || 12)
      control = Math.min(chrome + textWidth(menuValue), floor)
    }
    const cap = capFor(control)
    const kept = Math.min(labelW, cap)
    const acc = row.querySelector<HTMLElement>(":scope > .knobs-accessory")
    if (acc && !watched.has(acc)) {
      watched.add(acc)
      ro.observe(acc)
    }
    // The accessory sits 4px after the label (see .knobs-accessory), and the gap follows it.
    const extra = acc?.offsetWidth ? acc.offsetWidth + gap - 4 : 0
    const over = Math.max(0, Math.min(extra, extra - (inner - kept - gap - control)))
    const next = `${cap}px ${over}px`
    if (next !== shared) {
      shared = next
      row.style.setProperty("--k-label-cap", `${cap}px`)
      row.style.setProperty("--k-acc-over", `${over}px`)
      row.toggleAttribute("data-acc-over", over > 4)
      // The label and value moved inside an unchanged panel: the GPU measures them again.
      row.dispatchEvent(new Event("knobs-layout", { bubbles: true }))
    }
    return segFits
  }
  const check = () => {
    if (!row.isConnected || !(o.observe ?? row).clientWidth) return
    const fits = arrange()
    if (display === "auto" && items.length <= compact && fits === asMenu) {
      apply(!fits)
      arrange()
    } else if (!asMenu) placeSegPill(seg, buttons, o.value(), true)
  }
  const ro = new ResizeObserver(check)
  ro.observe(o.observe ?? row)
  if (label) ro.observe(label)
  // On the next frame, with the rest of a change's writes done: measuring now would force a
  // layout per row in the middle of them (a preset changing many values at once).
  let queued = 0
  const win = doc.defaultView
  const rearrange = () => {
    if (queued || !win) return
    queued = win.requestAnimationFrame(() => {
      queued = 0
      check()
    })
  }
  const pillRo = new ResizeObserver(() => {
    if (!asMenu) placeSegPill(seg, buttons, o.value(), true)
  })
  pillRo.observe(seg)
  apply(asMenu)

  return {
    seg,
    buttons,
    menu,
    menuValue,
    focusTarget: () => (asMenu ? menu : seg),
    isMenu: () => asMenu,
    show(value, instant = false, mixed = false) {
      placeSegPill(seg, buttons, mixed ? "\u0000mixed" : value, instant)
      const text = mixed ? "—" : labelOf(value)
      if (menuValue.textContent !== text) {
        menuValue.textContent = text
        // A longer or shorter value shares the row out again.
        if (asMenu) rearrange()
      }
      // The whole label on hover, where the button's room truncates it.
      if (menu.title !== text) menu.title = text
      menu.toggleAttribute("data-none", !mixed && !items.some((i) => i.value === value))
    },
    relabel(next) {
      items = next
      buttons.forEach((b, i) => {
        if (next[i]) b.textContent = next[i]!.label
      })
      menuValue.textContent = labelOf(o.value())
      rearrange()
      // New labels move the segments; the pill follows (showing the same value doesn't measure).
      if (!asMenu) placeSegPill(seg, buttons, o.value(), true)
    },
    step,
    dispose() {
      if (queued) win?.cancelAnimationFrame(queued)
      ro.disconnect()
      pillRo.disconnect()
      open?.close(false)
    },
  }
}
