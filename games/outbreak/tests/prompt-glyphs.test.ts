import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ACTION_GLYPHS, actionGlyphHtml, glyphWeight } from "@arcade/kit/client/action-glyphs"
import { glyphUses } from "../src/hud/glyph-sheet"
import { FINISHER_GLYPH, PROMPT_ACTIONS, promptGlyph } from "../src/hud/prompt-glyphs"
import { DEFAULT_HUD_SETTINGS, hudControls } from "../src/hud/settings"

const SHARED = join(import.meta.dir, "../shared")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : []
  })
}

/** The action ids the interact union declares. */
function unionIds(): string[] {
  const src = readFileSync(join(SHARED, "interact.ts"), "utf8")
  const block = src.slice(src.indexOf("export type InteractActionId ="), src.indexOf("export type InteractAction ="))
  return [...block.matchAll(/\| "([a-z-]+)"/g)].map((m) => m[1]!)
}

const literals = (expr: string) => [...expr.matchAll(/"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2]!)

/** Every (id, label) the game's source can put in a world prompt. */
function promptsInSource(): { id: string; label: string; file: string }[] {
  const ids = new Set(unionIds())
  const out: { id: string; label: string; file: string }[] = []
  for (const file of sources(SHARED)) {
    const lines = readFileSync(file, "utf8").split("\n")
    for (const line of lines) {
      if (!/InteractAction|(primary|secondary|alt) = \{/.test(line)) continue
      for (const m of line.matchAll(/\{ id: "([a-z-]+)", label: (.*?)(?=, (?:hold|modifier)\b| \})/g)) {
        if (!ids.has(m[1]!)) continue
        for (const label of literals(m[2]!)) out.push({ id: m[1]!, label, file })
      }
    }
    // Vehicle prompts build their label in `actionLabel` first.
    for (const line of lines) {
      const m = /actionLabel = (.*)$/.exec(line)
      if (m) for (const label of literals(m[1]!).filter(Boolean)) out.push({ id: "enter", label, file })
    }
  }
  return out
}

const listed = (id: string, label: string) =>
  PROMPT_ACTIONS.some(({ action }) => action.id === id && (label.includes("${") ? action.label.startsWith(label.slice(0, label.indexOf("${"))) : action.label === label))

describe("prompt glyphs (D-25)", () => {
  test("every prompt label in the game's source is listed and has a glyph", () => {
    const found = promptsInSource()
    // Sanity: the scan sees the door, window, container, bench, closet, tripwire and vehicle prompts.
    expect(found.length).toBeGreaterThan(35)
    const missing = found.filter((p) => !listed(p.id, p.label)).map((p) => `${p.id} "${p.label}" (${p.file.split("/shared/")[1]})`)
    expect(missing).toEqual([])
  })

  test("every listed prompt maps to a glyph", () => {
    const none = PROMPT_ACTIONS.filter(({ kind, action }) => !promptGlyph(kind, action).glyph).map(({ kind, action }) => `${kind}: ${action.label}`)
    expect(none).toEqual([])
  })

  test("every action id the interact union declares either has prompts or is a channel with none", () => {
    const withPrompts = new Set(PROMPT_ACTIONS.map(({ action }) => action.id))
    // Boarding up runs as a timed channel from the hotbar, never as a world prompt.
    expect(unionIds().filter((id) => !withPrompts.has(id as never))).toEqual(["barricade"])
  })

  test("words stay only where the glyph is ambiguous", () => {
    const words = PROMPT_ACTIONS.map(({ kind, action }) => [`${kind}: ${action.label}`, promptGlyph(kind, action).word] as const).filter(([, w]) => w)
    expect(Object.fromEntries(words)).toEqual({ "door: Locked": "Locked", "drop: Pick up 9mm Ammo": "9mm Ammo", "vehicle: Ride": "Ride" })
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

  test("prompt icons are a Lab setting, on by default at 24 px", () => {
    expect(DEFAULT_HUD_SETTINGS.promptIcons).toBe(true)
    expect(DEFAULT_HUD_SETTINGS.promptIconSize).toBe(24)
    expect(hudControls.find((c) => c.key === "promptIconSize")).toBeDefined()
    expect(hudControls.find((c) => c.key === "promptIcons")).toBeDefined()
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
