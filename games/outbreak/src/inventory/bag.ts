import type { Ledger } from "@arcade/kit/sim/ledger"
import type { InventoryOp, InvRef } from "../../shared/inventory-ops/types"
import type { Command, SessionView } from "../../shared/session"
import type { InventoryPresenter } from "./hooks"
import { cellAt, fitAt, inventoryModel, moveFor, parseRef, quickMoveFor, refAttr, type CaseItem, type InvModel } from "./model"
import { artHtml, caseHtml, CRATE_COLS, type RenderState } from "./render"
import { DEFAULT_INVENTORY_SETTINGS, type InventorySettings } from "./settings"
import "./inventory.css"

const DRAG_START_PX = 5
const PENDING_S = 0.8
/** How long the cells a bigger bag adds keep unfolding. */
const GROW_S = 1.6
/** How long a dropped item's ghost waits, snapped in place, for the room to say where it landed. */
const SETTLE_S = 0.9
const CRATE_SCALE = 0.8

type Snap = { x: number; y: number; state: "fit" | "merge" | "blocked" }

type Drag = {
  from: InvRef
  item: string
  count: number
  x: number
  y: number
  started: boolean
  pointer: number
  shift: boolean
  turned: boolean
  /** Where on the ghost it was picked up, as a fraction of its width and height. */
  fx: number
  fy: number
  ghost: HTMLElement | null
  snap: Snap | null
  px: number
  py: number
}

type Settle = { el: HTMLElement; item: string; x: number; y: number; until: number }

export type BagFrame = {
  view: SessionView
  session: { sim?: { slots: readonly { id: string; index: number; survivor: { x: number; y: number; health: number } }[] } }
  w: number
  h: number
  dt: number
  names: (index: number) => string
  colours: (index: number) => string
}

/**
 * The Attaché Case Tab opens (AR-94, D-46). It owns the open state, the DOM, dragging (lift, turn with R or a right
 * click, snap to the grid, settle) and the keyboard while open, and queues one inventory move per command for the
 * room to apply (`shared/inventory-ops`). The world never pauses: you keep facing where you were and don't fire.
 */
export class InventoryBag implements InventoryPresenter {
  open = false
  private root: HTMLElement | null = null
  private caption: HTMLElement | null = null
  private stage: HTMLElement | null = null
  private html = ""
  private model: InvModel | null = null
  private ledger: Ledger | null = null
  private hovered: InvRef | null = null
  private drag: Drag | null = null
  private settle: Settle | null = null
  private readonly queue: InventoryOp[] = []
  private readonly pending = new Map<string, number>()
  private readonly fresh = new Set<string>()
  private lastKey = ""
  private seen = new Map<string, string>()
  private time = 0
  private shift = false
  /** The case's size when the player last saw it, and the size it grew from (unfolding until `grownUntil`). */
  private shownSize: { cols: number; rows: number } | null = null
  private grown: { cols: number; rows: number } | null = null
  private grownUntil = 0
  private cellPx = 56
  /** Where the survivor faced when the case opened: the cursor is on the case now, so it no longer aims. */
  private aimAtOpen: number | null = null
  /** Moves sent, for the harness. */
  sent = 0

  constructor(private readonly settings: () => InventorySettings = () => DEFAULT_INVENTORY_SETTINGS) {}

  owns(): boolean {
    return this.settings().inventoryStyle !== "today"
  }

  toggle(): void {
    if (this.open) this.close()
    else this.show()
  }

  show(): void {
    if (!this.owns()) return
    this.open = true
    this.aimAtOpen = null
  }

  close(): boolean {
    const was = this.open
    this.open = false
    this.cancelDrag()
    this.hovered = null
    // What was new has been seen now.
    if (was) this.fresh.clear()
    return was
  }

  digit(index: number, _view: SessionView): Partial<Command> | null {
    if (!this.open || !this.model || !this.hovered) return null
    const src = cellAt(this.model, this.hovered)
    if (!src?.stack) return null
    const op = moveFor(this.model, this.hovered, { at: "hotbar", slot: index })
    if (op) this.enqueue(op)
    return {}
  }

