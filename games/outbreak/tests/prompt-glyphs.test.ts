import { describe, expect, test } from "bun:test"
import { ACTION_GLYPHS, actionGlyphHtml, glyphWeight } from "@arcade/kit/client/action-glyphs"
import { glyphUses } from "../src/hud/glyph-sheet"
import { FINISHER_GLYPH, PROMPT_ACTIONS, promptGlyph } from "../src/hud/prompt-glyphs"

describe("prompt glyphs (D-25)", () => {
  test("every listed prompt maps to a glyph", () => {
    const none = PROMPT_ACTIONS.filter(({ kind, action }) => !promptGlyph(kind, action).glyph).map(({ kind, action }) => `${kind}: ${action.label}`)
    expect(none).toEqual([])
  })

  test("words stay only where the glyph is ambiguous", () => {
    const words = PROMPT_ACTIONS.map(({ kind, action }) => [`${kind}: ${action.label}`, promptGlyph(kind, action).word] as const).filter(([, w]) => w)
    expect(Object.fromEntries(words)).toEqual({ "door: Locked": "Locked", "drop: Pick up 9mm Ammo": "9mm Ammo", "bench: Recipes": "Recipes", "vehicle: Ride": "Ride" })
  })

  test("doors and windows share verbs but not glyphs", () => {
    const open = (kind: string) => promptGlyph(kind, { id: "toggle", label: "Open" }).glyph
    const close = (kind: string) => promptGlyph(kind, { id: "toggle", label: "Close" }).glyph
    expect([open("door"), close("door"), open("window"), close("window")]).toEqual(["door-open", "door-close", "window-open", "window-close"])
    expect(promptGlyph("door", { id: "lock", label: "Lock", hold: true }).glyph).toBe("lock")
    expect(promptGlyph("door", { id: "lock", label: "Unlock" }).glyph).toBe("unlock")
    expect(promptGlyph("fence", { id: "climb", label: "Vault" }).glyph).toBe("vault")
    expect(promptGlyph("window", { id: "climb", label: "Climb" }).glyph).toBe("climb")
  })

  test("an unknown action keeps its label and draws no glyph", () => {
    expect(promptGlyph("door", { id: "toggle", label: "Slam" })).toEqual({ glyph: null, word: "Slam", label: "Slam" })
    expect(promptGlyph("vehicle", { id: "enter", label: "Hotwire" })).toEqual({ glyph: null, word: "Hotwire", label: "Hotwire" })
  })

  test("every glyph in the set is used by a prompt or the finisher cue", () => {
    const unused = [...glyphUses()].filter(([, u]) => !u.uses.length).map(([g]) => g)
    expect(unused).toEqual([])
    expect(glyphUses().get(FINISHER_GLYPH)!.uses).toContain("downed zombie: Finish off (LMB)")
  })

})

describe("glyph markup", () => {
  test("whole-pixel boxes on the 24-unit grid in currentColor, labelled or hidden", () => {
    for (const g of ACTION_GLYPHS) {
      for (const size of [16, 20, 24]) {
        const html = actionGlyphHtml(g, { size, label: "Open" })
        expect(html).toContain(`width="${size}" height="${size}" viewBox="0 0 24 24"`)
        expect(html).toContain('fill="currentColor"')
        expect(html).toContain('role="img" aria-label="Open"><title>Open</title>')
        expect(html).not.toMatch(/NaN|undefined/)
      }
    }
    expect(actionGlyphHtml("lock", { size: 19.6 })).toContain('width="20" height="20"')
    expect(actionGlyphHtml("lock")).toContain('aria-hidden="true"')
  })

  test("smaller sizes get heavier outlines", () => {
    expect(glyphWeight(16)).toBeGreaterThan(glyphWeight(20))
    expect(glyphWeight(20)).toBeGreaterThan(glyphWeight(24))
    expect(glyphWeight(24)).toBe(0)
    expect(actionGlyphHtml("lock", { size: 24 })).toContain('stroke="none"')
  })
})
