import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { RECIPES } from "../../shared/progression/catalog"
import type { SessionView } from "../../shared/session"
import { itemIcon } from "../discovery/icons"
import { hudMotion, snapToPixels } from "../hud/motion"
import "./crafting.css"
import { coachState, coachTips, craftRows, craftStation, learnHint, whereToFind, type CoachState, type CoachTip, type CraftRow } from "./model"
import { DEFAULT_CRAFTING_SETTINGS, showsPanel, showsTips, type CraftingSettings } from "./settings"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const TIPS_KEY = "arcade.outbreak.craftTips"
const label = (view: SessionView, item: string) => esc(view.progression.ledger.label(item, true))
const recipeLabel = (id: string) => esc(RECIPES.find((r) => r.id === id)?.label ?? id)
const productOf = (id: string) => RECIPES.find((r) => r.id === id)?.produces ?? id

function loadCounts(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(TIPS_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/**
 * The crafting HUD: what hold Q shows (today's wordless strip or the recipe panel, by Lab › Crafting › Style) and the
 * one-line tips that teach where crafting starts. `InventoryHud` owns opening and closing; this draws.
 */
export class CraftUi {
  private coach: CoachState | null = null
  private coachKey = ""
  private tip: { html: string; until: number } | null = null
  private tipEl: HTMLElement | null = null
  private tipShown = false
  private readonly counts = loadCounts()

  constructor(
    private readonly craftEl: HTMLElement | null,
    readonly settings: () => CraftingSettings = () => DEFAULT_CRAFTING_SETTINGS,
  ) {}

  /** Whether a digit would start a craft that can be paid for here (the strip stays open when it cannot). */
  affordable(view: SessionView, index: number): boolean {
    return craftRows(view.progression, view.actorId, craftStation(view.progression, view.prompt)).some((r) => r.index === index && r.ok)
  }

  /** The open strip's HTML for this frame. */
  html(view: SessionView): string {
    const rows = craftRows(view.progression, view.actorId, craftStation(view.progression, view.prompt))
    const s = this.settings()
    const style = showsPanel(s) ? "panel" : "strip"
    if (this.craftEl && this.craftEl.dataset.style !== style) this.craftEl.dataset.style = style
    return showsPanel(s) ? this.panelHtml(view, rows) : this.stripHtml(rows, showsTips(s))
  }

  /** Today's strip: what each learned recipe makes and takes, drawn, no names. Short costs dim the row. */
  private stripHtml(rows: CraftRow[], tips: boolean): string {
    const learned = rows.filter((r) => r.learned)
    if (!learned.length) {
      return tips
        ? `<div class="craft-empty">${keyCapHtml("KeyE")}<span>Try two materials together on a workbench</span></div>`
        : `<div class="craft-row" data-blank="true"></div>`
    }
    const body = learned.map((r) => {
      const cost = r.cost.map((c) => `<span class="cost" data-short="${c.have < c.need}">${Array.from({ length: c.need }, () => itemIcon(c.item, 18)).join("")}</span>`).join("")
      return `<div class="craft-row" data-off="${!r.ok}">${keyCapHtml(`Digit${r.index + 1}`)}${itemIcon(r.recipe.produces!, 26)}<span class="from">${cost}</span></div>`
    })
    return `${body.join("")}<div class="strip-h">${keyCapHtml("KeyQ")}</div>`
  }

  /**
   * The recipe panel: every recipe that makes something. Learned rows carry their digit, name and have/need per
   * material, the short one in caution with where it turns up; the rest say how they are learned.
   */
  private panelHtml(view: SessionView, rows: CraftRow[]): string {
    const learned = rows.filter((r) => r.learned)
    const body = rows.map((r) => {
      const name = `<span class="cp-name">${esc(r.recipe.label)}</span>`
      const glyph = itemIcon(r.recipe.produces!, 22)
      if (!r.learned) return `<div class="cp-row" data-learned="false"><span class="cp-key"></span>${glyph}${name}<span class="cp-learn">${esc(learnHint(r.recipe))}</span></div>`
      const cost = r.cost
        .map((c) => `<span class="cp-cost" data-short="${c.have < c.need}">${itemIcon(c.item, 14)}<span>${label(view, c.item)}</span><b>${Math.min(c.have, 99)}/${c.need}</b></span>`)
        .join("")
      const short = r.cost.find((c) => c.have < c.need)
      const where = short ? `<div class="cp-where">${label(view, short.item)}: ${esc(whereToFind(short.item))}</div>` : ""
      return `<div class="cp-row" data-ok="${r.ok}">${keyCapHtml(`Digit${r.index + 1}`, { className: "cp-key" })}${glyph}${name}<span class="cp-costs">${cost}</span>${where}</div>`
    })
    const head = `<div class="cp-head"><span>Craft</span><span class="cp-keys">${learned.length ? `${keyCapHtml("Digit1")}${learned.length > 1 ? `–${keyCapHtml(`Digit${learned.length}`)}` : ""} make · ` : ""}${keyCapHtml("KeyQ")} close</span></div>`
    const foot = learned.length ? "" : `<div class="cp-foot">Nothing learned yet. Lay two materials on a workbench mat and hold ${keyCapHtml("KeyE", { hold: true })} to try them.</div>`
    return `${head}${body.join("")}${foot}`
  }

  /** Watches the squad's knowledge and the belt for the moments that teach, and draws the tip above the dock. */
  syncTip(view: SessionView, craftOpen: boolean, now = performance.now() / 1000): void {
    const s = this.settings()
    const atBench = view.prompt?.kind === "bench"
    const key = `${view.progression.ledger.rev}|${atBench}`
    if (key !== this.coachKey) {
      this.coachKey = key
      const state = coachState(view.progression, view.actorId, atBench)
      const tips = showsTips(s) ? coachTips(this.coach, state) : []
      this.coach = state
      const tip = tips.find((t) => (this.counts[t.kind] ?? 0) < s.craftTipUses)
      if (tip) {
        this.counts[tip.kind] = (this.counts[tip.kind] ?? 0) + 1
        try {
          localStorage.setItem(TIPS_KEY, JSON.stringify(this.counts))
        } catch {}
        this.tip = { html: this.tipHtml(tip), until: now + s.craftTipTime }
      }
    }
    if (!showsTips(s)) this.tip = null
    const show = Boolean(this.tip && now < this.tip.until && !craftOpen)
    const el = show || this.tipShown ? this.ensureTipEl() : null
    if (!el) return
    if (show && this.tip) {
      if (el.innerHTML !== this.tip.html) el.innerHTML = this.tip.html
      if (!this.tipShown) {
        this.tipShown = true
        el.hidden = false
        for (const a of el.getAnimations()) a.cancel()
        hudMotion.enter(el, "smooth", { y: 6 })
        snapToPixels(el)
      }
    } else if (this.tipShown) {
      this.tipShown = false
      void hudMotion.exit(el, "snappy", { y: 6 }).then(() => {
        if (!this.tipShown) el.hidden = true
      })
    }
  }

  /** The tip on screen now, for proofs. */
  get currentTip(): string | null {
    return this.tipShown ? (this.tipEl?.innerText ?? null) : null
  }

  /** Forgets how often each tip has shown (Lab, proofs). */
  resetTips(): void {
    for (const k of Object.keys(this.counts)) delete this.counts[k]
    this.coach = null
    this.coachKey = ""
    this.tip = null
    try {
      localStorage.removeItem(TIPS_KEY)
    } catch {}
  }

  private tipHtml(tip: CoachTip): string {
    const holdQ = keyCapHtml("KeyQ", { hold: true })
    switch (tip.kind) {
      case "materials":
        return `<span>Materials make things. Try two together on a safehouse workbench.</span>`
      case "bench":
        return `${keyCapHtml("KeyE")}<span>lay out two</span><i class="sep"></i>${keyCapHtml("KeyE", { hold: true })}<span>try them together</span>`
      case "learned":
        return `${itemIcon(productOf(tip.recipe), 18)}<span><b>${recipeLabel(tip.recipe)}</b> learned</span><i class="sep"></i>${holdQ}<span>craft it anywhere</span>`
      case "ready":
        return `${itemIcon(productOf(tip.recipe), 18)}<span>Enough for <b>${recipeLabel(tip.recipe)}</b></span><i class="sep"></i>${holdQ}<span>craft</span>`
    }
  }

  private ensureTipEl(): HTMLElement | null {
    if (this.tipEl) return this.tipEl
    const craft = this.craftEl
    if (!craft?.parentElement || typeof document === "undefined") return null
    const el = document.createElement("div")
    el.id = "craft-tip"
    el.className = "hud-panel"
    el.setAttribute("role", "status")
    el.hidden = true
    craft.parentElement.insertBefore(el, craft)
    this.tipEl = el
    return el
  }
}
