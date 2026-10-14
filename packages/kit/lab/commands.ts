import type { LabValue } from "../lab-panel"
import type { LabWorldObject } from "./types"

export type RadialSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export type RadialContext = "object" | "ground"
/** Glyphs the radial menu can draw next to a command's short label. */
export type LabCommandIcon =
  | "zap"
  | "gamepad"
  | "copy"
  | "search"
  | "trash"
  | "reset"
  | "move"
  | "frame"
  | "pin-plus"
  | "user-plus"
  | "light"
  | "eraser"
  | "shuffle"

export type LabCommandCategory = "Mode" | "Transport" | "Scene" | "Compare" | "Object" | "Inspector" | "Preset" | "Camera" | "Navigation"

export const RADIAL_COMPASS: readonly { slot: RadialSlot; compass: string; angle: number }[] = [
  { slot: 0, compass: "N", angle: 0 },
  { slot: 1, compass: "NE", angle: 45 },
  { slot: 2, compass: "E", angle: 90 },
  { slot: 3, compass: "SE", angle: 135 },
  { slot: 4, compass: "S", angle: 180 },
  { slot: 5, compass: "SW", angle: 225 },
  { slot: 6, compass: "W", angle: 270 },
  { slot: 7, compass: "NW", angle: 315 },
]

export type LabCommandArgField = {
  type: "string" | "number" | "boolean" | "number[]" | "object" | "value"
  required?: boolean
  description?: string
  min?: number
  max?: number
  enum?: readonly (string | number)[]
}

export type LabCommandArgSchema = Readonly<Record<string, LabCommandArgField>>
export type LabCommandArgs = Readonly<Record<string, LabValue>>

export type LabCommandContext = {
  pickedObject: LabWorldObject | null
  groundHit: { x: number; y: number; z: number } | null
  screenX?: number
  screenY?: number
  args?: LabCommandArgs
  source?: "ui" | "cli"
  seed?: number
}

export type LabCommandDescriptor = {
  id: string
  aliases?: readonly string[]
  label: string
  shortLabel: string
  description?: string
  category: LabCommandCategory
  shortcut?: string
  undoable: boolean
  readOnly: boolean
  enabled: boolean
  available: boolean
  disabledReason?: string
  args?: LabCommandArgSchema
  radial?: { context: RadialContext; slot: RadialSlot }
}

export type LabSceneState = {
  mode: "edit" | "play"
  section: string
  environment: string
  seed: number
  effectSeed?: number
  transport: {
    playing: boolean
    loop: boolean
    speed: number
    elapsed: number
    frames: number
  }
  camera: {
    focus: [number, number, number]
    yaw: number
    pitch: number
    distance: number
  }
  selection: {
    selectedIds: string[]
    hoveredId: string | null
    boxSelectMode: boolean
  }
  objects: LabWorldObject[]
  settings: Record<string, LabValue>
  lighting: Record<string, LabValue>
  compare: {
    activeSlot: "A" | "B"
    hasSlotA: boolean
    wipeEnabled: boolean
    frames: number
    diffs: { key: string; before: LabValue; after: LabValue; deltaText: string }[]
  }
  history: {
    canUndo: boolean
    canRedo: boolean
    undoLabel: string | null
    redoLabel: string | null
    undoDepth: number
    redoDepth: number
  }
  commands: LabCommandDescriptor[]
  /** Workbench layout state (Outliner locks, Library drawer, Details filters, Watch pins). */
  layout?: {
    library: { open: boolean; category: string; query: string }
    locked: string[]
    details: { query: string; modifiedOnly: boolean; showAll: boolean; modified: string[] }
    watch: { section: string; key: string; label: string; value: string | null }[]
  }
  grid?: {
    active: boolean
    id: string
    title: string
    section: string
    cols: number
    rows: number
    focusedTile: number | null
    hoveredTile: number | null
    frameCostMs: number | null
    tiles: { tile: number; label: string; subtitle: string }[]
  } | null
}

export type LabCommand<TArgs extends LabCommandArgs = LabCommandArgs> = {
  id: string
  aliases?: readonly string[]
  label: string
  shortLabel: string
  description?: string
  category: LabCommandCategory
  shortcut?: string
  accelerators?: readonly string[]
  icon?: LabCommandIcon
  args?: LabCommandArgSchema
  /** Whether invoking this command should record an authored undo transaction when state mutates. */
  undoable?: boolean
  readOnly?: boolean
  radial?: { context: RadialContext; slot: RadialSlot }
  enabled: (ctx?: LabCommandContext) => boolean
  available?: (state: LabSceneState, ctx?: LabCommandContext) => boolean
  disabledReason?: (ctx?: LabCommandContext) => string
  run: (ctx?: LabCommandContext, args?: TArgs) => unknown
}

