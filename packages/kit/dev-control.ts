import {
  LabCommandRegistry,
  type LabCommandDescriptor,
  type LabCommandInvokeResult,
  type LabSceneState,
} from "./lab-commands"
import {
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  randomizeLookSettings,
  resolveLookGroup,
  resolveLookPresetId,
} from "./gpu/look"
import { formatLabValue, inferControlUnit, type LabControl, type LabPanel, type LabRow, type LabValue } from "./lab-panel"
import type { Stage } from "./lab/stage"

declare global {
  interface ImportMetaEnv {
    DEV: boolean
  }
  interface Window {
    __arcadeDevControl?: PageControlRuntime
    __arcadeSubmitListeners?: Set<() => void>
    __arcadeSubmitHooked?: boolean
  }
}

export type DevPageKind = "hub" | "lab" | "catalogue" | "characters" | "game"

export type DevNoteTarget = {
  objectId?: string
  setting?: string
  rect?: [number, number, number, number]
  world?: [number, number, number]
  selector?: string
}

export type DevNoteResolvedRect = {
  x: number
  y: number
  width: number
  height: number
  shape?: "pill" | "rect"
  label?: string
}

export type DevNotePayload = {
  title: string
  body?: string
  step?: string
  accent?: string
  target?: DevNoteTarget
  dismissible: boolean
  tourId?: string
  stepIndex?: number
  stepCount?: number
  prevUrl?: string
  nextUrl?: string
  singleTab?: boolean
}

export type TourSetupCommand = {
  command: string
  args?: Record<string, unknown>
}

export type TourPageImage = {
  src: string
  label?: string
  caption?: string
  tag?: string
}

export type TourStepDefinition = {
  kind?: "scene" | "page" | "grid"
  title: string
  body?: string
  url: string
  setup: TourSetupCommand[]
  target?: DevNoteTarget
  accent?: string
  dismissible?: boolean
  markdown?: string
  images?: TourPageImage[]
  preset?: string
  section?: string
  cols?: number
  tiles?: Record<string, unknown>[]
}

export type TourDefinition = {
  id: string
  title?: string
  baseUrl?: string
  singleTab?: boolean
  steps: TourStepDefinition[]
}

export type DevPageSummary = {
  id: string
  kind: DevPageKind
  url: string
  pathname: string
  hash: string
  title: string
  focused: boolean
  visible: boolean
  mode: "edit" | "play" | "view"
  section?: string
  note?: DevNotePayload | null
  tour?: { id: string; step: number; singleTab?: boolean; applied?: boolean } | null
  commands: LabCommandDescriptor[]
  updatedAt: number
  lastActiveAt: number
}

export type DevControlBusyState = {
  busy: boolean
  reason?: string
}

export type DevControlAdapter = {
  kind: DevPageKind
  commands: LabCommandRegistry
  getState: () => Record<string, unknown> | LabSceneState | Promise<Record<string, unknown> | LabSceneState>
  getCanvas?: () => HTMLCanvasElement | null
  captureCanvas?: (target: HTMLCanvasElement) => Promise<void> | void
  isBusy?: () => DevControlBusyState
  getMode?: () => "edit" | "play" | "view"
  getSection?: () => string | undefined
  onIndicator?: (text: string, isError?: boolean) => void
  resolveTargetRect?: (target: DevNoteTarget) => DevNoteResolvedRect | null
}

export type StageCameraCommandOptions = {
  stage: Stage
  render: () => Promise<unknown> | unknown
  canEdit?: () => boolean
  disabledReason?: () => string
  resolveFrameTarget?: (idOrName?: string) => { x: number; y: number; z: number; dist?: number; label?: string } | null
}

export type PanelLabCommandOptions = {
  getPanels: () => readonly LabPanel[]
  canEdit?: () => boolean
  disabledReason?: () => string
  render?: () => Promise<unknown> | unknown
  extraGet?: (path?: string) => unknown
  extraSet?: (path: string, value: unknown) => { key: string; label: string; before: unknown; value: unknown } | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round4 = (n: number) => Math.round(n * 10000) / 10000

export function readStageCameraState(stage: Stage) {
  stage.updateCamera()
  return {
    focus: [round3(stage.focus[0]!), round3(stage.focus[1]!), round3(stage.focus[2]!)] as [number, number, number],
    target: [round3(stage.focus[0]!), round3(stage.focus[1]!), round3(stage.focus[2]!)] as [number, number, number],
    yaw: round4(stage.camYaw),
    pitch: round4(stage.camPitch),
    distance: round3(stage.camDist),
    orbit: round2((stage.camYaw * 180) / Math.PI),
    elevation: round2((stage.camPitch * 180) / Math.PI),
    eye: [round3(stage.eye[0]!), round3(stage.eye[1]!), round3(stage.eye[2]!)] as [number, number, number],
  }
}

export function registerStageCameraCommands(commands: LabCommandRegistry, opts: StageCameraCommandOptions): void {
  const { stage, render, canEdit, disabledReason, resolveFrameTarget } = opts

  commands.registerAll([
    {
      id: "camera.get",
      label: "Get Camera State",
      shortLabel: "Camera Get",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      run: () => readStageCameraState(stage),
    },
    {
      id: "camera.set",
      label: "Set Camera Orientation & Target",
      shortLabel: "Camera Set",
      category: "Scene",
      undoable: true,
      args: {
        orbit: { type: "number", min: -3600, max: 3600, description: "Orbit yaw in degrees" },
        elevation: { type: "number", min: 5, max: 89, description: "Elevation pitch in degrees (10..83)" },
        distance: { type: "number", min: 4, max: 75, description: "Distance in metres (4..75)" },
        targetX: { type: "number", description: "Target X coordinate" },
        targetY: { type: "number", description: "Target Y coordinate" },
        targetZ: { type: "number", description: "Target Z coordinate" },
        frame: { type: "string", description: "Object ID/name to frame, or 'scene'" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const a = args ?? {}
        const hasOrbit = typeof a.orbit === "number"
        const hasElevation = typeof a.elevation === "number"
        const hasDistance = typeof a.distance === "number"
        const hasTarget = typeof a.targetX === "number" || typeof a.targetY === "number" || typeof a.targetZ === "number"
        const hasFrame = typeof a.frame === "string" && a.frame.trim().length > 0

        if (!hasOrbit && !hasElevation && !hasDistance && !hasTarget && !hasFrame) {
          throw new Error("camera.set requires at least one of: orbit, elevation, distance, targetX/Y/Z, frame.")
        }

        if (hasFrame) {
          const query = String(a.frame).trim()
          const framed = resolveFrameTarget
            ? resolveFrameTarget(query)
            : query === "scene" || query === "origin" || query === "default"
              ? { x: 0, y: 0.5, z: 0, dist: 15 }
              : null
          if (!framed) {
            throw new Error(`Unknown frame target "${query}".`)
          }
          stage.frameTarget(framed.x, framed.y, framed.z, hasDistance ? Number(a.distance) : (framed.dist ?? stage.camDist))
        }
        if (hasTarget) {
          if (typeof a.targetX === "number") stage.focus[0] = a.targetX
          if (typeof a.targetY === "number") stage.focus[1] = a.targetY
          if (typeof a.targetZ === "number") stage.focus[2] = a.targetZ
          stage.camCustom = true
        }
        if (hasOrbit) {
          stage.camYaw = (Number(a.orbit) * Math.PI) / 180
          stage.camCustom = true
        }
        if (hasElevation) {
          stage.camPitch = Math.max(0.18, Math.min(1.45, (Number(a.elevation) * Math.PI) / 180))
          stage.camCustom = true
        }
        if (hasDistance) {
          stage.camDist = Math.max(4, Math.min(75, Number(a.distance)))
          stage.camCustom = true
        }
        stage.updateCamera()
        void render()
        return readStageCameraState(stage)
      },
    },
  ])
}

const normalizeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

export function formatControlValue(control: LabControl, val: LabValue): string {
  if ("min" in control) {
    const unit = inferControlUnit(control.key, control.label, control.unit)
    return formatLabValue(val, control.step, unit)
  }
  return String(val)
}

export function findControlRow(
  panels: readonly LabPanel[],
  rawPath: string,
): { panel: LabPanel; row: LabRow; control: LabControl } | null {
  const trimmed = rawPath.trim()
  const dotIdx = trimmed.indexOf(".")
  const prefix = dotIdx > 0 ? trimmed.slice(0, dotIdx).trim().toLowerCase() : null
  const leaf = dotIdx > 0 ? trimmed.slice(dotIdx + 1).trim() : trimmed
  const leafLower = leaf.toLowerCase()
  const leafSlug = normalizeSlug(leaf)

  const allRows: { panel: LabPanel; row: LabRow; control: LabControl }[] = []
  for (const panel of panels) {
    for (const row of panel.navigation.rows) {
      if (row.control) allRows.push({ panel, row, control: row.control })
    }
  }

  for (const entry of allRows) {
    const { control } = entry
    if (control.key === trimmed || control.key.toLowerCase() === trimmed.toLowerCase()) return entry
  }
  for (const entry of allRows) {
    const { row, control } = entry
    if (prefix && normalizeSlug(row.group) !== normalizeSlug(prefix)) continue
    if (control.key === leaf || control.key.toLowerCase() === leafLower) return entry
  }
  for (const entry of allRows) {
    const { row, control } = entry
    if (prefix && !normalizeSlug(row.group).includes(normalizeSlug(prefix))) continue
    if (
      control.label.toLowerCase() === leafLower ||
      normalizeSlug(control.label) === leafSlug ||
      normalizeSlug(control.key) === leafSlug ||
      normalizeSlug(`${row.group}.${control.key}`) === normalizeSlug(trimmed)
    ) {
      return entry
    }
  }
  return null
}

export function coerceControlValue(control: LabControl, rawValue: unknown): LabValue {
  if (control.type === "action") return true
  if ("options" in control) {
    const str = String(rawValue).toLowerCase()
    const match = control.options.find(
      opt =>
        opt.value === rawValue ||
        String(opt.value).toLowerCase() === str ||
        opt.label.toLowerCase() === str ||
        normalizeSlug(opt.label) === normalizeSlug(str),
    )
    if (!match) {
      const choices = control.options.map(o => `${String(o.value)} (${o.label})`).join(", ")
      throw new Error(`Invalid value "${String(rawValue)}" for "${control.label}". Valid options: ${choices}.`)
    }
    return match.value
  }
  if ("min" in control) {
    const num =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim() !== ""
          ? Number(rawValue)
          : Number.NaN
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid numeric value "${String(rawValue)}" for "${control.label}".`)
    }
    if (num < control.min || num > control.max) {
      throw new Error(`Value ${num} for "${control.label}" (${control.key}) is out of range [${control.min}, ${control.max}].`)
    }
    return num
  }
  const onVal = "on" in control && control.on !== undefined ? control.on : true
  const offVal = "off" in control && control.off !== undefined ? control.off : false
  if (rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true" || rawValue === "on") return onVal
  if (rawValue === false || rawValue === 0 || rawValue === "0" || rawValue === "false" || rawValue === "off") return offVal
  throw new Error(`Invalid toggle value "${String(rawValue)}" for "${control.label}". Expected true or false.`)
}

export function registerPanelLabCommands(commands: LabCommandRegistry, opts: PanelLabCommandOptions): void {
  const { getPanels, canEdit, disabledReason, render, extraGet, extraSet } = opts

  commands.registerAll([
    {
      id: "lab.get",
      label: "Get Lab Parameter Value(s)",
      shortLabel: "Lab Get",
      category: "Inspector",
      undoable: false,
      args: {
        path: { type: "string", description: "Control key, group.key, or label (omit for all controls)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const rawPath = typeof args?.path === "string" ? args.path.trim() : ""
        const panels = getPanels()
        if (!rawPath || rawPath === "all" || rawPath === "*") {
          const settings: Record<string, LabValue> = {}
          const controls: Record<string, unknown>[] = []
          for (const panel of panels) {
            for (const row of panel.navigation.rows) {
              const c = row.control
              if (!c) continue
              if (c.type === "action") {
                controls.push({ key: c.key, label: c.label, group: row.group, type: "action" })
                continue
              }
              const val = panel.navigation.settings[c.key]!
              settings[c.key] = val
              controls.push({
                key: c.key,
                label: c.label,
                group: row.group,
                value: val,
                formatted: formatControlValue(c, val),
                ...("min" in c ? { min: c.min, max: c.max, step: c.step, unit: inferControlUnit(c.key, c.label, c.unit) } : {}),
                ...("options" in c ? { options: c.options } : {}),
              })
            }
          }
          const extra = extraGet?.()
          if (extra && typeof extra === "object") Object.assign(settings, extra)
          return { settings, controls }
        }

        const found = findControlRow(panels, rawPath)
        if (found) {
          const { panel, row, control: c } = found
          if (c.type === "action") {
            return { key: c.key, label: c.label, group: row.group, type: "action" }
          }
          const val = panel.navigation.settings[c.key]!
          return {
            key: c.key,
            label: c.label,
            group: row.group,
            value: val,
            formatted: formatControlValue(c, val),
            ...("min" in c ? { min: c.min, max: c.max, step: c.step, unit: inferControlUnit(c.key, c.label, c.unit) } : {}),
            ...("options" in c ? { options: c.options } : {}),
          }
        }

        if (extraGet) {
          const extraVal = extraGet(rawPath)
          if (extraVal !== undefined) return extraVal
        }

        const available: string[] = []
        for (const panel of panels) {
          for (const row of panel.navigation.rows) {
            if (row.control) available.push(row.control.key)
          }
        }
        throw new Error(`Unknown lab setting "${rawPath}". Available keys: ${available.slice(0, 30).join(", ") || "none"}.`)
      },
    },
    {
      id: "scene.set-param",
      label: "Set Inspector Parameter",
      shortLabel: "Set Param",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", required: true, description: "Control key, group.key, or label" },
        value: { type: "value", required: true, description: "New value (number, boolean, or option)" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode",
      run: (_ctx, args) => {
        const rawPath = String(args?.key ?? "").trim()
        const rawValue = args?.value
        if (!rawPath) {
          throw new Error("scene.set-param requires a non-empty key.")
        }
        const panels = getPanels()
        const found = findControlRow(panels, rawPath)
        if (found) {
          const { panel, row, control: c } = found
          if (c.type === "action") {
            void c.run(document.createElement("button"))
            panel.sync()
            void render?.()
            return { key: c.key, label: c.label, group: row.group, action: "triggered" }
          }
          const prev = panel.navigation.settings[c.key]
          const next = coerceControlValue(c, rawValue)
          panel.navigation.set(c, next)
          panel.sync()
          void render?.()
          return {
            key: c.key,
            label: c.label,
            group: row.group,
            before: prev,
            value: panel.navigation.settings[c.key],
            formatted: formatControlValue(c, panel.navigation.settings[c.key]!),
          }
        }

        if (extraSet) {
          const extraRes = extraSet(rawPath, rawValue)
          if (extraRes) {
            void render?.()
            return extraRes
          }
        }

        const available: string[] = []
        for (const panel of panels) {
          for (const row of panel.navigation.rows) {
            if (row.control) available.push(row.control.key)
          }
        }
        throw new Error(`Unknown lab setting "${rawPath}". Available keys: ${available.slice(0, 30).join(", ") || "none"}.`)
      },
    },
    {
      id: "look.preset",
      label: "Apply Rendering Look Preset",
      shortLabel: "Look Preset",
      category: "Preset",
      undoable: true,
      args: {
        preset: { type: "string", required: true, description: "Look preset ID or name" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode",
      run: (_ctx, args) => {
        const raw = String(args?.preset ?? "").trim()
        const pid = resolveLookPresetId(raw)
        if (!pid) {
          throw new Error(`Unknown look preset "${raw}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
        }
        const harness = (globalThis as { __arcadeHarness?: { setLookPreset?: (p: string) => unknown } }).__arcadeHarness
        if (harness?.setLookPreset) {
          const settings = harness.setLookPreset(pid)
          void render?.()
          return { preset: pid, label: LOOK_PRESETS[pid].label, settings }
        }
        const panels = getPanels()
        const found = findControlRow(panels, "lookPreset") ?? findControlRow(panels, "preset")
        if (found) {
          found.panel.navigation.set(found.control, pid)
          found.panel.sync()
          void render?.()
          return { preset: pid, label: LOOK_PRESETS[pid].label }
        }
        throw new Error("Active page does not expose a Look preset control.")
      },
    },
    {
      id: "look.set",
      label: "Set Rendering Look Parameter",
      shortLabel: "Look Set",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", required: true, description: "Look parameter key" },
        value: { type: "value", required: true, description: "New value" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode",
      run: (_ctx, args) => {
        const key = String(args?.key ?? "").trim()
        const val = args?.value
        if (!key || val === undefined) throw new Error("look.set requires key and value.")
        const panels = getPanels()
        const found = findControlRow(panels, key)
        if (found && found.control.type !== "action") {
          const before = found.panel.navigation.settings[found.control.key]
          const next = coerceControlValue(found.control, val)
          found.panel.navigation.set(found.control, next)
          found.panel.sync()
          void render?.()
          return { key: found.control.key, before, value: found.panel.navigation.settings[found.control.key] }
        }
        const harness = (globalThis as { __arcadeHarness?: { setLook?: (p: Record<string, unknown>) => unknown; getLook?: () => Record<string, unknown> } }).__arcadeHarness
        if (harness?.setLook && harness.getLook) {
          const cur = harness.getLook()
          if (key in cur) {
            const before = cur[key]
            harness.setLook({ [key]: val })
            void render?.()
            return { key, before, value: harness.getLook()[key] }
          }
        }
        throw new Error(`Unknown look parameter "${key}".`)
      },
    },
    {
      id: "look.randomize",
      label: "Randomize Rendering Look Parameters",
      shortLabel: "Look Randomize",
      category: "Preset",
      undoable: true,
      args: {
        group: { type: "string", required: false, description: "Look group to randomize" },
        seed: { type: "number", required: false, min: 1, max: 9999, description: "Tuning seed" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode",
      run: (ctx, args) => {
        const rawGroup = typeof args?.group === "string" ? args.group : "all"
        const grp = resolveLookGroup(rawGroup)
        if (!grp) throw new Error(`Unknown look group "${rawGroup}".`)
        const seed = typeof args?.seed === "number" ? args.seed : (ctx?.seed ?? 108)
        const harness = (globalThis as { __arcadeHarness?: { setLook?: (p: any) => any; getLook?: () => any } }).__arcadeHarness
        if (harness?.setLook && harness.getLook) {
          const next = randomizeLookSettings(harness.getLook(), seed, grp)
          harness.setLook(next)
          void render?.()
          return { group: grp, tuningSeed: seed, settings: next }
        }
        throw new Error("Active page does not expose Look randomization.")
      },
    },
  ])
}

export function resolveNavigationPath(target: string): string {
  const raw = target.trim()
  if (!raw) throw new Error("Navigation target cannot be empty.")
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const parsed = new URL(raw)
    return parsed.pathname + parsed.search + parsed.hash
  }
  if (raw.startsWith("/")) return raw
  if (raw.startsWith("#")) return `/arcade/getaway/dev.html${raw}`

  let baseRaw = raw
  let extraSuffix = ""
  const qIdx = raw.indexOf("?")
  const hIdx = raw.indexOf("#")
  const splitIdx = qIdx >= 0 && hIdx >= 0 ? Math.min(qIdx, hIdx) : qIdx >= 0 ? qIdx : hIdx
  if (splitIdx > 0) {
    baseRaw = raw.slice(0, splitIdx)
    extraSuffix = raw.slice(splitIdx)
  }

  const lower = baseRaw.toLowerCase()
  let baseResolved: string | null = null
  if (lower === "hub" || lower === "games" || lower === "studio") baseResolved = "/arcade/getaway/dev.html#games"
  else if (lower.startsWith("tour/")) {
    baseResolved = `/arcade/getaway/dev.html#${raw}`
    extraSuffix = ""
  } else if (lower === "catalogue" || lower === "catalog") baseResolved = "/arcade/getaway/dev.html#catalogue"
  else if (lower.startsWith("catalogue/") || lower.startsWith("catalog/")) {
    const asset = baseRaw.slice(baseRaw.indexOf("/") + 1)
    baseResolved = `/arcade/getaway/dev.html#catalogue/${encodeURIComponent(asset)}`
  } else if (lower === "characters" || lower === "character" || lower === "rig") {
    baseResolved = "/arcade/blackout/characters.html"
  } else if (lower === "anim" || lower === "anim-viewer") {
    baseResolved = "/arcade/blackout/anim.html"
  } else if (lower === "lab" || lower === "sandbox") {
    baseResolved = "/arcade/lab/"
  } else if (lower === "getaway-lab") {
    baseResolved = "/arcade/lab/?game=getaway"
  } else if (lower === "outbreak-lab" || lower === "vignette" || lower === "outbreak-vignette") {
    baseResolved = "/arcade/lab/?game=outbreak&section=outbreak-vignette"
  } else if (lower === "looks" || lower === "looks-lab") {
    baseResolved = "/arcade/lab/#looks"
  } else if (lower === "blackout-lab") {
    baseResolved = "/arcade/lab/?game=blackout"
  } else if (lower === "getaway") baseResolved = "/arcade/getaway/?solo&seed=7"
  else if (lower === "blackout") baseResolved = "/arcade/blackout/?sandbox=1&seed=1"
  else if (lower === "wizards") baseResolved = "/arcade/blackout/?sandbox=1&mode=wizards&seed=1"
  else if (lower === "outbreak") baseResolved = "/arcade/outbreak/?seed=7"
  else if (lower === "carrier") baseResolved = "/arcade/carrier/?seed=7"

  if (!baseResolved) {
    throw new Error(
      `Unknown page target "${target}". Expected one of: hub, games, lab, sandbox, getaway-lab, blackout-lab, outbreak-lab, catalogue, characters, getaway, blackout, outbreak, carrier, or a /arcade/... path.`,
    )
  }
  if (!extraSuffix) return baseResolved
  const baseUrl = new URL(baseResolved, "http://arcade.local")
  const extraUrl = new URL(`http://arcade.local/x${extraSuffix}`)
  for (const [k, v] of extraUrl.searchParams.entries()) {
    baseUrl.searchParams.set(k, v)
  }
  if (extraUrl.hash) baseUrl.hash = extraUrl.hash
  return baseUrl.pathname + baseUrl.search + baseUrl.hash
}

