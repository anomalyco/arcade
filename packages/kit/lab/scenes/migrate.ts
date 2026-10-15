import type { LabValue } from "../../lab-navigation"
import type { LabStation, StationCommand, StationStatus, StationVariant } from "../stations/types"
import type { LabPresetSchema } from "../workbench"
import {
  SCENE_SCHEMA,
  checkScene,
  slug,
  type LabScene,
  type PartRef,
  type SceneChoices,
  type SceneCommand,
  type SceneHost,
  type SceneVariant,
} from "./model"

/**
 * Commands that make a choice, by part prefix, and the command that tunes it. Read both ways: migration lifts the
 * commands into `choices`, and opening a lab turns `choices` back into the same commands (`choiceCommands`).
 */
export const CHOICE_COMMANDS: readonly { prefix: string; preset: string; arg: string; set?: string }[] = [
  { prefix: "weather", preset: "weather.preset", arg: "preset", set: "weather.set" },
  { prefix: "look", preset: "look.preset", arg: "preset", set: "look.set" },
  { prefix: "vignette", preset: "vignette.preset", arg: "direction" },
  { prefix: "style", preset: "style.preset", arg: "style" },
]
/** The Lab's global lighting rig, with its values as `scene.set-param` keys. */
export const CURRENT_LIGHTING = "lighting:current"

type Lifted = { choices: SceneChoices; set: Record<string, LabValue>; setup: SceneCommand[] }
/** Which choice slot a part prefix fills in this kind of lab (`weather` is the subject's preset in a Weather lab). */
export type SlotFor = (prefix: string) => string | undefined

const isValue = (v: unknown): v is LabValue => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))

/**
 * Splits a command list into choices, values (`scene.set-param`) and the commands left over. Opening runs them in that
 * order, so the split only happens when the list is already in that order; otherwise it stays as commands.
 */
export function liftCommands(list: readonly StationCommand[] = [], slotFor: SlotFor = prefix => prefix): Lifted {
  const choices: SceneChoices = {}
  const set: Record<string, LabValue> = {}
  const setup: SceneCommand[] = []
  let phase = 0
  let open: { slot: string; prefix: string; settings: Record<string, LabValue> } | null = null
  const verbatim = (): Lifted => ({ choices: {}, set: {}, setup: list.map(c => ({ ...c })) })
  for (const c of list) {
    const preset = CHOICE_COMMANDS.find(s => s.preset === c.command)
    const tune = CHOICE_COMMANDS.find(s => s.set === c.command)
    if (preset) {
      const value = c.args?.[preset.arg]
      const slot = slotFor(preset.prefix)
      if (!slot || phase > 0 || choices[slot] || typeof value !== "string" || Object.keys(c.args ?? {}).length !== 1) return verbatim()
      open = { slot, prefix: preset.prefix, settings: {} }
      choices[slot] = { part: `${preset.prefix}:${value}` }
    } else if (tune) {
      const { key, value } = c.args ?? {}
      if (phase > 0 || open?.prefix !== tune.prefix || typeof key !== "string" || !isValue(value)) return verbatim()
      open.settings[key] = value
      choices[open.slot] = { ...choices[open.slot]!, settings: { ...open.settings } }
    } else if (c.command === "scene.set-param") {
      const { key, value } = c.args ?? {}
      if (phase > 1 || typeof key !== "string" || !isValue(value) || key in set) return verbatim()
      phase = 1
      set[key] = value
    } else {
      phase = 2
      setup.push({ ...c })
    }
  }
  return { choices, set, setup }
}

/** The commands that make a lab's (or a variant's) choices; the inverse of `liftCommands`. */
export function choiceCommands(choices: SceneChoices = {}): SceneCommand[] {
  const out: SceneCommand[] = []
  for (const [slot, ref] of Object.entries(choices) as [string, PartRef][]) {
    if (ref.part === CURRENT_LIGHTING) {
      for (const [key, value] of Object.entries(ref.settings ?? {})) out.push({ command: "scene.set-param", args: { key, value } })
      continue
    }
    const [prefix, ...rest] = ref.part.split(":")
    const def = CHOICE_COMMANDS.find(s => s.prefix === prefix)
    if (!def) throw new Error(`No command makes choice ${slot} = "${ref.part}"`)
    out.push({ command: def.preset, args: { [def.arg]: rest.join(":") } })
    for (const [key, value] of Object.entries(ref.settings ?? {})) {
      if (!def.set) throw new Error(`choice ${slot} "${ref.part}" has settings but no command to set them`)
      out.push({ command: def.set, args: { key, value } })
    }
  }
  return out
}

