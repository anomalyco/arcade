import { storageKey } from "../core/storage.js"

/** What a reload should bring back, per tab: open panels, open editors and the focused stop. */
export interface PanelSession {
  readonly open?: boolean
  readonly expanded?: readonly string[]
  readonly focus?: { readonly inline: boolean; readonly stop: number }
  /** A page's collapsible custom cards, by title: whether each is folded. */
  readonly folded?: Readonly<Record<string, boolean>>
  /** A panel's foldable groups, by id: whether each is folded. */
  readonly groups?: Readonly<Record<string, boolean>>
  /** A panel's sub-headings, by group and name: whether each is folded. */
  readonly subsections?: Readonly<Record<string, boolean>>
  /** The tab a panel showed. */
  readonly tab?: string
}

const tab = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

export function readSession(id: string): PanelSession {
  try {
    return JSON.parse(tab()?.getItem(storageKey(id, "session")) ?? "{}") ?? {}
  } catch {
    return {}
  }
}

export function writeSession(id: string, patch: Partial<PanelSession>) {
  const next: Record<string, unknown> = { ...readSession(id), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  try {
    tab()?.setItem(storageKey(id, "session"), JSON.stringify(next))
  } catch {
    /* A tab that can't remember just starts closed. */
  }
}
