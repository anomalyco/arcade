import type { LabScene, SceneHost } from "./model"

/**
 * What a lab can show. Every piece is opt-in per kind, and a lab shows only what its subject needs (Kit, 2026-10-15:
 * "Shouldn't we just have things that are relevant to what we're experimenting with?"). Its subject's knobs come first.
 *
 * - `controls`: the subject's knobs (Details for a section lab, the page's own panel in a card for a page lab).
 * - `choices`: the kind's named pickers (preset, art direction). `add`: its add-picker. `objects`: the Outliner, only
 *   for kinds whose subject has placeable objects. `actions`: on-demand events with their own keys.
 * - `variants`: the Variants card, one choice per variant group (digits pick, ⇧digit wipes), shown when the lab has
 *   variants. `compare`: the A/B and variation-grid card, for section kinds with variants.
 * - `transport`: the clock (retrigger, pause, step, loop, speed) and Details' Retrigger row, for subjects that play out.
 *   `backdrop`: the room the subject is shown in (environment, room seed).
 * - `readouts`: live numbers. `measured`: recorded numbers. `views`: saved cameras. `timeline`: a scrubbable clock.
 * - `notes`: a text note card, for the rare lab that needs one. `work`: recent commits and branches.
 *
 * There is no voice-note panel: Kit gives feedback with Scrawl.
 */
export type LabPanel =
  | "controls" | "choices" | "add" | "objects" | "actions" | "variants" | "compare" | "transport" | "backdrop"
  | "readouts" | "measured" | "views" | "timeline" | "notes" | "work"
export const LAB_PANELS: readonly LabPanel[] = ["controls", "choices", "add", "objects", "actions", "variants", "compare", "transport", "backdrop", "readouts", "measured", "views", "timeline", "notes", "work"]

/** Panels that drive the Lab's own scene, so only section kinds can have them. */
const SECTION_PANELS: readonly LabPanel[] = ["objects", "compare", "transport", "backdrop"]

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
  /**
   * For section kinds: the Details groups the subject owns, in order. Without it Details shows the section's groups,
   * less the backdrop's (`BACKDROP_GROUPS`) unless the kind has `backdrop`.
   */
  groups?: readonly string[]
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
    if (k.panels.includes("add") && !k.panels.includes("objects")) problems.push(`${at}: "add" places objects, so it needs the "objects" panel (the Outliner)`)
    if (k.panels.includes("compare") && !k.panels.includes("variants")) problems.push(`${at}: "compare" needs "variants"`)
    if (k.host.kind === "page") for (const p of SECTION_PANELS) if (k.panels.includes(p)) problems.push(`${at}: "${p}" drives the Lab's own scene; a page lab can't have it`)
    if (k.groups && k.host.kind !== "section") problems.push(`${at}: only section kinds pick Details groups`)
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

/** Details groups that set the room a subject is shown in, hidden unless the kind has `backdrop`. */
export const BACKDROP_GROUPS: readonly string[] = ["Environment"]

/**
 * Pieces of the workbench a focused lab shows, from its kind. A page lab is its page: the Lab's own Outliner, Details,
 * transport, modes and compare tools all drive the Lab scene behind it, so it shows none of them.
 */
export type LabChrome = "edit" | "play" | "details" | "outliner" | "transport" | "compare" | "backdrop"
export function labChrome(kind: LabKind): LabChrome[] {
  if (kind.host.kind !== "section") return []
  const has = (p: LabPanel) => kind.panels.includes(p)
  const out: LabChrome[] = ["edit"]
  if (kind.play) out.push("play")
  if (has("controls")) out.push("details")
  if (has("objects")) out.push("outliner")
  if (has("transport")) out.push("transport")
  if (has("compare")) out.push("compare")
  if (has("backdrop")) out.push("backdrop")
  return out
}

/** Station cards (`StationWidgetKind`) a lab of this kind may show; a station's layout is trimmed to these. */
export type LabWidget = "status" | "controls" | "variants" | "compare" | "perf" | "metrics" | "changes" | "notes" | "links"
export function labWidgets(kind: LabKind, station: { variants?: readonly unknown[]; metrics?: readonly unknown[] }): LabWidget[] {
  const has = (p: LabPanel) => kind.panels.includes(p)
  const variants = Boolean(station.variants?.length)
  const out: LabWidget[] = ["status"]
  if (has("controls")) out.push("controls")
  if (has("variants") && variants) out.push("variants")
  if (has("compare") && variants && kind.host.kind === "section") out.push("compare")
  // The Lab's own frame time; a page lab's Lab scene is suspended behind the page.
  if (has("readouts") && kind.host.kind === "section") out.push("perf")
  if (has("measured") && station.metrics?.length) out.push("metrics")
  if (has("work")) out.push("changes")
  if (has("notes")) out.push("notes")
  return out
}

/** Which Details groups a section lab shows: its own `groups`, or every group but the backdrop's unless it has one. */
export function detailsGroups(kind: LabKind): ((group: string) => boolean) | null {
  if (kind.host.kind !== "section") return null
  if (kind.groups) { const own = new Set(kind.groups); return g => own.has(g) }
  if (kind.panels.includes("backdrop")) return null
  return g => !BACKDROP_GROUPS.includes(g)
}