/** The single Lab app (`/arcade/lab/`); `lab.html` covers standalone fixtures that still serve one. */
const isLabPath = (pathname: string) => pathname.startsWith("/arcade/lab/") || pathname.endsWith("/lab.html")

const ALLOWED_TARGET_KEYS = new Set([
  "objectId",
  "object",
  "id",
  "setting",
  "settingKey",
  "key",
  "rect",
  "screenRect",
  "world",
  "worldPoint",
  "point",
  "selector",
  "x",
  "y",
  "z",
  "width",
  "height",
  "w",
  "h",
])

function parseNumberList(raw: string, label: string, expectedCounts: readonly number[]): number[] {
  const nums = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
  if (!expectedCounts.includes(nums.length) || !nums.every(Number.isFinite)) {
    throw new Error(`Invalid ${label} "${raw}". Expected ${expectedCounts.join(" or ")} comma-separated numbers.`)
  }
  return nums
}

export function normalizeNoteTarget(raw: unknown): DevNoteTarget | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith("{")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        throw new Error(`Invalid JSON in note target: ${err instanceof Error ? err.message : String(err)}`)
      }
      return normalizeNoteTarget(parsed)
    }
    const lower = trimmed.toLowerCase()
    if (lower.startsWith("rect:")) {
      const nums = parseNumberList(trimmed.slice(5), "screen rect", [4])
      if (nums[2]! <= 0 || nums[3]! <= 0) throw new Error("Screen rect width and height must be > 0.")
      return { rect: [nums[0]!, nums[1]!, nums[2]!, nums[3]!] }
    }
    if (lower.startsWith("world:") || lower.startsWith("point:")) {
      const slice = trimmed.slice(trimmed.indexOf(":") + 1)
      const nums = parseNumberList(slice, "world point", [2, 3])
      return { world: nums.length === 2 ? [nums[0]!, 0, nums[1]!] : [nums[0]!, nums[1]!, nums[2]!] }
    }
    if (lower.startsWith("setting:") || lower.startsWith("key:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("Setting target key cannot be empty.")
      return { setting: val }
    }
    if (lower.startsWith("object:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("Object target ID cannot be empty.")
      return { objectId: val }
    }
    if (lower.startsWith("selector:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("DOM selector target cannot be empty.")
      return { selector: val }
    }
    if (trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.startsWith("[")) {
      return { selector: trimmed }
    }
    return { objectId: trimmed, setting: trimmed }
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Note target must be an object ({ objectId, setting, rect, world, selector }) or target string.")
  }

  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TARGET_KEYS.has(k)) {
      throw new Error(`Unknown note target field "${k}". Expected one of: objectId, setting, rect, world, selector.`)
    }
  }

  const out: DevNoteTarget = {}
  const rawObjId = obj.objectId ?? obj.object ?? obj.id
  if (rawObjId !== undefined) {
    if (typeof rawObjId !== "string" || !rawObjId.trim()) {
      throw new Error("Note target 'objectId' must be a non-empty string.")
    }
    out.objectId = rawObjId.trim()
  }

  const rawSetting = obj.setting ?? obj.settingKey ?? obj.key
  if (rawSetting !== undefined) {
    if (typeof rawSetting !== "string" || !rawSetting.trim()) {
      throw new Error("Note target 'setting' must be a non-empty string.")
    }
    out.setting = rawSetting.trim()
  }

  if (obj.selector !== undefined) {
    if (typeof obj.selector !== "string" || !obj.selector.trim()) {
      throw new Error("Note target 'selector' must be a non-empty string.")
    }
    out.selector = obj.selector.trim()
  }

  const rawRect =
    obj.rect ??
    obj.screenRect ??
    (obj.x !== undefined && obj.y !== undefined && (obj.width !== undefined || obj.w !== undefined)
      ? { x: obj.x, y: obj.y, width: obj.width ?? obj.w, height: obj.height ?? obj.h }
      : undefined)
  if (rawRect !== undefined) {
    if (Array.isArray(rawRect)) {
      if (rawRect.length !== 4 || !rawRect.every(n => typeof n === "number" && Number.isFinite(n))) {
        throw new Error("Note target 'rect' array must be [x, y, width, height] with 4 finite numbers.")
      }
      if (Number(rawRect[2]) <= 0 || Number(rawRect[3]) <= 0) {
        throw new Error("Note target 'rect' width and height must be > 0.")
      }
      out.rect = [Number(rawRect[0]), Number(rawRect[1]), Number(rawRect[2]), Number(rawRect[3])]
    } else if (rawRect && typeof rawRect === "object") {
      const r = rawRect as Record<string, unknown>
      const rx = Number(r.x)
      const ry = Number(r.y)
      const rw = Number(r.width ?? r.w)
      const rh = Number(r.height ?? r.h)
      if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) {
        throw new Error("Note target 'rect' object requires finite x, y, width (>0), and height (>0).")
      }
      out.rect = [rx, ry, rw, rh]
    } else {
      throw new Error("Note target 'rect' must be [x, y, width, height] or { x, y, width, height }.")
    }
  }

  const rawWorld =
    obj.world ??
    obj.worldPoint ??
    obj.point ??
    (obj.x !== undefined && obj.z !== undefined && obj.width === undefined && obj.w === undefined
      ? { x: obj.x, y: obj.y ?? 0, z: obj.z }
      : undefined)
  if (rawWorld !== undefined) {
    if (Array.isArray(rawWorld)) {
      if ((rawWorld.length !== 2 && rawWorld.length !== 3) || !rawWorld.every(n => typeof n === "number" && Number.isFinite(n))) {
        throw new Error("Note target 'world' array must be [x, y, z] or [x, z] with finite numbers.")
      }
      out.world =
        rawWorld.length === 2
          ? [Number(rawWorld[0]), 0, Number(rawWorld[1])]
          : [Number(rawWorld[0]), Number(rawWorld[1]), Number(rawWorld[2])]
    } else if (rawWorld && typeof rawWorld === "object") {
      const w = rawWorld as Record<string, unknown>
      const wx = Number(w.x)
      const wy = w.y !== undefined ? Number(w.y) : 0
      const wz = Number(w.z)
      if (![wx, wy, wz].every(Number.isFinite)) {
        throw new Error("Note target 'world' object requires finite x, y, and z coordinates.")
      }
      out.world = [wx, wy, wz]
    } else {
      throw new Error("Note target 'world' must be [x, y, z] or { x, y, z }.")
    }
  }

  if (!out.objectId && !out.setting && !out.rect && !out.world && !out.selector) {
    throw new Error("Note target must specify at least one of: objectId, setting, rect, world, or selector.")
  }

  return out
}

export function normalizeNoteArgs(
  raw: Record<string, unknown> | undefined,
): { clear: true } | { clear: false; note: DevNotePayload } {
  const input = raw ?? {}
  if (input.clear === true || input.dismiss === true) {
    return { clear: true }
  }
  const rawTitle = typeof input.title === "string" ? input.title.trim() : ""
  if (!rawTitle) {
    throw new Error('ui.note requires a non-empty "title" string (or { clear: true }).')
  }
  if (input.body !== undefined && input.body !== null && typeof input.body !== "string") {
    throw new Error('Argument "body" must be a string.')
  }
  if (input.step !== undefined && input.step !== null && typeof input.step !== "string") {
    throw new Error('Argument "step" must be a string (for example "2/5").')
  }
  if (input.accent !== undefined && input.accent !== null && typeof input.accent !== "string") {
    throw new Error('Argument "accent" must be a string.')
  }
  if (input.dismissible !== undefined && typeof input.dismissible !== "boolean") {
    throw new Error('Argument "dismissible" must be a boolean.')
  }
  const target = normalizeNoteTarget(input.target)
  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : undefined
  const step = typeof input.step === "string" && input.step.trim() ? input.step.trim() : undefined
  const accent = typeof input.accent === "string" && input.accent.trim() ? input.accent.trim() : undefined
  const dismissible = typeof input.dismissible === "boolean" ? input.dismissible : true
  const tourId = typeof input.tourId === "string" && input.tourId.trim() ? input.tourId.trim() : undefined
  const stepIndex = typeof input.stepIndex === "number" && Number.isFinite(input.stepIndex) ? Math.round(input.stepIndex) : undefined
  const stepCount = typeof input.stepCount === "number" && Number.isFinite(input.stepCount) ? Math.round(input.stepCount) : undefined
  const prevUrl = typeof input.prevUrl === "string" && input.prevUrl.trim() ? input.prevUrl.trim() : undefined
  const nextUrl = typeof input.nextUrl === "string" && input.nextUrl.trim() ? input.nextUrl.trim() : undefined
  const singleTab = typeof input.singleTab === "boolean" ? input.singleTab : undefined

  return {
    clear: false,
    note: {
      title: rawTitle,
      ...(body !== undefined ? { body } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(accent !== undefined ? { accent } : {}),
      ...(target !== undefined ? { target } : {}),
      dismissible,
      ...(tourId !== undefined ? { tourId } : {}),
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(stepCount !== undefined ? { stepCount } : {}),
      ...(prevUrl !== undefined ? { prevUrl } : {}),
      ...(nextUrl !== undefined ? { nextUrl } : {}),
      ...(singleTab !== undefined ? { singleTab } : {}),
    },
  }
}

export function resolveTourAssetUrl(tourId: string, rawSrc: string): string {
  const trimmed = rawSrc.trim()
  if (!trimmed) return ""
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("/__arcade/") ||
    trimmed.startsWith("/arcade/")
  ) {
    return trimmed
  }
  const cleanId = tourId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tour"
  const fileName = trimmed.split("/").pop() ?? trimmed
  return `/__arcade/tour-assets/${encodeURIComponent(cleanId)}/${encodeURIComponent(fileName)}`
}