export type LabCommandInvokeResult<T = any> =
  | { ok: true; id: string; label: string; undoable: boolean; state: LabSceneState | null; result?: T }
  | { ok: false; id: string; error: string; code?: "unknown_command" | "invalid_args" | "unavailable" | "busy" | "error" }

export type ResolvedRadialSector = {
  slot: RadialSlot
  compass: string
  angle: number
  command: LabCommand
  enabled: boolean
  disabledReason?: string
}

export function validateCommandArgs(
  schema: LabCommandArgSchema | undefined,
  args: Record<string, unknown> | undefined,
): { ok: true; value: LabCommandArgs } | { ok: false; error: string } {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { ok: false, error: "Arguments must be a JSON object." }
  }
  if (!schema) return { ok: true, value: (args ?? {}) as LabCommandArgs }
  const input = args ?? {}
  for (const key of Object.keys(input)) {
    if (!(key in schema) && key !== "seed") {
      const allowed = Object.keys(schema).length ? Object.keys(schema).join(", ") : "none"
      return { ok: false, error: `Unknown argument "${key}". Allowed arguments: ${allowed}.` }
    }
  }
  const out: Record<string, LabValue> = {}
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
    out.seed = input.seed
  }
  for (const [key, field] of Object.entries(schema)) {
    const raw = input[key]
    if (raw === undefined || raw === null) {
      if (field.required) return { ok: false, error: `Missing required argument "${key}".` }
      continue
    }
    if (field.type === "number") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, error: `Argument "${key}" must be a finite number.` }
      }
      if (field.min !== undefined && raw < field.min) {
        return { ok: false, error: `Argument "${key}" must be >= ${field.min}.` }
      }
      if (field.max !== undefined && raw > field.max) {
        return { ok: false, error: `Argument "${key}" must be <= ${field.max}.` }
      }
      out[key] = raw
    } else if (field.type === "boolean") {
      if (typeof raw !== "boolean") return { ok: false, error: `Argument "${key}" must be a boolean.` }
      out[key] = raw
    } else if (field.type === "string") {
      if (typeof raw !== "string") return { ok: false, error: `Argument "${key}" must be a string.` }
      out[key] = raw
    } else if (field.type === "value") {
      if (typeof raw !== "string" && (typeof raw !== "number" || !Number.isFinite(raw)) && typeof raw !== "boolean") {
        return { ok: false, error: `Argument "${key}" must be a string, finite number, or boolean.` }
      }
      out[key] = raw
    } else {
      out[key] = raw as LabValue
    }
    if (field.enum && !field.enum.some(c => c === out[key] || String(c).toLowerCase() === String(out[key]).toLowerCase())) {
      return { ok: false, error: `Argument "${key}" must be one of: ${field.enum.join(", ")}.` }
    }
  }
  return { ok: true, value: out as LabCommandArgs }
}

export class LabCommandRegistry {
  private readonly map = new Map<string, LabCommand>()
  private readonly aliases = new Map<string, string>()
  private readonly list: LabCommand[] = []
  private stateReader?: () => Omit<LabSceneState, "commands">
  private historyTransactor?: (label: string, run: () => void) => void

  constructor(options?: {
    getState?: () => Omit<LabSceneState, "commands">
    transact?: (label: string, run: () => void) => void
  }) {
    this.stateReader = options?.getState
    this.historyTransactor = options?.transact
  }

  configure(options: {
    getState?: () => Omit<LabSceneState, "commands">
    transact?: (label: string, run: () => void) => void
  }): void {
    if (options.getState) this.stateReader = options.getState
    if (options.transact) this.historyTransactor = options.transact
  }

  register(command: LabCommand): LabCommand {
    this.map.set(command.id, command)
    for (const alias of command.aliases ?? []) this.aliases.set(alias, command.id)
    const existingIdx = this.list.findIndex(c => c.id === command.id)
    if (existingIdx >= 0) this.list[existingIdx] = command
    else this.list.push(command)
    return command
  }

  registerAll(commands: readonly LabCommand[]): void {
    for (const cmd of commands) this.register(cmd)
  }

