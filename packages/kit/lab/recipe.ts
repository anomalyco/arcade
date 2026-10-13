import type { LabValue } from "../lab-panel"
import { vehicleEffectSettings } from "../vehicle/effect-settings"
import { effectSpecs } from "./effects"
import { tyreSettings } from "./tyre-settings"

export type GameRecipeTarget =
  | "blackout-effects"
  | "getaway-effects"
  | "shared-effects"
  | "lighting"
  | "spawn"

export type GameRecipePayload = {
  schema: "arcade-game-recipe/v1"
  target: GameRecipeTarget
  modulePath: string
  exportName: string
  group: string
  seed: number
  effectSeed?: number
  values: Record<string, number | boolean | string>
  codeSnippet: string
}

const INTERNAL_KEYS = new Set([
  "playing",
  "loop",
  "interval",
  "lockEffect",
  "lockEnvironment",
  "environment",
  "room",
  "seed",
  "roomSeed",
  "effectSeed",
  "targetX",
  "targetZ",
  "selectedX",
  "selectedZ",
  "selectedYaw",
  "selectedPower",
  "selectedRadius",
  "where",
  "distance",
  "count",
  "spacing",
])

export function buildGameRecipe(opts: {
  sectionId: string
  settings: Readonly<Record<string, LabValue>>
  lighting: Readonly<Record<string, LabValue>>
}): GameRecipePayload {
  const { sectionId, settings, lighting } = opts
  const seed = Number(settings.seed ?? settings.roomSeed ?? 7)
  const effectSeed = "effectSeed" in settings ? Number(settings.effectSeed) : undefined

  if (sectionId === "blackout-effects") {
    const activeEffect = String(settings.effect ?? "glass")
    const prefix = activeEffect === "shot" ? String(settings.surface ?? "glass") : activeEffect
    const values: Record<string, number | boolean | string> = {}
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith(`${prefix}.`) && typeof v === "number" && Number.isFinite(v)) {
        const subKey = k.slice(prefix.length + 1)
        values[subKey] = Number(v.toFixed(4))
      }
    }
    const entries = Object.entries(values)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ")
    return {
      schema: "arcade-game-recipe/v1",
      target: "blackout-effects",
      modulePath: "games/blackout/src/lab/settings.ts",
      exportName: "blackoutEffects",
      group: prefix,
      seed,
      effectSeed,
      values,
      codeSnippet: `// games/blackout/src/lab/settings.ts -> blackoutEffects.${prefix}\n${prefix}: { ${entries} },`,
    }
  }

  if (sectionId === "getaway-effects") {
    const activeEffect = String(settings.effect ?? "sparks")
    const values: Record<string, number | boolean | string> = {}
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith(`${activeEffect}.`) && typeof v === "number" && Number.isFinite(v)) {
        const subKey = k.slice(activeEffect.length + 1)
        values[subKey] = Number(v.toFixed(4))
      }
    }
    const modulePath = activeEffect === "tyre" ? "packages/kit/lab/tyre-settings.ts" : "packages/kit/vehicle/effect-settings.ts"
    const exportName = activeEffect === "tyre" ? "tyreSettings" : "vehicleEffectSettings"
    const entries = Object.entries(values)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ")
    return {
      schema: "arcade-game-recipe/v1",
      target: "getaway-effects",
      modulePath,
      exportName,
      group: activeEffect,
      seed,
      effectSeed,
      values,
      codeSnippet: `// ${modulePath} -> ${exportName}${activeEffect === "tyre" ? "" : `.${activeEffect}`}\n${activeEffect}: { ${entries} },`,
    }
  }

  if (sectionId === "lighting") {
    const values: Record<string, number | boolean | string> = {}
    for (const [k, v] of Object.entries(lighting)) {
      if (typeof v === "number" && Number.isFinite(v)) values[k] = Number(v.toFixed(4))
      else if (typeof v === "boolean") values[k] = v
    }
    const entries = Object.entries(values)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ")
    return {
      schema: "arcade-game-recipe/v1",
      target: "lighting",
      modulePath: "packages/kit/lab/lighting.ts",
      exportName: "lightingDefaults",
      group: "lighting",
      seed,
      values,
      codeSnippet: `// packages/kit/lab/lighting.ts\nexport const lightingRecipe = { ${entries} }`,
    }
  }

  const group = String(settings.effect ?? sectionId)
  const values: Record<string, number | boolean | string> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (INTERNAL_KEYS.has(k) || k === "effect") continue
    if (typeof v === "number" && Number.isFinite(v)) values[k] = Number(v.toFixed(4))
    else if (typeof v === "boolean" || typeof v === "string") values[k] = v
  }
  const entries = Object.entries(values)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")
  return {
    schema: "arcade-game-recipe/v1",
    target: sectionId === "spawn" ? "spawn" : "shared-effects",
    modulePath: sectionId === "spawn" ? "packages/kit/vehicle/effect-settings.ts" : "packages/kit/lab/effects.ts",
    exportName: sectionId === "spawn" ? "vehicleEffectSettings" : "effectSpecs",
    group,
    seed,
    effectSeed,
    values,
    codeSnippet: `// ${sectionId === "spawn" ? "packages/kit/vehicle/effect-settings.ts" : "packages/kit/lab/effects.ts"}\n${group}: { ${entries} },`,
  }
}