export function validateTourDefinition(raw: unknown, defaultId = "tour"): TourDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error("Tour definition must be a JSON object or non-empty array of steps.")
  }
  const isArray = Array.isArray(raw)
  const container = isArray ? { steps: raw } : (raw as Record<string, unknown>)
  const rawSteps = container.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error("Tour definition requires a non-empty 'steps' array.")
  }

  const rawId = typeof container.id === "string" && container.id.trim() ? container.id.trim() : defaultId
  const id = rawId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tour"
  const title = typeof container.title === "string" && container.title.trim() ? container.title.trim() : undefined
  const baseUrl = typeof container.baseUrl === "string" && container.baseUrl.trim() ? container.baseUrl.trim().replace(/\/$/, "") : undefined
  const singleTab = typeof container.singleTab === "boolean" ? container.singleTab : true

  const steps: TourStepDefinition[] = rawSteps.map((item, idx) => {
    const stepNum = idx + 1
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Tour step ${stepNum} must be an object.`)
    }
    const s = item as Record<string, unknown>
    const stepTitle = typeof s.title === "string" ? s.title.trim() : ""
    if (!stepTitle) {
      throw new Error(`Tour step ${stepNum} is missing a non-empty "title".`)
    }

    const rawKind = typeof s.kind === "string" ? s.kind.trim().toLowerCase() : ""
    if (rawKind && rawKind !== "scene" && rawKind !== "page" && rawKind !== "grid") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): invalid kind "${String(s.kind)}". Expected "scene", "page", or "grid".`)
    }

    if (s.markdown !== undefined && s.markdown !== null && typeof s.markdown !== "string") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "markdown" must be a string.`)
    }
    const markdown = typeof s.markdown === "string" && s.markdown.trim() ? s.markdown.trim() : undefined

    let images: TourPageImage[] | undefined
    if (s.images !== undefined) {
      if (!Array.isArray(s.images)) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "images" must be an array.`)
      }
      images = s.images.map((imgItem, imgIdx) => {
        if (typeof imgItem === "string" && imgItem.trim()) {
          return { src: imgItem.trim() }
        }
        if (!imgItem || typeof imgItem !== "object" || Array.isArray(imgItem)) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") images[${imgIdx}] must be a string or { src, label?, caption?, tag? }.`)
        }
        const imgObj = imgItem as Record<string, unknown>
        const rawSrc =
          typeof imgObj.src === "string"
            ? imgObj.src.trim()
            : typeof imgObj.url === "string"
              ? imgObj.url.trim()
              : typeof imgObj.path === "string"
                ? imgObj.path.trim()
                : ""
        if (!rawSrc) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") images[${imgIdx}] is missing "src".`)
        }
        const label =
          typeof imgObj.label === "string" && imgObj.label.trim()
            ? imgObj.label.trim()
            : typeof imgObj.title === "string" && imgObj.title.trim()
              ? imgObj.title.trim()
              : undefined
        const caption = typeof imgObj.caption === "string" && imgObj.caption.trim() ? imgObj.caption.trim() : undefined
        const tag = typeof imgObj.tag === "string" && imgObj.tag.trim() ? imgObj.tag.trim() : undefined
        return {
          src: rawSrc,
          ...(label !== undefined ? { label } : {}),
          ...(caption !== undefined ? { caption } : {}),
          ...(tag !== undefined ? { tag } : {}),
        }
      })
    }

    const isPage = rawKind === "page" || Boolean(markdown || (images && images.length > 0))
    const isGrid = rawKind === "grid" || Array.isArray(s.tiles)
    const rawUrl = typeof s.url === "string" ? s.url.trim() : typeof s.page === "string" ? s.page.trim() : typeof s.path === "string" ? s.path.trim() : ""
    if (!rawUrl && !isPage && !isGrid) {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}") is missing a non-empty "url".`)
    }
    let resolvedUrl: string
    if (!rawUrl && isPage) {
      resolvedUrl = `/arcade/getaway/dev.html#tour/${encodeURIComponent(id)}/${stepNum}`
    } else if (!rawUrl && isGrid) {
      resolvedUrl = "/arcade/lab/"
    } else {
      try {
        resolvedUrl = resolveNavigationPath(rawUrl)
      } catch (err) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const rawBody = s.body ?? s.description
    if (rawBody !== undefined && rawBody !== null && typeof rawBody !== "string") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "body" must be a string.`)
    }
    const body = typeof rawBody === "string" && rawBody.trim() ? rawBody.trim() : undefined

    const setup: TourSetupCommand[] = []
    if (s.setup !== undefined) {
      if (!Array.isArray(s.setup)) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "setup" must be an array of commands.`)
      }
      for (let cIdx = 0; cIdx < s.setup.length; cIdx++) {
        const entry = s.setup[cIdx]
        if (typeof entry === "string" && entry.trim()) {
          setup.push({ command: entry.trim() })
          continue
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] must be a command object.`)
        }
        const cmdObj = entry as Record<string, unknown>
        const cmdName =
          typeof cmdObj.command === "string"
            ? cmdObj.command.trim()
            : typeof cmdObj.cmd === "string"
              ? cmdObj.cmd.trim()
              : typeof cmdObj.id === "string"
                ? cmdObj.id.trim()
                : ""
        if (!cmdName) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] is missing "command".`)
        }
        let cmdArgs: Record<string, unknown> | undefined
        if (cmdObj.args !== undefined) {
          if (!cmdObj.args || typeof cmdObj.args !== "object" || Array.isArray(cmdObj.args)) {
            throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] "args" must be a JSON object.`)
          }
          cmdArgs = { ...(cmdObj.args as Record<string, unknown>) }
        } else {
          const inline: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(cmdObj)) {
            if (k !== "command" && k !== "cmd" && k !== "id") inline[k] = v
          }
          if (Object.keys(inline).length > 0) cmdArgs = inline
        }
        setup.push(cmdArgs ? { command: cmdName, args: cmdArgs } : { command: cmdName })
      }
    }

    const gridPreset = typeof s.preset === "string" && s.preset.trim() ? s.preset.trim() : undefined
    const gridSection = typeof s.section === "string" && s.section.trim() ? s.section.trim() : undefined
    const gridCols = typeof s.cols === "number" && Number.isFinite(s.cols) ? Math.round(s.cols) : undefined
    const gridTiles = Array.isArray(s.tiles) ? (s.tiles as Record<string, unknown>[]) : undefined

    if (isGrid && !setup.some(c => c.command === "grid.open" || c.command === "grid")) {
      const gridArgs: Record<string, unknown> = { title: stepTitle }
      if (gridPreset) gridArgs.preset = gridPreset
      if (gridSection) gridArgs.section = gridSection
      if (gridCols !== undefined) gridArgs.cols = gridCols
      if (gridTiles) gridArgs.tiles = gridTiles
      setup.push({ command: "grid.open", args: gridArgs })
    }

    let target: DevNoteTarget | undefined
    const rawTarget = s.target ?? s.noteTarget
    if (rawTarget !== undefined) {
      try {
        target = normalizeNoteTarget(rawTarget)
      } catch (err) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const accent = typeof s.accent === "string" && s.accent.trim() ? s.accent.trim() : undefined
    const dismissible = typeof s.dismissible === "boolean" ? s.dismissible : undefined

    return {
      ...(isPage
        ? { kind: "page" as const }
        : isGrid
          ? { kind: "grid" as const }
          : rawKind === "scene"
            ? { kind: "scene" as const }
            : {}),
      title: stepTitle,
      ...(body !== undefined ? { body } : {}),
      url: resolvedUrl,
      setup,
      ...(target !== undefined ? { target } : {}),
      ...(accent !== undefined ? { accent } : {}),
      ...(dismissible !== undefined ? { dismissible } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(gridPreset !== undefined ? { preset: gridPreset } : {}),
      ...(gridSection !== undefined ? { section: gridSection } : {}),
      ...(gridCols !== undefined ? { cols: gridCols } : {}),
      ...(gridTiles !== undefined ? { tiles: gridTiles } : {}),
    }
  })

  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    singleTab,
    steps,
  }
}

export function buildTourStepUrl(
  origin: string,
  stepUrl: string,
  tourId: string,
  stepNumber: number,
  singleTab = true,
): string {
  const resolved = resolveNavigationPath(stepUrl)
  const u = new URL(resolved, origin.endsWith("/") ? origin : `${origin}/`)
  u.searchParams.set("tour", tourId)
  u.searchParams.set("step", String(stepNumber))
  if (singleTab) u.searchParams.set("singleTab", "1")
  return u.href
}

const ACCENT_PALETTE: Record<string, { border: string; text: string; glow: string; badgeBg: string }> = {
  cyan: {
    border: "rgba(124, 197, 214, 0.55)",
    text: "#7cc5d6",
    glow: "rgba(124, 197, 214, 0.28)",
    badgeBg: "rgba(124, 197, 214, 0.16)",
  },
  amber: {
    border: "rgba(245, 185, 66, 0.6)",
    text: "#f5b942",
    glow: "rgba(245, 185, 66, 0.28)",
    badgeBg: "rgba(245, 185, 66, 0.18)",
  },
  emerald: {
    border: "rgba(92, 214, 154, 0.58)",
    text: "#5cd69a",
    glow: "rgba(92, 214, 154, 0.28)",
    badgeBg: "rgba(92, 214, 154, 0.16)",
  },
  rose: {
    border: "rgba(255, 122, 144, 0.58)",
    text: "#ff7a90",
    glow: "rgba(255, 122, 144, 0.28)",
    badgeBg: "rgba(255, 122, 144, 0.16)",
  },
  violet: {
    border: "rgba(180, 142, 247, 0.58)",
    text: "#b48ef7",
    glow: "rgba(180, 142, 247, 0.28)",
    badgeBg: "rgba(180, 142, 247, 0.16)",
  },
}

function resolveAccentColors(accent?: string) {
  if (!accent) return ACCENT_PALETTE.cyan!
  const key = accent.trim().toLowerCase()
  if (ACCENT_PALETTE[key]) return ACCENT_PALETTE[key]!
  return {
    border: accent,
    text: accent,
    glow: "rgba(124, 197, 214, 0.28)",
    badgeBg: "rgba(124, 197, 214, 0.16)",
  }
}

export function registerUiNoteCommand(
  commands: LabCommandRegistry,
  handlers?: {
    onShow?: (note: DevNotePayload) => DevNoteResolvedRect | null
    onClear?: () => void
    getDocumentTitle?: () => string
  },
): void {
  let fallbackTitle = handlers?.getDocumentTitle?.() ?? (typeof document !== "undefined" ? document.title : "Arcade")
  let activeNoteState: DevNotePayload | null = null

  commands.register({
    id: "ui.note",
    aliases: ["note", "show-me"],
    label: "Show Pinned Page Note & Highlight Target",
    shortLabel: "Note",
    category: "Navigation",
    undoable: false,
    readOnly: true,
    args: {
      title: { type: "string", description: "Short pinned tab/card title (sets document.title to '▸ <title>')" },
      body: { type: "string", description: "One-line description of what to look at" },
      step: { type: "string", description: "Optional tour step counter such as '2/5'" },
      accent: { type: "string", description: "Optional accent colour (cyan, amber, emerald, rose, violet, or CSS colour)" },
      target: { type: "object", description: "Optional highlight target ({ objectId, setting, rect, world, selector } or string)" },
      dismissible: { type: "boolean", description: "Whether Esc and × dismiss the note (default true)" },
      clear: { type: "boolean", description: "Dismiss any active note and restore document.title" },
      tourId: { type: "string", description: "Optional tour identifier" },
      stepIndex: { type: "number", min: 1, max: 999, description: "Optional 1-based step index" },
      stepCount: { type: "number", min: 1, max: 999, description: "Optional total steps in tour" },
      prevUrl: { type: "string", description: "Optional previous step URL" },
      nextUrl: { type: "string", description: "Optional next step URL" },
      singleTab: { type: "boolean", description: "Navigate within the same tab on Next/Prev" },
    },
    enabled: () => true,
    run: (_ctx, rawArgs) => {
      const normalized = normalizeNoteArgs(rawArgs as Record<string, unknown> | undefined)
      if (normalized.clear) {
        activeNoteState = null
        handlers?.onClear?.()
        return {
          active: false,
          documentTitle: handlers?.getDocumentTitle?.() ?? fallbackTitle,
        }
      }
      const { note } = normalized
      activeNoteState = note
      const formattedDocTitle = note.title.startsWith("▸ ") ? note.title : `▸ ${note.title}`
      fallbackTitle = formattedDocTitle
      const resolvedRect = handlers?.onShow ? handlers.onShow(note) : null
      return {
        active: true,
        title: note.title,
        documentTitle: handlers?.getDocumentTitle?.() ?? formattedDocTitle,
        body: note.body ?? null,
        step: note.step ?? null,
        accent: note.accent ?? "cyan",
        target: note.target ?? null,
        targetResolved: Boolean(resolvedRect),
        targetRect: resolvedRect ?? null,
        dismissible: note.dismissible,
        tourId: note.tourId ?? null,
        stepIndex: note.stepIndex ?? null,
        stepCount: note.stepCount ?? null,
      }
    },
  })

  if (!commands.get("ui.note.clear")) {
    commands.register({
      id: "ui.note.clear",
      aliases: ["note.clear"],
      label: "Dismiss Pinned Page Note",
      shortLabel: "Dismiss Note",
      category: "Navigation",
      undoable: false,
      readOnly: true,
      enabled: () => true,
      run: () => {
        activeNoteState = null
        handlers?.onClear?.()
        return {
          active: false,
          documentTitle: handlers?.getDocumentTitle?.() ?? fallbackTitle,
        }
      },
    })
  }
  void activeNoteState
}

function detectGameName(pathname: string): string {
  const m = pathname.match(/^\/arcade\/([a-z0-9-]+)/)
  return m?.[1] ?? "unknown"
}

function getSubmitListeners(): Set<() => void> {
  if (typeof window === "undefined") return new Set()
  window.__arcadeSubmitListeners ??= new Set<() => void>()
  if (import.meta.env?.DEV && !window.__arcadeSubmitHooked && typeof GPUQueue !== "undefined") {
    window.__arcadeSubmitHooked = true
    const origSubmit = GPUQueue.prototype.submit
    GPUQueue.prototype.submit = function (commandBuffers) {
      const res = origSubmit.call(this, commandBuffers)
      const listeners = window.__arcadeSubmitListeners
      if (listeners && listeners.size > 0) {
        for (const fn of [...listeners]) fn()
      }
      return res
    }
  }
  return window.__arcadeSubmitListeners
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  getSubmitListeners()
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5))
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

function drawActiveNoteOverlayToCanvas(
  targetCanvas: HTMLCanvasElement,
  sourceCanvas: HTMLCanvasElement,
  rt: PageControlRuntime | null | undefined,
) {
  if (!rt) return
  const note = rt.getActiveNote()
  const studioTour = rt.getStudioTour()
  const studioStep = rt.getStudioStep()
  const showStrip = Boolean(studioTour && studioTour.singleTab !== false && rt.isStudioStripExpanded())
  if (!note && !showStrip) return
  const ctx = targetCanvas.getContext("2d")
  if (!ctx) return

  const cw = targetCanvas.width
  const ch = targetCanvas.height
  const cRect = sourceCanvas.getBoundingClientRect()
  const refW = Math.max(1, cRect.width || window.innerWidth || cw)
  const refH = Math.max(1, cRect.height || window.innerHeight || ch)
  const sx = cw / refW
  const sy = ch / refH

  // 0. Draw Studio Tab Strip across the top if active
  if (showStrip && studioTour) {
    ctx.save()
    const stripH = 28 * sy
    ctx.fillStyle = "rgba(12, 14, 18, 0.96)"
    ctx.fillRect(0, 0, cw, stripH)
    ctx.fillStyle = "rgba(44, 52, 62, 0.85)"
    ctx.fillRect(0, stripH - 1, cw, 1)

    const monoFont = `600 ${Math.max(8, Math.round(10 * sx))}px ui-monospace, SFMono-Regular, Menlo, monospace`
    const tabFont = `500 ${Math.max(9, Math.round(11 * sx))}px system-ui, -apple-system, sans-serif`
    let x = 10 * sx
    ctx.font = monoFont
    ctx.fillStyle = "#7cc5d6"
    ctx.textBaseline = "middle"
    const badge = `◫ ${studioStep}/${studioTour.steps.length}`
    ctx.fillText(badge, x, stripH * 0.5)
    x += ctx.measureText(badge).width + 12 * sx

    for (let i = 0; i < studioTour.steps.length; i++) {
      const s = studioTour.steps[i]!
      const num = i + 1
      const active = num === studioStep
      const shortTitle = s.title.length > 24 ? `${s.title.slice(0, 23)}…` : s.title
      const label = `${num} ${shortTitle}`
      ctx.font = tabFont
      const tw = ctx.measureText(label).width + 14 * sx
      if (x + tw > cw - 50 * sx) break
      const th = 20 * sy
      const ty = (stripH - th) * 0.5
      roundRectPath(ctx, x, ty, tw, th, 4 * sx)
      const stepColors = resolveAccentColors(s.accent)
      ctx.fillStyle = active ? "rgba(77, 141, 255, 0.2)" : "rgba(255, 255, 255, 0.04)"
      ctx.fill()
      ctx.strokeStyle = active ? stepColors.text : "rgba(255, 255, 255, 0.1)"
      ctx.lineWidth = Math.max(1, (active ? 1.4 : 0.8) * sx)
      ctx.stroke()
      ctx.fillStyle = active ? "#f2f6fa" : "#8b949e"
      ctx.fillText(label, x + 7 * sx, stripH * 0.5)
      x += tw + 5 * sx
    }
    ctx.restore()
  }

  if (!note) return
  const colors = resolveAccentColors(note.accent)

  // 1. Draw target highlight ring if resolved and overlapping the canvas
  const targetRect = note.target ? rt.resolveNoteTargetRect(note.target, false) : null
  if (targetRect && targetRect.width > 0 && targetRect.height > 0) {
    const localX = targetRect.x - cRect.left
    const localY = targetRect.y - cRect.top
    const overlapsCanvas =
      localX + targetRect.width > 4 && localX < refW - 4 && localY + targetRect.height > 4 && localY < refH - 4
    if (overlapsCanvas) {
      const pad = 6
      const rx = (localX - pad) * sx
      const ry = (localY - pad) * sy
      const rw = (targetRect.width + pad * 2) * sx
      const rh = (targetRect.height + pad * 2) * sy
      const radius = targetRect.shape === "pill" ? Math.min(rw, rh) * 0.5 : 8 * sx

      ctx.save()
      if (note.target?.selector) {
        const domEl = document.querySelector<HTMLElement>(note.target.selector)
        const text = domEl?.innerText?.replace(/\s+/g, " ").trim()
        if (text) {
          roundRectPath(ctx, localX * sx, localY * sy, targetRect.width * sx, targetRect.height * sy, 6 * sx)
          ctx.fillStyle = "rgba(12, 16, 20, 0.88)"
          ctx.fill()
          ctx.font = `600 ${Math.max(10, Math.round(12 * sx))}px system-ui, -apple-system, sans-serif`
          ctx.fillStyle = "#eef4f8"
          ctx.textBaseline = "middle"
          ctx.fillText(text, (localX + 10) * sx, (localY + targetRect.height * 0.5) * sy)
        }
      }

      roundRectPath(ctx, rx - 3 * sx, ry - 3 * sy, rw + 6 * sx, rh + 6 * sy, radius + 3 * sx)
      ctx.strokeStyle = colors.glow
      ctx.lineWidth = Math.max(3, 5 * sx)
      ctx.stroke()

      roundRectPath(ctx, rx, ry, rw, rh, radius)
      ctx.strokeStyle = colors.text
      ctx.lineWidth = Math.max(2, 2.2 * sx)
      ctx.stroke()
      ctx.restore()
    }
  }

  // 2. Draw top-centered "Show me" card
  ctx.save()
  const topPx = (showStrip ? 36 : 10) * sy
  const titleFont = `600 ${Math.max(11, Math.round(13 * sx))}px system-ui, -apple-system, sans-serif`
  const bodyFont = `400 ${Math.max(10, Math.round(11.5 * sx))}px system-ui, -apple-system, sans-serif`
  const monoFont = `600 ${Math.max(9, Math.round(10.5 * sx))}px ui-monospace, SFMono-Regular, Menlo, monospace`

  ctx.font = titleFont
  const titleText = `▸ ${note.title}`
  const titleW = ctx.measureText(titleText).width
  ctx.font = bodyFont
  const bodyText = note.body ? (note.body.length > 96 ? `${note.body.slice(0, 95)}…` : note.body) : ""
  const bodyW = bodyText ? ctx.measureText(bodyText).width : 0
  ctx.font = monoFont
  const stepText = note.step ?? ""
  const stepW = stepText ? ctx.measureText(stepText).width + 14 * sx : 0
  const navW = note.prevUrl || note.nextUrl || (note.stepCount && note.stepCount > 1) ? 94 * sx : 0

  const padX = 14 * sx
  const cardW = Math.min(cw - 20 * sx, Math.max(260 * sx, titleW + stepW + navW + padX * 2 + 28 * sx, bodyW + padX * 2))
  const cardH = (bodyText ? 48 : 30) * sy
  const cardX = (cw - cardW) * 0.5
  const cardY = topPx

  roundRectPath(ctx, cardX, cardY, cardW, cardH, 9 * sx)
  ctx.fillStyle = "rgba(11, 15, 20, 0.93)"
  ctx.fill()
  ctx.strokeStyle = colors.border
  ctx.lineWidth = Math.max(1, 1.25 * sx)
  ctx.stroke()

  // Left accent bar
  roundRectPath(ctx, cardX + 4 * sx, cardY + 6 * sy, 3 * sx, cardH - 12 * sy, 2 * sx)
  ctx.fillStyle = colors.text
  ctx.fill()

  let curX = cardX + padX
  const row1Y = cardY + (bodyText ? 18 : 19) * sy

  if (stepText) {
    const bw = ctx.measureText(stepText).width + 10 * sx
    const bh = 15 * sy
    roundRectPath(ctx, curX, row1Y - 11.5 * sy, bw, bh, 4 * sx)
    ctx.fillStyle = colors.badgeBg
    ctx.fill()
    ctx.font = monoFont
    ctx.fillStyle = colors.text
    ctx.fillText(stepText, curX + 5 * sx, row1Y - 1 * sy)
    curX += bw + 8 * sx
  }

  ctx.font = titleFont
  ctx.fillStyle = "#f0f5f8"
  ctx.fillText(titleText, curX, row1Y)

  if (bodyText) {
    ctx.font = bodyFont
    ctx.fillStyle = "#a5b5c2"
    ctx.fillText(bodyText, cardX + padX, cardY + 36 * sy, cardW - padX * 2)
  }
  ctx.restore()
}

async function captureWebGPUOr2DCanvas(
  canvas: HTMLCanvasElement,
  customCapture: ((target: HTMLCanvasElement) => Promise<void> | void) | undefined,
  maxSize = 1280,
  includeOverlay = true,
): Promise<{ dataUrl: string; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  const scratch = document.createElement("canvas")
  const srcW = Math.max(1, canvas.width || canvas.clientWidth || 320)
  const srcH = Math.max(1, canvas.height || canvas.clientHeight || 200)
  scratch.width = srcW
  scratch.height = srcH

  if (customCapture) {
    await customCapture(scratch)
  } else {
    const ctx2d = scratch.getContext("2d")!
    let capturedViaSubmit = false
    if (typeof GPUQueue !== "undefined") {
      const listeners = getSubmitListeners()
      await new Promise<void>(resolve => {
        let settled = false
        let rafAfter = 0
        const onSubmit = () => {
          try {
            ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            capturedViaSubmit = true
          } catch {}
          if (!rafAfter) {
            rafAfter = requestAnimationFrame(() => {
              window.clearTimeout(timer)
              finish()
            })
          }
        }
        const finish = () => {
          if (settled) return
          settled = true
          listeners.delete(onSubmit)
          if (rafAfter) cancelAnimationFrame(rafAfter)
          resolve()
        }
        const timer = window.setTimeout(() => {
          if (!capturedViaSubmit) {
            try {
              ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            } catch {}
          }
          finish()
        }, 250)
        listeners.add(onSubmit)
      })
    } else {
      ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
    }
  }

  const limit = maxSize > 0 ? maxSize : Math.max(scratch.width, scratch.height)
  const longest = Math.max(scratch.width, scratch.height)
  let outCanvas = scratch
  if (longest > limit) {
    const scale = limit / longest
    const outW = Math.max(1, Math.round(scratch.width * scale))
    const outH = Math.max(1, Math.round(scratch.height * scale))
    const scaled = document.createElement("canvas")
    scaled.width = outW
    scaled.height = outH
    const sctx = scaled.getContext("2d")!
    sctx.drawImage(scratch, 0, 0, outW, outH)
    outCanvas = scaled
  }

  if (includeOverlay) {
    drawActiveNoteOverlayToCanvas(outCanvas, canvas, typeof window !== "undefined" ? window.__arcadeDevControl : null)
  }

  return {
    dataUrl: outCanvas.toDataURL("image/png"),
    width: outCanvas.width,
    height: outCanvas.height,
    sourceWidth: scratch.width,
    sourceHeight: scratch.height,
  }
}

function synthesizeHubCanvas(): HTMLCanvasElement {
  const out = document.createElement("canvas")
  out.width = Math.max(640, Math.min(1280, window.innerWidth || 1280))
  out.height = Math.max(400, Math.min(800, window.innerHeight || 800))
  const ctx = out.getContext("2d")!
  ctx.fillStyle = "#0c0d0f"
  ctx.fillRect(0, 0, out.width, out.height)

  const studioPage = document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])")
  if (studioPage) {
    const titleText = studioPage.querySelector<HTMLElement>("[data-studio-page-title]")?.textContent ?? document.title
    const bodyText = studioPage.querySelector<HTMLElement>("[data-studio-page-body]")?.textContent ?? ""
    ctx.fillStyle = "#f0f5f8"
    ctx.font = "700 20px system-ui, -apple-system, sans-serif"
    ctx.fillText(titleText, 32, 118)
    if (bodyText) {
      ctx.fillStyle = "#9fb0bd"
      ctx.font = "400 13px system-ui, -apple-system, sans-serif"
      ctx.fillText(bodyText.slice(0, 130), 32, 142)
    }

    const imgs = [...studioPage.querySelectorAll<HTMLImageElement>("img[data-studio-image]")]
    if (imgs.length > 0) {
      const cols = Math.min(3, Math.max(1, imgs.length <= 2 ? imgs.length : 3))
      const rows = Math.ceil(imgs.length / cols)
      const gridTop = 166
      const availW = out.width - 64
      const availH = out.height - gridTop - 24
      const gap = 14
      const cellW = Math.floor((availW - gap * (cols - 1)) / cols)
      const cellH = Math.floor((availH - gap * (rows - 1)) / rows)
      imgs.forEach((img, idx) => {
        const col = idx % cols
        const row = Math.floor(idx / cols)
        const cx = 32 + col * (cellW + gap)
        const cy = gridTop + row * (cellH + gap)
        ctx.fillStyle = "#141518"
        ctx.fillRect(cx, cy, cellW, cellH)
        ctx.strokeStyle = "#252a32"
        ctx.strokeRect(cx, cy, cellW, cellH)
        if (img.complete && img.naturalWidth > 0) {
          try {
            ctx.drawImage(img, cx + 2, cy + 2, cellW - 4, cellH - 28)
          } catch {}
        }
        const label = img.dataset.studioLabel || img.alt || ""
        if (label) {
          ctx.fillStyle = "#d8dbe0"
          ctx.font = "600 11.5px system-ui, -apple-system, sans-serif"
          ctx.fillText(label, cx + 10, cy + cellH - 10)
        }
      })
    }
    return out
  }

  ctx.fillStyle = "#171f27"
  ctx.fillRect(0, 0, out.width, 44)
  ctx.fillStyle = "#e4e9ed"
  ctx.font = "600 15px system-ui, -apple-system, sans-serif"
  ctx.fillText(`Arcade Dev Hub (${document.title || location.pathname + location.hash})`, 20, 27)
  const cards = [...document.querySelectorAll<HTMLElement>("a.game")]
  let y = 76
  for (const card of cards) {
    ctx.fillStyle = "#19222b"
    ctx.fillRect(24, y, 260, 54)
    ctx.strokeStyle = "#2d3c4a"
    ctx.strokeRect(24, y, 260, 54)
    ctx.fillStyle = "#e4e9ed"
    ctx.font = "600 14px system-ui, -apple-system, sans-serif"
    ctx.fillText(card.querySelector("span")?.textContent ?? card.dataset.game ?? "Game", 38, y + 24)
    ctx.fillStyle = "#8fa0ad"
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillText(card.querySelector("small")?.textContent ?? card.getAttribute("href") ?? "", 38, y + 42)
    y += 66
  }
  return out
}

const COMMAND_ALIASES: Record<string, string> = {
  select: "object.select",
  spawn: "ground.spawn-here",
  "lab.set": "scene.set-param",
  env: "scene.set-env",
  "env.set": "scene.set-env",
  possess: "mode.play",
  release: "mode.play",
  "preset.save": "preset.export",
  "preset.load": "preset.import",
  undo: "edit.undo",
  redo: "edit.redo",
  reroll: "ground.reroll",
  frame: "object.frame",
  note: "ui.note",
  "show-me": "ui.note",
  "note.clear": "ui.note.clear",
}

const STUDIO_SESSION_KEY = "arcade.studio.tour.v1"

function renderMarkdownFragment(markdown: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  let listEl: HTMLUListElement | null = null

  const appendInline = (parent: HTMLElement, text: string) => {
    const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g
    let lastIdx = 0
    let match: RegExpExecArray | null
    while ((match = tokenRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parent.append(document.createTextNode(text.slice(lastIdx, match.index)))
      }
      const raw = match[0]
      if (raw.startsWith("**") && raw.endsWith("**")) {
        const strong = document.createElement("strong")
        strong.style.color = "#f0f5f8"
        strong.textContent = raw.slice(2, -2)
        parent.append(strong)
      } else if (raw.startsWith("`") && raw.endsWith("`")) {
        const code = document.createElement("code")
        code.style.cssText =
          "font:11.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border-radius:4px;background:#0e0f11;border:1px solid #23252a;color:#7cc5d6;"
        code.textContent = raw.slice(1, -1)
        parent.append(code)
      }
      lastIdx = match.index + raw.length
    }
    if (lastIdx < text.length) {
      parent.append(document.createTextNode(text.slice(lastIdx)))
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      listEl = null
      continue
    }
    if (line.startsWith("### ")) {
      listEl = null
      const h3 = document.createElement("h3")
      h3.style.cssText = "margin:10px 0 4px;font:600 13px/1.35 system-ui,-apple-system,sans-serif;color:#e6eef4;"
      appendInline(h3, line.slice(4))
      frag.append(h3)
    } else if (line.startsWith("## ")) {
      listEl = null
      const h2 = document.createElement("h2")
      h2.style.cssText = "margin:12px 0 6px;font:600 15px/1.35 system-ui,-apple-system,sans-serif;color:#f0f5f8;"
      appendInline(h2, line.slice(3))
      frag.append(h2)
    } else if (line.startsWith("# ")) {
      listEl = null
      const h1 = document.createElement("h1")
      h1.style.cssText = "margin:12px 0 6px;font:700 17px/1.3 system-ui,-apple-system,sans-serif;color:#f0f5f8;"
      appendInline(h1, line.slice(2))
      frag.append(h1)
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!listEl) {
        listEl = document.createElement("ul")
        listEl.style.cssText = "margin:4px 0 8px;padding-left:18px;display:flex;flex-direction:column;gap:4px;color:#b8c4ce;font-size:12.5px;line-height:1.45;"
        frag.append(listEl)
      }
      const li = document.createElement("li")
      appendInline(li, line.slice(2))
      listEl.append(li)
    } else {
      listEl = null
      const p = document.createElement("p")
      p.style.cssText = "margin:4px 0 8px;color:#b8c4ce;font-size:12.5px;line-height:1.5;"
      appendInline(p, line)
      frag.append(p)
    }
  }
  return frag
}

// Singleton per-page DevControl runtime (only active in DEV when served by the Arcade dev router)
class PageControlRuntime {
  readonly panels = new Set<LabPanel>()
  private adapter: DevControlAdapter | null = null
  private defaultAdapter: DevControlAdapter | null = null
  private ws: WebSocket | null = null
  private reconnectTimer = 0
  private indicatorEl: HTMLElement | null = null
  private indicatorTimer = 0
  private noteEl: HTMLElement | null = null
  private ringEl: HTMLElement | null = null
  private ringRaf = 0
  private activeNote: DevNotePayload | null = null
  private baseDocumentTitle: string | null = null
  private studioTour: TourDefinition | null = null
  private studioStep = 1
  private studioCollapsed = false
  private studioStripEl: HTMLElement | null = null
  private studioPageEl: HTMLElement | null = null
  private studioLightboxEl: HTMLElement | null = null
  private tourStepAppliedInPlace = false
  private lastActiveAt = Date.now()
  private fallbackReady = false
  readonly pageId: string
  private routerConfig: { controlPath: string; pageToken: string } | null = null

  constructor() {
    this.pageId = this.resolvePageId()
    if (!import.meta.env?.DEV) return
    if (typeof window === "undefined" || typeof document === "undefined") return
    this.routerConfig = this.readRouterConfig()
    this.restoreStudioSession()
    this.syncWindowTourName()
    window.addEventListener("keydown", e => this.handleNoteKeydown(e), { capture: true })
    if (!this.routerConfig) return

    const bumpActivity = () => {
      this.lastActiveAt = Date.now()
      this.sendStatus()
    }
    window.addEventListener("focus", bumpActivity)
    window.addEventListener("blur", () => this.sendStatus())
    document.addEventListener("visibilitychange", () => this.sendStatus())
    window.addEventListener("hashchange", () => {
      this.lastActiveAt = Date.now()
      const meta = this.readUrlTourMeta()
      if (meta && this.studioTour && meta.id === this.studioTour.id && meta.step !== this.studioStep) {
        this.studioStep = meta.step
        this.saveStudioSession()
      }
      this.syncStudioUI()
      this.sendStatus()
    })
    window.addEventListener("popstate", () => {
      const meta = this.readUrlTourMeta()
      if (meta && this.studioTour && meta.id === this.studioTour.id) {
        this.studioStep = meta.step
        this.saveStudioSession()
      }
      this.syncStudioUI()
      this.sendStatus()
    })
    this.connect()
    this.pollUntilReady()
  }

  getActiveNote(): DevNotePayload | null {
    return this.activeNote
  }

  getStudioTour(): TourDefinition | null {
    return this.studioTour
  }

  getStudioStep(): number {
    return this.studioStep
  }

  isStudioStripExpanded(): boolean {
    return Boolean(this.studioTour && this.studioTour.singleTab !== false && !this.studioCollapsed)
  }

  private readUrlTourMeta(): { id: string; step: number; singleTab?: boolean; applied?: boolean } | null {
    try {
      const sp = new URLSearchParams(location.search)
      const id = sp.get("tour")?.trim()
      const step = Number(sp.get("step"))
      const multiTabParam = sp.get("multiTab") === "1" || sp.get("singleTab") === "0"
      if (id && Number.isFinite(step) && step >= 1) {
        return {
          id,
          step: Math.round(step),
          singleTab: !multiTabParam,
          ...(this.tourStepAppliedInPlace ? { applied: true } : {}),
        }
      }
      const hashMatch = (location.hash || "").match(/^#tour\/([a-zA-Z0-9_-]+)(?:\/(\d+))?/)
      if (hashMatch) {
        return {
          id: hashMatch[1]!,
          step: hashMatch[2] ? Math.max(1, Number(hashMatch[2])) : 1,
          singleTab: true,
          ...(this.tourStepAppliedInPlace ? { applied: true } : {}),
        }
      }
    } catch {}
    return null
  }

  private restoreStudioSession() {
    const urlMeta = this.readUrlTourMeta()
    try {
      const raw = sessionStorage.getItem(STUDIO_SESSION_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { tour?: TourDefinition; step?: number; collapsed?: boolean }
        if (parsed && parsed.tour && Array.isArray(parsed.tour.steps)) {
          if (!urlMeta || urlMeta.id === parsed.tour.id) {
            this.studioTour = parsed.tour
            this.studioStep = urlMeta ? urlMeta.step : Math.max(1, Math.min(parsed.tour.steps.length, Number(parsed.step) || 1))
            this.studioCollapsed = Boolean(parsed.collapsed)
          }
        }
      }
    } catch {}
    if (urlMeta) {
      this.studioStep = urlMeta.step
      if (this.studioTour && this.studioTour.id !== urlMeta.id) {
        this.studioTour = null
      }
    }
  }

  private saveStudioSession() {
    try {
      if (!this.studioTour || this.studioTour.singleTab === false) {
        sessionStorage.removeItem(STUDIO_SESSION_KEY)
        return
      }
      sessionStorage.setItem(
        STUDIO_SESSION_KEY,
        JSON.stringify({
          tour: this.studioTour,
          step: this.studioStep,
          collapsed: this.studioCollapsed,
        }),
      )
    } catch {}
  }

  closeStudioTour() {
    this.studioTour = null
    this.tourStepAppliedInPlace = false
    try {
      sessionStorage.removeItem(STUDIO_SESSION_KEY)
    } catch {}
    if (this.studioStripEl) this.studioStripEl.hidden = true
    this.hideStudioPage()
    this.clearNote()
    document.documentElement.removeAttribute("data-arcade-studio-open")
    document.documentElement.removeAttribute("data-arcade-studio-collapsed")
    document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
    try {
      const u = new URL(location.href)
      let changed = false
      for (const k of ["tour", "step", "singleTab"]) {
        if (u.searchParams.has(k)) {
          u.searchParams.delete(k)
          changed = true
        }
      }
      if (u.hash.startsWith("#tour/")) {
        u.hash = "#games"
        changed = true
      }
      if (changed) history.replaceState(null, "", u.pathname + u.search + u.hash)
    } catch {}
    this.sendStatus()
  }

  private isPageStep(step: TourStepDefinition | undefined): boolean {
    if (!step) return false
    return step.kind === "page" || Boolean((step.markdown || (step.images && step.images.length > 0)) && step.url.includes("#tour/"))
  }

  private syncWindowTourName() {
    const meta = this.readUrlTourMeta()
    if (meta) {
      try {
        window.name = `arcade-tour:${meta.id}:${meta.step}`
      } catch {}
    }
  }

  private handleNoteKeydown(event: KeyboardEvent) {
    const target = event.composedPath()[0] as HTMLElement | null
    const inText =
      Boolean(target) &&
      ((target instanceof HTMLInputElement && (target.type === "text" || target.type === "search" || target.type === "number")) ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable))

    if (this.studioLightboxEl && !this.studioLightboxEl.hidden && event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      this.studioLightboxEl.hidden = true
      return
    }

    if (this.studioTour && this.studioTour.singleTab !== false && !inText && this.studioTour.steps.length > 1) {
      const isAltPrev =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.code === "BracketLeft" || event.key === "[" || event.key === "“" || (event.key === "ArrowLeft" && !document.activeElement?.hasAttribute("data-lab")))
      const isAltNext =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.code === "BracketRight" || event.key === "]" || event.key === "‘" || (event.key === "ArrowRight" && !document.activeElement?.hasAttribute("data-lab")))
      if (isAltPrev || isAltNext) {
        event.preventDefault()
        event.stopPropagation()
        const count = this.studioTour.steps.length
        const nextStep = isAltPrev ? (this.studioStep > 1 ? this.studioStep - 1 : count) : this.studioStep < count ? this.studioStep + 1 : 1
        void this.goToTourStep(nextStep)
        return
      }
    }

    if (!this.activeNote) return
    if (inText || (target && target.tagName === "SELECT")) {
      return
    }
    if (event.key === "Escape" && this.activeNote.dismissible !== false) {
      const modalOpen = Boolean(document.querySelector(".lab-palette-backdrop:not([hidden]), .lab-modal-backdrop:not([hidden])"))
      if (modalOpen) return
      this.clearNote()
      this.sendStatus()
    }
  }

  private ensureNoteStyle() {
    if (document.querySelector("style[data-arcade-note-style]")) return
    const style = document.createElement("style")
    style.dataset.arcadeNoteStyle = ""
    style.textContent = `
      :root {
        --arcade-studio-strip-h: 0px;
      }
      html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) {
        --arcade-studio-strip-h: 30px;
      }
      html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) .lab-workbench {
        margin-top: 30px !important;
        height: calc(100dvh - 30px) !important;
      }
      html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) .hub-bar {
        margin-top: 30px !important;
      }
      [data-arcade-note][hidden], [data-arcade-note-ring][hidden], [data-arcade-studio-strip][hidden], [data-arcade-studio-page][hidden], [data-arcade-studio-lightbox][hidden] {
        display: none !important;
      }
      @keyframes arcade-note-pulse {
        0%, 100% { transform: scale(1); opacity: 0.96; }
        50% { transform: scale(1.035); opacity: 0.68; }
      }
      @keyframes arcade-note-card-flash {
        0% { transform: translateX(-50%) scale(1.035); }
        100% { transform: translateX(-50%) scale(1); }
      }
      [data-arcade-note] button:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.14) !important;
        color: #fff !important;
      }
      [data-arcade-note] button:disabled {
        opacity: 0.35;
        cursor: default;
      }
      [data-arcade-studio-strip] {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 30px;
        z-index: 10002;
        background: #0c0d0f;
        border-bottom: 1px solid #23252a;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 8px;
        font: 11.5px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        color: #d8dbe0;
        user-select: none;
        box-sizing: border-box;
      }
      html[data-arcade-studio-collapsed="true"] [data-arcade-studio-strip] {
        right: auto;
        top: 6px;
        left: 8px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid #2c2f35;
        background: rgba(12, 13, 15, 0.94);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        padding: 0 6px 0 8px;
      }
      html[data-arcade-studio-collapsed="true"] [data-studio-tabs],
      html[data-arcade-studio-collapsed="true"] [data-studio-kbd] {
        display: none !important;
      }
      [data-studio-brand] {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        font-size: 11px;
        color: #9fb0bd;
        padding-right: 4px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      [data-studio-counter] {
        font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #7cc5d6;
        background: rgba(124, 197, 214, 0.14);
        padding: 2px 5px;
        border-radius: 3px;
      }
      [data-studio-tabs] {
        display: flex;
        align-items: center;
        gap: 3px;
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
        padding: 2px 0;
      }
      [data-studio-tabs]::-webkit-scrollbar {
        display: none;
      }
      [data-studio-step] {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px 0 6px;
        border-radius: 4px;
        border: 1px solid #23252a;
        background: #141518;
        color: #8b9098;
        font: 500 11px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
      }
      [data-studio-step]:hover {
        background: #1e2024;
        color: #d8dbe0;
        border-color: #2c2f35;
      }
      [data-studio-step][aria-selected="true"] {
        background: rgba(77, 141, 255, 0.16);
        color: #f2f6fa;
        border-color: var(--step-accent, #4d8dff);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--step-accent, #4d8dff) 35%, transparent);
      }
      [data-studio-step-num] {
        font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--step-accent, #7cc5d6);
        opacity: 0.85;
      }
      [data-studio-step][aria-selected="true"] [data-studio-step-num] {
        opacity: 1;
      }
      .arcade-studio-btn {
        display: inline-grid;
        place-items: center;
        min-width: 20px;
        height: 20px;
        padding: 0 4px;
        border-radius: 4px;
        border: 1px solid #23252a;
        background: #141518;
        color: #9fb0bd;
        font: 600 11px/1 system-ui, -apple-system, sans-serif;
        cursor: pointer;
        flex-shrink: 0;
      }
      .arcade-studio-btn:hover:not(:disabled) {
        background: #1e2024;
        color: #fff;
        border-color: #353942;
      }
      .arcade-studio-btn:disabled {
        opacity: 0.35;
        cursor: default;
      }
      [data-studio-kbd] {
        font: 500 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #5b6068;
        padding: 0 4px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      [data-arcade-studio-page] {
        position: fixed;
        top: var(--arcade-studio-strip-h, 30px);
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 9500;
        background: #0c0d0f;
        color: #d8dbe0;
        overflow-y: auto;
        padding: 66px 24px 28px;
        font: 12.5px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        box-sizing: border-box;
      }
      [data-studio-page-inner] {
        max-width: 1360px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      [data-studio-image-grid] {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      @media (max-width: 960px) {
        [data-studio-image-grid] {
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        }
      }
      .arcade-studio-img-card {
        background: #141518;
        border: 1px solid #23252a;
        border-radius: 7px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        cursor: zoom-in;
        transition: border-color 0.12s ease;
      }
      .arcade-studio-img-card:hover {
        border-color: #4d8dff;
      }
      .arcade-studio-img-card img {
        width: 100%;
        height: 196px;
        object-fit: cover;
        display: block;
        background: #08090b;
      }
      .arcade-studio-img-meta {
        padding: 6px 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        border-top: 1px solid #1e2024;
      }
    `
    document.head.append(style)
  }

  resolveNoteTargetRect(target: DevNoteTarget, revealSetting = false): DevNoteResolvedRect | null {
    if (target.rect) {
      const [rx, ry, rw, rh] = target.rect
      const normalized = rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1 && rw > 0 && rw <= 1 && rh > 0 && rh <= 1
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      return {
        x: normalized ? rx * vw : rx,
        y: normalized ? ry * vh : ry,
        width: normalized ? rw * vw : rw,
        height: normalized ? rh * vh : rh,
        shape: "rect",
      }
    }

    if (target.setting) {
      const panels = [...this.panels]
      const found = findControlRow(panels, target.setting)
      if (found) {
        const rowEl = found.panel.getControlElement(found.control.key, revealSetting)
        if (rowEl) {
          const r = rowEl.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect", label: found.control.label }
          }
        }
      }
    }

    const adapter = this.activeAdapter()
    if (adapter.resolveTargetRect) {
      const custom = adapter.resolveTargetRect(target)
      if (custom && custom.width > 0 && custom.height > 0) return custom
    }

    const harness = (globalThis as { __arcadeHarness?: { resolveTargetRect?: (t: DevNoteTarget) => DevNoteResolvedRect | null } }).__arcadeHarness
    if (harness?.resolveTargetRect) {
      const hRect = harness.resolveTargetRect(target)
      if (hRect && hRect.width > 0 && hRect.height > 0) return hRect
    }

    if (target.selector) {
      try {
        const el = document.querySelector<HTMLElement>(target.selector)
        if (el && !el.hidden) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect" }
          }
        }
      } catch {}
    }

    if (target.objectId) {
      const q = target.objectId
      const candidates = [
        `[data-object-id="${CSS.escape(q)}"]`,
        `[data-actor-id="${CSS.escape(q)}"]`,
        `[data-catalog-id="${CSS.escape(q)}"]`,
        `[data-game="${CSS.escape(q)}"]`,
        `#${CSS.escape(q)}`,
      ]
      for (const sel of candidates) {
        try {
          const el = document.querySelector<HTMLElement>(sel)
          if (el && !el.hidden) {
            const r = el.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) {
              return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect" }
            }
          }
        } catch {}
      }
    }

    return null
  }

  private updateTargetRing(initial = false) {
    if (this.ringRaf) {
      cancelAnimationFrame(this.ringRaf)
      this.ringRaf = 0
    }
    const note = this.activeNote
    if (!note?.target) {
      if (this.ringEl) this.ringEl.hidden = true
      return
    }

    const rect = this.resolveNoteTargetRect(note.target, initial)
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      if (this.ringEl) this.ringEl.hidden = true
    } else {
      if (!this.ringEl || !document.body.contains(this.ringEl)) {
        const ring = document.createElement("div")
        ring.dataset.arcadeNoteRing = ""
        ring.setAttribute("aria-hidden", "true")
        document.body.append(ring)
        this.ringEl = ring
      }
      const colors = resolveAccentColors(note.accent)
      const pad = 6
      const borderRadius = rect.shape === "pill" ? "999px" : "8px"
      this.ringEl.hidden = false
      this.ringEl.style.cssText = `position:fixed;left:${Math.round(rect.x - pad)}px;top:${Math.round(rect.y - pad)}px;width:${Math.round(rect.width + pad * 2)}px;height:${Math.round(rect.height + pad * 2)}px;border-radius:${borderRadius};border:2px solid ${colors.text};box-shadow:0 0 0 4px ${colors.glow},0 0 18px ${colors.glow};pointer-events:none;z-index:9998;box-sizing:border-box;animation:arcade-note-pulse 1.8s ease-in-out infinite;`
    }

    this.ringRaf = requestAnimationFrame(() => this.updateTargetRing(false))
  }

  private navigateTourStep(direction: "prev" | "next") {
    if (this.studioTour && this.studioTour.singleTab !== false) {
      const count = this.studioTour.steps.length
      const nextStep = direction === "prev" ? Math.max(1, this.studioStep - 1) : Math.min(count, this.studioStep + 1)
      if (nextStep !== this.studioStep) {
        void this.goToTourStep(nextStep)
      }
      return
    }
    const note = this.activeNote
    if (!note) return
    const targetUrl = direction === "prev" ? note.prevUrl : note.nextUrl
    const targetStep =
      typeof note.stepIndex === "number" ? (direction === "prev" ? note.stepIndex - 1 : note.stepIndex + 1) : undefined

    if (note.singleTab && targetUrl) {
      location.assign(targetUrl)
      return
    }

    if (note.tourId && targetStep !== undefined) {
      const targetWinName = `arcade-tour:${note.tourId}:${targetStep}`
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "tour.focus",
            tourId: note.tourId,
            step: targetStep,
            url: targetUrl,
            singleTab: Boolean(note.singleTab),
          }),
        )
      }
      try {
        const existing = window.open("", targetWinName)
        if (existing && existing !== window && existing.location?.href && existing.location.href !== "about:blank") {
          existing.focus()
          return
        }
        if (existing && existing.location?.href === "about:blank") {
          existing.close()
        }
      } catch {}
    }

    if (targetUrl) {
      location.assign(targetUrl)
    }
  }

  private canApplyStepInPlace(step: TourStepDefinition, targetUrl: string): boolean {
    try {
      const cur = new URL(location.href)
      const dst = new URL(targetUrl, location.origin)
      if (cur.origin !== dst.origin || cur.pathname !== dst.pathname) return false
      if (cur.searchParams.has("bench") !== dst.searchParams.has("bench")) return false
      const stripParams = (sp: URLSearchParams, isLab: boolean) => {
        const copy = new URLSearchParams(sp)
        copy.delete("tour")
        copy.delete("step")
        copy.delete("singleTab")
        copy.delete("multiTab")
        if (isLab) copy.delete("section")
        copy.sort()
        return copy.toString()
      }
      const isLab = isLabPath(cur.pathname)
      return stripParams(cur.searchParams, isLab) === stripParams(dst.searchParams, isLab)
    } catch {
      void step
      return false
    }
  }

  private async invokeCommandDirect(adapter: DevControlAdapter, rawCmd: string, args?: Record<string, unknown>) {
    const cmdId = this.resolveCommandId(adapter.commands, rawCmd)
    const out = adapter.commands.invoke(cmdId, args, {
      pickedObject: null,
      groundHit: null,
      source: "cli",
    })
    if (out.ok && out.result instanceof Promise) {
      try {
        await out.result
      } catch {}
    }
    return out
  }

  /** Runs one of this page's commands from a same-origin embedder (the Lab Overworld's page stations). */
  async invokeLocal(command: string, args?: Record<string, unknown>) {
    const out = await this.invokeCommandDirect(this.activeAdapter(), command, args)
    return out.ok && out.result instanceof Promise ? { ...out, result: await out.result.catch(() => null) } : out
  }

  async goToTourStep(stepNumber: number): Promise<void> {
    const tour = this.studioTour
    if (!tour || stepNumber < 1 || stepNumber > tour.steps.length) return
    const step = tour.steps[stepNumber - 1]!
    this.studioStep = stepNumber
    this.saveStudioSession()
    const targetUrl = buildTourStepUrl(location.origin, step.url, tour.id, stepNumber, true)

    if (this.canApplyStepInPlace(step, targetUrl)) {
      this.tourStepAppliedInPlace = true
      history.replaceState(null, "", targetUrl)
      this.renderStudioStrip()
      await this.applyStepInPlace(tour, stepNumber)
      this.sendStatus()
      return
    }

    this.tourStepAppliedInPlace = false
    location.assign(targetUrl)
  }

  private async applyStepInPlace(tour: TourDefinition, stepNumber: number): Promise<void> {
    await this.waitForReady()
    const step = tour.steps[stepNumber - 1]
    if (!step) return
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)

    if (this.isPageStep(step)) {
      this.renderStudioPage(tour, step, stepNumber)
    } else {
      this.hideStudioPage()
      if (isLabPath(location.pathname)) {
        const parsed = new URL(step.url, location.origin)
        const urlSection =
          parsed.searchParams.get("section")?.trim() ||
          parsed.hash.replace(/^#/, "").split("/")[0]?.trim() ||
          ""
        const isGridStep =
          step.kind === "grid" || step.setup.some(c => c.command === "grid.open" || c.command === "grid" || c.command === "grid.focus")
        if (!isGridStep && adapter.commands.get("grid.close")) {
          await this.invokeCommandDirect(adapter, "grid.close")
        }
        const hasSectionCmd = step.setup.some(c =>
          [
            "scene.select-section",
            "look.preset",
            "look.set",
            "foliage.preset",
            "foliage.set",
            "vignette.preset",
            "vignette.camera",
            "grid.open",
            "grid",
          ].includes(c.command),
        )
        const desiredSection = urlSection || (!hasSectionCmd ? "spawn" : "")
        if (desiredSection && adapter.getSection?.() !== desiredSection) {
          await this.invokeCommandDirect(adapter, "scene.select-section", { section: desiredSection })
        }
      } else if (location.pathname.endsWith("/dev.html")) {
        const parsed = new URL(step.url, location.origin)
        const targetHash = parsed.hash || "#games"
        if (location.hash !== targetHash) {
          location.hash = targetHash
          await new Promise(r => setTimeout(r, 60))
        }
      }
    }

    for (const cmd of step.setup) {
      const currentAdapter = this.activeAdapter()
      this.ensureStandardCommands(currentAdapter)
      await this.invokeCommandDirect(currentAdapter, cmd.command, cmd.args)
    }

    const prevUrl =
      stepNumber > 1 ? buildTourStepUrl(location.origin, tour.steps[stepNumber - 2]!.url, tour.id, stepNumber - 1, true) : undefined
    const nextUrl =
      stepNumber < tour.steps.length
        ? buildTourStepUrl(location.origin, tour.steps[stepNumber]!.url, tour.id, stepNumber + 1, true)
        : undefined

    this.showNote({
      title: step.title,
      ...(step.body ? { body: step.body } : {}),
      step: `${stepNumber}/${tour.steps.length}`,
      ...(step.accent ? { accent: step.accent } : {}),
      ...(step.target ? { target: step.target } : {}),
      dismissible: step.dismissible ?? true,
      tourId: tour.id,
      stepIndex: stepNumber,
      stepCount: tour.steps.length,
      ...(prevUrl ? { prevUrl } : {}),
      ...(nextUrl ? { nextUrl } : {}),
      singleTab: true,
    })
  }

  private renderStudioStrip() {
    if (typeof document === "undefined" || !document.body) return
    this.ensureNoteStyle()
    const tour = this.studioTour
    const meta = this.readUrlTourMeta()
    if (!tour || tour.singleTab === false || meta?.singleTab === false) {
      if (this.studioStripEl) this.studioStripEl.hidden = true
      document.documentElement.removeAttribute("data-arcade-studio-open")
      document.documentElement.removeAttribute("data-arcade-studio-collapsed")
      document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
      return
    }

    document.documentElement.setAttribute("data-arcade-studio-open", "true")
    if (this.studioCollapsed) {
      document.documentElement.setAttribute("data-arcade-studio-collapsed", "true")
      document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
    } else {
      document.documentElement.removeAttribute("data-arcade-studio-collapsed")
      document.documentElement.style.setProperty("--arcade-studio-strip-h", "30px")
    }

    if (!this.studioStripEl || !document.body.contains(this.studioStripEl)) {
      const nav = document.createElement("nav")
      nav.dataset.arcadeStudioStrip = ""
      nav.setAttribute("aria-label", "Arcade Studio Tour Tabs")
      document.body.prepend(nav)
      this.studioStripEl = nav
    }

    const strip = this.studioStripEl
    strip.hidden = false
    strip.replaceChildren()

    const brand = document.createElement("span")
    brand.dataset.studioBrand = ""
    const icon = document.createElement("span")
    icon.textContent = "◫"
    icon.style.color = "#4d8dff"
    const tourTitle = document.createElement("span")
    tourTitle.textContent = tour.title || tour.id
    const counter = document.createElement("span")
    counter.dataset.studioCounter = ""
    counter.textContent = `${this.studioStep}/${tour.steps.length}`
    brand.append(icon, tourTitle, counter)
    strip.append(brand)

    const prevBtn = document.createElement("button")
    prevBtn.type = "button"
    prevBtn.className = "arcade-studio-btn"
    prevBtn.dataset.studioPrev = ""
    prevBtn.tabIndex = -1
    prevBtn.title = "Previous step (Alt+[)"
    prevBtn.setAttribute("aria-label", "Previous tour step")
    prevBtn.textContent = "‹"
    prevBtn.disabled = tour.steps.length <= 1
    prevBtn.onclick = e => {
      e.stopPropagation()
      const prev = this.studioStep > 1 ? this.studioStep - 1 : tour.steps.length
      void this.goToTourStep(prev)
    }

    const nextBtn = document.createElement("button")
    nextBtn.type = "button"
    nextBtn.className = "arcade-studio-btn"
    nextBtn.dataset.studioNext = ""
    nextBtn.tabIndex = -1
    nextBtn.title = "Next step (Alt+])"
    nextBtn.setAttribute("aria-label", "Next tour step")
    nextBtn.textContent = "›"
    nextBtn.disabled = tour.steps.length <= 1
    nextBtn.onclick = e => {
      e.stopPropagation()
      const next = this.studioStep < tour.steps.length ? this.studioStep + 1 : 1
      void this.goToTourStep(next)
    }

    strip.append(prevBtn, nextBtn)

    const tabsWrap = document.createElement("div")
    tabsWrap.dataset.studioTabs = ""
    tabsWrap.setAttribute("role", "tablist")

    tour.steps.forEach((step, idx) => {
      const stepNum = idx + 1
      const isSelected = stepNum === this.studioStep
      const colors = resolveAccentColors(step.accent)
      const tab = document.createElement("button")
      tab.type = "button"
      tab.setAttribute("role", "tab")
      tab.dataset.studioStep = String(stepNum)
      tab.dataset.stepKind = this.isPageStep(step) ? "page" : "scene"
      tab.setAttribute("aria-selected", String(isSelected))
      tab.tabIndex = isSelected ? 0 : -1
      tab.title = `${stepNum}. ${step.title}${step.body ? ` — ${step.body}` : ""}`
      tab.style.setProperty("--step-accent", colors.text)

      const numSpan = document.createElement("span")
      numSpan.dataset.studioStepNum = ""
      numSpan.textContent = String(stepNum)

      const labelSpan = document.createElement("span")
      labelSpan.dataset.studioStepTitle = ""
      labelSpan.textContent = step.title

      tab.append(numSpan, labelSpan)
      if (this.isPageStep(step)) {
        const kindBadge = document.createElement("span")
        kindBadge.textContent = "▤"
        kindBadge.style.cssText = "font-size:10px;opacity:0.7;"
        kindBadge.title = "Studio landing page (0 WebGPU cost)"
        tab.append(kindBadge)
      }

      tab.onclick = e => {
        e.stopPropagation()
        tab.blur()
        void this.goToTourStep(stepNum)
      }
      tab.onkeydown = e => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault()
          e.stopPropagation()
          const delta = e.key === "ArrowLeft" ? -1 : 1
          const next = ((stepNum - 1 + delta + tour.steps.length) % tour.steps.length) + 1
          void this.goToTourStep(next)
        }
      }

      tabsWrap.append(tab)
    })

    strip.append(tabsWrap)

    const kbdHint = document.createElement("span")
    kbdHint.dataset.studioKbd = ""
    kbdHint.title = "Switch mini tabs with Alt+[ and Alt+]"
    kbdHint.textContent = "⌥[ ⌥]"
    strip.append(kbdHint)

    const collapseBtn = document.createElement("button")
    collapseBtn.type = "button"
    collapseBtn.className = "arcade-studio-btn"
    collapseBtn.dataset.studioCollapse = ""
    collapseBtn.tabIndex = -1
    collapseBtn.title = this.studioCollapsed ? "Expand studio tab strip" : "Collapse studio tab strip"
    collapseBtn.setAttribute("aria-label", this.studioCollapsed ? "Expand studio tab strip" : "Collapse studio tab strip")
    collapseBtn.textContent = this.studioCollapsed ? "▾" : "▴"
    collapseBtn.onclick = e => {
      e.stopPropagation()
      this.studioCollapsed = !this.studioCollapsed
      this.saveStudioSession()
      this.renderStudioStrip()
      if (this.activeNote) this.showNote(this.activeNote)
    }

    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "arcade-studio-btn"
    closeBtn.dataset.studioClose = ""
    closeBtn.tabIndex = -1
    closeBtn.title = "Close studio tour strip"
    closeBtn.setAttribute("aria-label", "Close studio tour strip")
    closeBtn.textContent = "×"
    closeBtn.onclick = e => {
      e.stopPropagation()
      this.closeStudioTour()
    }

    strip.append(collapseBtn, closeBtn)
    const activeTab = tabsWrap.querySelector<HTMLElement>('[aria-selected="true"]')
    activeTab?.scrollIntoView({ inline: "center", block: "nearest" })
  }

  private openStudioLightbox(images: TourPageImage[], tourId: string, initialIdx: number) {
    if (!document.body) return
    if (!this.studioLightboxEl || !document.body.contains(this.studioLightboxEl)) {
      const lb = document.createElement("div")
      lb.dataset.arcadeStudioLightbox = ""
      lb.style.cssText =
        "position:fixed;inset:0;z-index:10005;background:rgba(6,8,10,0.92);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;"
      document.body.append(lb)
      this.studioLightboxEl = lb
    }
    let cur = initialIdx
    const lb = this.studioLightboxEl
    lb.hidden = false

    const renderLb = () => {
      lb.replaceChildren()
      const item = images[cur]!
      const src = resolveTourAssetUrl(tourId, item.src)

      const topRow = document.createElement("div")
      topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;width:min(1280px,94vw);margin-bottom:10px;color:#e6eef4;"
      const labelEl = document.createElement("div")
      labelEl.style.cssText = "font:600 14px/1.3 system-ui,-apple-system,sans-serif;"
      labelEl.textContent = `${cur + 1}/${images.length} · ${item.label || item.src}${item.caption ? ` — ${item.caption}` : ""}`

      const btnGroup = document.createElement("div")
      btnGroup.style.cssText = "display:flex;gap:6px;"
      const prev = document.createElement("button")
      prev.type = "button"
      prev.className = "arcade-studio-btn"
      prev.style.cssText = "width:28px;height:26px;"
      prev.textContent = "‹"
      prev.onclick = e => {
        e.stopPropagation()
        cur = (cur - 1 + images.length) % images.length
        renderLb()
      }
      const next = document.createElement("button")
      next.type = "button"
      next.className = "arcade-studio-btn"
      next.style.cssText = "width:28px;height:26px;"
      next.textContent = "›"
      next.onclick = e => {
        e.stopPropagation()
        cur = (cur + 1) % images.length
        renderLb()
      }
      const close = document.createElement("button")
      close.type = "button"
      close.className = "arcade-studio-btn"
      close.style.cssText = "width:28px;height:26px;"
      close.textContent = "×"
      close.onclick = e => {
        e.stopPropagation()
        lb.hidden = true
      }
      btnGroup.append(prev, next, close)
      topRow.append(labelEl, btnGroup)

      const img = document.createElement("img")
      img.src = src
      img.alt = item.label || item.src
      img.style.cssText = "max-width:94vw;max-height:calc(100dvh - 96px);border-radius:6px;border:1px solid #2c2f35;box-shadow:0 16px 48px rgba(0,0,0,0.65);object-fit:contain;"
      lb.append(topRow, img)
    }

    lb.onclick = () => {
      lb.hidden = true
    }
    renderLb()
  }

  private renderStudioPage(tour: TourDefinition, step: TourStepDefinition, stepNumber: number) {
    if (typeof document === "undefined" || !document.body) return
    this.ensureNoteStyle()
    if (!this.studioPageEl || !document.body.contains(this.studioPageEl)) {
      const page = document.createElement("section")
      page.dataset.arcadeStudioPage = ""
      page.setAttribute("aria-label", "Studio Tour Landing Page")
      document.body.append(page)
      this.studioPageEl = page
    }

    const pageEl = this.studioPageEl
    pageEl.hidden = false
    pageEl.replaceChildren()

    const inner = document.createElement("div")
    inner.dataset.studioPageInner = ""

    const hiddenMeta = document.createElement("div")
    hiddenMeta.hidden = true
    const h1 = document.createElement("h1")
    h1.dataset.studioPageTitle = ""
    h1.textContent = step.title
    hiddenMeta.append(h1)
    if (step.body) {
      const lead = document.createElement("p")
      lead.dataset.studioPageBody = ""
      lead.textContent = step.body
      hiddenMeta.append(lead)
    }
    inner.append(hiddenMeta)

    if (step.markdown) {
      const mdCard = document.createElement("div")
      mdCard.dataset.studioMarkdown = ""
      mdCard.style.cssText = "background:#141518;border:1px solid #23252a;border-radius:7px;padding:10px 14px;"
      mdCard.append(renderMarkdownFragment(step.markdown))
      inner.append(mdCard)
    }

    if (step.images && step.images.length > 0) {
      const grid = document.createElement("div")
      grid.dataset.studioImageGrid = ""
      step.images.forEach((item, idx) => {
        const card = document.createElement("figure")
        card.className = "arcade-studio-img-card"
        card.style.margin = "0"
        card.dataset.studioImageCard = String(idx + 1)

        const img = document.createElement("img")
        img.dataset.studioImage = String(idx + 1)
        img.dataset.studioLabel = item.label || item.src
        img.src = resolveTourAssetUrl(tour.id, item.src)
        img.alt = item.label || item.src
        img.loading = "eager"

        const meta = document.createElement("figcaption")
        meta.className = "arcade-studio-img-meta"

        const titleRow = document.createElement("div")
        titleRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;"

        const nameSpan = document.createElement("span")
        nameSpan.style.cssText = "font-weight:600;font-size:12.5px;color:#e6eef4;"
        nameSpan.textContent = item.label || item.src
        titleRow.append(nameSpan)

        if (item.tag) {
          const tagSpan = document.createElement("span")
          tagSpan.style.cssText =
            "font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;border-radius:4px;background:rgba(77,141,255,0.16);color:#8ab4ff;text-transform:uppercase;"
          tagSpan.textContent = item.tag
          titleRow.append(tagSpan)
        }
        meta.append(titleRow)

        if (item.caption) {
          const cap = document.createElement("div")
          cap.style.cssText = "font-size:11.5px;color:#8b9098;line-height:1.35;"
          cap.textContent = item.caption
          meta.append(cap)
        }

        card.append(img, meta)
        card.onclick = () => this.openStudioLightbox(step.images!, tour.id, idx)
        grid.append(card)
      })
      inner.append(grid)
    }

    pageEl.append(inner)
  }

  private hideStudioPage() {
    if (this.studioPageEl) {
      this.studioPageEl.hidden = true
    }
    if (this.studioLightboxEl) {
      this.studioLightboxEl.hidden = true
    }
  }

  private syncStudioUI() {
    if (typeof document === "undefined" || !document.body) return
    this.renderStudioStrip()
    if (this.studioTour && this.studioTour.singleTab !== false) {
      const currentStep = this.studioTour.steps[this.studioStep - 1]
      const onTourHash = location.hash.startsWith("#tour/")
      if (currentStep && this.isPageStep(currentStep) && (onTourHash || location.pathname.endsWith("/dev.html"))) {
        this.renderStudioPage(this.studioTour, currentStep, this.studioStep)
      } else {
        this.hideStudioPage()
      }
    } else {
      this.hideStudioPage()
    }
  }

  showNote(note: DevNotePayload): DevNoteResolvedRect | null {
    this.ensureNoteStyle()
    if (note.tourId && note.stepIndex && this.studioTour && this.studioTour.id === note.tourId) {
      this.studioStep = note.stepIndex
      this.saveStudioSession()
    }
    this.syncStudioUI()
    if (this.baseDocumentTitle === null) {
      const current = document.title || ""
      this.baseDocumentTitle = current.startsWith("▸ ") ? current.slice(2) : current
    }
    this.activeNote = note
    document.title = note.title.startsWith("▸ ") ? note.title : `▸ ${note.title}`
    if (note.tourId && note.stepIndex) {
      try {
        window.name = `arcade-tour:${note.tourId}:${note.stepIndex}`
      } catch {}
    }

    if (!this.noteEl || !document.body.contains(this.noteEl)) {
      const el = document.createElement("aside")
      el.dataset.arcadeNote = ""
      el.setAttribute("role", "region")
      el.setAttribute("aria-label", "Show me note")
      document.body.append(el)
      this.noteEl = el
    }

    const colors = resolveAccentColors(note.accent)
    const studioPageVisible = Boolean(document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])"))
    const hasTopbar = !studioPageVisible && Boolean(document.querySelector(".lab-topbar, .hub-bar"))
    const stripOffset = this.isStudioStripExpanded() ? 30 : 0
    const topPx = (hasTopbar ? 42 : 8) + stripOffset
    this.noteEl.hidden = false
    this.noteEl.style.cssText = `position:fixed;top:${topPx}px;left:50%;transform:translateX(-50%);z-index:10000;pointer-events:none;max-width:min(760px,calc(100vw - 28px));background:rgba(11,15,20,0.93);backdrop-filter:blur(10px);color:#f0f5f8;border:1px solid ${colors.border};border-left:3.5px solid ${colors.text};border-radius:9px;padding:7px 12px;box-shadow:0 8px 26px rgba(0,0,0,0.48);font:12.5px/1.35 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;gap:10px;animation:arcade-note-card-flash 0.22s ease-out;`

    this.noteEl.replaceChildren()

    if (note.step) {
      const stepBadge = document.createElement("span")
      stepBadge.dataset.arcadeNoteStep = ""
      stepBadge.textContent = note.step
      stepBadge.style.cssText = `font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 6px;border-radius:4px;background:${colors.badgeBg};color:${colors.text};white-space:nowrap;flex-shrink:0;`
      this.noteEl.append(stepBadge)
    }

    const textCol = document.createElement("div")
    textCol.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;"

    const titleEl = document.createElement("div")
    titleEl.dataset.arcadeNoteTitle = ""
    titleEl.textContent = `▸ ${note.title}`
    titleEl.style.cssText = "font-weight:600;font-size:13px;color:#f0f5f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    textCol.append(titleEl)

    if (note.body) {
      const bodyEl = document.createElement("div")
      bodyEl.dataset.arcadeNoteBody = ""
      bodyEl.textContent = note.body
      bodyEl.style.cssText = "font-size:11.5px;color:#a5b5c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
      bodyEl.title = note.body
      textCol.append(bodyEl)
    }
    this.noteEl.append(textCol)

    const hasTourNav = Boolean(note.prevUrl || note.nextUrl || (note.stepCount && note.stepCount > 1))
    if (hasTourNav) {
      const navWrap = document.createElement("div")
      navWrap.style.cssText = "display:flex;align-items:center;gap:4px;pointer-events:auto;flex-shrink:0;"
      const btnCss =
        "pointer-events:auto;font:600 11px/1 system-ui,-apple-system,sans-serif;padding:4px 7px;border-radius:5px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#d7e2ea;cursor:pointer;"

      const prevBtn = document.createElement("button")
      prevBtn.type = "button"
      prevBtn.dataset.arcadeNotePrev = ""
      prevBtn.tabIndex = -1
      prevBtn.textContent = "‹ Prev"
      prevBtn.disabled = !note.prevUrl && (note.stepIndex === undefined || note.stepIndex <= 1)
      prevBtn.style.cssText = btnCss
      prevBtn.onclick = e => {
        e.stopPropagation()
        prevBtn.blur()
        this.navigateTourStep("prev")
      }

      const nextBtn = document.createElement("button")
      nextBtn.type = "button"
      nextBtn.dataset.arcadeNoteNext = ""
      nextBtn.tabIndex = -1
      nextBtn.textContent = "Next ›"
      nextBtn.disabled = !note.nextUrl && (note.stepIndex === undefined || note.stepCount === undefined || note.stepIndex >= note.stepCount)
      nextBtn.style.cssText = btnCss
      nextBtn.onclick = e => {
        e.stopPropagation()
        nextBtn.blur()
        this.navigateTourStep("next")
      }

      navWrap.append(prevBtn, nextBtn)
      this.noteEl.append(navWrap)
    }

    if (note.dismissible !== false) {
      const closeBtn = document.createElement("button")
      closeBtn.type = "button"
      closeBtn.dataset.arcadeNoteDismiss = ""
      closeBtn.tabIndex = -1
      closeBtn.title = "Dismiss note (Esc)"
      closeBtn.setAttribute("aria-label", "Dismiss note")
      closeBtn.textContent = "×"
      closeBtn.style.cssText =
        "pointer-events:auto;font:600 14px/1 system-ui,-apple-system,sans-serif;width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:#9fb0bd;cursor:pointer;display:grid;place-items:center;flex-shrink:0;padding:0;"
      closeBtn.onclick = e => {
        e.stopPropagation()
        this.clearNote()
        this.sendStatus()
      }
      this.noteEl.append(closeBtn)
    }

    const initialRect = note.target ? this.resolveNoteTargetRect(note.target, true) : null
    this.updateTargetRing(false)
    this.sendStatus()
    return initialRect
  }

  clearNote() {
    this.activeNote = null
    if (this.ringRaf) {
      cancelAnimationFrame(this.ringRaf)
      this.ringRaf = 0
    }
    if (this.noteEl) this.noteEl.hidden = true
    if (this.ringEl) this.ringEl.hidden = true
    if (this.baseDocumentTitle !== null) {
      document.title = this.baseDocumentTitle
    }
  }

  private isPageReady(): boolean {
    if (this.adapter !== null) return true
    if (isLabPath(location.pathname) || location.pathname.endsWith("/dev.html")) {
      return this.fallbackReady
    }
    if (location.pathname.includes("/outbreak/")) {
      const h = (globalThis as { __arcadeHarness?: { ready?: boolean } }).__arcadeHarness
      return Boolean(h?.ready) || this.fallbackReady
    }
    if (this.panels.size > 0) return true
    if ((globalThis as { carrier?: unknown }).carrier !== undefined) return true
    return this.fallbackReady
  }

  private pollUntilReady() {
    const started = Date.now()
    const isStructuredPage =
      isLabPath(location.pathname) ||
      location.pathname.endsWith("/dev.html") ||
      location.pathname.includes("/outbreak/")
    const maxWait = isStructuredPage ? 6000 : 1200
    const timer = window.setInterval(() => {
      if (this.isPageReady()) {
        window.clearInterval(timer)
        this.syncStudioUI()
        this.sendStatus()
        return
      }
      if (Date.now() - started > maxWait) {
        this.fallbackReady = true
        window.clearInterval(timer)
        this.syncStudioUI()
        this.sendStatus()
      }
    }, 40)
  }

  private async waitForReady(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.isPageReady() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 40))
    }
  }

  private resolvePageId(): string {
    try {
      const key = "arcade.control.pageId"
      const existing = sessionStorage.getItem(key)
      if (existing) return existing
      const id = `page_${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(key, id)
      return id
    } catch {
      return `page_${Math.random().toString(36).slice(2, 10)}`
    }
  }

  private readRouterConfig(): { controlPath: string; pageToken: string } | null {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')?.content
    if (!meta) return null
    try {
      const parsed = JSON.parse(meta) as { controlPath?: string; pageToken?: string }
      if (typeof parsed.controlPath === "string" && typeof parsed.pageToken === "string") {
        return { controlPath: parsed.controlPath, pageToken: parsed.pageToken }
      }
    } catch {}
    return null
  }

  setAdapter(adapter: DevControlAdapter | null) {
    this.adapter = adapter
    if (adapter) {
      this.ensureStandardCommands(adapter)
    }
    this.syncStudioUI()
    this.sendStatus()
  }

  addPanel(panel: LabPanel) {
    this.panels.add(panel)
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    this.syncStudioUI()
    this.sendStatus()
  }

  registerCommands(setup: (commands: LabCommandRegistry) => void) {
    const adapter = this.activeAdapter()
    setup(adapter.commands)
    this.sendStatus()
  }

  removePanel(panel: LabPanel) {
    this.panels.delete(panel)
    this.sendStatus()
  }

  private activeAdapter(): DevControlAdapter {
    if (this.adapter) return this.adapter
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    return this.defaultAdapter
  }

  private createDefaultGameAdapter(): DevControlAdapter {
    const commands = new LabCommandRegistry()
    const getCarrier = () => (globalThis as { carrier?: Record<string, any> }).carrier
    const classifyCarrierWeather = (c: Record<string, any>): string => {
      const w = c.lab?.mode === "manual" ? c.lab.target : c.weather?.current
      const rain = Number(w?.rain ?? 0)
      return rain < 0.05 ? "clear" : rain < 0.35 ? "light" : rain < 0.7 ? "medium" : "heavy"
    }
    registerPanelLabCommands(commands, {
      getPanels: () => [...this.panels],
      extraGet: path => {
        const c = getCarrier()
        if (!c) return undefined
        if (!path) {
          return {
            weather: classifyCarrierWeather(c),
            hour: round2(c.daynight?.state?.hour ?? 12),
            exposure: round2(c.grade?.exposure ?? 0),
            overcast: round2(c.atmosphere?.overcast ?? 0),
          }
        }
        const key = path.toLowerCase()
        if (key === "weather") return { key: "weather", label: "Weather", value: classifyCarrierWeather(c) }
        if (key === "hour" || key === "tod") return { key: "hour", label: "Time of day", value: round2(c.daynight?.state?.hour ?? 12) }
        if (c.grade && key in c.grade) return { key, label: key, group: "Grade", value: c.grade[key] }
        if (c.atmosphere && key in c.atmosphere) return { key, label: key, group: "Atmosphere", value: c.atmosphere[key] }
        return undefined
      },
      extraSet: (path, value) => {
        const c = getCarrier()
        if (!c) return null
        const key = path.toLowerCase()
        if (key === "weather" && c.lab?.force) {
          const valid = ["clear", "light", "medium", "heavy"]
          const str = String(value).toLowerCase()
          if (!valid.includes(str)) {
            throw new Error(`Invalid Carrier weather "${String(value)}". Expected: ${valid.join(", ")}.`)
          }
          const before = classifyCarrierWeather(c)
          c.lab.force(str, 0)
          c.lab.frame?.(0, 0)
          return { key: "weather", label: "Weather", before, value: classifyCarrierWeather(c) }
        }
        if ((key === "hour" || key === "tod") && c.daynight?.setManual) {
          const num = Number(value)
          if (!Number.isFinite(num) || num < 0 || num > 24) {
            throw new Error(`Invalid hour "${String(value)}". Expected 0..24.`)
          }
          const before = round2(c.daynight?.state?.hour ?? 12)
          c.daynight.setManual(num, 0)
          return { key: "hour", label: "Time of day", before, value: num }
        }
        if (c.grade && key in c.grade && typeof c.grade[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.grade[key]
          c.grade[key] = num
          return { key, label: key, before, value: num }
        }
        if (c.atmosphere && key in c.atmosphere && typeof c.atmosphere[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.atmosphere[key]
          c.atmosphere[key] = num
          return { key, label: key, before, value: num }
        }
        return null
      },
    })
    return {
      kind: "game",
      commands,
      getCanvas: () => document.querySelector<HTMLCanvasElement>("canvas"),
      isBusy: () => {
        for (const p of this.panels) {
          if (p.isInteracting()) return { busy: true, reason: "User is scrubbing a Lab control" }
        }
        return { busy: false }
      },
      getState: () => {
        const labAll = commands.get("lab.get")?.run({ pickedObject: null, groundHit: null, args: {} }) as
          | { settings?: Record<string, unknown> }
          | undefined
        const canvas = document.querySelector<HTMLCanvasElement>("canvas")
        const c = getCarrier()
        return {
          game: detectGameName(location.pathname),
          settings: labAll?.settings ?? {},
          note: this.activeNote,
          ...(c?.camera
            ? {
                camera: {
                  orbit: round2(((c.camera.yaw ?? 0) * 180) / Math.PI),
                  elevation: round2(((c.camera.pitch ?? 0) * 180) / Math.PI),
                  distance: round2(c.camera.dist ?? 0),
                  target: [round2(c.camera.x ?? 0), 0, round2(c.camera.z ?? 0)],
                },
              }
            : {}),
          canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        }
      },
    }
  }

  private ensureStandardCommands(adapter: DevControlAdapter) {
    const { commands } = adapter
    if (!commands.get("ui.note")) {
      registerUiNoteCommand(commands, {
        onShow: note => this.showNote(note),
        onClear: () => this.clearNote(),
        getDocumentTitle: () => document.title,
      })
    }

    if (!commands.get("nav.open")) {
      commands.register({
        id: "nav.open",
        label: "Navigate Page",
        shortLabel: "Open",
        category: "Scene",
        undoable: false,
        args: {
          target: { type: "string", required: true, description: "Page shorthand or /arcade/... path" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const target = String(args?.target ?? "")
          const resolved = resolveNavigationPath(target)
          const targetUrl = new URL(resolved, location.origin)
          const sameDoc = targetUrl.pathname === location.pathname && targetUrl.search === location.search && Boolean(targetUrl.hash)
          if (sameDoc) {
            location.hash = targetUrl.hash
            if (targetUrl.hash.startsWith("#catalogue")) {
              const deadline = Date.now() + 5000
              while (this.adapter?.kind !== "catalogue" && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 40))
              }
            } else {
              await new Promise(r => setTimeout(r, 60))
            }
            this.sendStatus()
            return { navigated: resolved, inPage: true, url: location.href }
          }
          setTimeout(() => {
            location.assign(targetUrl.href)
          }, 15)
          return { navigating: true, navigated: resolved, inPage: false, url: targetUrl.href }
        },
      })
    }

    if (!commands.get("state")) {
      commands.register({
        id: "state",
        label: "Get Scene & Page State",
        shortLabel: "State",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: async () => {
          const regState = commands.state()
          const pageState = regState ?? (await adapter.getState())
          return {
            page: this.buildSummary(),
            note: this.activeNote,
            ...pageState,
          }
        },
      })
    }

    if (!commands.get("screenshot")) {
      commands.register({
        id: "screenshot",
        label: "Capture Canvas Screenshot",
        shortLabel: "Screenshot",
        category: "Scene",
        undoable: false,
        args: {
          maxSize: { type: "number", min: 0, max: 4096, description: "Max long-edge pixel dimension (default 1280, 0 for native)" },
          raw: { type: "boolean", description: "Omit 2D note overlay when compositing with live DOM" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const maxSize = typeof args?.maxSize === "number" ? args.maxSize : 1280
          const includeOverlay = args?.raw !== true
          const studioPageVisible = Boolean(document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])"))
          const canvas = adapter.getCanvas?.() ?? document.querySelector<HTMLCanvasElement>("canvas")
          if (studioPageVisible || !canvas || (canvas.closest("[hidden]") && adapter.kind === "hub")) {
            const synth = synthesizeHubCanvas()
            return await captureWebGPUOr2DCanvas(synth, undefined, maxSize, includeOverlay)
          }
          return await captureWebGPUOr2DCanvas(canvas, adapter.captureCanvas, maxSize, includeOverlay)
        },
      })
    }
  }

  showIndicator(text: string, isError = false) {
    const adapter = this.activeAdapter()
    adapter.onIndicator?.(text, isError)
    if (!this.indicatorEl || !document.body.contains(this.indicatorEl)) {
      const el = document.createElement("div")
      el.dataset.arcadeCliIndicator = ""
      el.setAttribute("role", "status")
      el.setAttribute("aria-live", "polite")
      el.style.cssText =
        "position:fixed;top:44px;right:14px;z-index:9999;pointer-events:none;font:600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 10px;border-radius:999px;background:rgba(14,19,24,0.92);color:#7cc5d6;border:1px solid rgba(124,197,214,0.42);box-shadow:0 4px 14px rgba(0,0,0,0.35);transition:opacity 0.15s ease"
      document.body.append(el)
      this.indicatorEl = el
    }
    this.indicatorEl.textContent = text
    this.indicatorEl.style.color = isError ? "#ff8a8a" : "#7cc5d6"
    this.indicatorEl.style.borderColor = isError ? "rgba(255,138,138,0.45)" : "rgba(124,197,214,0.42)"
    this.indicatorEl.hidden = false
    if (this.indicatorTimer) window.clearTimeout(this.indicatorTimer)
    this.indicatorTimer = window.setTimeout(() => {
      if (this.indicatorEl) this.indicatorEl.hidden = true
    }, 2200)
  }

  buildSummary(): DevPageSummary {
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    const tourMeta = this.readUrlTourMeta()
    return {
      id: this.pageId,
      kind: adapter.kind,
      url: location.href,
      pathname: location.pathname,
      hash: location.hash,
      title: document.title || adapter.kind,
      focused: document.hasFocus(),
      visible: !document.hidden,
      mode: adapter.getMode?.() ?? "view",
      section: adapter.getSection?.(),
      note: this.activeNote,
      tour: tourMeta,
      commands: adapter.commands.describe(),
      updatedAt: Date.now(),
      lastActiveAt: this.lastActiveAt,
    }
  }

  sendStatus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.isPageReady()) return
    try {
      this.ws.send(JSON.stringify({ type: "status", page: this.buildSummary() }))
    } catch {}
  }

  private async waitIfBusy(adapter: DevControlAdapter, waitMs = 600): Promise<DevControlBusyState> {
    for (const panel of this.panels) {
      if (panel.isInteracting()) {
        return { busy: true, reason: "User is actively scrubbing or editing a Lab control." }
      }
    }
    if (!adapter.isBusy) return { busy: false }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const state = adapter.isBusy()
      if (!state.busy) return state
      await new Promise(r => setTimeout(r, 50))
    }
    return adapter.isBusy()
  }

  private formatIndicatorText(command: string, args?: Record<string, unknown>): string {
    const short = command.replace(/\./g, " ")
    if ((command === "scene.set-param" || command === "lab.set") && (args?.key ?? args?.path) !== undefined) {
      return `CLI: lab set ${String(args?.key ?? args?.path)} = ${String(args?.value)}`
    }
    if ((command === "object.select" || command === "select") && (args?.id ?? args?.target) !== undefined) {
      return `CLI: select ${String(args?.id ?? args?.target)}`
    }
    if ((command === "ground.spawn-here" || command === "spawn") && args?.asset !== undefined) {
      return `CLI: spawn ${String(args.asset)}`
    }
    if ((command === "scene.set-env" || command === "env") && args?.name !== undefined) {
      return `CLI: env ${String(args.name)}`
    }
    if (command === "look.preset" && args?.preset !== undefined) {
      return `CLI: look preset ${String(args.preset)}`
    }
    if (command === "look.set" && args?.key !== undefined) {
      return `CLI: look set ${String(args.key)} = ${String(args?.value)}`
    }
    if (command === "look.randomize") {
      return `CLI: look randomize ${String(args?.group ?? "all")}`
    }
    if (command === "nav.open" && args?.target !== undefined) {
      return `CLI: open ${String(args.target)}`
    }
    return `CLI: ${short}`
  }

  private resolveCommandId(commands: LabCommandRegistry, requested: string): string {
    if (commands.get(requested)) return requested
    const mapped = COMMAND_ALIASES[requested]
    if (mapped && commands.get(mapped)) return mapped
    return requested
  }

  private isReadOnlyCommand(id: string): boolean {
    return (
      id === "state" ||
      id === "screenshot" ||
      id === "camera.get" ||
      id === "lab.get" ||
      id === "preset.export" ||
      id === "ui.note" ||
      id === "ui.note.clear"
    )
  }

  private async handleRpc(msg: { requestId: string; command: string; args?: Record<string, unknown> }) {
    await this.waitForReady()
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    const cmdId = this.resolveCommandId(adapter.commands, msg.command)
    const cmd = adapter.commands.get(cmdId)

    if (cmd && !this.isReadOnlyCommand(cmd.id)) {
      const busy = await this.waitIfBusy(adapter)
      if (busy.busy) {
        const reason = busy.reason ?? "User is actively interacting with the viewport."
        this.showIndicator(`CLI blocked: ${reason}`, true)
        const outcome: LabCommandInvokeResult = {
          ok: false,
          id: cmd.id,
          code: "busy",
          error: `Blocked by live user input: ${reason}`,
        }
        this.ws?.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
        return
      }
    }

    const rawOutcome = adapter.commands.invoke(cmdId, msg.args, {
      pickedObject: null,
      groundHit: null,
      source: "cli",
    })

    let outcome: LabCommandInvokeResult = rawOutcome
    if (rawOutcome.ok && rawOutcome.result instanceof Promise) {
      try {
        const awaited = await rawOutcome.result
        outcome = { ...rawOutcome, state: adapter.commands.state(), result: awaited }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        outcome = {
          ok: false,
          id: rawOutcome.id,
          code: /unavailable|play mode/i.test(message) ? "unavailable" : "invalid_args",
          error: message,
        }
      }
    }

    if (outcome.ok && !this.isReadOnlyCommand(outcome.id)) {
      this.showIndicator(this.formatIndicatorText(outcome.id, msg.args), false)
    } else if (!outcome.ok) {
      this.showIndicator(`CLI: ${msg.command} (${outcome.code ?? "error"})`, true)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
    }
  }

  private connect() {
    if (!this.routerConfig) return
    // A page embedded in a Lab Overworld station is driven through its embedder, not as a separate CLI target.
    try { if (window.frameElement?.closest("[data-overworld]")) return } catch { /* cross-origin parent */ }
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const wsUrl = `${proto}//${location.host}${this.routerConfig.controlPath}?token=${encodeURIComponent(this.routerConfig.pageToken)}&pageId=${encodeURIComponent(this.pageId)}`
    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.onopen = () => {
        this.syncStudioUI()
        this.sendStatus()
        const urlMeta = this.readUrlTourMeta()
        const tourId = urlMeta?.id ?? this.studioTour?.id
        const step = urlMeta?.step ?? this.studioStep
        if (tourId) {
          try {
            ws.send(JSON.stringify({ type: "tour.get", tourId, step }))
          } catch {}
        }
      }
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string
            requestId?: string
            command?: string
            args?: Record<string, unknown>
            url?: string
            tour?: TourDefinition
            step?: number
          }
          if (msg.type === "invoke" && msg.requestId && msg.command) {
            void this.handleRpc({ requestId: msg.requestId, command: msg.command, args: msg.args })
          } else if (msg.type === "tour.state" && msg.tour) {
            const urlMeta = this.readUrlTourMeta()
            this.studioTour = msg.tour
            if (urlMeta && urlMeta.id === msg.tour.id) {
              this.studioStep = urlMeta.step
            } else if (typeof msg.step === "number" && msg.step >= 1) {
              this.studioStep = msg.step
            }
            this.saveStudioSession()
            this.syncStudioUI()
            if (this.activeNote) this.showNote(this.activeNote)
          } else if (msg.type === "tour.activate") {
            try {
              window.focus()
            } catch {}
            if (this.noteEl) {
              this.noteEl.style.animation = "none"
              void this.noteEl.offsetWidth
              this.noteEl.style.animation = "arcade-note-card-flash 0.28s ease-out"
            }
            this.lastActiveAt = Date.now()
            this.sendStatus()
          } else if (msg.type === "tour.navigate" && typeof msg.url === "string" && msg.url) {
            location.assign(msg.url)
          } else if (msg.type === "ping") {
            this.sendStatus()
          }
        } catch {}
      }
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null
        if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
        this.reconnectTimer = window.setTimeout(() => this.connect(), 600)
      }
      ws.onerror = () => {
        ws.close()
      }
    } catch {}
  }
}

function getRuntime(): PageControlRuntime | null {
  if (!import.meta.env?.DEV) return null
  if (typeof window === "undefined" || typeof document === "undefined") return null
  window.__arcadeDevControl ??= new PageControlRuntime()
  return window.__arcadeDevControl
}

if (import.meta.env?.DEV) {
  getRuntime()
}

export function registerDevControl(adapter: DevControlAdapter): { notifyUpdate: () => void; dispose: () => void } {
  const rt = getRuntime()
  rt?.setAdapter(adapter)
  return {
    notifyUpdate: () => rt?.sendStatus(),
    dispose: () => rt?.setAdapter(null),
  }
}

export function attachLabPanelControl(panel: LabPanel): () => void {
  const rt = getRuntime()
  rt?.addPanel(panel)
  return () => rt?.removePanel(panel)
}

export function registerGameCommands(setup: (commands: LabCommandRegistry) => void): void {
  const rt = getRuntime()
  rt?.registerCommands(setup)
}

export function ensureDevControlConnected(): void {
  getRuntime()
}
