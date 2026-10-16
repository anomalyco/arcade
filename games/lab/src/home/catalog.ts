import { LAB_KINDS } from "../scenes/kinds"
import { migrateStations } from "../scenes/from-stations"
import { stationFromScene } from "@arcade/kit/lab/scenes/migrate"
import { browserSceneStorage, createSceneStore, memorySceneStorage, type SceneEntry, type SceneStorage } from "@arcade/kit/lab/scenes/store"
import type { LabStation } from "@arcade/kit/lab/stations/types"
import { orderedVariants } from "@arcade/kit/lab/stations/variants"

/** Station files carry no dates; their labs all take this one so a repo lab never looks edited. */
const STATION_EPOCH = "2026-10-15T00:00:00.000Z"

export type HomeLab = {
  /** `collection/id`, the lab's address in URLs and commands. */
  ref: string
  id: string
  title: string
  summary: string
  kind: { id: string; label: string }
  collection: { id: string; title: string }
  status: SceneEntry["scene"]["status"]
  source: SceneEntry["source"]
  color: number | undefined
  /** In group order, as number keys pick them. */
  variants: readonly { id: string; label: string; group?: string }[]
  /** What the station workspace opens: the station file itself for a lab it became unchanged, else one built from the lab. */
  station(): LabStation
}

export type HomeCollection = { id: string; title: string; labs: readonly HomeLab[] }

/**
 * Every lab the Lab can open: the station files as kept labs in their area collections, merged with this browser's own
 * labs and edits (`createSceneStore`). Empty collections are left out.
 */
export function createCatalog(stations: readonly LabStation[], storage: Storage | SceneStorage | null) {
  const repo = migrateStations(stations, STATION_EPOCH)
  const source = storage === null ? memorySceneStorage() : isSceneStorage(storage) ? storage : browserSceneStorage(storage)
  const store = createSceneStore({ storage: source, repo })
  for (const problem of store.problems) console.warn(`[labs] ${problem}`)
  // Drafts nobody touched for a week are archived; labs archived here a month ago are deleted.
  const swept = store.sweep()
  const byStation = new Map(stations.map(s => [s.id, s]))
  const kinds = new Map(LAB_KINDS.map(k => [k.id, k]))

  const lab = (entry: SceneEntry, collection: { id: string; title: string }): HomeLab => {
    const { scene } = entry
    const original = entry.source === "repo" ? byStation.get(scene.id) : undefined
    return {
      ref: entry.ref,
      id: scene.id,
      title: scene.title,
      summary: scene.summary ?? "",
      kind: { id: scene.kind, label: kinds.get(scene.kind)?.label ?? "Lab" },
      collection,
      status: scene.status,
      source: entry.source,
      color: scene.info?.color,
      variants: orderedVariants(scene.variants).map(v => ({ id: v.id, label: v.label, ...(v.group ? { group: v.group } : {}) })),
      station: () => original ?? stationFromScene(scene),
    }
  }

  function collections(): HomeCollection[] {
    return store
      .collections()
      .map(c => {
        const head = { id: c.collection.id, title: c.collection.title }
        return { ...head, labs: c.scenes.map(e => lab(e, head)) }
      })
      .filter(c => c.labs.length > 0)
  }

  function all(): HomeLab[] {
    return collections().flatMap(c => c.labs)
  }

  /** A lab by ref, or by id alone (old `?station=` links name the station, which is the lab's id). */
  function find(key: string): HomeLab | undefined {
    const labs = all()
    return labs.find(l => l.ref === key) ?? labs.find(l => l.id === key)
  }

  /** The lab `step` places after (or before) this one in its collection, wrapping. */
  function step(ref: string, by: number): HomeLab | undefined {
    const here = find(ref)
    if (!here) return undefined
    const labs = collections().find(c => c.id === here.collection.id)?.labs ?? []
    const i = labs.findIndex(l => l.ref === ref)
    return labs[(i + by + labs.length) % labs.length]
  }

  /** Labs archived in this browser, newest first. */
  function archived(): HomeLab[] {
    return store
      .scenes({ archived: true })
      .filter(e => e.scene.status === "archived")
      .map(e => lab(e, { id: e.scene.collection, title: store.collections({ archived: true }).find(c => c.collection.id === e.scene.collection)?.collection.title ?? e.scene.collection }))
  }

  /** Kinds a new lab can start from: the ones that run a Lab section (page kinds open a game page as it ships). */
  const kindsToStart = LAB_KINDS.filter(k => k.host.kind === "section")

  const entry = (ref: string) => {
    const found = store.get(ref)
    if (!found) throw new Error(`No lab "${ref}"`)
    return found
  }
  const view = (e: SceneEntry) => all().find(l => l.ref === e.ref) ?? archived().find(l => l.ref === e.ref)!

  return {
    store,
    collections,
    all,
    archived,
    find: (key: string) => find(key) ?? archived().find(l => l.ref === key),
    step,
    notes: repo.notes,
    swept,
    kinds: kindsToStart.map(k => ({ id: k.id, label: k.label, subject: k.subject })),
    /** A new draft lab of a kind, in Drafts. */
    create(kindId: string): HomeLab {
      const kind = kindsToStart.find(k => k.id === kindId)
      if (!kind) throw new Error(`No lab kind "${kindId}"`)
      return view(store.create({ title: `${kind.label} lab`, kind: kind.id, host: kind.host }))
    },
    /** A draft copy beside the original, opening on the same values and variants. */
    duplicate(ref: string): HomeLab {
      const { scene } = entry(ref)
      return view(store.create({ title: `${scene.title} copy`, kind: scene.kind, collection: scene.collection, from: ref }))
    },
    /** Draft → Kept: the weekly sweep leaves it alone. */
    keep: (ref: string) => view(store.keep(ref)),
    archive: (ref: string) => view(store.archive(ref)),
    /** Back from the archive. A station's lab simply drops this browser's archived copy. */
    restore(ref: string): HomeLab {
      const found = entry(ref)
      return view(found.source === "edited" ? store.revert(ref) : store.restore(ref))
    },
    /** Deletes a lab made in this browser. Station labs go when their station file does. */
    remove(ref: string): void {
      if (entry(ref).source !== "local") throw new Error("Station labs can't be deleted here; archive it, or delete its station file")
      store.remove(ref)
    },
    deletable: (ref: string) => store.get(ref)?.source === "local",
  }
}

/** The lab's title, id, kind, collection or summary contains every word of the query. */
export function matches(lab: HomeLab, query: string): boolean {
  const hay = `${lab.title} ${lab.id} ${lab.kind.label} ${lab.collection.title} ${lab.summary}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word))
}

function isSceneStorage(s: Storage | SceneStorage): s is SceneStorage {
  return typeof (s as SceneStorage).read === "function" && typeof (s as SceneStorage).write === "function"
}

export type Catalog = ReturnType<typeof createCatalog>
