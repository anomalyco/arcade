import type { LabValue } from "../../lab-navigation"
import type { LabStation, StationCommand, StationVariant } from "../stations/types"
import type { LabPresetSchema } from "../workbench"
import {
  SCENE_SCHEMA,
  checkScene,
  slug,
  type LabScene,
  type PartRef,
  type SceneCommand,
  type SceneVariant,
  type StageSlot,
} from "./model"

/**
 * Commands that choose a stage slot, and the command that tunes it. Read both ways: migration lifts the commands into
 * `stage`, and opening a scene turns `stage` back into the same commands (`stageCommands`).
 */
export const STAGE_COMMANDS: readonly { slot: StageSlot; prefix: string; preset: string; arg: string; set?: string }[] = [
  { slot: "weather", prefix: "weather", preset: "weather.preset", arg: "preset", set: "weather.set" },
  { slot: "look", prefix: "look", preset: "look.preset", arg: "preset", set: "look.set" },
  { slot: "look", prefix: "vignette", preset: "vignette.preset", arg: "direction" },
]
/** The Lab's global lighting rig, with its values as `scene.set-param` keys. */
export const CURRENT_LIGHTING = "lighting:current"

type Stage = { [S in StageSlot]?: PartRef }
type Lifted = { stage: Stage; set: Record<string, LabValue>; setup: SceneCommand[] }

const isValue = (v: unknown): v is LabValue => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))

/**
 * Splits a command list into stage choices, values (`scene.set-param`) and the commands left over. Opening runs them
 * in that order, so the split only happens when the list is already in that order; otherwise it stays as commands.
 */