const setParams = (set: Record<string, LabValue> = {}): SceneCommand[] =>
  Object.entries(set).map(([key, value]) => ({ command: "scene.set-param", args: { key, value } }))

/** What opening a section lab runs after selecting its host section, then what its variant adds. */
export function openCommands(scene: LabScene, variantId = scene.variant): SceneCommand[] {
  const variant = scene.variants.find(v => v.id === variantId)
  const host = scene.host?.kind === "section" ? scene.host.setup ?? [] : []
  return [
    ...choiceCommands(scene.choices),
    ...setParams(scene.settings),
    ...host,
    ...(variant ? variantCommands(variant) : []),
  ]
}

/** The commands a variant runs on top of its lab. */
export function variantCommands(variant: SceneVariant): SceneCommand[] {
  return [...choiceCommands(variant.choices), ...setParams(variant.set), ...(variant.setup ?? [])]
}

const WORK: readonly StationStatus[] = ["live", "in-progress", "review", "planned"]

/**
 * A lab as a station, so the station workspace can open it: the lab's choices, values and host setup (plus its opening
 * variant) as the demo's setup, its variants as station variants, and its info back as station fields. The inverse of
 * `scenesFromStation` for what a station can hold; extras and views beyond one orbit camera have no station form yet.
 */
export function stationFromScene(scene: LabScene): LabStation {
  const info = scene.info ?? {}
  const camera = scene.views.find(v => v.id === scene.view && v.kind === "orbit")
  const work = WORK.find(w => w === info.work) ?? (scene.status === "draft" ? "in-progress" : "live")
  return {
    id: scene.id,
    title: scene.title,
    summary: scene.summary ?? "",
    order: 0,
    status: work,
    ...(info.workNote ? { statusNote: info.workNote } : {}),
    ...(info.color !== undefined ? { color: info.color } : {}),
    demo: scene.host?.kind === "page"
      ? { kind: "page", url: scene.host.url }
      : {
        kind: "section",
        section: scene.host?.kind === "section" ? scene.host.section : "effects",
        ...(scene.games?.[0] ? { game: scene.games[0] } : {}),
        setup: openCommands(scene),
        ...(camera?.kind === "orbit" ? { camera: { yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance, ...(camera.target ? { target: camera.target } : {}) } } : {}),
      },
    variants: scene.variants.map(v => ({
      id: v.id,
      label: v.label,
      ...(v.note ? { note: v.note } : {}),
      setup: variantCommands(v),
      ...(v.url ? { url: v.url } : {}),
    })),
    ...(scene.variant ? { defaultVariant: scene.variant } : {}),
    ...(scene.layout?.grid ? { grid: scene.layout.grid } : {}),
    ...(info.board ? { board: info.board } : {}),
    ...(info.metrics?.length ? { metrics: info.metrics } : {}),
    ...(info.links?.length ? { links: info.links } : {}),
    ...(info.paths?.length ? { paths: info.paths } : {}),
    ...(info.branches?.length ? { branches: info.branches } : {}),
  }
}

// ── stations ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Migrated = { scenes: LabScene[]; notes: string[] }

const titleCase = (id: string) => id.replace(/-/g, " ").replace(/^./, c => c.toUpperCase())

function variantOf(v: StationVariant, slotFor: SlotFor | null): SceneVariant {
  const lifted = slotFor ? liftCommands(v.setup, slotFor) : { choices: {}, set: {}, setup: [...(v.setup ?? [])] }
  return {
    id: v.id,
    label: v.label,
    ...(v.note ? { note: v.note } : {}),
    ...(Object.keys(lifted.choices).length ? { choices: lifted.choices } : {}),
    ...(Object.keys(lifted.set).length ? { set: lifted.set } : {}),
    ...(lifted.setup.length ? { setup: lifted.setup } : {}),
    ...(v.url ? { url: v.url } : {}),
  }
}

/**
 * A station file as kept scenes. Variants that switch to another section become a scene of their own (a variant can't
 * change what the scene runs), a variant that only opens a variation grid becomes the scene's grid, and setup commands
 * become choices and values where their order allows. `kindOf` names the lab kind that runs a host and which choice
 * slot each command prefix fills in it.
 */
export type KindOf = (host: SceneHost, station?: string) => { kind: string; slotFor: SlotFor }

