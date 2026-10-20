/**
 * The bottom dock: the belt of supplies, the five hand slots and the pack. It never disappears. It dims after a few
 * idle seconds and brightens when something in it changes, while the pack or field craft is open, and while the
 * cursor is over it. Every element is keyed and updated in place, so counts roll, new supplies slide in beside the
 * others, and the pack grows out of its chip as one shape (knobs' morph.ts) instead of swapping in.
 */
import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { keyLabel } from "@arcade/kit/client/controls"
import { FIRE_ITEMS } from "../../shared/fire/fire"
import { BELT_ITEMS, HOTBAR_SIZE, PACK_SIZE } from "../../shared/progression"
import type { SessionView } from "../../shared/session"
import { itemIcon } from "../discovery/icons"
import { flip, hudMotion, RollingNumber, snapToPixels, type HudMotion } from "./motion"

/** Hotbar items drawn with their pencil glyph beside the label (fire & explosives, AR-62). */
const GLYPH_SLOTS: ReadonlySet<string> = new Set(FIRE_ITEMS)

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type DockSettings = {
  /** Opacity of the dock once idle (Lab › HUD › Idle dock opacity). */
  dockIdleOpacity: number
  /** Seconds without a change before the dock dims. */
  dockDimAfter: number
}

export const DEFAULT_DOCK_SETTINGS: DockSettings = { dockIdleOpacity: 0.5, dockDimAfter: 3 }

type Chip = { el: HTMLElement; roll: RollingNumber; cap: HTMLElement; count: number; full: boolean }
type Slot = { el: HTMLElement; item: HTMLElement; roll: RollingNumber; key: string; count: number | null }
type Cell = { el: HTMLElement; key: string }

export type DockEls = {
  hud: HTMLElement
  dock: HTMLElement
  belt: HTMLElement
  hotbar: HTMLElement
  pack: HTMLElement
  sheet: HTMLElement
}

export class Dock {
  private readonly chips = new Map<string, Chip>()
  private readonly slots: Slot[] = []
  private readonly cells: Cell[] = []
  private readonly packCount = new RollingNumber(1, "roll pack-used")
  /** The shoulder light: not a hand slot, always toggled with F. */
  private readonly light: HTMLElement
  private readonly grid: HTMLElement
  private packCap: HTMLElement
  private open = false
  private awakeUntil = -Infinity
  private hover = false
  private state = ""
  private lastKey = ""
  private first = true
  private snapKey = ""
  private rect: DOMRect | null = null
  /** Set when the dock or HUD box changes size; reading their size every frame forced a layout each frame. */
  private layoutDirty = true
  private readonly observed = typeof ResizeObserver !== "undefined"
  private idleOpacity = Number.NaN
  private snapRatio = 0

