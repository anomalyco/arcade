import type { LabStation } from "@arcade/kit/lab/stations/types"

// One file per station; adding a file here adds a station to the Lab. See docs/lab.md#stations.
const modules = import.meta.glob<{ default: LabStation }>(["./*.ts", "!./index.ts", "!./define.ts"], { eager: true })

export const STATIONS: readonly LabStation[] = Object.values(modules).map(module => module.default)
