import { bea } from "./bea"
import { chef } from "./chef"
import { fern } from "./fern"
import { presto } from "./presto"
import { roxy } from "./roxy"
import { slab } from "./slab"
import type { CharacterDef } from "./types"

export type { CharacterDef } from "./types"

/** The roster, in select-screen order. */
export const ROSTER: readonly CharacterDef[] = [bea, presto, chef, roxy, slab, fern]
export const CHARACTERS: Readonly<Record<string, CharacterDef>> = Object.fromEntries(ROSTER.map((c) => [c.id, c]))
export const characterOf = (id: unknown): CharacterDef | null => (typeof id === "string" && CHARACTERS[id]) || null
