import { storageKey, type StoragePort } from "../core/storage.js"

/** What a page or panel remembers folded or open: sections, group cards and a panel's sub-headings. */
export type FoldKind = "sections" | "groups" | "subsections"

export interface FoldMemory {
  /** What the user last chose for it, if anything. */
  get(kind: FoldKind, id: string): boolean | undefined
  set(kind: FoldKind, id: string, folded: boolean): void
}

/**
 * A page's or panel's folds, kept under `knobs:<id>:folds:v1` in `storage` as
 * `{ sections?: Record<string, boolean>, groups?: Record<string, boolean>, subsections?: … }`, and
 * nothing else (no values, locks or variants). `null` storage remembers nothing.
 */
export function foldMemory(id: string, storage: () => StoragePort | null): FoldMemory {
  const key = storageKey(id, "folds")
  const read = (): Partial<Record<FoldKind, Record<string, boolean>>> => {
    try {
      const data = JSON.parse(storage()?.getItem(key) ?? "{}")
      return data && typeof data === "object" ? data : {}
    } catch {
      return {}
    }
  }
  return {
    get(kind, at) {
      const value = read()[kind]?.[at]
      return typeof value === "boolean" ? value : undefined
    },
    set(kind, at, folded) {
      const port = storage()
      if (!port) return
      const data = read()
      if (data[kind]?.[at] === folded) return
      const next = { ...data, [kind]: { ...data[kind], [at]: folded } }
      try {
        port.setItem(key, JSON.stringify(next))
      } catch {
        /* Storage that's full or refused just forgets. */
      }
    },
  }
}