  key(code: string, _view: SessionView): boolean {
    if (code === "ShiftLeft" || code === "ShiftRight") this.shift = true
    if (!this.open || !this.model) return false
    if (code === "KeyR") {
      if (this.drag?.started) this.turnDrag()
      else this.turnHovered()
      return true
    }
    if (code === "KeyG" && this.hovered) {
      const src = cellAt(this.model, this.hovered)
      if (!src?.stack || this.hovered.at === "target") return true
      const op = moveFor(this.model, this.hovered, { at: "ground", slot: 0 }, this.shift ? 0 : 1)
      if (op) this.enqueue(op)
      return true
    }
    return false
  }

  shape(command: Command, first: boolean): Command {
    let out = command
    if (this.open) {
      // Keep facing what you opened the case at, so the container you face stays the one beside it.
      this.aimAtOpen ??= command.aim
      out = { ...out, aim: this.aimAtOpen, fire: false, fireHeld: false }
    }
    if (first && this.queue.length) {
      const op = this.queue.shift()!
      out = { ...out, inv: op }
      this.sent++
    }
    return out
  }

  enqueue(op: InventoryOp): void {
    if (this.queue.length > 6) return
    this.queue.push(op)
    this.pending.set(refAttr(op.from), this.time + PENDING_S)
  }

  inspect() {
    const m = this.model
    return {
      style: this.settings().inventoryStyle,
      open: this.open,
      hovered: this.hovered ? refAttr(this.hovered) : null,
      queued: this.queue.length,
      sent: this.sent,
      cells: m
        ? {
            hands: m.hands.map((c) => c.stack?.item ?? null),
            case: { cols: m.case.cols, rows: m.case.rows, used: m.case.used, bag: m.case.bag, items: m.case.items.map((i) => `${i.stack!.item}@${i.x},${i.y}${i.r ? "r" : ""}×${i.stack!.count}`) },
            target: m.target?.cells.map((c) => c.stack?.item ?? null) ?? null,
            mates: m.mates.map((x) => x.index),
          }
        : null,
    }
  }

