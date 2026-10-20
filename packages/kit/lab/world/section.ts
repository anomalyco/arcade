import { BUSH_PRESETS, BUSH_PRESET_IDS, FOLIAGE_PARAM_SPECS, GRASS_PRESETS, GRASS_PRESET_IDS, TREE_PRESETS, TREE_PRESET_IDS, type FoliageKind } from "../../gpu/foliage"
import { LOOK_PRESETS, LOOK_PRESET_IDS, createLookControls } from "../../gpu/look"
import { MAX_SPOT_SHADOWS } from "../../gpu/shadows/spot-shadows"
import type { LabControl, LabSettings } from "../../lab-panel"
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, createWeatherControls } from "../../weather"
import type { LabContext, LabSection } from "../types"
import { PRESET_PICKS, WORLD_PRESETS, WORLD_PRESET_VERSION, worldPreset, type WorldPresetFile } from "./presets"
import { FLOOR, WORLD_CAMERA, WORLD_FOCUS } from "./scene"
import { CAR_PAINT_OPTIONS, WALL_PAINT_OPTIONS, WORLD_DEFAULTS, type DebugWorld } from "./world"

export const WORLD_TABS = [
  { label: "Look", groups: ["Look"] },
  { label: "Light", groups: ["Clock & light"] },
  { label: "Weather", groups: ["Weather"] },
  { label: "Materials", groups: ["Materials"] },
  { label: "Vegetation", groups: ["Vegetation"] },
] as const

type Value = string | number | boolean

/**
 * The Look and world section: every knob of the shared debug world in one Details column, tabbed Look, Light,
 * Weather, Materials and Vegetation, with the curated presets (`presets.ts`) on top. The look, weather and foliage
 * values are the kit's own settings objects, so a value found here is the value to promote into a game.
 */
