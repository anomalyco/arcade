import type { LabStation } from "@arcade/kit/lab/stations/types"

export { gridVariants } from "@arcade/kit/lab/stations/types"
export type { LabStation, StationLayout, StationVariant, StationWidget } from "@arcade/kit/lab/stations/types"

/** Identity helper so a station file is checked against the registry type. */
export const defineStation = (station: LabStation): LabStation => station
