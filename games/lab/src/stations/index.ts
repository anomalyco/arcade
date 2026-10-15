import type { LabStation } from "@arcade/kit/lab/overworld/types"

// One file per station; adding a file here adds a plot to the overworld. See docs/lab.md#overworld-stations.
const modules = import.meta.glob<{ default: LabStation }>(["./*.ts", "!./index.ts", "!./define.ts"], { eager: true })

export const STATIONS: readonly LabStation[] = Object.values(modules).map(module => module.default)
