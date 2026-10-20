/** Persistent damaging gas, including its authoritative birth and expiry for late joiners. */
export type GasCloud = { id: number; x: number; y: number; born: number; until: number; radius: number }
export type SpecialsSnapshot = { clouds: GasCloud[] }