export function liftCommands(list: readonly StationCommand[] = []): Lifted {
  const stage: Stage = {}
  const set: Record<string, LabValue> = {}
  const setup: SceneCommand[] = []
  let phase = 0
  let open: { slot: StageSlot; settings: Record<string, LabValue> } | null = null
  const verbatim = (): Lifted => ({ stage: {}, set: {}, setup: list.map(c => ({ ...c })) })
  for (const c of list) {
    const preset = STAGE_COMMANDS.find(s => s.preset === c.command)
    const tune = STAGE_COMMANDS.find(s => s.set === c.command)
    if (preset) {
      const value = c.args?.[preset.arg]
      if (phase > 0 || stage[preset.slot] || typeof value !== "string" || Object.keys(c.args ?? {}).length !== 1) return verbatim()
      open = { slot: preset.slot, settings: {} }
      stage[preset.slot] = { part: `${preset.prefix}:${value}` }
    } else if (tune) {
      const { key, value } = c.args ?? {}
      if (phase > 0 || open?.slot !== tune.slot || !stage[tune.slot]?.part.startsWith(`${tune.prefix}:`) || typeof key !== "string" || !isValue(value)) return verbatim()
      open.settings[key] = value
      stage[tune.slot] = { ...stage[tune.slot]!, settings: { ...open.settings } }
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
  return { stage, set, setup }
}

/** The commands that put a stage (or a variant's stage changes) in place; the inverse of `liftCommands`. */
export function stageCommands(stage: Stage = {}): SceneCommand[] {
  const out: SceneCommand[] = []
  for (const [slot, ref] of Object.entries(stage) as [StageSlot, PartRef][]) {
    if (ref.part === CURRENT_LIGHTING) {
      for (const [key, value] of Object.entries(ref.settings ?? {})) out.push({ command: "scene.set-param", args: { key, value } })
      continue
    }
    const [prefix, ...rest] = ref.part.split(":")
    const def = STAGE_COMMANDS.find(s => s.slot === slot && s.prefix === prefix)
    if (!def) throw new Error(`No command sets stage.${slot} to "${ref.part}"`)
    out.push({ command: def.preset, args: { [def.arg]: rest.join(":") } })
    for (const [key, value] of Object.entries(ref.settings ?? {})) {
      if (!def.set) throw new Error(`stage.${slot} part "${ref.part}" has settings but no command to set them`)
      out.push({ command: def.set, args: { key, value } })
    }
  }
  return out
}

const setParams = (set: Record<string, LabValue> = {}): SceneCommand[] =>
  Object.entries(set).map(([key, value]) => ({ command: "scene.set-param", args: { key, value } }))

/** What opening a section scene runs after selecting its host section, then what its variant adds. */
export function openCommands(scene: LabScene, variantId = scene.variant): SceneCommand[] {
  const variant = scene.variants.find(v => v.id === variantId)
  const host = scene.host?.kind === "section" ? scene.host.setup ?? [] : []
  return [
    ...stageCommands(scene.stage),
    ...setParams(scene.settings),
    ...host,
    ...(variant ? [...stageCommands(variant.stage), ...setParams(variant.set), ...(variant.setup ?? [])] : []),
  ]
}

// ── stations ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Migrated = { scenes: LabScene[]; notes: string[] }

const titleCase = (id: string) => id.replace(/-/g, " ").replace(/^./, c => c.toUpperCase())

function variantOf(v: StationVariant, lift: boolean): SceneVariant {
  const lifted = lift ? liftCommands(v.setup) : { stage: {}, set: {}, setup: [...(v.setup ?? [])] }
  return {
    id: v.id,
    label: v.label,
    ...(v.note ? { note: v.note } : {}),
    ...(Object.keys(lifted.stage).length ? { stage: lifted.stage } : {}),
    ...(Object.keys(lifted.set).length ? { set: lifted.set } : {}),
    ...(lifted.setup.length ? { setup: lifted.setup } : {}),
    ...(v.url ? { url: v.url } : {}),
  }
}

/**
 * A station file as kept scenes. Variants that switch to another section become a scene of their own (a variant can't
 * change what the scene runs), a variant that only opens a variation grid becomes the scene's grid, and setup commands
 * become stage choices and values where their order allows.
 */
export function scenesFromStation(station: LabStation, opts: { collection: string; now: string }): Migrated {
  const notes: string[] = []
  const base = {
    schema: SCENE_SCHEMA,
    collection: opts.collection,
    status: "kept" as const,
    created: opts.now,
    updated: opts.now,
    author: "station file",
    things: [],
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
    const scene: LabScene = {
      ...base,
      id: station.id,
      title: station.title,
      summary: station.summary,
      host: { kind: "page", url: station.demo.url },
      stage: {},
      settings: {},
      views: [],
      variants: (station.variants ?? []).map(v => variantOf(v, false)),
      ...(station.defaultVariant ? { variant: station.defaultVariant } : {}),
      ...(Object.keys(layout).length ? { layout } : {}),
      info,
    }
    return { scenes: [scene], notes }
  }

  const demo = station.demo
  const lifted = liftCommands(demo.setup)
  if (demo.setup?.length && lifted.setup.length === demo.setup.length) notes.push(`${station.id}: setup kept as commands`)
  const own: StationVariant[] = []
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
    } else own.push(v)
  }
  const views = demo.camera && demo.camera.yaw !== undefined && demo.camera.pitch !== undefined && demo.camera.distance !== undefined
    ? [{ id: "station", label: "Station camera", kind: "orbit" as const, yaw: demo.camera.yaw, pitch: demo.camera.pitch, distance: demo.camera.distance, ...(demo.camera.target ? { target: demo.camera.target } : {}) }]
    : []
  if (demo.camera && !views.length) notes.push(`${station.id}: partial camera dropped`)
  const scenes: LabScene[] = [{
    ...base,
    id: station.id,
    title: station.title,
    summary: station.summary,
    ...(demo.game ? { games: [demo.game] } : {}),
    host: { kind: "section", section: demo.section, ...(lifted.setup.length ? { setup: lifted.setup } : {}) },
    stage: lifted.stage,
    settings: lifted.set,
    views,
    ...(views.length ? { view: "station" } : {}),
    variants: own.map(v => variantOf(v, true)),
    ...(station.defaultVariant && own.some(v => v.id === station.defaultVariant) ? { variant: station.defaultVariant } : {}),
    ...(Object.keys(layout).length || grid ? { layout: { ...layout, ...(grid ? { grid } : {}) } } : {}),
    info,
  }]
  const taken = [station.id]
  for (const [section, variants] of elsewhere) {
    const id = slug(`${station.id}-${section}`, taken)
    taken.push(id)
    scenes.push({
      ...base,
      id,
      title: `${station.title} · ${titleCase(section)}`,
      summary: station.summary,
      ...(demo.game ? { games: [demo.game] } : {}),
      host: { kind: "section", section },
      stage: {},
      settings: {},
      views: [],
      variants: variants.map(v => variantOf(v, true)),
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
export function sceneFromPreset(preset: LabPresetSchema, opts: { id: string; title: string; now: string; collection?: string }): LabScene {
  if (preset.version !== 1 || typeof preset.section !== "string") throw new Error("Not a version 1 Lab preset")
  const things = [
    ...(preset.spawn?.characterId ? [{ id: "character", part: `character:${preset.spawn.characterId}` }] : []),
    ...(preset.spawn?.props ?? []).map((p, i) => ({ id: `prop-${i + 1}`, part: `prop:${p.kind}`, at: [p.x, p.y, p.z] as const, yaw: p.yaw })),
  ]
  const scene: LabScene = {
    schema: SCENE_SCHEMA,
    id: opts.id,
    collection: opts.collection ?? "drafts",
    title: opts.title,
    status: "draft",
    created: opts.now,
    updated: opts.now,
    host: { kind: "section", section: preset.section },
    stage: preset.lighting && Object.keys(preset.lighting).length ? { lighting: { part: CURRENT_LIGHTING, settings: { ...preset.lighting } } } : {},
    things,
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
export function scenesFromTour(tour: { id: string; title: string; steps: readonly TourStep[] }, opts: { collection: string; now: string }): Migrated {
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
    const lifted = liftCommands(step.setup)
    const game = url.searchParams.get("game")
    scenes.push({
      schema: SCENE_SCHEMA,
      id: slug(step.title, scenes.map(s => s.id)),
      collection: opts.collection,
      title: step.title,
      status: "kept",
      created: opts.now,
      updated: opts.now,
      author: `tour ${tour.id}`,
      ...(game ? { games: [game] } : {}),
      host: { kind: "section", section, ...(lifted.setup.length ? { setup: lifted.setup } : {}) },
      stage: lifted.stage,
      things: [],
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