/**
 * Validates and applies a typed GameRecipePayload directly into production settings objects
 * (without URL query parameters).
 */
export function applyGameRecipe(
  raw: unknown,
  customTargets?: {
    blackoutEffects?: Record<string, Record<string, number>>
    lighting?: Record<string, LabValue>
    sectionSettings?: Record<string, LabValue>
  },
): { ok: true; appliedKeys: string[] } | { ok: false; error: string } {
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Recipe must be a valid JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.schema !== "arcade-game-recipe/v1") {
    return { ok: false, error: `Unsupported recipe schema: "${String(obj.schema)}".` }
  }
  if (typeof obj.group !== "string" || !obj.group) {
    return { ok: false, error: "Recipe is missing a target group." }
  }
  if (!obj.values || typeof obj.values !== "object" || Array.isArray(obj.values)) {
    return { ok: false, error: "Recipe is missing a values dictionary." }
  }

  const values = obj.values as Record<string, unknown>
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "number" && !Number.isFinite(v)) {
      return { ok: false, error: `Non-finite number for key "${k}".` }
    }
    if (typeof v !== "number" && typeof v !== "boolean" && typeof v !== "string") {
      return { ok: false, error: `Invalid value type for key "${k}".` }
    }
  }

  const appliedKeys: string[] = []
  const group = obj.group

  if (obj.target === "getaway-effects") {
    if (group === "tyre") {
      for (const [k, v] of Object.entries(values)) {
        if (k in tyreSettings && typeof v === "number") {
          ;(tyreSettings as Record<string, number>)[k] = v
          appliedKeys.push(`tyre.${k}`)
        }
      }
    } else if (group in vehicleEffectSettings) {
      const bucket = (vehicleEffectSettings as Record<string, Record<string, number>>)[group]!
      for (const [k, v] of Object.entries(values)) {
        if (k in bucket && typeof v === "number") {
          bucket[k] = v
          appliedKeys.push(`${group}.${k}`)
        }
      }
    }
  } else if (obj.target === "blackout-effects" && customTargets?.blackoutEffects && group in customTargets.blackoutEffects) {
    const bucket = customTargets.blackoutEffects[group]!
    for (const [k, v] of Object.entries(values)) {
      if (k in bucket && typeof v === "number") {
        bucket[k] = v
        appliedKeys.push(`${group}.${k}`)
      }
    }
  } else if (obj.target === "shared-effects" && group in effectSpecs) {
    const spec = effectSpecs[group] as unknown as Record<string, LabValue>
    for (const [k, v] of Object.entries(values)) {
      if (k in spec && (typeof v === "number" || typeof v === "string")) {
        spec[k] = v
        appliedKeys.push(`${group}.${k}`)
      }
    }
  }

  if (customTargets?.lighting && obj.target === "lighting") {
    for (const [k, v] of Object.entries(values)) {
      if (k in customTargets.lighting && (typeof v === "number" || typeof v === "boolean")) {
        customTargets.lighting[k] = v
        appliedKeys.push(`lighting.${k}`)
      }
    }
  }

  if (customTargets?.sectionSettings) {
    for (const [k, v] of Object.entries(values)) {
      const prefixed = `${group}.${k}`
      if (prefixed in customTargets.sectionSettings) {
        customTargets.sectionSettings[prefixed] = v as LabValue
        if (!appliedKeys.includes(prefixed)) appliedKeys.push(prefixed)
      } else if (k in customTargets.sectionSettings) {
        customTargets.sectionSettings[k] = v as LabValue
        if (!appliedKeys.includes(k)) appliedKeys.push(k)
      }
    }
  }

  return { ok: true, appliedKeys }
}
