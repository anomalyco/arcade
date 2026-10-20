import type { Camera } from "@arcade/kit/client/camera"
import type { InventoryOp, InvRef } from "../../shared/inventory-ops/types"
import type { Command, SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import type { InventoryPresenter } from "./hooks"
import { itemIconSvg } from "./icons"
import { cellAt, inventoryModel, moveFor, parseRef, quickMoveFor, refAttr, type InvModel } from "./model"
import { caseHtml, groundHtml, sheetHtml, type RenderState } from "./render"
import { DEFAULT_INVENTORY_SETTINGS, type InventorySettings, type InventoryStyle } from "./settings"
import "./inventory.css"

/** Mat proportions (design pixels) for the Ground Pack; the floor quad keeps the same aspect. */
const MAT_W = 820
const MAT_H = 470
const DRAG_START_PX = 5
const PENDING_S = 0.8

type Drag = { from: InvRef; x: number; y: number; started: boolean; ghost: HTMLElement | null; shift: boolean; pointer: number }

export type BagFrame = {
  view: SessionView
  session: { sim?: { slots: readonly { id: string; index: number; survivor: { x: number; y: number; health: number } }[] } }
  cam: Camera
  w: number
  h: number
  dt: number
  zoom: number
  names: (index: number) => string
  colours: (index: number) => string
}

/** The quad the Ground Pack lies on, in plan metres (x, y) and its floor height. */
export type MatAnchor = { x: number; y: number; w: number; h: number; ground: number }

/**
 * The bag Tab opens in every style but Today (AR-94). It owns the open state, the DOM, dragging and the keyboard while
 * open, and queues one inventory move per command for the room to apply (`shared/inventory-ops`). The world never
 * pauses; in the Ground Pack you kneel and the camera leans in, and walking picks the bag up again.
 */
export class InventoryBag implements InventoryPresenter {
  open = false
  private root: HTMLElement | null = null
  private floor: HTMLElement | null = null
  private caption: HTMLElement | null = null
  private stage: HTMLElement | null = null
  private html = ""
  private style: InventoryStyle = "today"
  private model: InvModel | null = null
  private hovered: InvRef | null = null
  private drag: Drag | null = null
  private readonly queue: InventoryOp[] = []
  private readonly pending = new Map<string, number>()
  private readonly fresh = new Set<string>()
  private lastKey = ""
  private seen = new Map<string, string>()
  private time = 0
  private anchor: MatAnchor | null = null
  /** Movement was held when the bag opened, so it does not count as walking away until released. */
  private moveHeldAtOpen = false
  private pushed = false
  private zoomBase = 0
  private shift = false
  /** Where the survivor faced when the bag opened: the cursor is on the bag now, so it no longer aims. */
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
    this.anchor = null
    this.moveHeldAtOpen = true
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

  digit(index: number, view: SessionView): Partial<Command> | null {
    if (!this.open || !this.model || !this.hovered) return null
    const from = this.hovered
    const src = cellAt(this.model, from)
    if (!src?.stack) return null
    const op = moveFor(this.model, from, { at: "hotbar", slot: index })
    if (op) this.enqueue(op)
    void view
    return {}
  }

  key(code: string, _view: SessionView): boolean {
    if (code === "ShiftLeft" || code === "ShiftRight") this.shift = true
    if (!this.open || !this.model) return false
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
      // Keep facing what you opened the bag at, so the container you face stays the one beside your bag.
      this.aimAtOpen ??= command.aim
      out = { ...out, aim: this.aimAtOpen, fire: false, fireHeld: false }
    }
    if (this.open && this.style === "ground" && this.settings().invKneel) {
      const moving = Math.hypot(command.mx, command.my) > 0.25
      if (!moving) this.moveHeldAtOpen = false
      if (moving && !this.moveHeldAtOpen) this.close()
      else out = { ...out, mx: 0, my: 0, sprint: false, crouch: true }
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

  /** Where the Ground Pack lies, for the floor light and proofs. */
  matAnchor(): MatAnchor | null {
    return this.open && this.style === "ground" ? this.anchor : null
  }

  inspect() {
    return {
      style: this.settings().inventoryStyle,
      open: this.open,
      hovered: this.hovered ? refAttr(this.hovered) : null,
      queued: this.queue.length,
      sent: this.sent,
      cells: this.model
        ? {
            hands: this.model.hands.map((c) => c.stack?.item ?? null),
            pack: this.model.pack.map((c) => c.stack?.item ?? null),
            belt: this.model.belt.map((c) => `${c.stack?.item}:${c.stack?.count}`),
            target: this.model.target?.cells.map((c) => c.stack?.item ?? null) ?? null,
            mates: this.model.mates.map((m) => m.index),
          }
        : null,
    }
  }

  /** Call once per rendered frame after the camera has settled. */
  frame(f: BagFrame): void {
    if (typeof document === "undefined") return
    this.time += f.dt
    const s = this.settings()
    this.style = s.inventoryStyle
    if (!this.owns() && this.open) this.close()
    const model = inventoryModel(f.view, f.session, f.names, f.colours)
    this.noteFresh(model)
    this.model = model
    this.pushIn(f, s)
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
    root.dataset.style = this.style
    for (const [ref, until] of this.pending) if (this.time > until || model.key !== this.lastKey) this.pending.delete(ref)
    this.lastKey = model.key
    const st: RenderState = { fresh: this.fresh, pending: new Set(this.pending.keys()), cell: s.invCell }
    root.style.setProperty("--inv-cell", `${s.invCell}px`)
    const html = this.style === "ground" ? groundHtml(model, st) : this.style === "case" ? caseHtml(model, st) : sheetHtml(model, st)
    if (html !== this.html) {
      this.html = html
      this.stage!.innerHTML = html
      this.markHover()
    }
    if (this.style === "ground") this.placeMat(f, s)
    else this.stage!.style.transform = ""
    this.syncCaption()
  }

  // ── Ground Pack: the floor quad, the lean-in and the lamp ─────────────────────────────────────────────────────

  private placeMat(f: BagFrame, s: InventorySettings): void {
    const p = f.view.player
    if (!this.anchor) {
      // Sized on screen, not in metres: the mat spans `invMatScreen` of the view once the camera has leaned in.
      const g = supportHeight(f.view.town, p.x, p.y)
      const l = f.cam.project(p.x - 0.5, g, p.y, f.w, f.h)
      const r = f.cam.project(p.x + 0.5, g, p.y, f.w, f.h)
      const perMetre = Math.max(1, Math.hypot(r.x - l.x, r.y - l.y))
      const settled = Math.max(1e-3, (this.pushed ? this.zoomBase : f.cam.dist) * (1 - s.invPushIn))
      const w = Math.max(1.4, Math.min(6, (s.invMatScreen * f.w) / (perMetre * (f.cam.dist / settled))))
      const h = (w * MAT_H) / MAT_W
      // The bag lies in front of the kneeling survivor, toward the camera (plan +y is down the screen).
      this.anchor = { x: p.x, y: p.y + 0.3 + h / 2, w, h, ground: supportHeight(f.view.town, p.x, p.y) + 0.03 }
    }
    const a = this.anchor
    const corners = [
      [a.x - a.w / 2, a.y - a.h / 2],
      [a.x + a.w / 2, a.y - a.h / 2],
      [a.x + a.w / 2, a.y + a.h / 2],
      [a.x - a.w / 2, a.y + a.h / 2],
    ].map(([x, y]) => f.cam.project(x!, a.ground, y!, f.w, f.h))
    if (corners.some((c) => !c.ok)) return
    const m = quadMatrix(MAT_W, MAT_H, corners as { x: number; y: number }[])
    if (m) this.stage!.style.transform = m
  }

  private pushIn(f: BagFrame, s: InventorySettings): void {
    const want = this.open && this.style === "ground" ? s.invPushIn : 0
    if (!this.pushed && want <= 0) return
    if (!this.pushed) {
      this.zoomBase = f.zoom
      this.pushed = true
    }
    const target = this.zoomBase * (1 - want)
    const k = 1 - Math.exp(-f.dt * 7)
    f.cam.dist += (target - f.cam.dist) * k
    if (want <= 0 && Math.abs(f.cam.dist - this.zoomBase) < 0.02) {
      f.cam.dist = this.zoomBase
      this.pushed = false
    }
  }

  // ── Freshness: what arrived since you last looked ─────────────────────────────────────────────────────────────

  private noteFresh(m: InvModel): void {
    const now = new Map<string, string>()
    for (const c of [...m.hands, ...m.pack, ...m.belt]) if (c.stack) now.set(refAttr(c.ref), `${c.stack.item}:${c.stack.count}`)
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

  // ── DOM and pointer handling ──────────────────────────────────────────────────────────────────────────────────

  private ensureDom(): void {
    if (this.root) return
    const root = document.createElement("div")
    root.id = "inv"
    root.hidden = true
    root.innerHTML = `<div class="inv-floor" data-ref="ground:0"></div><div class="inv-stage"></div><div class="inv-caption" aria-live="polite"></div>`
    document.body.appendChild(root)
    this.root = root
    this.floor = root.querySelector<HTMLElement>(".inv-floor")
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

  private refOf(el: Element | null): InvRef | null {
    const hit = el?.closest?.("[data-row-ref], [data-ref]") as HTMLElement | null
    return parseRef(hit?.dataset.rowRef ?? hit?.dataset.ref)
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
    const el = this.stage.querySelector(`.inv-cell[data-ref="${refAttr(this.hovered)}"]`)
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
      const extra = ch ? (ch.kind === "rounds" ? ` · ${ch.value}/${ch.max} in the gun` : ch.kind === "battery" ? ` · ${ch.value}%` : ` · ${Math.round((ch.value / ch.max) * 100)}%`) : ""
      text = `${c.label}${extra}${c.blocked === "full" ? " · no room" : c.blocked === "installed" ? " · installed" : ""}`
    }
    if (el.textContent !== text) el.textContent = text
    el.dataset.on = String(Boolean(text))
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.model) return
    const from = this.refOf(e.target as Element)
    if (!from || from.slot < 0) return
    const cell = cellAt(this.model, from)
    if (!cell?.stack) return
    e.preventDefault()
    e.stopPropagation()
    this.drag = { from, x: e.clientX, y: e.clientY, started: false, ghost: null, shift: e.shiftKey, pointer: e.pointerId }
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.pointer) return
    if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START_PX) return
    if (!d.started) {
      d.started = true
      const cell = this.model ? cellAt(this.model, d.from) : undefined
      const ghost = document.createElement("div")
      ghost.className = "inv-ghost"
      ghost.innerHTML = cell?.stack ? itemIconSvg(cell.stack.item) : ""
      this.root!.appendChild(ghost)
      d.ghost = ghost
      this.root!.dataset.dragging = "true"
      this.stage?.querySelector(`.inv-cell[data-ref="${refAttr(d.from)}"]`)?.setAttribute("data-lifted", "true")
    }
    if (d.ghost) d.ghost.style.translate = `${Math.round(e.clientX)}px ${Math.round(e.clientY)}px`
    const over = this.refOf(document.elementFromPoint(e.clientX, e.clientY))
    for (const el of this.root!.querySelectorAll("[data-drop]")) el.removeAttribute("data-drop")
    if (over && this.model && moveFor(this.model, d.from, over)) {
      const sel = over.at === "ground" ? ".inv-floor" : `[data-ref="${refAttr(over)}"]`
      this.root!.querySelector(sel)?.setAttribute("data-drop", "true")
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.pointer || !this.model) return
    this.drag = null
    if (!d.started) {
      const op = quickMoveFor(this.model, d.from)
      if (op) this.enqueue(op)
      return
    }
    const to = this.refOf(document.elementFromPoint(e.clientX, e.clientY)) ?? { at: "ground", slot: 0 }
    const src = cellAt(this.model, d.from)
    const half = d.shift || e.shiftKey ? Math.ceil((src?.stack?.count ?? 1) / 2) : 0
    const op = moveFor(this.model, d.from, to, half)
    if (op) this.enqueue(op)
    this.cancelDrag()
  }

  private cancelDrag(): void {
    const d = this.drag
    this.drag = null
    d?.ghost?.remove()
    for (const el of this.root?.querySelectorAll(".inv-ghost, [data-drop], [data-lifted]") ?? []) {
      if (el.classList.contains("inv-ghost")) el.remove()
      el.removeAttribute("data-drop")
      el.removeAttribute("data-lifted")
    }
    if (this.root) delete this.root.dataset.dragging
    void this.floor
  }
}

/**
 * The CSS `matrix3d` that maps a `w`×`h` box (origin top left) onto the screen quad `pts` (top left, top right,
 * bottom right, bottom left): the projective map from the unit square, scaled to the box.
 */
export function quadMatrix(w: number, h: number, pts: readonly { x: number; y: number }[]): string | null {
  const [p0, p1, p2, p3] = pts as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  const den = dx1 * dy2 - dx2 * dy1
  if (Math.abs(den) < 1e-9) return null
  const g = (dx3 * dy2 - dx2 * dy3) / den
  const hh = (dx1 * dy3 - dx3 * dy1) / den
  const a = p1.x - p0.x + g * p1.x
  const b = p3.x - p0.x + hh * p3.x
  const d = p1.y - p0.y + g * p1.y
  const e = p3.y - p0.y + hh * p3.y
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, p0.x, p0.y, 0, 1]
  return `matrix3d(${m.map((v) => Number(v.toFixed(8))).join(",")})`
}
