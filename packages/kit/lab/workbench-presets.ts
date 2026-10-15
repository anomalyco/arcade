import type { LabPanel, LabValue } from "../lab-panel"
import type { LookLabController } from "./looks"
import type { createSpawn } from "./spawn"
import type { Stage } from "./stage"
import type { LabSection } from "./types"
import type { FullSnapshot, LabPresetSchema } from "./workbench-types"

export interface WorkbenchPresetContext {
  sections: readonly LabSection[]
  globalSettings: { section: string; debug: number }
  activeSection: () => LabSection
  selectSection: (id: string) => void
  stage: Stage
  panel: LabPanel
  spawn?: ReturnType<typeof createSpawn>
  looks?: LookLabController
  captureSnapshot: () => FullSnapshot
  recordHistory: (label: string, before: FullSnapshot) => void
  syncChrome: () => void
  renderNow: () => Promise<unknown>
  showToast: (message: string, isError?: boolean) => void
}

export function buildWorkbenchPresetPayload(ctx: Pick<WorkbenchPresetContext, "activeSection" | "stage" | "spawn">): LabPresetSchema {
  const sec = ctx.activeSection()
  const cleanSettings: Record<string, LabValue> = {}
  for (const k of Object.keys(sec.settings)) {
    const v = sec.settings[k]
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      cleanSettings[k] = v
    }
  }
  return {
    version: 1,
    section: sec.id,
    settings: cleanSettings,
    lighting: { ...ctx.stage.lighting },
    spawn: ctx.spawn
      ? {
          characterId: ctx.spawn.snapshot().characterId,
          props: [...ctx.spawn.snapshot().props],
        }
      : undefined,
  }
}

export function applyWorkbenchPresetJson(
  rawText: string,
  ctx: WorkbenchPresetContext,
): { ok: true } | { ok: false; error: string } {
  const { sections, globalSettings, selectSection, stage, panel, spawn, looks, captureSnapshot, recordHistory, syncChrome, renderNow, showToast } = ctx
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { ok: false, error: "Invalid JSON syntax." }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported preset schema version: ${String(obj.version)} (expected 1).` }
  }
  if (obj.section === undefined && looks && ("preset" in obj || (obj.settings && typeof obj.settings === "object" && "exposure" in (obj.settings as Record<string, unknown>)))) {
    const before = captureSnapshot()
    if (globalSettings.section !== "looks") selectSection("looks")
    const res = looks.importPresetJson(obj)
    if (!res.ok) return res
    recordHistory("Import look preset", before)
    panel.sync()
    syncChrome()
    void renderNow()
    showToast("Imported look preset")
    return { ok: true }
  }
  if (typeof obj.section !== "string" || !sections.some(s => s.id === obj.section)) {
    return { ok: false, error: `Unknown Lab section: "${String(obj.section)}".` }
  }
  const targetSec = sections.find(s => s.id === obj.section)!
  if (!obj.settings || typeof obj.settings !== "object" || Array.isArray(obj.settings)) {
    return { ok: false, error: "Preset is missing a valid settings object." }
  }
  const incomingSettings = obj.settings as Record<string, unknown>
  // Validate select options (such as effect or environment) before mutating scene
  for (const ctrl of targetSec.controls) {
    if ("options" in ctrl && ctrl.key in incomingSettings) {
      const val = incomingSettings[ctrl.key]
      if (!ctrl.options.some(o => o.value === val || String(o.value) === String(val))) {
        return { ok: false, error: `Unknown ${ctrl.label} value: "${String(val)}".` }
      }
    }
  }
  if (obj.spawn && typeof obj.spawn === "object" && spawn) {
    const sp = obj.spawn as { characterId?: unknown; props?: unknown }
    if (sp.characterId && typeof sp.characterId === "string" && !spawn.adapters.characters.some(c => c.id === sp.characterId)) {
      return { ok: false, error: `Unknown character ID: "${sp.characterId}".` }
    }
    if (sp.props !== undefined) {
      if (!Array.isArray(sp.props)) return { ok: false, error: "spawn.props must be an array." }
      for (const p of sp.props) {
        if (!p || typeof p !== "object" || !spawn.adapters.items.items.some(i => i.id === (p as any).kind)) {
          return { ok: false, error: `Unknown prop kind in spawn.props: "${String((p as any)?.kind)}".` }
        }
      }
    }
  }

  const before = captureSnapshot()
  if (globalSettings.section !== targetSec.id) selectSection(targetSec.id)
  for (const [k, v] of Object.entries(incomingSettings)) {
    if (!(k in targetSec.settings)) continue
    if (typeof v === "number" && Number.isFinite(v)) {
      const ctrl = targetSec.controls.find(c => c.key === k)
      if (ctrl && "min" in ctrl) {
        targetSec.settings[k] = Math.max(ctrl.min, Math.min(ctrl.max, v))
      } else {
        targetSec.settings[k] = v
      }
    } else if (typeof v === "boolean" || typeof v === "string") {
      targetSec.settings[k] = v
    }
  }
  if (obj.lighting && typeof obj.lighting === "object") {
    for (const [k, v] of Object.entries(obj.lighting as Record<string, unknown>)) {
      if (k in stage.lighting && (typeof v === "number" || typeof v === "boolean")) {
        ;(stage.lighting as Record<string, unknown>)[k] = v
      }
    }
  }
  if (obj.spawn && typeof obj.spawn === "object" && spawn) {
    const sp = obj.spawn as { characterId?: string | null; props?: { kind: string; x: number; y: number; z: number; yaw: number }[] }
    const curSnap = spawn.snapshot()
    spawn.restore({
      environment: curSnap.environment,
      seed: curSnap.seed,
      characterId: sp.characterId ?? curSnap.characterId,
      characterAt: curSnap.characterAt ?? { x: 0, y: 0, z: 8, yaw: Math.PI },
      props: sp.props ?? curSnap.props,
      lights: curSnap.lights,
    })
  }
  targetSec.enter?.()
  targetSec.retrigger?.()
  recordHistory("Import preset", before)
  panel.sync()
  syncChrome()
  void renderNow()
  showToast("Imported preset")
  return { ok: true }
}