  /** Screen rect of a case item or quick slot, for proofs that drag by pointer. */
  rectOf(ref: string): { x: number; y: number; w: number; h: number } | null {
    const el = this.stage?.querySelector<HTMLElement>(`[data-ref="${ref}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }

  /** Screen point at the top-left corner of case cell (`x`, `y`). */
  cellPoint(x: number, y: number): { x: number; y: number } | null {
    const paper = this.stage?.querySelector<HTMLElement>(".inv-case-paper")
    if (!paper || !this.model) return null
    const r = paper.getBoundingClientRect()
    const cell = r.width / Math.max(1, this.model.case.cols)
    return { x: r.left + x * cell, y: r.top + y * cell }
  }

  /** Call once per rendered frame. */
  frame(f: BagFrame): void {
    if (typeof document === "undefined") return
    this.time += f.dt
    const s = this.settings()
    if (!this.owns() && this.open) this.close()
    this.ledger = f.view.progression.ledger
    const model = inventoryModel(f.view, f.session, f.names, f.colours)
    this.noteFresh(model)
    this.model = model
    if (!this.open || f.view.player.vehicleId) {
      if (this.open && f.view.player.vehicleId) this.close()
      if (this.root && !this.root.hidden) {
        this.root.hidden = true
        this.cancelDrag()
      }
      return
    }
    this.ensureDom()
    const root = this.root!
    root.hidden = false
    this.noteGrowth(model)
    for (const [ref, until] of this.pending) if (this.time > until || model.key !== this.lastKey) this.pending.delete(ref)
    this.lastKey = model.key
    // Cells as big as the setting allows while the case and the crate still fit the screen.
    const c = model.case
    const across = c.cols + (model.target ? CRATE_COLS * CRATE_SCALE + 1.2 : 0) + 1.2
    const down = c.rows + 3.4
    this.cellPx = Math.max(24, Math.floor(Math.min(s.invCell, (f.w * 0.92) / across, (f.h * 0.78) / down)))
    root.style.setProperty("--inv-cell", `${this.cellPx}px`)
    root.style.setProperty("--inv-crate-cell", `${Math.round(this.cellPx * CRATE_SCALE)}px`)
    const st: RenderState = { fresh: this.fresh, pending: new Set(this.pending.keys()), grown: this.grown }
    const html = caseHtml(model, st, (item) => this.shapeOf(item))
    if (html !== this.html) {
      this.html = html
      this.stage!.innerHTML = html
      this.decorate()
    }
    this.landSettle(model)
    this.syncCaption()
  }

  private shapeOf(item: string, turned = false): { w: number; h: number } {
    return this.ledger ? this.ledger.footprint(item, turned) : { w: 1, h: 1 }
  }

  // ── Growth: a bigger bag or a pouch adds cells, and they unfold in the next time you look ───────────────────────

  private noteGrowth(m: InvModel): void {
    const now = { cols: m.case.cols, rows: m.case.rows }
    const was = this.shownSize
    if (was && (now.cols > was.cols || now.rows > was.rows)) {
      this.grown = was
      this.grownUntil = this.time + GROW_S
    }
    if (this.grown && this.time > this.grownUntil) this.grown = null
    this.shownSize = now
  }

  // ── Freshness: what arrived since you last looked ─────────────────────────────────────────────────────────────

  private noteFresh(m: InvModel): void {
    const now = new Map<string, string>()
    for (const c of [...m.hands, ...m.case.items]) if (c.stack) now.set(refAttr(c.ref), `${c.stack.item}:${c.stack.count}`)
    if (this.seen.size || now.size) {
      for (const [ref, v] of now) {
        const before = this.seen.get(ref)
        if (before === v) continue
        const [item, count] = v.split(":")
        const [bItem, bCount] = (before ?? ":0").split(":")
        if (before === undefined || bItem !== item || Number(count) > Number(bCount)) this.fresh.add(ref)
      }
    }
    for (const ref of this.fresh) if (!now.has(ref)) this.fresh.delete(ref)
    this.seen = now
  }

  // ── DOM ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private ensureDom(): void {
    if (this.root) return
    const root = document.createElement("div")
    root.id = "inv"
    root.hidden = true
    root.dataset.style = "case"
    root.innerHTML = `<div class="inv-floor" data-ref="ground:0"></div><div class="inv-stage"></div><div class="inv-caption" aria-live="polite"></div>`
    document.body.appendChild(root)
    this.root = root
    this.stage = root.querySelector<HTMLElement>(".inv-stage")
    this.caption = root.querySelector<HTMLElement>(".inv-caption")
    root.addEventListener("pointerdown", (e) => this.onDown(e))
    root.addEventListener("pointerover", (e) => this.onOver(e))
    root.addEventListener("contextmenu", (e) => e.preventDefault())
    window.addEventListener("pointermove", (e) => this.onMove(e))
    window.addEventListener("pointerup", (e) => this.onUp(e))
    window.addEventListener("keyup", (e) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shift = false
    })
  }

  /** Re-applies what lives outside the markup after a re-render: hover, the lifted item, the fit outline. */
  private decorate(): void {
    this.markHover()
    const d = this.drag
    if (d?.started) {
      this.stage?.querySelector(`[data-ref="${refAttr(d.from)}"]`)?.setAttribute("data-lifted", "true")
      this.showSnap(d)
    }
  }

  private refOf(el: Element | null): InvRef | null {
    const hit = el?.closest?.("[data-ref]") as HTMLElement | null
    return parseRef(hit?.dataset.ref)
  }

  private onOver(e: PointerEvent): void {
    const ref = this.refOf(e.target as Element)
    const cell = ref && this.model ? cellAt(this.model, ref) : undefined
    const next = cell?.stack ? ref : null
    if ((next && refAttr(next)) === (this.hovered && refAttr(this.hovered))) return
    this.hovered = next
    if (next) this.fresh.delete(refAttr(next))
    this.markHover()
  }

  private markHover(): void {
    if (!this.stage) return
    for (const el of this.stage.querySelectorAll("[data-hover]")) el.removeAttribute("data-hover")
    if (!this.hovered) return
    const el = this.stage.querySelector(`[data-ref="${refAttr(this.hovered)}"]`)
    el?.setAttribute("data-hover", "true")
    el?.removeAttribute("data-fresh")
  }

  private syncCaption(): void {
    const el = this.caption
    if (!el || !this.model) return
    const c = this.hovered ? cellAt(this.model, this.hovered) : undefined
    let text = ""
    if (c?.stack) {
      const ch = c.charge
      const extra = ch ? (ch.kind === "rounds" ? ` · ${ch.value}/${ch.max} in the gun` : ` · ${Math.round((ch.value / ch.max) * 100)}%`) : ""
      text = `${c.label}${extra}${c.blocked === "full" ? " · no room" : c.blocked === "installed" ? " · installed" : ""}`
    }
    if (el.textContent !== text) el.textContent = text
    el.dataset.on = String(Boolean(text))
  }

  // ── Turning ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** R over an item in the case: turn it a quarter where it lies, if it fits turned. */
  private turnHovered(): void {
    const m = this.model
    const ref = this.hovered
    if (!m || !ref || ref.at !== "pack" || !this.ledger) return
    const it = m.case.items.find((i) => i.ref.slot === ref.slot)
    if (!it) return
    const fp = this.shapeOf(it.stack!.item)
    if (fp.w === fp.h) return
    if (fitAt(m, this.ledger, ref, it.x, it.y, !it.r) !== "fit") {
      this.shake(this.stage?.querySelector(`[data-ref="${refAttr(ref)}"]`) ?? null)
      return
    }
    this.enqueue({ from: ref, to: { at: "case", slot: it.y * m.case.cols + it.x, r: !it.r } })
  }

  /** R or a right click mid-drag: the ghost turns a quarter about where it is held. */
  private turnDrag(): void {
    const d = this.drag
    if (!d?.ghost) return
    const fp = this.shapeOf(d.item)
    if (fp.w === fp.h) return
    d.turned = !d.turned
    const fx = d.fx
    d.fx = 1 - d.fy
    d.fy = fx
    this.drawGhost(d)
    d.ghost.animate([{ rotate: "-90deg" }, { rotate: "0deg" }], { duration: 160, easing: "cubic-bezier(.2,.9,.3,1.2)" })
    this.placeGhost(d)
    this.showSnap(d)
  }

  // ── Dragging: lift, carry, snap, settle ───────────────────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    if (e.button === 2 && this.drag?.started) {
      e.preventDefault()
      this.turnDrag()
      return
    }
    if (e.button !== 0 || !this.model) return
    const from = this.refOf(e.target as Element)
    if (!from || from.slot < 0) return
    const cell = cellAt(this.model, from)
    if (!cell?.stack || cell.def?.bound) return
    e.preventDefault()
    e.stopPropagation()
    const it = from.at === "pack" ? this.model.case.items.find((i) => i.ref.slot === from.slot) : undefined
    const el = (e.target as Element).closest?.("[data-ref]") as HTMLElement | null
    const r = el?.getBoundingClientRect()
    const fx = it && r ? (e.clientX - r.left) / Math.max(1, r.width) : 0.5
    const fy = it && r ? (e.clientY - r.top) / Math.max(1, r.height) : 0.5
    const half = e.shiftKey ? Math.ceil(cell.stack.count / 2) : 0
    this.drag = {
      from,
      item: cell.stack.item,
      count: half,
      x: e.clientX,
      y: e.clientY,
      started: false,
      pointer: e.pointerId,
      shift: e.shiftKey,
      turned: Boolean(it?.r),
      fx,
      fy,
      ghost: null,
      snap: null,
      px: e.clientX,
      py: e.clientY,
    }
  }

  private drawGhost(d: Drag): void {
    const fp = this.shapeOf(d.item)
    const w = (d.turned ? fp.h : fp.w) * this.cellPx
    const h = (d.turned ? fp.w : fp.h) * this.cellPx
    const g = d.ghost!
    g.style.width = `${w}px`
    g.style.height = `${h}px`
    g.innerHTML = artHtml(d.item, fp.w, fp.h, d.turned)
  }

  private placeGhost(d: Drag): void {
    const g = d.ghost
    if (!g) return
    const w = g.offsetWidth
    const h = g.offsetHeight
    g.style.translate = `${Math.round(d.px - d.fx * w)}px ${Math.round(d.py - d.fy * h)}px`
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.pointer) return
    d.px = e.clientX
    d.py = e.clientY
    if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START_PX) return
    if (!d.started) {
      d.started = true
      const ghost = document.createElement("div")
      ghost.className = "inv-ghost"
      this.root!.appendChild(ghost)
      d.ghost = ghost
      this.drawGhost(d)
      this.root!.dataset.dragging = "true"
      this.stage?.querySelector(`[data-ref="${refAttr(d.from)}"]`)?.setAttribute("data-lifted", "true")
      // The lift: it comes up off the paper toward you.
      ghost.animate([{ scale: "1", filter: "drop-shadow(0 2px 2px rgb(0 0 0 / .6))" }, { scale: "1.06", filter: "drop-shadow(0 14px 12px rgb(0 0 0 / .55))" }], {
        duration: 140,
        easing: "cubic-bezier(.2,.8,.3,1)",
        fill: "forwards",
      })
    }
    this.placeGhost(d)
    this.showSnap(d)
  }

  /** Where the ghost would land in the case (its top-left cell), and whether it fits there. */
  private snapFor(d: Drag): Snap | null {
    const m = this.model
    const paper = this.stage?.querySelector<HTMLElement>(".inv-case-paper")
    if (!m || !paper || !this.ledger) return null
    // A bag is worn, not placed: anywhere on the case takes it.
    if (cellAt(m, d.from)?.def?.tag === "bag") return null
    const over = document.elementFromPoint(d.px, d.py)
    if (!over?.closest(".inv-case-paper")) return null
    const r = paper.getBoundingClientRect()
    const cell = r.width / Math.max(1, m.case.cols)
    const fp = this.shapeOf(d.item, d.turned)
    const left = d.px - d.fx * fp.w * cell
    const top = d.py - d.fy * fp.h * cell
    const x = Math.round((left - r.left) / cell)
    const y = Math.round((top - r.top) / cell)
    // Over a stack of the same supply, the cell under the cursor decides (topping up).
    const cx = Math.floor((d.px - r.left) / cell)
    const cy = Math.floor((d.py - r.top) / cell)
    if (fitAt(m, this.ledger, d.from, cx, cy, d.turned, d.count) === "merge") return { x: cx, y: cy, state: "merge" }
    return { x, y, state: fitAt(m, this.ledger, d.from, x, y, d.turned, d.count) }
  }

  private showSnap(d: Drag): void {
    const paper = this.stage?.querySelector<HTMLElement>(".inv-case-paper")
    for (const el of this.root!.querySelectorAll("[data-drop]")) el.removeAttribute("data-drop")
    d.snap = this.snapFor(d)
    let fit = paper?.querySelector<HTMLElement>(".inv-fit") ?? null
    if (d.snap && paper && this.model) {
      if (!fit) {
        fit = document.createElement("div")
        fit.className = "inv-fit"
        paper.appendChild(fit)
      }
      const merge = d.snap.state === "merge"
      const target = merge ? this.model.case.items[this.model.case.occ[d.snap.y * this.model.case.cols + d.snap.x]!] : undefined
      const fp = this.shapeOf(d.item, d.turned)
      const box = target ? { x: target.x, y: target.y, w: target.w, h: target.h } : { x: d.snap.x, y: d.snap.y, w: fp.w, h: fp.h }
      fit.style.cssText = `--x:${box.x};--y:${box.y};--w:${box.w};--h:${box.h}`
      fit.dataset.state = d.snap.state
      return
    }
    fit?.remove()
    const over = this.refOf(document.elementFromPoint(d.px, d.py))
    if (over && this.model && moveFor(this.model, d.from, over)) {
      const sel = over.at === "ground" ? ".inv-floor" : `[data-ref="${refAttr(over)}"]`
      this.root!.querySelector(sel)?.setAttribute("data-drop", "true")
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.pointer || !this.model) return
    if (e.button === 2) return
    this.drag = null
    if (!d.started) {
      const op = quickMoveFor(this.model, d.from)
      if (op) this.enqueue(op)
      return
    }
    d.px = e.clientX
    d.py = e.clientY
    const snap = this.snapFor(d)
    if (snap) {
      if (snap.state === "blocked") {
        this.flyBack(d)
        this.shake(this.stage?.querySelector(".inv-fit") ?? null)
        return
      }
      const cols = this.model.case.cols
      const op: InventoryOp = { from: d.from, to: { at: "case", slot: snap.y * cols + snap.x, r: d.turned }, ...(d.count ? { count: d.count } : {}) }
      this.enqueue(op)
      this.settleGhost(d, snap)
      return
    }
    const to = this.refOf(document.elementFromPoint(e.clientX, e.clientY)) ?? { at: "ground", slot: 0 }
    const op = moveFor(this.model, d.from, to, d.count)
    if (op) this.enqueue(op)
    this.cancelDrag()
  }

  /** The drop: the ghost eases down onto its cells and waits there until the room puts the real item in its place. */
  private settleGhost(d: Drag, snap: Snap): void {
    const g = d.ghost
    const p = this.cellPoint(snap.x, snap.y)
    this.clearDragMarks()
    if (!g || !p) return this.cancelDrag()
    if (snap.state === "merge") {
      g.animate([{ opacity: 1 }, { opacity: 0, scale: "0.8" }], { duration: 160, easing: "ease-in", fill: "forwards" }).finished.then(() => g.remove(), () => g.remove())
      return
    }
    for (const a of g.getAnimations()) a.cancel()
    const from = g.style.translate
    g.style.translate = `${Math.round(p.x)}px ${Math.round(p.y)}px`
    g.animate(
      [
        { translate: from, scale: "1.06", filter: "drop-shadow(0 14px 12px rgb(0 0 0 / .55))" },
        { translate: g.style.translate, scale: "1", filter: "drop-shadow(0 2px 2px rgb(0 0 0 / .6))" },
      ],
      { duration: 150, easing: "cubic-bezier(.3,.7,.4,1)" },
    )
    this.settle?.el.remove()
    this.settle = { el: g, item: d.item, x: snap.x, y: snap.y, until: this.time + SETTLE_S }
  }

  /** Once the item shows at its new place, the ghost gives way to it with a small settle; a refusal sends it home. */
  private landSettle(m: InvModel): void {
    const s = this.settle
    if (!s) return
    const landed: CaseItem | undefined = m.case.items.find((i) => i.stack?.item === s.item && i.x === s.x && i.y === s.y)
    if (landed) {
      s.el.remove()
      this.settle = null
      const el = this.stage?.querySelector<HTMLElement>(`[data-ref="${refAttr(landed.ref)}"]`)
      el?.animate([{ scale: "1.035" }, { scale: "0.99", offset: 0.6 }, { scale: "1" }], { duration: 220, easing: "ease-out" })
      return
    }
    if (this.time > s.until) {
      s.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.then(() => s.el.remove(), () => s.el.remove())
      this.settle = null
    }
  }

  private flyBack(d: Drag): void {
    const g = d.ghost
    const home = this.stage?.querySelector<HTMLElement>(`[data-ref="${refAttr(d.from)}"]`)?.getBoundingClientRect()
    this.clearDragMarks()
    if (!g) return
    const to = home ? `${Math.round(home.left)}px ${Math.round(home.top)}px` : g.style.translate
    g.animate([{ translate: g.style.translate, opacity: 1 }, { translate: to, opacity: 0 }], { duration: 200, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).finished.then(
      () => g.remove(),
      () => g.remove(),
    )
  }

  private shake(el: Element | null): void {
    ;(el as HTMLElement | null)?.animate?.([{ translate: "0 0" }, { translate: "-4px 0" }, { translate: "4px 0" }, { translate: "-2px 0" }, { translate: "0 0" }], { duration: 220 })
  }

  private clearDragMarks(): void {
    for (const el of this.root?.querySelectorAll("[data-drop], [data-lifted], .inv-fit") ?? []) {
      if (el.classList.contains("inv-fit")) el.remove()
      el.removeAttribute("data-drop")
      el.removeAttribute("data-lifted")
    }
    if (this.root) delete this.root.dataset.dragging
  }

  private cancelDrag(): void {
    const d = this.drag
    this.drag = null
    d?.ghost?.remove()
    this.clearDragMarks()
    for (const el of this.root?.querySelectorAll(".inv-ghost") ?? []) if (el !== this.settle?.el) el.remove()
  }
}