export function createWorldSection(context: LabContext, world: DebugWorld): LabSection & { applyPreset(id: string): void; set(key: string, value: unknown): { key: string; before: unknown; value: unknown }; exportPreset(): WorldPresetFile; importPreset(raw: unknown): { ok: true } | { ok: false; error: string } } {
  const { stage } = context
  const settings: LabSettings = {}
  let preset = "day"
  const def = (key: string, get: () => Value, set: (v: Value) => void) =>
    Object.defineProperty(settings, key, { configurable: true, enumerable: true, get, set })

  def("worldPreset", () => preset, v => { preset = String(v) })
  for (const key of Object.keys(WORLD_DEFAULTS) as (keyof typeof WORLD_DEFAULTS)[]) {
    def(key, () => world.state[key], v => {
      ;(world.state as Record<string, Value>)[key] = v
      world.invalidate(key)
    })
  }
  def("lookPreset", () => world.look.preset, v => world.setLook(String(v)))
  for (const key of Object.keys(world.look)) {
    if (key === "preset") continue
    def(key, () => (world.look as Record<string, Value>)[key]!, v => { ;(world.look as Record<string, Value>)[key] = v })
  }
  def("weatherPreset", () => world.weather.preset, v => world.setWeather(String(v)))
  for (const key of Object.keys(world.weather)) {
    if (key === "preset") continue
    def(key, () => (world.weather as Record<string, Value>)[key]!, v => { ;(world.weather as Record<string, Value>)[key] = v })
  }
  for (const kind of ["tree", "bush", "grass"] as const) {
    def(`${kind}Preset`, () => world.vegetation[`${kind}Preset`], v => world.setVegetation(kind as FoliageKind, String(v)))
  }
  const vegetationSpecs = FOLIAGE_PARAM_SPECS.filter(s => s.boundary === "structural")
  for (const spec of vegetationSpecs) {
    def(spec.key, () => world.vegetation[spec.key], v => {
      world.vegetation[spec.key] = Number(v)
      world.invalidate(spec.key)
    })
  }

  const sync = () => context.sync()
  const regroup = (controls: LabControl[], group: string): LabControl[] =>
    controls.filter(c => c.type !== "action").map(c => ({ ...c, group, subsection: c.group?.replace(/^Weather · /, "") }))

  const controls: LabControl[] = [
    {
      key: "worldPreset",
      label: "Preset",
      group: "Preset",
      type: "select",
      options: WORLD_PRESETS.map(p => ({ value: p.id, label: p.label })),
      change: v => applyPreset(String(v)),
    },
    { key: "resetWorld", label: "Reset to default", group: "Preset", type: "action", run: () => applyPreset("day") },

    { key: "hour", label: "Time of day", group: "Clock & light", type: "range", min: 0, max: 24, step: 0.25, unit: "h" },
    { key: "timeScale", label: "Time-lapse", group: "Clock & light", type: "range", min: 0, max: 2400, step: 60, unit: "×" },
    { key: "lampPower", label: "Practical lamps", group: "Clock & light", type: "range", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "porch", label: "Porch lamp", group: "Clock & light" },
    { key: "headlights", label: "Car headlights", group: "Clock & light" },
    { key: "flashlight", label: "Flashlight", group: "Clock & light" },
    { key: "lightModel", label: "Light model", group: "Clock & light", type: "select", options: [{ value: "today", label: "Today" }, { value: "physical", label: "Physical (GGX + sky)" }] },
    { key: "envSpecular", label: "Sky reflections", group: "Clock & light", subsection: "Physical", type: "range", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "sphereLights", label: "Fixture size in highlights", group: "Clock & light", subsection: "Physical", type: "range", min: 0, max: 3, step: 0.05, unit: "×" },
    { key: "specularAA", label: "Specular anti-aliasing", group: "Clock & light", subsection: "Physical", type: "range", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "spotShadows", label: "Spot shadow maps", group: "Clock & light", subsection: "Physical", type: "range", min: 0, max: MAX_SPOT_SHADOWS, step: 1 },
    { key: "flicker", label: "Lamp flicker and failure", group: "Clock & light", type: "range", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "playing", label: "Animate", group: "Clock & light" },

    {
      key: "lookPreset",
      label: "Grade",
      group: "Look",
      type: "select",
      options: LOOK_PRESET_IDS.map(id => ({ value: id, label: LOOK_PRESETS[id].label })),
      change: sync,
    },
    ...regroup(createLookControls(settings, { includePresetPicker: false, onChange: sync }), "Look"),

    {
      key: "weatherPreset",
      label: "Weather",
      group: "Weather",
      type: "select",
      options: WEATHER_PRESET_IDS.map(id => ({ value: id, label: WEATHER_PRESETS[id].label })),
      change: sync,
    },
    { key: "lightning", label: "Lightning now", group: "Weather", type: "action", run: () => world.strike() },
    ...regroup(createWeatherControls(settings, { includePresetPicker: false, onChange: sync }), "Weather"),

    { key: "street", label: "Street", group: "Materials", type: "select", options: [{ value: FLOOR.wetAsphalt, label: "Wet asphalt" }, { value: FLOOR.asphalt, label: "Asphalt" }, { value: FLOOR.concrete, label: "Concrete" }] },
    { key: "walk", label: "Sidewalk", group: "Materials", type: "select", options: [{ value: FLOOR.sidewalk, label: "Concrete slabs" }, { value: FLOOR.flagstone, label: "Flagstones" }, { value: FLOOR.plaza, label: "Plaza tiles" }, { value: FLOOR.concrete, label: "Poured concrete" }] },
    { key: "path", label: "Garden path", group: "Materials", type: "select", options: [{ value: FLOOR.flagstone, label: "Flagstones" }, { value: FLOOR.sidewalk, label: "Concrete slabs" }, { value: FLOOR.plaza, label: "Plaza tiles" }] },
    { key: "floor", label: "Floor inside", group: "Materials", type: "select", options: [{ value: FLOOR.planks, label: "Planks" }, { value: FLOOR.carpet, label: "Carpet" }, { value: FLOOR.lino, label: "Linoleum" }] },
    { key: "wall", label: "Walls", group: "Materials", type: "select", options: WALL_PAINT_OPTIONS },
    { key: "car", label: "Car paint", group: "Materials", type: "select", options: CAR_PAINT_OPTIONS },

    { key: "tree", label: "Tree", group: "Vegetation" },
    { key: "treePreset", label: "Tree recipe", group: "Vegetation", type: "select", options: TREE_PRESET_IDS.map(id => ({ value: id, label: TREE_PRESETS[id].label })), change: sync },
    { key: "bush", label: "Bushes", group: "Vegetation" },
    { key: "bushPreset", label: "Bush recipe", group: "Vegetation", type: "select", options: BUSH_PRESET_IDS.map(id => ({ value: id, label: BUSH_PRESETS[id].label })), change: sync },
    { key: "grass", label: "Grass", group: "Vegetation" },
    { key: "grassPreset", label: "Grass recipe", group: "Vegetation", type: "select", options: GRASS_PRESET_IDS.map(id => ({ value: id, label: GRASS_PRESETS[id].label })), change: sync },
    ...vegetationSpecs.map((s): LabControl => ({ key: s.key, label: s.label, group: "Vegetation", subsection: s.group, type: "range", min: s.min, max: s.max, step: s.step, unit: s.unit })),
    { key: "seed", label: "Structure seed", group: "Vegetation", type: "range", min: 1, max: 999, step: 1, unit: "" },
  ]
  const byKey = new Map(controls.filter(c => c.type !== "action").map(c => [c.key, c]))
  if (byKey.size !== controls.filter(c => c.type !== "action").length) throw new Error("Look and world: two controls share a key")

  /** Checks one value against its control: a known key, a finite number in range, a listed choice or a boolean. */
  const validate = (key: string, value: unknown): Value => {
    const control = byKey.get(key)
    if (!control) throw new Error(`Unknown world setting "${key}".`)
    if ("min" in control) {
      const n = Number(value)
      if (typeof value === "boolean" || !Number.isFinite(n)) throw new Error(`"${key}" needs a number.`)
      return Math.max(control.min, Math.min(control.max, n))
    }
    if ("options" in control) {
      const option = control.options.find(o => String(o.value) === String(value))
      if (!option) throw new Error(`"${key}" must be one of ${control.options.map(o => o.value).join(", ")}.`)
      return option.value
    }
    if (typeof value !== "boolean") throw new Error(`"${key}" needs true or false.`)
    return value
  }

  const assign = (values: Readonly<Record<string, unknown>>) => {
    const checked = Object.entries(values).map(([k, v]) => [k, validate(k, v)] as const)
    const order = (k: string) => (PRESET_PICKS as readonly string[]).indexOf(k)
    checked.sort(([a], [b]) => (order(a) < 0 ? 99 : order(a)) - (order(b) < 0 ? 99 : order(b)))
    for (const [k, v] of checked) settings[k] = v
  }

  function applyPreset(id: string) {
    const p = worldPreset(id)
    if (!p) throw new Error(`Unknown world preset "${id}". Valid presets: ${WORLD_PRESETS.map(x => x.id).join(", ")}.`)
    for (const [k, v] of Object.entries(p.values)) validate(k, v)
    world.reset()
    assign(p.values)
    preset = p.id
    sync()
  }

  const set = (key: string, value: unknown) => {
    if (key === "worldPreset") {
      const before = preset
      applyPreset(String(value))
      return { key, before, value: preset }
    }
    const before = settings[key]
    settings[key] = validate(key, value)
    sync()
    return { key, before, value: settings[key] }
  }

  const exportPreset = (): WorldPresetFile => {
    const values: Record<string, Value> = {}
    for (const key of byKey.keys()) if (key !== "worldPreset") values[key] = settings[key] as Value
    return { version: WORLD_PRESET_VERSION, kind: "arcade.lab.world", preset, values }
  }

  const importPreset = (raw: unknown): { ok: true } | { ok: false; error: string } => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<WorldPresetFile> | null
      if (!data || typeof data !== "object") return { ok: false, error: "Not a world preset." }
      if (data.kind !== "arcade.lab.world") return { ok: false, error: `Not a world preset (kind ${String(data.kind)}).` }
      if (data.version !== WORLD_PRESET_VERSION) return { ok: false, error: `Unsupported world preset version ${String(data.version)}.` }
      if (!data.values || typeof data.values !== "object") return { ok: false, error: "World preset has no values." }
      for (const [k, v] of Object.entries(data.values)) validate(k, v)
      world.reset()
      assign(data.values)
      preset = typeof data.preset === "string" && worldPreset(data.preset) ? data.preset : preset
      sync()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  const section = {
    id: "world",
    label: "Look and world",
    settings,
    controls,
    tabs: WORLD_TABS,
    applyPreset,
    set,
    exportPreset,
    importPreset,
    enter() {
      stage.customRender = (w, h, view, _output, _debug, measure) => world.render(w, h, view, measure)
      world.frame()
    },
    leave() {
      stage.customRender = undefined
    },
    update(dt) {
      world.update(dt)
    },
    frameTarget: () => ({ x: WORLD_FOCUS[0], y: WORLD_FOCUS[1], z: WORLD_FOCUS[2], dist: WORLD_CAMERA.dist }),
    telemetry: () => world.telemetry(),
    library: {
      category: "looks",
      label: "Look and world",
      tag: "World",
      items: () => WORLD_PRESETS.map(p => ({ id: `world-${p.id}`, label: p.label, tag: p.idea, group: "World presets", select: () => applyPreset(p.id), active: () => preset === p.id })),
    },
    registerCommands(commands) {
      commands.registerAll([
        {
          id: "world.preset",
          label: "Apply World Preset",
          shortLabel: "World Preset",
          category: "Preset",
          undoable: true,
          args: { preset: { type: "string", required: true, enum: WORLD_PRESETS.map(p => p.id), description: "World preset id" } },
          enabled: () => true,
          run: (_ctx, args) => {
            applyPreset(String(args?.preset ?? "day"))
            return { preset, values: exportPreset().values }
          },
        },
        {
          id: "world.set",
          label: "Set World Setting",
          shortLabel: "World Set",
          category: "Inspector",
          undoable: true,
          args: { key: { type: "string", required: true, description: "Setting key" }, value: { type: "value", required: true, description: "Value" } },
          enabled: () => true,
          run: (_ctx, args) => set(String(args?.key), args?.value),
        },
        {
          id: "world.export",
          label: "Export World Preset",
          shortLabel: "World Export",
          category: "Preset",
          readOnly: true,
          enabled: () => true,
          run: () => exportPreset(),
        },
        {
          id: "world.import",
          label: "Import World Preset",
          shortLabel: "World Import",
          category: "Preset",
          undoable: true,
          args: { json: { type: "value", required: true, description: "World preset JSON (version 1)" } },
          enabled: () => true,
          run: (_ctx, args) => {
            const res = importPreset(args?.json)
            if (!res.ok) throw new Error(res.error)
            return { preset }
          },
        },
      ])
    },
  } satisfies LabSection & Record<string, unknown>
  return section
}
