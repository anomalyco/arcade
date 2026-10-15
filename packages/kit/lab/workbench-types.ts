import type { LabPanel, LabValue } from "../lab-panel"
import type { createEffects } from "./effects"
import { lightingDefaults } from "./lighting"
import type { LookLabController } from "./looks"
import type { createSpawn, SpawnSceneSnapshot } from "./spawn"
import type { LabContext, LabLibraryCategory, LabSection } from "./types"

export type CatalogCategory = LabLibraryCategory
export type CatalogCollection = "all" | "fixtures" | "blackout" | "getaway" | "shared"

export type CatalogEntry = {
  id: string
  label: string
  group: string
  category: CatalogCategory
  collection: Exclude<CatalogCollection, "all">
  tag: string
  sectionId: string
  run: (fromUser: boolean) => void
  isActive?: () => boolean
}

export type LabPresetSchema = {
  version: 1
  section: string
  settings: Record<string, LabValue>
  lighting?: Record<string, LabValue>
  spawn?: {
    characterId?: string | null
    props?: { kind: string; x: number; y: number; z: number; yaw: number }[]
  }
}

export type FullSnapshot = {
  sectionId: string
  sections: Record<string, Record<string, LabValue>>
  lighting: Record<string, LabValue>
  spawn: SpawnSceneSnapshot | null
}

export type HistoryEntry = {
  label: string
  before: FullSnapshot
  after: FullSnapshot
}

export const LIGHTING_LOOKS: Record<string, { label: string; values: Partial<ReturnType<typeof lightingDefaults>> }> = {
  neutral: {
    label: "Neutral Stage",
    values: { lamps: true, lampPower: 2, lampRadius: 10, lampHeight: 3, spot: true, spotPower: 4, spotAngle: 38, spotYaw: -120, spotPitch: 40, shadows: true, moon: true, moonPower: 0.35, moonAzimuth: -45, moonElevation: 55, count: 2, exposure: 0, tone: 0, temperature: 0, saturation: 1 },
  },
  night_street: {
    label: "Night Street",
    values: { lamps: true, lampPower: 3.2, lampRadius: 14, lampHeight: 3.8, spot: true, spotPower: 6, spotAngle: 32, spotYaw: -95, spotPitch: 45, shadows: true, moon: true, moonPower: 0.18, moonAzimuth: -60, moonElevation: 42, count: 4, exposure: -0.15, tone: 1, temperature: -0.2, saturation: 1.05 },
  },
  fluorescent_office: {
    label: "Fluorescent Office",
    values: { lamps: true, lampPower: 2.8, lampRadius: 12, lampHeight: 2.9, spot: false, spotPower: 2, shadows: true, moon: true, moonPower: 0.45, moonAzimuth: -30, moonElevation: 60, count: 4, exposure: 0.2, tone: 0, temperature: 0.12, saturation: 0.95 },
  },
  sodium_alley: {
    label: "Sodium Alley",
    values: { lamps: true, lampPower: 3.6, lampRadius: 11, lampHeight: 3.2, spot: true, spotPower: 5, spotAngle: 28, spotYaw: -140, spotPitch: 36, shadows: true, moon: true, moonPower: 0.1, moonAzimuth: -20, moonElevation: 35, count: 3, exposure: -0.1, tone: 1, temperature: 0.45, saturation: 1.1 },
  },
  cold_moon: {
    label: "Cold Moon",
    values: { lamps: false, lampPower: 0.8, spot: true, spotPower: 3.5, spotAngle: 44, shadows: true, moon: true, moonPower: 0.85, moonAzimuth: -50, moonElevation: 62, count: 1, exposure: 0.05, tone: 1, temperature: -0.45, saturation: 0.88 },
  },
}

export type WorkbenchOptions = {
  root: HTMLElement
  canvas: HTMLCanvasElement
  ViewportHost: HTMLElement
  panel: LabPanel
  context: LabContext
  sections: readonly LabSection[]
  globalSettings: { section: string; debug: number }
  selectSection: (id: string) => void
  renderNow: () => Promise<unknown>
  advanceSim: (dt: number) => void
  spawn?: ReturnType<typeof createSpawn>
  looks?: LookLabController
  effects?: ReturnType<typeof createEffects>
}
