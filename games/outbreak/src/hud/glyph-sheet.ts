/**
 * The prompt glyph sheet (Lab station outbreak-hud › Prompt icons, `hud.state` "icons"): every action glyph at 16, 20
 * and 24 px with the prompts that use it, drawn by the same code as the world prompt.
 */
import { ACTION_GLYPHS, type ActionGlyph } from "@arcade/kit/client/action-glyphs"
import { FINISHER_GLYPH, PROMPT_ACTIONS, promptGlyph, promptGlyphHtml } from "./prompt-glyphs"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const SIZES = [16, 20, 24] as const

/** Glyph → the prompts that show it ("door: Open", …) and any word kept beside it. */
export function glyphUses(): Map<ActionGlyph, { uses: string[]; words: string[] }> {
  const out = new Map<ActionGlyph, { uses: string[]; words: string[] }>(ACTION_GLYPHS.map((g) => [g, { uses: [], words: [] }]))
  for (const { kind, action } of PROMPT_ACTIONS) {
    const g = promptGlyph(kind, action)
    if (!g.glyph) continue
    const entry = out.get(g.glyph)!
    entry.uses.push(`${kind}: ${action.label}${action.hold ? " (hold)" : action.modifier === "shift" ? " (Shift)" : ""}`)
    if (g.word && !entry.words.includes(g.word)) entry.words.push(g.word)
  }
  out.get(FINISHER_GLYPH)!.uses.push("downed zombie: Finish off (LMB)")
  return out
}

export function glyphSheetHtml(): string {
  const rows = [...glyphUses()].map(([glyph, { uses, words }]) => {
    const cells = SIZES.map((s) => `<span class="gs-cell">${promptGlyphHtml(glyph, uses[0] ?? glyph, s)}</span>`).join("")
    const kept = words.length ? `<small>word kept: ${esc(words.join(", "))}</small>` : ""
    return `<div class="gs-row">${cells}<span class="gs-name"><b>${esc(glyph)}</b><span>${esc(uses.join(" · "))}</span>${kept}</span></div>`
  })
  const head = `<div class="gs-row gs-head">${SIZES.map((s) => `<span class="gs-cell">${s}</span>`).join("")}<span class="gs-name">Glyph and prompts</span></div>`
  return `${head}${rows.join("")}`
}

/** Shows or hides the sheet over the game. */
export function showGlyphSheet(on: boolean, root: HTMLElement = document.body): void {
  let el = root.querySelector<HTMLElement>("#glyph-sheet")
  if (!on) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement("div")
    el.id = "glyph-sheet"
    el.className = "hud-panel"
    root.appendChild(el)
  }
  el.innerHTML = glyphSheetHtml()
}
