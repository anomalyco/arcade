import type { LabStation } from "@arcade/kit/lab/overworld/types"

/** Identity helper so a station file is checked against the registry type. */
export const defineStation = (station: LabStation): LabStation => station
