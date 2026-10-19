import type { PageSite } from "../../shared/discovery/found"
import { RECIPES } from "../../shared/progression"
import type { SessionView } from "../../shared/session"
import { itemIcon } from "./icons"
import type { DiscoverySettings } from "./settings"

/** What a page shows as its result, in the glyph set (`icons.ts`). */
const RESULT_GLYPH: Readonly<Record<string, string>> = { lure: "noisemaker", battery: "battery" }

/** How near, in metres, a survivor must be to a page for its disappearing to mean they read it. */
const READ_NEAR = 2.5

/**
 * Reading a page holds it up to the camera for a moment: the flyer, chart or photo, large, with the two materials
 * and what they make. No words, and it goes by itself. Watches the page stores, so it works the same in co-op.
 */
export class PageGlance {
  private readonly el: HTMLElement | null
  private readonly last = new Map<string, number>()
  private left = 0
  private total = 0
  /** The page on show, for proofs: `style:recipe`, or null. */
  showing: string | null = null

  constructor(doc: Document | null = typeof document === "undefined" ? null : document) {
    if (!doc) {
      this.el = null
      return
    }
    let el = doc.getElementById("glance")
    if (!el) {
      el = doc.createElement("div")
      el.id = "glance"
      el.setAttribute("aria-hidden", "true")
      el.hidden = true
      doc.body.appendChild(el)
    }
    this.el = el
  }

  update(view: SessionView, settings: DiscoverySettings, dt: number): void {
    const p = view.player
    for (const site of view.progression.knowledge.pages) {
      const count = view.progression.ledger.count(site.id, "page")
      const prev = this.last.get(site.id)
      this.last.set(site.id, count)
      if (prev === undefined || prev <= 0 || count > 0) continue
      if (!settings.discoveryPageGlance || Math.hypot(site.x - p.x, site.y - p.y) > READ_NEAR) continue
      this.show(site, settings.discoveryGlanceTime)
    }
    if (this.left <= 0) return
    this.left = Math.max(0, this.left - Math.max(0, dt))
    if (!this.el) return
    const t = this.total - this.left
    const fade = Math.min(1, t / 0.15, this.left / 0.35)
    this.el.style.opacity = fade.toFixed(3)
    this.el.style.transform = `translate(-50%, -50%) scale(${(0.94 + 0.06 * Math.min(1, t / 0.25)).toFixed(3)})`
    if (this.left <= 0) {
      this.el.hidden = true
      this.showing = null
    }
  }

  /** Puts any page on show away at once (staging a scene). */
  hide(): void {
    this.left = 0
    this.showing = null
    if (this.el) this.el.hidden = true
  }

  /** Holds a page up for `seconds` (Lab, proofs, and reading). */
  show(site: Pick<PageSite, "recipe" | "style">, seconds: number): void {
    const recipe = RECIPES.find((r) => r.id === site.recipe)
    if (!recipe?.sketch) return
    this.showing = `${site.style}:${site.recipe}`
    this.left = this.total = Math.max(0.1, seconds)
    if (!this.el) return
    const result = itemIcon(RESULT_GLYPH[recipe.id] ?? recipe.produces ?? recipe.id, 64)
    const [a, b] = recipe.sketch
    this.el.dataset.style = site.style
    this.el.innerHTML =
      `<div class="page-head">${site.style === "flyer" ? result : ""}</div>` +
      `<div class="page-pair">${itemIcon(a, 44)}<span class="plus"></span>${itemIcon(b, 44)}</div>` +
      `<div class="page-arrow"></div>` +
      `<div class="page-result">${result}</div>`
    this.el.hidden = false
    this.el.style.opacity = "0"
  }
}
