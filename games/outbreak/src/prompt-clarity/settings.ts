import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: the D-25 prompt (a key cap and a glyph, no words, nothing on the target, boarding unprompted). */
export const PROMPT_CLARITY_TODAY = 0
/** AR-89 (default): verbs while they are new, the target outlined, B in door and window prompts, a stamp after. */
export const PROMPT_CLARITY_CLEAR = 1

/** Prompt clarity (AR-89, after Aiden: "everything is E"); the values live in the HUD settings (Backquote › Controls). */
export const DEFAULT_PROMPT_CLARITY_SETTINGS = {
  /** 1 Clear (default), 0 Today. Off turns every switch below off. */
  promptClarity: PROMPT_CLARITY_CLEAR,
  /** Each action keeps its verb beside its glyph until it has been done this many times in this browser (0 never). */
  promptTeachUses: 3,
  /** Corner brackets on the exact thing E will act on; they close in while E is held. */
  promptHighlight: true,
  /** Door and window prompts show B with the board-up glyph, and how many boards are already up. */
  promptBoardKey: true,
  /** The result's glyph rises off the target when a door, window, barricade or container changes. */
  promptStamp: true,
}

export type PromptClaritySettings = typeof DEFAULT_PROMPT_CLARITY_SETTINGS

/** Whether one part of the clarity pass is on (the master switch gates them all). */
export function clarityOn(s: PromptClaritySettings, key: "promptHighlight" | "promptBoardKey" | "promptStamp"): boolean {
  return s.promptClarity !== PROMPT_CLARITY_TODAY && Boolean(s[key])
}

/** How many uses an action keeps its verb for, 0 when the pass is off. */
export function teachUses(s: PromptClaritySettings): number {
  return s.promptClarity === PROMPT_CLARITY_TODAY ? 0 : Math.max(0, Math.round(s.promptTeachUses))
}

export const promptClarityControls: LabControl[] = [
  {
    key: "promptClarity",
    label: "Prompt clarity",
    group: "Controls",
    options: [
      { label: "Clear (verbs, outline, B, stamp)", value: PROMPT_CLARITY_CLEAR },
      { label: "Today (glyph only)", value: PROMPT_CLARITY_TODAY },
    ],
  },
  { key: "promptTeachUses", label: "Verb shown for the first", group: "Controls", min: 0, max: 10, step: 1, unit: "uses" },
  { key: "promptHighlight", label: "Outline what E acts on", group: "Controls" },
  { key: "promptBoardKey", label: "Show B (board up) on doors and windows", group: "Controls" },
  { key: "promptStamp", label: "Stamp the result", group: "Controls" },
]
