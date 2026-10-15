import type { LabCommandDescriptor, LabCommandRegistry, LabSceneState } from "../lab-commands"
import type { LabPanel } from "../lab-panel"
import type { Stage } from "../lab/stage"

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
