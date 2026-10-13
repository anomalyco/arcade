import type { LabWorldObject } from "./types"

export type RadialSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export type RadialContext = "object" | "ground"
export type LabCommandCategory = "Mode" | "Transport" | "Scene" | "Compare" | "Object" | "Inspector" | "Preset"

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

export type LabCommandContext = {
  pickedObject: LabWorldObject | null
  groundHit: { x: number; y: number; z: number } | null
  screenX?: number
  screenY?: number
}

export type LabCommand = {
  id: string
  label: string
  shortLabel: string
  category: LabCommandCategory
  shortcut?: string
  accelerators?: readonly string[]
  radial?: { context: RadialContext; slot: RadialSlot }
  enabled: (ctx?: LabCommandContext) => boolean
  disabledReason?: (ctx?: LabCommandContext) => string
  run: (ctx?: LabCommandContext) => void
}

export type ResolvedRadialSector = {
  slot: RadialSlot
  compass: string
  angle: number
  command: LabCommand
  enabled: boolean
  disabledReason?: string
}

export class LabCommandRegistry {
  private readonly map = new Map<string, LabCommand>()
  private readonly list: LabCommand[] = []

  register(command: LabCommand): LabCommand {
    this.map.set(command.id, command)
    const existingIdx = this.list.findIndex(c => c.id === command.id)
    if (existingIdx >= 0) this.list[existingIdx] = command
    else this.list.push(command)
    return command
  }

  registerAll(commands: readonly LabCommand[]): void {
    for (const cmd of commands) this.register(cmd)
  }

  get(id: string): LabCommand | undefined {
    return this.map.get(id)
  }

  all(): readonly LabCommand[] {
    return this.list
  }

  execute(id: string, ctx?: LabCommandContext): boolean {
    const cmd = this.map.get(id)
    if (!cmd || !cmd.enabled(ctx)) return false
    cmd.run(ctx)
    return true
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