  get(id: string): LabCommand | undefined {
    return this.map.get(id) ?? (this.aliases.has(id) ? this.map.get(this.aliases.get(id)!) : undefined)
  }

  all(): readonly LabCommand[] {
    return this.list
  }

  describe(ctx?: LabCommandContext): LabCommandDescriptor[] {
    return this.list.map(cmd => {
      const available = cmd.enabled(ctx)
      return {
        id: cmd.id,
        aliases: cmd.aliases,
        label: cmd.label,
        shortLabel: cmd.shortLabel,
        description: cmd.description,
        category: cmd.category,
        shortcut: cmd.shortcut,
        undoable: Boolean(cmd.undoable),
        readOnly: Boolean(cmd.readOnly),
        enabled: available,
        available,
        disabledReason: available ? undefined : cmd.disabledReason?.(ctx) ?? "Unavailable in current state",
        args: cmd.args,
        radial: cmd.radial,
      }
    })
  }

  state(ctx?: LabCommandContext): LabSceneState | null {
    if (!this.stateReader) return null
    const base = this.stateReader()
    return {
      ...base,
      commands: this.describe(ctx),
    }
  }

  execute(id: string, ctx?: LabCommandContext, args?: Record<string, unknown>): boolean {
    return this.invoke(id, args, ctx).ok
  }

  invoke<T = any>(id: string, args?: Record<string, unknown>, ctx?: Partial<LabCommandContext>): LabCommandInvokeResult<T> {
    const cmd = this.get(id)
    if (!cmd) {
      return { ok: false, id, code: "unknown_command", error: `Unknown command "${id}".` }
    }
    const validated = validateCommandArgs(cmd.args, args)
    if (!validated.ok) {
      return { ok: false, id, code: "invalid_args", error: validated.error }
    }
    const seed = typeof validated.value.seed === "number" ? validated.value.seed : ctx?.seed
    const mergedCtx: LabCommandContext = {
      pickedObject: ctx?.pickedObject ?? null,
      groundHit: ctx?.groundHit ?? null,
      screenX: ctx?.screenX,
      screenY: ctx?.screenY,
      args: validated.value,
      source: ctx?.source,
      seed,
    }
    if (!cmd.enabled(mergedCtx)) {
      return {
        ok: false,
        id,
        code: "unavailable",
        error: cmd.disabledReason?.(mergedCtx) ?? `Command "${id}" is currently unavailable.`,
      }
    }
    let result: unknown
    const runFn = () => {
      result = cmd.run(mergedCtx, validated.value)
    }
    try {
      if (cmd.undoable && this.historyTransactor) {
        this.historyTransactor(cmd.label, runFn)
      } else {
        runFn()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isUnavailable = /unavailable|play mode/i.test(message)
      return {
        ok: false,
        id: cmd.id,
        code: isUnavailable ? "unavailable" : "invalid_args",
        error: message,
      }
    }
    return {
      ok: true,
      id: cmd.id,
      label: cmd.label,
      undoable: Boolean(cmd.undoable),
      state: this.state(mergedCtx),
      ...(result !== undefined ? { result: result as T } : {}),
    }
  }

  search(query: string): LabCommand[] {
    const q = query.trim().toLowerCase()
    if (!q) return [...this.list]
    return this.list.filter(cmd => {
      const hay = `${cmd.label} ${cmd.shortLabel} ${cmd.category} ${cmd.shortcut ?? ""} ${cmd.id}`.toLowerCase()
      return hay.includes(q)
    })
  }

  /**
   * Resolves the 8 fixed compass sectors for `"object"` or `"ground"` context.
   * Disabled commands stay in their assigned compass slot so sector angles never shift.
   */
  resolveRadialRing(context: RadialContext, ctx?: LabCommandContext): readonly ResolvedRadialSector[] {
    return RADIAL_COMPASS.map(({ slot, compass, angle }) => {
      const cmd = this.list.find(c => c.radial?.context === context && c.radial.slot === slot)
      if (!cmd) {
        throw new Error(`Missing radial command for context "${context}" slot ${slot} (${compass})`)
      }
      const isEnabled = cmd.enabled(ctx)
      return {
        slot,
        compass,
        angle,
        command: cmd,
        enabled: isEnabled,
        disabledReason: isEnabled ? undefined : cmd.disabledReason?.(ctx) ?? "Unavailable in this context",
      }
    })
  }
}
