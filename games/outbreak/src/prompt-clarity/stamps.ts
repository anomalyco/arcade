import type { ActionGlyph } from "@arcade/kit/client/action-glyphs"
import { actionGlyphHtml } from "@arcade/kit/client/action-glyphs"
import type { Camera } from "@arcade/kit/client/camera"
import type { SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { MAX_PLANKS } from "./board"

/** Something near the survivor changed state: what it became, where, and (for boards) how many are up. */
export type StampEvent = { key: string; glyph: ActionGlyph; x: number; y: number; z: number; planks?: number }

const RANGE = 9

type PortalState = { open: boolean; locked: boolean; planks: number }

/**
 * Watches the doors, windows, barricades and containers within reach of the survivor and reports what changed since
 * the last frame. The first frame (and the first after a new session) only records, so nothing stamps on load.
 */
export class StateWatch {
  private portals = new Map<string, PortalState>()
  private revealed = new Set<string>()
  private session: unknown = null

  step(view: SessionView, session: unknown): StampEvent[] {
    const out: StampEvent[] = []
    const fresh = session !== this.session
    if (fresh) {
      this.session = session
      this.portals.clear()
      this.revealed.clear()
    }
    const { player: p, town } = view
    const planksOf = view.barricadePlanks ?? (() => 0)
    const near = (r: readonly number[]) => Math.hypot((r[0]! + r[2]!) / 2 - p.x, (r[1]! + r[3]!) / 2 - p.y) < RANGE
    const seen = new Set<string>()
    const check = (id: string, kind: "door" | "window", rect: readonly number[], open: boolean, locked: boolean) => {
      seen.add(id)
      const now: PortalState = { open, locked, planks: planksOf(id) }
      const was = this.portals.get(id)
      this.portals.set(id, now)
      if (!was || fresh) return
      const x = (rect[0]! + rect[2]!) / 2
      const y = (rect[1]! + rect[3]!) / 2
      const z = kind === "door" ? 1.2 : 1.5
      if (now.planks > was.planks) out.push({ key: id, glyph: "board-up", x, y, z, planks: Math.min(MAX_PLANKS, now.planks) })
      else if (now.open !== was.open) out.push({ key: id, glyph: kind === "door" ? (now.open ? "door-open" : "door-close") : now.open ? "window-open" : "window-close", x, y, z })
      else if (now.locked !== was.locked) out.push({ key: id, glyph: now.locked ? "lock" : "unlock", x, y, z })
    }
    for (const d of town.doors) if (near(d.rect)) check(d.id, "door", d.rect, d.open, Boolean(d.locked))
    for (const w of town.windows) if (near(w.rect)) check(w.id, "window", w.rect, w.open, false)
    for (const id of this.portals.keys()) if (!seen.has(id)) this.portals.delete(id)
    for (const c of view.containers) {
      if (Math.hypot(c.x - p.x, c.y - p.y) > RANGE) continue
      const st = view.progression.ledger.store(c.id)
      if (!st?.revealed || this.revealed.has(c.id)) continue
      this.revealed.add(c.id)
      if (!fresh) out.push({ key: c.id, glyph: "search", x: c.x, y: c.y, z: 1.1 })
    }
    return out
  }
}

const STAMP_SECONDS = 0.9

/** The stamps on screen: a glyph chip that rises off the target and fades, with boards shown as pips. */
export class StampLayer {
  readonly root: HTMLElement
  private live: { el: HTMLElement; ev: StampEvent; age: number }[] = []

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "ob-stamps"
    this.root.setAttribute("aria-hidden", "true")
    parent.appendChild(this.root)
  }

  add(ev: StampEvent): void {
    for (const s of this.live) if (s.ev.key === ev.key) s.age = STAMP_SECONDS
    const el = document.createElement("div")
    el.className = "ob-stamp"
    el.dataset.glyph = ev.glyph
    const pips = ev.planks !== undefined ? `<span class="pips">${Array.from({ length: MAX_PLANKS }, (_, i) => `<i data-on="${i < ev.planks!}"></i>`).join("")}</span>` : ""
    el.innerHTML = `${actionGlyphHtml(ev.glyph, { size: 20 })}${pips}`
    this.root.appendChild(el)
    this.live.push({ el, ev, age: 0 })
  }

  draw(view: SessionView, cam: Camera, w: number, h: number, dt: number): void {
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
    this.live = this.live.filter((s) => {
      s.age += dt
      if (s.age >= STAMP_SECONDS) {
        s.el.remove()
        return false
      }
      const p = cam.project(s.ev.x, s.ev.z + supportHeight(view.town, s.ev.x, s.ev.y), s.ev.y, w, h)
      if (!p.ok) {
        s.el.style.opacity = "0"
        return true
      }
      const u = s.age / STAMP_SECONDS
      const rise = 26 * (1 - (1 - u) ** 3)
      const pop = u < 0.15 ? 0.8 + (u / 0.15) * 0.25 : 1.05 - Math.min(0.05, (u - 0.15) * 0.2)
      const x = Math.round(p.x * ratio) / ratio
      const y = Math.round((p.y - rise) * ratio) / ratio
      s.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${pop.toFixed(3)})`
      s.el.style.opacity = String(u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4)
      return true
    })
  }

  get count(): number {
    return this.live.length
  }
}
