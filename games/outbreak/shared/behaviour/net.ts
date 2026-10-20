import type { OutbreakNetSectionCodec } from "../feature-registry"
import { ACT_NONE, ACTIVITY_COUNT } from "./activities"
import type { BehaviourState } from "./mind"
import type { BehaviourSnapshot } from "./net-types"

/** The behaviour section's bit (2048 bodies is the last before it; bits past 128 cost a header byte). */
export const SEC_BEHAVIOUR = 4096

type Payload = { full: boolean; changes: number[] }

/**
 * Activities of the zombies inside the recipient's bubble. A full snapshot carries every zombie doing something
 * (id u16 + code u8); a delta carries only the ones whose code changed against the acked base (code 0 clears), and is
 * omitted when nothing changed, so a quiet crowd costs nothing and a change costs about 3 bytes.
 */
export const behaviourNetSection: OutbreakNetSectionCodec<BehaviourState, BehaviourSnapshot, Payload> = {
  bit: SEC_BEHAVIOUR,
  key: "behaviour",
  collect: ({ sim, state, isDelta, baseSnap, viewerCenter, bubbleCx, bubbleCy, interest }) => {
    const acts: number[] = []
    const half = interest.bubbleHalfExtent
    for (const a of sim.ai.agents) {
      const act = state.minds[a.id]?.act ?? ACT_NONE
      if (act === ACT_NONE || a.state === "dead" || a.id > 0xffff) continue
      if (viewerCenter && (Math.abs(a.x - bubbleCx) > half || Math.abs(a.y - bubbleCy) > half)) continue
      acts.push(a.id, act)
    }
    sortPairs(acts)
    const value: BehaviourSnapshot | undefined = acts.length ? { acts } : undefined
    if (!isDelta) return { snapshotValue: value, shouldWrite: acts.length > 0, writePayload: { full: true, changes: acts } }
    const base = (baseSnap?.behaviour as BehaviourSnapshot | undefined)?.acts ?? []
    const changes = diffPairs(base, acts)
    return { snapshotValue: value, shouldWrite: changes.length > 0, writePayload: { full: false, changes } }
  },
  encode: (w, p) => {
    w.uvar(p.changes.length / 2)
    for (let i = 0; i < p.changes.length; i += 2) w.u16(p.changes[i]!).u8(p.changes[i + 1]!)
  },
  decode: (r, { isDelta, baseSnap }) => {
    const changes: number[] = []
    for (let n = r.uvar(), i = 0; i < n; i++) {
      const id = r.u16()
      const act = r.u8()
      changes.push(id, act < ACTIVITY_COUNT ? act : ACT_NONE)
    }
    const acts = isDelta ? applyPairs((baseSnap?.behaviour as BehaviourSnapshot | undefined)?.acts ?? [], changes) : applyPairs([], changes)
    return acts.length ? { acts } : undefined
  },
  decodeOmitted: ({ isDelta, baseSnap }) => (isDelta ? (baseSnap?.behaviour as BehaviourSnapshot | undefined) : undefined),
  skip: (r) => {
    for (let n = r.uvar(), i = 0; i < n; i++) r.u16(), r.u8()
  },
}

function sortPairs(a: number[]): void {
  const pairs: [number, number][] = []
  for (let i = 0; i < a.length; i += 2) pairs.push([a[i]!, a[i + 1]!])
  pairs.sort((x, y) => x[0] - y[0])
  for (let i = 0; i < pairs.length; i++) {
    a[i * 2] = pairs[i]![0]
    a[i * 2 + 1] = pairs[i]![1]
  }
}

/** Changes that turn `base` into `next` (both sorted id/code pairs): new or changed codes, and 0 for ids now gone. */
export function diffPairs(base: readonly number[], next: readonly number[]): number[] {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < base.length || j < next.length) {
    const bi = i < base.length ? base[i]! : Infinity
    const nj = j < next.length ? next[j]! : Infinity
    if (bi === nj) {
      if (base[i + 1] !== next[j + 1]) out.push(nj, next[j + 1]!)
      i += 2
      j += 2
    } else if (bi < nj) {
      out.push(bi, ACT_NONE)
      i += 2
    } else {
      out.push(nj, next[j + 1]!)
      j += 2
    }
  }
  return out
}

/** `base` with `changes` applied (code 0 removes the id), sorted by id. */
export function applyPairs(base: readonly number[], changes: readonly number[]): number[] {
  const map = new Map<number, number>()
  for (let i = 0; i < base.length; i += 2) map.set(base[i]!, base[i + 1]!)
  for (let i = 0; i < changes.length; i += 2) {
    if (changes[i + 1] === ACT_NONE) map.delete(changes[i]!)
    else map.set(changes[i]!, changes[i + 1]!)
  }
  const out: number[] = []
  for (const id of [...map.keys()].sort((x, y) => x - y)) out.push(id, map.get(id)!)
  return out
}