export function scenesFromStation(station: LabStation, opts: { collection: string; now: string; kindOf: KindOf }): Migrated {
  const notes: string[] = []
  const base = {
    schema: SCENE_SCHEMA,
    collection: opts.collection,
    status: "kept" as const,
    created: opts.now,
    updated: opts.now,
    author: "station file",
    extras: [],
    seeds: {},
  } satisfies Partial<LabScene>
  const info = {
    ...(station.board ? { board: station.board } : {}),
    ...(station.metrics?.length ? { metrics: station.metrics } : {}),
    ...(station.links?.length ? { links: station.links } : {}),
    ...(station.paths?.length ? { paths: station.paths } : {}),
    ...(station.branches?.length ? { branches: station.branches } : {}),
    work: station.status,
    ...(station.statusNote ? { workNote: station.statusNote } : {}),
    ...(station.color !== undefined ? { color: station.color } : {}),
  }
  const featured = Object.values(station.layout ?? {})
    .flat()
    .filter(w => w?.widget === "controls")
    .reduce<{ groups: string[]; keys: string[] }>((acc, w) => ({ groups: [...acc.groups, ...(w.groups ?? [])], keys: [...acc.keys, ...(w.keys ?? [])] }), { groups: [], keys: [] })
  const layout = {
    ...(featured.groups.length || featured.keys.length ? { featured: { ...(featured.groups.length ? { groups: featured.groups } : {}), ...(featured.keys.length ? { keys: featured.keys } : {}) } } : {}),
    ...(station.grid ? { grid: station.grid } : {}),
  }

  if (station.demo.kind === "page") {
    const host: SceneHost = { kind: "page", url: station.demo.url }
    const scene: LabScene = {
      ...base,
      id: station.id,
      kind: opts.kindOf(host, station.id).kind,
      title: station.title,
      summary: station.summary,
      host,
      choices: {},
      settings: {},
      views: [],
      variants: (station.variants ?? []).map(v => variantOf(v, null)),
      ...(station.defaultVariant ? { variant: station.defaultVariant } : {}),
      ...(Object.keys(layout).length ? { layout } : {}),
      info,
    }
    return { scenes: [scene], notes }
  }

  const demo = station.demo
  const own = opts.kindOf({ kind: "section", section: demo.section }, station.id)
  const lifted = liftCommands(demo.setup, own.slotFor)
  if (demo.setup?.length && lifted.setup.length === demo.setup.length) notes.push(`${station.id}: setup kept as commands`)
  const mine: StationVariant[] = []
  const elsewhere = new Map<string, StationVariant[]>()
  let grid = station.grid
  for (const v of station.variants ?? []) {
    const first = v.setup?.[0]
    const target = first?.command === "scene.select-section" ? String(first.args?.id ?? "") : ""
    if (target && target !== demo.section) {
      elsewhere.set(target, [...(elsewhere.get(target) ?? []), { ...v, setup: v.setup!.slice(1) }])
    } else if (v.setup?.length === 1 && v.setup[0]!.command === "grid.open" && typeof v.setup[0]!.args?.preset === "string") {
      if (!grid) grid = String(v.setup[0]!.args.preset)
      notes.push(`${station.id}: variant "${v.id}" opened a grid; it is the scene's grid now`)
    } else mine.push(v)
  }
  const views = demo.camera && demo.camera.yaw !== undefined && demo.camera.pitch !== undefined && demo.camera.distance !== undefined
    ? [{ id: "station", label: "Station camera", kind: "orbit" as const, yaw: demo.camera.yaw, pitch: demo.camera.pitch, distance: demo.camera.distance, ...(demo.camera.target ? { target: demo.camera.target } : {}) }]
    : []
  if (demo.camera && !views.length) notes.push(`${station.id}: partial camera dropped`)
  const scenes: LabScene[] = [{
    ...base,
    id: station.id,
    kind: own.kind,
    title: station.title,
    summary: station.summary,
    ...(demo.game ? { games: [demo.game] } : {}),
    host: { kind: "section", section: demo.section, ...(lifted.setup.length ? { setup: lifted.setup } : {}) },
    choices: lifted.choices,
    settings: lifted.set,
    views,
    ...(views.length ? { view: "station" } : {}),
    variants: mine.map(v => variantOf(v, own.slotFor)),
    ...(station.defaultVariant && mine.some(v => v.id === station.defaultVariant) ? { variant: station.defaultVariant } : {}),
    ...(Object.keys(layout).length || grid ? { layout: { ...layout, ...(grid ? { grid } : {}) } } : {}),
    info,
  }]
  const taken = [station.id]
  for (const [section, variants] of elsewhere) {
    const id = slug(`${station.id}-${section}`, taken)
    taken.push(id)
    const other = opts.kindOf({ kind: "section", section })
    scenes.push({
      ...base,
      id,
      kind: other.kind,
      title: `${station.title} · ${titleCase(section)}`,
      summary: station.summary,
      ...(demo.game ? { games: [demo.game] } : {}),
      host: { kind: "section", section },
      choices: {},
      settings: {},
      views: [],
      variants: variants.map(v => variantOf(v, other.slotFor)),
      variant: variants[0]!.id,
      info,
    })
    notes.push(`${station.id}: ${variants.length} variant(s) switching to "${section}" became scene "${id}"`)
  }
  for (const scene of scenes) {
    const checked = checkScene(scene)
    if (!checked.ok) throw new Error(`station ${station.id} → ${scene.id}: ${checked.problems.join("; ")}`)
  }
  return { scenes, notes }
}

