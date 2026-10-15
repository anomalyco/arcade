import type { LabScene, SceneHost } from "./model"

/**
 * The shared patterns a lab can show. A kind picks the ones its subject needs; nothing else appears. `controls` is the
 * subject's knobs panel, `choices` the kind's named pickers (preset, backdrop, light…), `add` the kind's own add-picker
 * and the list of what it placed, `variants` the strip (digits pick, ⇧digits compare), `readouts` live numbers,
 * `measured` recorded numbers, `views` saved cameras, `notes` text and voice notes, `timeline` a scrubbable clock for
 * subjects that animate (a walk cycle, an explosion).
 */
export type LabPanel = "controls" | "choices" | "add" | "actions" | "variants" | "readouts" | "measured" | "views" | "notes" | "timeline" | "work"
export const LAB_PANELS: readonly LabPanel[] = ["controls", "choices", "add", "actions", "variants", "readouts", "measured", "views", "notes", "timeline", "work"]

/**
 * Letters a kind may give its actions. Every other letter is either a global editor shortcut (A add, C view, D
 * duplicate, F frame, G move, H home, K pause, L loop, M mute, N note, P play, R rotate, Z slow replay) or a Play
 * movement key (W A S D, E interact), so an action key never means something else in another lab. S and E are allowed
 * because actions only fire in Edit, where Play keys are idle.
 */
export const ACTION_KEYS = ["B", "E", "I", "J", "O", "Q", "S", "T", "U", "V", "X", "Y"] as const

/** Something the subject does on demand: fire a shot, take a hit. Runs a command; `L` loops every action in order. */
export type KindAction = { id: string; label: string; key: (typeof ACTION_KEYS)[number]; command: string; args?: Record<string, string | number | boolean> }

export type KindPart = { part: string; label: string }

/**
 * A named picker. `subject` choices are the thing being tuned (an explosion preset); `backdrop` choices are what it is
 * shown against (the street, the light). Choosing either is a value change on the lab, never a switch to another lab.
 */
export type KindChoice = {
  slot: string
  label: string
  role: "subject" | "backdrop"
  /** Part id prefix (`weather:` for `weather:storm`); parts listed here are the picker's options. */
  prefix: string
  parts?: readonly KindPart[]
}

/** A lab kind: the subject, what runs it, and the panels, choices and add-picker it gets. */
export type LabKind = {
  id: string
  label: string
  /** One plain line: what you look at in this kind of lab. */
  subject: string
  host: SceneHost
  panels: readonly LabPanel[]
  choices?: readonly KindChoice[]
  /** The add-picker's groups. Only kinds whose subject needs company (a vehicle course, walkers) have one. */
  add?: readonly { group: string; parts: readonly KindPart[] }[]
  /** On-demand events (the Feel kind's shot, shove, hit taken, kill, explosion), each with its own key. */
  actions?: readonly KindAction[]
  /** Play mode verb, for kinds with something to possess ("Drive", "Walk"). */
  play?: string
}

const ID = /^[a-z][a-z0-9-]{0,31}$/

/** Checks a kind list: ids, panels that exist, and that `add` and `choices` are listed when they have content. */
export function checkKinds(kinds: readonly LabKind[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const k of kinds) {
    const at = `kind "${k.id}"`
    if (!ID.test(k.id)) problems.push(`${at}: id must be lowercase letters, digits and dashes`)
    if (ids.has(k.id)) problems.push(`${at}: duplicate id`)
    ids.add(k.id)
    for (const p of k.panels) if (!LAB_PANELS.includes(p)) problems.push(`${at}: unknown panel "${p}"`)
    if (k.add?.length && !k.panels.includes("add")) problems.push(`${at}: has an add-picker but no "add" panel`)
    if (k.panels.includes("add") && !k.add?.length) problems.push(`${at}: "add" panel with nothing to add`)
    if (k.choices?.length && !k.panels.includes("choices")) problems.push(`${at}: has choices but no "choices" panel`)
    if (k.actions?.length && !k.panels.includes("actions")) problems.push(`${at}: has actions but no "actions" panel`)
    if (k.panels.includes("actions") && !k.actions?.length) problems.push(`${at}: "actions" panel with no actions`)
    const keys = new Set<string>()
    for (const a of k.actions ?? []) {
      if (!(ACTION_KEYS as readonly string[]).includes(a.key)) problems.push(`${at}: action "${a.id}" uses ${a.key}, which is not an action key (${ACTION_KEYS.join(" ")})`)
      if (keys.has(a.key)) problems.push(`${at}: key ${a.key} is used by two actions`)
      keys.add(a.key)
    }
    const slots = new Set<string>()
    for (const c of k.choices ?? []) {
      if (slots.has(c.slot)) problems.push(`${at}: choice slot "${c.slot}" twice`)
      slots.add(c.slot)
      for (const p of c.parts ?? []) if (!p.part.startsWith(c.prefix)) problems.push(`${at}: ${c.slot} option "${p.part}" doesn't start with "${c.prefix}"`)
    }
    for (const g of k.add ?? []) for (const p of g.parts) if (!/^[a-z][a-z0-9-]*:[^\s]+$/.test(p.part)) problems.push(`${at}: add part "${p.part}" must look like prop:cone`)
  }
  return problems
}

/** Checks a lab against its kind: a known kind, only the kind's choice slots and prefixes, extras only from its add-picker. */
export function checkAgainstKind(scene: LabScene, kinds: readonly LabKind[]): string[] {
  const kind = kinds.find(k => k.id === scene.kind)
  if (!kind) return [`unknown kind "${scene.kind}"`]
  const problems: string[] = []
  const slotProblems = (choices: LabScene["choices"], at: string) => {
    for (const [slot, ref] of Object.entries(choices)) {
      const c = kind.choices?.find(x => x.slot === slot)
      if (!c) problems.push(`${at}.${slot}: ${kind.label} labs have no "${slot}" choice`)
      else if (!ref.part.startsWith(c.prefix)) problems.push(`${at}.${slot}: "${ref.part}" is not a ${c.label.toLowerCase()} option`)
    }
  }
  slotProblems(scene.choices, "choices")
  for (const v of scene.variants) if (v.choices) slotProblems(v.choices, `variants.${v.id}.choices`)
  const addable = new Set((kind.add ?? []).flatMap(g => g.parts.map(p => p.part)))
  for (const e of scene.extras) if (!addable.has(e.part)) problems.push(`extras.${e.id}: ${kind.label} labs can't add "${e.part}"`)
  if (scene.host && kind.host.kind !== scene.host.kind) problems.push(`host: ${kind.label} labs run as a ${kind.host.kind}`)
  if (scene.host?.kind === "section" && kind.host.kind === "section" && scene.host.section !== kind.host.section) problems.push(`host: ${kind.label} labs run section "${kind.host.section}"`)
  return problems
}
