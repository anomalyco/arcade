/** Slot-store inventory is on the ledger wire; these lifecycle counters are not. */
export type BodiesSnapshot = { rising: { id: string; rise: number; risen: boolean }[] }
