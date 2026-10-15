import {
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  randomizeLookSettings,
  resolveLookGroup,
  resolveLookPresetId,
} from "../gpu/look"
import type { LabCommandRegistry } from "../lab-commands"
import { formatLabValue, inferControlUnit, type LabControl, type LabPanel, type LabRow, type LabValue } from "../lab-panel"
import type { Stage } from "../lab/stage"
import type { PanelLabCommandOptions, StageCameraCommandOptions } from "./types"

export const round2 = (n: number) => Math.round(n * 100) / 100
export const round3 = (n: number) => Math.round(n * 1000) / 1000
export const round4 = (n: number) => Math.round(n * 10000) / 10000

export const COMMAND_ALIASES: Record<string, string> = {
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
    if (
      control.key === trimmed ||
      control.key.toLowerCase() === trimmed.toLowerCase() ||
      control.legacyKeys?.some(k => k === trimmed || k.toLowerCase() === trimmed.toLowerCase())
    ) {
      return entry
    }
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
