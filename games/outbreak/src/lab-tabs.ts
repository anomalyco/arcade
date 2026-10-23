import type { LabTab } from "@arcade/kit/lab-panel"

// The Backquote panel's tabs: over a hundred groups split six ways so each tab's folded group headers fit on one
// screen. Groups are matched by id, so groups added later find a tab; anything unmatched lands on World. Group ids,
// keys and values are untouched.
const tab = (label: string, pattern: RegExp, rest = false): LabTab => ({ label, groups: [], match: group => pattern.test(group), ...(rest ? { rest } : {}) })

export const OUTBREAK_LAB_TABS: readonly LabTab[] = [
  tab("Play", /^(Stamina|Survivor .*|Feel|Melee|Combat|Verbs|Crafting|Inventory|Characters|Death|Progression|Teammates|Bots|Co-op scaling|Controls|Onboarding|Interactions.*|Peek|HUD.*|Camera|Motion|View|Diagnostics|Map)$/),
  tab("Zombies", /^(AI|Hearing|Zombie.*|Hordes|Specials|Dogs|Unseen|Vision|Night ramp)$/),
  tab("World", /^(Pacing.*|Generation|World · .*|Details.*|Vegetation|Props|Physics|Discovery|Vehicle|Radios|Lights out|Flares|Bodies|Fire & explosives|Doors & barricades|Way Out|Secrets|Day cycle|Weather|Rugs & interiors|Blood)$/, true),
  tab("Look", /^(Look( · (Presets|Hero|Grade|Reflections|Character shadows|Contact shadows|Detail))?|Tone & Curve|Split-Tone & Palette|Lens & Film|Painterly & Ink|Camera filter|Anti-aliasing|Motion stability|Materials|Ground & Clutter|Driving FX|Weather · Manual look)$/),
  tab("Light", /^(Look · .*|Lighting.*|Flashlight|Lamp fog|Night lights|Bounced light|Atmosphere.*|World smoke|Beam dust|Fire & explosives look)$/),
  tab("Sound", /^(Volume|Sound.*)$/),
]
