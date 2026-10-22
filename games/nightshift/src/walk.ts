import { Walk as SharedWalk } from "@arcade/kit/client/walk"
export type { FoleyEvent, WalkInput } from "@arcade/kit/client/walk"
/** The office adds occasional furniture creaks to the shared walking clock. */
export class Walk extends SharedWalk { constructor(){super(true)} }
