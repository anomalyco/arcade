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
  const fits = () => {
    const cs = getComputedStyle(buttons[0] ?? seg)
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const segCs = getComputedStyle(seg)
    const gap = parseFloat(segCs.columnGap) || 0
    const tray = (parseFloat(segCs.paddingLeft) || 0) + (parseFloat(segCs.paddingRight) || 0)
    const need =
      items.reduce((sum, i) => sum + measure(i.label, font) + MIN_PAD * 2, 0) +
      gap * Math.max(0, items.length - 1) +
      tray
    if (o.room) return need <= o.room()
    const rowCs = getComputedStyle(row)
    const label = row.querySelector<HTMLElement>(":scope > span:first-child")
    const labelW = label
      ? measure(
          label.textContent ?? "",
          `${getComputedStyle(label).fontWeight} ${rowCs.fontSize} ${rowCs.fontFamily}`,
        ) +
        (parseFloat(rowCs.columnGap) || 0) +
        10
      : 0
    const inner =
      row.clientWidth - (parseFloat(rowCs.paddingLeft) || 0) - (parseFloat(rowCs.paddingRight) || 0)
    // The tray's own cap (.knobs-seg's max-width) counts too.
    const cap = segCs.maxWidth.endsWith("%")
      ? (parseFloat(segCs.maxWidth) / 100) * inner
      : parseFloat(segCs.maxWidth) || Infinity
    return need <= Math.min(inner - labelW, cap)
  }
  const ro =
    display === "auto" && items.length <= compact
      ? new ResizeObserver(() => {
          if (!row.isConnected || !(o.observe ?? row).clientWidth) return
          const next = !fits()
          if (next !== asMenu) apply(next)
          else if (!next) placeSegPill(seg, buttons, o.value(), true)
        })
      : undefined
  ro?.observe(o.observe ?? row)
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
      if (menuValue.textContent !== text) menuValue.textContent = text
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
      // New labels move the segments; the pill follows (showing the same value doesn't measure).
      if (!asMenu) placeSegPill(seg, buttons, o.value(), true)
    },
    step,
    dispose() {
      ro?.disconnect()
      pillRo.disconnect()
      open?.close(false)
    },
  }
}