// ── presets and tours ──────────────────────────────────────────────────────────────────────────────────────────────

/** A `LabPresetSchema` v1 export (⋯ Export preset) as a draft scene. */
export function sceneFromPreset(preset: LabPresetSchema, opts: { id: string; kind: string; title: string; now: string; collection?: string }): LabScene {
  if (preset.version !== 1 || typeof preset.section !== "string") throw new Error("Not a version 1 Lab preset")
  const extras = [
    ...(preset.spawn?.characterId ? [{ id: "character", part: `character:${preset.spawn.characterId}` }] : []),
    ...(preset.spawn?.props ?? []).map((p, i) => ({ id: `prop-${i + 1}`, part: `prop:${p.kind}`, at: [p.x, p.y, p.z] as const, yaw: p.yaw })),
  ]
  const scene: LabScene = {
    schema: SCENE_SCHEMA,
    id: opts.id,
    collection: opts.collection ?? "drafts",
    kind: opts.kind,
    title: opts.title,
    status: "draft",
    created: opts.now,
    updated: opts.now,
    host: { kind: "section", section: preset.section },
    choices: preset.lighting && Object.keys(preset.lighting).length ? { light: { part: CURRENT_LIGHTING, settings: { ...preset.lighting } } } : {},
    extras,
    settings: { ...preset.settings },
    seeds: {},
    views: [],
    variants: [],
  }
  const checked = checkScene(scene)
  if (!checked.ok) throw new Error(checked.problems.join("; "))
  return scene
}

export type TourStep = { kind?: string; title: string; body?: string; url?: string; setup?: readonly StationCommand[]; preset?: string }

/** A tour's Lab steps as a review collection's scenes. Page steps (images, markdown) stay tour pages. */
export function scenesFromTour(tour: { id: string; title: string; steps: readonly TourStep[] }, opts: { collection: string; now: string; kindOf: KindOf }): Migrated {
  const scenes: LabScene[] = []
  const notes: string[] = []
  tour.steps.forEach((step, i) => {
    const url = step.url ? new URL(step.url, "https://x.invalid") : null
    if (step.kind === "page" || !url || !url.pathname.startsWith("/arcade/lab")) {
      notes.push(`${tour.id} step ${i + 1} "${step.title}": not a Lab scene, kept as a tour page`)
      return
    }
    const hash = url.hash.replace(/^#(section=)?/, "").split("/")[0]
    const section = url.searchParams.get("section") ?? (hash || null)
    if (!section) {
      notes.push(`${tour.id} step ${i + 1} "${step.title}": no section in its URL`)
      return
    }
    const kind = opts.kindOf({ kind: "section", section })
    const lifted = liftCommands(step.setup, kind.slotFor)
    const game = url.searchParams.get("game")
    scenes.push({
      schema: SCENE_SCHEMA,
      id: slug(step.title, scenes.map(s => s.id)),
      collection: opts.collection,
      kind: kind.kind,
      title: step.title,
      status: "kept",
      created: opts.now,
      updated: opts.now,
      author: `tour ${tour.id}`,
      ...(game ? { games: [game] } : {}),
      host: { kind: "section", section, ...(lifted.setup.length ? { setup: lifted.setup } : {}) },
      choices: lifted.choices,
      extras: [],
      settings: lifted.set,
      seeds: {},
      views: [],
      variants: [],
      ...(step.kind === "grid" && step.preset ? { layout: { grid: step.preset } } : {}),
      ...(step.body ? { note: step.body } : {}),
    })
  })
  return { scenes, notes }
}