  constructor(
    private readonly els: DockEls,
    private readonly settings: DockSettings = DEFAULT_DOCK_SETTINGS,
    private readonly motion: HudMotion = hudMotion,
  ) {
    els.hotbar.replaceChildren()
    this.light = document.createElement("div")
    this.light.className = "light"
    this.light.title = "Flashlight"
    this.light.innerHTML = `<span class="light-cap"></span><span class="light-cell"><i></i></span>`
    els.hotbar.appendChild(this.light)
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement("div")
      el.className = "slot"
      el.dataset.slot = String(i + 1)
      el.innerHTML = `<kbd class="slot-key">${i + 1}</kbd><span class="slot-item"></span>`
      const roll = new RollingNumber(2, "roll slot-count")
      el.appendChild(roll.el)
      els.hotbar.appendChild(el)
      this.slots.push({ el, item: el.querySelector(".slot-item")!, roll, key: "", count: null })
    }
    els.pack.innerHTML = `<span class="pack-cap"></span>`
    els.pack.append(this.packCount.el, Object.assign(document.createElement("small"), { textContent: `/${PACK_SIZE}` }))
    this.packCap = els.pack.querySelector(".pack-cap")!
    els.sheet.innerHTML = `<div class="sheet-grid"></div>`
    this.grid = els.sheet.firstElementChild as HTMLElement
    for (let i = 0; i < PACK_SIZE; i++) {
      const el = document.createElement("div")
      el.className = "cell"
      el.dataset.empty = "true"
      el.innerHTML = `<kbd>${i + 1}</kbd><span></span>`
      this.grid.appendChild(el)
      this.cells.push({ el, key: "" })
    }
    els.sheet.dataset.open = "false"
    if (this.observed) {
      const ro = new ResizeObserver(() => {
        this.layoutDirty = true
      })
      ro.observe(els.dock)
      ro.observe(els.hud)
    }
    if (typeof window !== "undefined") window.addEventListener("pointermove", (e: PointerEvent) => this.pointer(e.clientX, e.clientY), { passive: true })
  }

  /** Wakes the dock as if something changed (a slot change from the wheel, a pickup callout). */
  wake(now = performance.now() / 1000): void {
    this.awakeUntil = now + this.settings.dockDimAfter
  }

  /** Lets the dock dim now (Lab station's idle variant). */
  sleep(): void {
    this.awakeUntil = -Infinity
  }

  /** The cursor position in CSS pixels; the dock brightens while the cursor is over it. */
  pointer(x: number, y: number): void {
    const r = this.rect
    this.hover = Boolean(r) && x >= r!.left - 8 && x <= r!.right + 8 && y >= r!.top - 8 && y <= r!.bottom + 8
  }

  get idle(): boolean {
    return this.state === "idle"
  }

  /** Call every drawn frame. */
  sync(view: SessionView, packOpen: boolean, craftOpen: boolean, now = performance.now() / 1000): void {
    const { progression, actorId, player: p } = view
    const ledger = progression.ledger
    const belt = ledger.store(`${actorId}/belt`)
    const hotbar = ledger.store(`${actorId}/hotbar`)
    const pack = ledger.store(`${actorId}/pack`)
    const pendKey = view.pendingItems?.size ? [...view.pendingItems].join(",") : ""
    const key = `${belt?.rev}|${hotbar?.rev}|${pack?.rev}|${p.flashlightOn}|${p.batteryDepleted}|${Math.ceil(p.battery * 10)}|${p.magAmmo}|${p.meleeDurability}|${pendKey}|${keyLabel("KeyF")}|${keyLabel("Tab")}`
    const animate = !this.first
    if (key !== this.lastKey) {
      this.wake(now)
      this.lastKey = key
      if (belt) this.syncBelt(view, belt, animate)
      this.syncLight(view)
      if (hotbar) this.syncHotbar(view, hotbar, animate)
      if (pack) this.syncPack(view, pack, animate)
      this.snapKey = ""
      this.layoutDirty = true
    }
    if (packOpen !== this.open) {
      this.open = packOpen
      this.morph(packOpen)
      this.wake(now)
    }
    const awake = packOpen || craftOpen || this.hover || now < this.awakeUntil
    const state = awake ? "awake" : "idle"
    if (state !== this.state) {
      this.state = state
      this.els.hud.dataset.dock = state
    }
    if (this.settings.dockIdleOpacity !== this.idleOpacity) {
      this.idleOpacity = this.settings.dockIdleOpacity
      this.els.hud.style.setProperty("--hud-idle", String(this.idleOpacity))
    }
    // Keep the centred dock's edges on whole device pixels so its text is crisp at rest. Only measured after the dock
    // or HUD changed size (or the pixel ratio did), so a quiet frame never forces a layout.
    if (!this.observed || this.layoutDirty || devicePixelRatio !== this.snapRatio) {
      const snap = `${innerWidth}|${innerHeight}|${devicePixelRatio}|${this.els.dock.offsetWidth}|${this.els.hud.offsetHeight}`
      if (snap !== this.snapKey) {
        if (snapToPixels(this.els.dock)) this.snapKey = snap
        this.rect = this.els.dock.getBoundingClientRect()
      }
      this.snapRatio = devicePixelRatio
      this.layoutDirty = this.snapKey !== snap
    }
    this.first = false
  }

  private syncBelt(view: SessionView, belt: NonNullable<ReturnType<SessionView["progression"]["ledger"]["store"]>>, animate: boolean): void {
    const { progression } = view
    const ledger = progression.ledger
    const shown = BELT_ITEMS.filter((item) => item === "ammo" || item === "plank" || (belt.counts[item] ?? 0) > 0 || progression.seen(item))
    const before = flip(this.els.belt.querySelectorAll<HTMLElement>(":scope > .chip, :scope > #pack"), this.motion)
    const added: HTMLElement[] = []
    for (const item of shown) {
      let chip = this.chips.get(item)
      if (!chip) {
        const el = document.createElement("span")
        el.className = "chip"
        el.dataset.item = item
        el.innerHTML = `<b>${esc(ledger.label(item, true))}</b>`
        const roll = new RollingNumber(2, "roll chip-count")
        const cap = document.createElement("small")
        el.append(roll.el, cap)
        chip = { el, roll, cap, count: -1, full: false }
        this.chips.set(item, chip)
        if (animate) added.push(el)
      }
      const n = belt.counts[item] ?? 0
      const cap = ledger.capFor(belt, item)
      chip.roll.set(n, animate)
      chip.cap.textContent = `/${cap}`
      const full = n >= cap
      if (full !== chip.full) {
        chip.full = full
        chip.el.dataset.full = String(full)
      }
      chip.el.dataset.pending = String(Boolean(view.pendingItems?.has(item)))
      if (animate && chip.count >= 0 && n > chip.count) this.pulse(chip.el)
      chip.count = n
    }
    // Keep belt order, with the pack chip last.
    const order = [...shown.map((i) => this.chips.get(i)!.el), this.els.pack]
    order.forEach((el, i) => {
      if (this.els.belt.children[i] !== el) this.els.belt.insertBefore(el, this.els.belt.children[i] ?? null)
    })
    for (const [item, chip] of this.chips) {
      if (shown.includes(item as (typeof BELT_ITEMS)[number])) continue
      this.chips.delete(item)
      chip.el.style.position = "absolute"
      void this.motion.exit(chip.el).then(() => chip.el.remove())
    }
    before.play()
    for (const el of added) this.motion.enter(el, "calm", { y: 4 })
  }

  private syncLight(view: SessionView): void {
    const p = view.player
    this.light.dataset.on = String(p.flashlightOn && !p.batteryDepleted)
    this.light.dataset.dead = String(p.batteryDepleted)
    const cap = keyCapHtml("KeyF", { className: "slot-cap" })
    const capEl = this.light.firstElementChild as HTMLElement
    if (capEl.innerHTML !== cap) capEl.innerHTML = cap
    ;(this.light.querySelector(".light-cell i") as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, p.battery)) * 100)}%`
  }

  private syncHotbar(view: SessionView, hotbar: NonNullable<ReturnType<SessionView["progression"]["ledger"]["store"]>>, animate: boolean): void {
    const { progression, player: p } = view
    const ledger = progression.ledger
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = hotbar.slots[i]
      const slot = this.slots[i]!
      const sel = i === hotbar.selected
      slot.el.dataset.selected = String(sel)
      slot.el.dataset.empty = String(!s)
      slot.el.dataset.pending = String(Boolean(s && view.pendingItems?.has(s.item)))
      const def = s ? ledger.items.get(s.item) : undefined
      const label = s ? (def?.shortLabel ?? s.item) : ""
      const extra = ""
      const glyph = s && GLYPH_SLOTS.has(s.item) ? itemIcon(s.item, 14) : ""
      const itemKey = `${s?.item ?? ""}|${extra}`
      if (itemKey !== slot.key) {
        const had = slot.key !== ""
        slot.key = itemKey
        slot.item.innerHTML = s ? `${glyph}<span class="slot-label">${esc(label)}</span>${extra}` : ""
        if (animate && s) this.motion.enter(slot.item, "default", { y: had ? 0 : 6 })
        if (animate && !s && had) this.pulse(slot.el)
      }
      // A charged fire item counts its charge: the flamethrower's fuel (%), the flare gun's shots.
      const count = s?.item === "pistol" ? p.magAmmo : s && GLYPH_SLOTS.has(s.item) && s.charge !== undefined ? Math.ceil(s.charge) : s && s.count > 1 ? s.count : null
      slot.el.dataset.count = String(count !== null)
      if (count !== null) slot.roll.set(count, animate && slot.count !== null)
      if (animate && count !== null && slot.count !== null && count > slot.count) this.pulse(slot.el)
      slot.count = count
    }
  }

  private syncPack(view: SessionView, pack: NonNullable<ReturnType<SessionView["progression"]["ledger"]["store"]>>, animate: boolean): void {
    const ledger = view.progression.ledger
    const used = ledger.usedSlots(pack)
    this.packCount.set(used, animate)
    this.packCap.innerHTML = keyCapHtml("Tab")
    this.els.pack.dataset.used = String(used)
    let skip = 0
    pack.slots.forEach((s, i) => {
      const cell = this.cells[i]
      if (!cell) return
      if (skip > 0) {
        skip--
        cell.el.dataset.covered = "true"
        return
      }
      cell.el.dataset.covered = "false"
      const span = s ? (ledger.items.get(s.item)?.slots ?? 1) : 1
      skip = span - 1
      const key = s ? `${s.item}|${span}` : ""
      cell.el.dataset.empty = String(!s)
      cell.el.style.gridColumn = span > 1 ? `span ${span}` : ""
      if (key !== cell.key) {
        cell.key = key
        cell.el.lastElementChild!.textContent = s ? ledger.label(s.item, true) : ""
        if (animate && s) this.motion.enter(cell.el.lastElementChild!, "default", { y: 4 })
      }
    })
  }

  /** A brief warm lift on something that just gained. */
  private pulse(el: HTMLElement): void {
    this.motion.animate(el, [{ opacity: 1 }, { opacity: 0 }], "slow", { pseudoElement: "::after" })
  }

  /** Box of `el` relative to the dock, from layout (ignores transforms in flight). */
  private box(el: HTMLElement) {
    let x = 0
    let y = 0
    let n: HTMLElement | null = el
    while (n && n !== this.els.dock) {
      x += n.offsetLeft
      y += n.offsetTop
      n = n.offsetParent as HTMLElement | null
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight }
  }

  /** Grows the pack sheet out of its chip, or folds it back, from wherever the shape is now. */
  private morph(open: boolean): void {
    const sheet = this.els.sheet
    const chip = this.box(this.els.pack)
    const gw = this.grid.offsetWidth
    const gh = this.grid.offsetHeight
    const dockW = this.els.dock.offsetWidth
    const panel = {
      x: Math.round(Math.max(chip.x + chip.w - gw, Math.min(0, (dockW - gw) / 2))),
      y: Math.round(chip.y - gh - 6),
      w: gw,
      h: gh,
    }
    const cs = getComputedStyle(sheet)
    const moving = sheet.getAnimations().length > 0 && sheet.dataset.open !== "rest"
    const from = moving
      ? { x: parseFloat(cs.left), y: parseFloat(cs.top), w: parseFloat(cs.width), h: parseFloat(cs.height), o: Number(cs.opacity) }
      : open
        ? { ...chip, o: 0 }
        : { ...panel, o: 1 }
    for (const a of sheet.getAnimations()) a.cancel()
    for (const a of this.grid.getAnimations()) a.cancel()
    const to = open ? panel : chip
    sheet.dataset.open = String(open)
    this.els.pack.dataset.open = String(open)
    this.els.belt.dataset.open = String(open)
    Object.assign(sheet.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px`, opacity: open ? "1" : "0" })
    const name = open ? "morphOpen" : "morphClose"
    const px = (v: number) => `${v}px`
    // The shape rises clear of the belt first, then widens into the panel; reversing starts from wherever it is.
    this.motion.animate(sheet, [{ height: px(from.h), top: px(from.y) }, { height: px(to.h), top: px(to.y) }], open ? "default" : name)
    this.motion.animate(sheet, [{ width: px(from.w), left: px(from.x) }, { width: px(to.w), left: px(to.x) }], open ? name : "snappy")
    const fade = open ? [{ opacity: from.o }, { opacity: 1, offset: 0.6 }, { opacity: 1 }] : [{ opacity: from.o }, { opacity: from.o, offset: 0.7 }, { opacity: 0 }]
    const a = this.motion.animate(sheet, fade, name)
    if (open) this.motion.animate(this.grid, [{ opacity: 0, filter: "blur(3px)" }, { opacity: 0, filter: "blur(3px)", offset: 0.2 }, { opacity: 1, filter: "blur(0px)" }], "morphOpen")
    else this.motion.animate(this.grid, [{ opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(3px)", offset: 0.55 }, { opacity: 0 }], "morphClose")
    if (!open) {
      const settle = () => {
        if (sheet.dataset.open === "false") sheet.dataset.open = "rest"
      }
      if (a) void a.finished.then(settle, () => undefined)
      else settle()
    }
  }
}
