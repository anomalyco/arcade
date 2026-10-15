import {
  COLLECTION_SCHEMA,
  DRAFTS,
  checkCollection,
  checkScene,
  emptyScene,
  sceneJson,
  sceneRef,
  slug,
  type CollectionKind,
  type LabScene,
  type SceneCollection,
  type SceneHost,
  type SceneStatus,
} from "./model"

/** Where local scenes live: one JSON text. `localStorage` today, IndexedDB once thumbnails exist. */
export type SceneStorage = { read(): string | null; write(text: string): void }

export const LOCAL_SCENES_KEY = "arcade.lab.scenes.v1"

export function memorySceneStorage(initial: string | null = null): SceneStorage & { text: string | null } {
  const port = { text: initial, read: () => port.text, write: (text: string) => void (port.text = text) }
  return port
}

export function browserSceneStorage(storage: Storage, key = LOCAL_SCENES_KEY): SceneStorage {
  return { read: () => storage.getItem(key), write: text => storage.setItem(key, text) }
}

/** `repo` is committed (games/lab/scenes), `local` lives in this browser, `edited` is a local change to a repo scene. */
export type SceneSource = "repo" | "local" | "edited"
export type SceneEntry = { ref: string; scene: LabScene; source: SceneSource }
export type CollectionEntry = { collection: SceneCollection; source: SceneSource; scenes: SceneEntry[] }

export type SceneStoreOptions = {
  storage: SceneStorage
  /** Parsed repo files; anything that fails validation is reported in `problems` and skipped. */
  repo?: { scenes?: readonly unknown[]; collections?: readonly unknown[] }
  now?: () => Date
  author?: string
}

const DAY = 24 * 60 * 60 * 1000
/** A draft nobody touched for this long is archived. */
export const DRAFT_LIFETIME_MS = 7 * DAY
/** A local archived scene is deleted this long after it was archived. */
export const ARCHIVE_LIFETIME_MS = 30 * DAY

type Saved = { scenes: LabScene[]; collections: SceneCollection[] }

export type SceneStore = ReturnType<typeof createSceneStore>

/**
 * Every scene the Lab knows: repo files merged with this browser's scenes and edits, with the lifecycle rules
 * (Draft → Kept → Archived → deleted) in one place. Writes go to `storage` immediately.
 */
export function createSceneStore(options: SceneStoreOptions) {
  const now = () => (options.now ?? (() => new Date()))().toISOString()
  const problems: string[] = []

  const repoScenes = new Map<string, LabScene>()
  for (const raw of options.repo?.scenes ?? []) {
    const checked = checkScene(raw)
    if (!checked.ok) problems.push(`repo scene ${label(raw)}: ${checked.problems.join("; ")}`)
    else if (repoScenes.has(sceneRef(checked.value))) problems.push(`repo scene ${sceneRef(checked.value)}: duplicate`)
    else repoScenes.set(sceneRef(checked.value), checked.value)
  }
  const repoCollections = new Map<string, SceneCollection>()
  for (const raw of options.repo?.collections ?? []) {
    const checked = checkCollection(raw)
    if (!checked.ok) problems.push(`repo collection ${label(raw)}: ${checked.problems.join("; ")}`)
    else repoCollections.set(checked.value.id, checked.value)
  }

  const local = load()
  function load(): { scenes: Map<string, LabScene>; collections: Map<string, SceneCollection> } {
    const scenes = new Map<string, LabScene>()
    const collections = new Map<string, SceneCollection>()
    let saved: Partial<Saved> = {}
    try {
      saved = JSON.parse(options.storage.read() ?? "{}") as Partial<Saved>
    } catch {
      problems.push("local scenes are not valid JSON; starting empty")
    }
    for (const raw of saved.scenes ?? []) {
      const checked = checkScene(raw)
      if (checked.ok) scenes.set(sceneRef(checked.value), checked.value)
      else problems.push(`local scene ${label(raw)}: ${checked.problems.join("; ")}`)
    }
    for (const raw of saved.collections ?? []) {
      const checked = checkCollection(raw)
      if (checked.ok) collections.set(checked.value.id, checked.value)
      else problems.push(`local collection ${label(raw)}: ${checked.problems.join("; ")}`)
    }
    return { scenes, collections }
  }
  function persist() {
    options.storage.write(JSON.stringify({ scenes: [...local.scenes.values()], collections: [...local.collections.values()] } satisfies Saved))
  }

  function entry(ref: string): SceneEntry | null {
    const mine = local.scenes.get(ref)
    if (mine) return { ref, scene: mine, source: repoScenes.has(ref) ? "edited" : "local" }
    const repo = repoScenes.get(ref)
    return repo ? { ref, scene: repo, source: "repo" } : null
  }
  function must(ref: string): SceneEntry {
    const found = entry(ref)
    if (!found) throw new Error(`No scene "${ref}"`)
    return found
  }
  function put(scene: LabScene): SceneEntry {
    const checked = checkScene(scene)
    if (!checked.ok) throw new Error(`Scene ${sceneRef(scene)} is invalid: ${checked.problems.join("; ")}`)
    local.scenes.set(sceneRef(scene), scene)
    persist()
    return entry(sceneRef(scene))!
  }
  function setStatus(ref: string, status: SceneStatus): SceneEntry {
    const { scene } = must(ref)
    if (scene.status === status) return must(ref)
    return put({ ...scene, status, updated: now() })
  }

  function collection(id: string): { collection: SceneCollection; source: SceneSource } | null {
    const mine = local.collections.get(id)
    if (mine) return { collection: mine, source: repoCollections.has(id) ? "edited" : "local" }
    const repo = repoCollections.get(id)
    if (repo) return { collection: repo, source: "repo" }
    return null
  }
  function allScenes(): SceneEntry[] {
    const refs = new Set([...repoScenes.keys(), ...local.scenes.keys()])
    return [...refs].map(ref => entry(ref)!)
  }
  /** A collection a scene names but nobody created still shows, so no scene is orphaned. */
  function implied(id: string, at: string): SceneCollection {
    return {
      schema: COLLECTION_SCHEMA,
      id,
      title: id === DRAFTS ? "Drafts" : id.replace(/-/g, " ").replace(/^./, c => c.toUpperCase()),
      kind: id === DRAFTS ? "drafts" : "area",
      status: "active",
      order: [],
      created: at,
      updated: at,
    }
  }

  return {
    /** Repo and local entries that failed validation and were skipped. */
    problems: problems as readonly string[],

    get: entry,

    scenes(filter: { collection?: string; archived?: boolean } = {}): SceneEntry[] {
      return allScenes()
        .filter(e => (filter.collection === undefined || e.scene.collection === filter.collection) && (filter.archived ? true : e.scene.status !== "archived"))
        .sort((a, b) => b.scene.updated.localeCompare(a.scene.updated))
    },

    collections(filter: { archived?: boolean } = {}): CollectionEntry[] {
      const at = now()
      const ids = new Set([DRAFTS, ...repoCollections.keys(), ...local.collections.keys(), ...allScenes().map(e => e.scene.collection)])
      return [...ids]
        .map(id => {
          const found = collection(id) ?? { collection: implied(id, at), source: "local" as const }
          const scenes = this.scenes({ collection: id, archived: filter.archived })
          const rank = (e: SceneEntry) => {
            const i = found.collection.order.indexOf(e.scene.id)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
          }
          scenes.sort((a, b) => rank(a) - rank(b))
          return { ...found, scenes }
        })
        .filter(c => filter.archived || c.collection.status !== "archived")
    },

    /** A new draft, empty or copied from another scene. */
    create(input: { title: string; collection?: string; host?: SceneHost; from?: string }): SceneEntry {
      const collectionId = input.collection ?? DRAFTS
      const taken = allScenes().filter(e => e.scene.collection === collectionId).map(e => e.scene.id)
      const id = slug(input.title, taken)
      const at = now()
      const base = input.from ? must(input.from).scene : null
      const scene: LabScene = base
        ? { ...structuredClone(base), id, collection: collectionId, title: input.title, status: "draft", created: at, updated: at, author: options.author }
        : emptyScene({ id, collection: collectionId, title: input.title, now: at, author: options.author, host: input.host })
      return put(scene)
    },

    /** Saves edits. Editing a repo scene keeps the change in this browser until it is saved to the repo. */
    save(scene: LabScene): SceneEntry {
      return put({ ...scene, updated: now() })
    },

    keep(ref: string, rename: { title?: string } = {}): SceneEntry {
      const { scene } = must(ref)
      if (scene.status === "archived") throw new Error(`Scene "${ref}" is archived; restore it first`)
      return put({ ...scene, title: rename.title?.trim() || scene.title, status: "kept", updated: now() })
    },

    archive(ref: string): SceneEntry {
      return setStatus(ref, "archived")
    },

    /** Restoring keeps the scene, so the draft sweep doesn't archive it again. */
    restore(ref: string): SceneEntry {
      const { scene } = must(ref)
      if (scene.status !== "archived") throw new Error(`Scene "${ref}" is not archived`)
      return setStatus(ref, "kept")
    },

    /** Deletes a local scene. A repo scene is deleted by removing its file. */
    remove(ref: string): void {
      const found = must(ref)
      if (found.source === "repo") throw new Error(`Scene "${ref}" is a repo file; delete ${repoPath(found.scene)} instead`)
      local.scenes.delete(ref)
      persist()
    },

    /** Drops this browser's edits to a repo scene. */
    revert(ref: string): SceneEntry {
      if (!repoScenes.has(ref)) throw new Error(`Scene "${ref}" has no repo version to go back to`)
      local.scenes.delete(ref)
      persist()
      return must(ref)
    },

    move(ref: string, collectionId: string): SceneEntry {
      const found = must(ref)
      if (found.source !== "local") throw new Error(`Scene "${ref}" comes from the repo; duplicate it to move a copy`)
      const taken = allScenes().filter(e => e.scene.collection === collectionId).map(e => e.scene.id)
      const moved = { ...found.scene, collection: collectionId, id: slug(found.scene.id, taken), updated: now() }
      local.scenes.delete(ref)
      return put(moved)
    },

    createCollection(input: { title: string; kind?: CollectionKind; summary?: string; board?: SceneCollection["board"] }): SceneCollection {
      const taken = new Set([DRAFTS, ...repoCollections.keys(), ...local.collections.keys()])
      const at = now()
      const created: SceneCollection = {
        schema: COLLECTION_SCHEMA,
        id: slug(input.title, taken),
        title: input.title,
        kind: input.kind ?? "feature",
        status: "active",
        order: [],
        summary: input.summary,
        board: input.board,
        created: at,
        updated: at,
      }
      const checked = checkCollection(created)
      if (!checked.ok) throw new Error(checked.problems.join("; "))
      local.collections.set(created.id, created)
      persist()
      return created
    },

    /** Archives a collection and every scene in it; returns the scene refs it archived. */
    archiveCollection(id: string): string[] {
      if (id === DRAFTS) throw new Error("Drafts can't be archived; its scenes clear themselves")
      const at = now()
      const found = collection(id)?.collection ?? implied(id, at)
      local.collections.set(id, { ...found, status: "archived", updated: at })
      const archived: string[] = []
      for (const e of allScenes()) {
        if (e.scene.collection !== id || e.scene.status === "archived") continue
        local.scenes.set(e.ref, { ...e.scene, status: "archived", updated: at })
        archived.push(e.ref)
      }
      persist()
      return archived
    },

    /** Archives drafts untouched for 7 days and deletes local scenes archived more than 30 days ago. */
    sweep(): { archived: string[]; deleted: string[] } {
      const t = Date.parse(now())
      const archived: string[] = []
      const deleted: string[] = []
      for (const [ref, scene] of local.scenes) {
        if (repoScenes.has(ref)) continue
        const age = t - Date.parse(scene.updated)
        if (scene.status === "draft" && age > DRAFT_LIFETIME_MS) {
          local.scenes.set(ref, { ...scene, status: "archived", updated: new Date(t).toISOString() })
          archived.push(ref)
        } else if (scene.status === "archived" && age > ARCHIVE_LIFETIME_MS) {
          local.scenes.delete(ref)
          deleted.push(ref)
        }
      }
      if (archived.length || deleted.length) persist()
      return { archived, deleted }
    },

    /** The file "Save to repo" writes: the scene as kept, at its path under games/lab/scenes. */
    repoFile(ref: string): { path: string; json: string } {
      const { scene } = must(ref)
      const kept: LabScene = { ...scene, status: scene.status === "draft" ? "kept" : scene.status }
      return { path: repoPath(kept), json: sceneJson(kept) }
    },
  }
}

export const repoPath = (scene: Pick<LabScene, "collection" | "id">) => `games/lab/scenes/${scene.collection}/${scene.id}.scene.json`

function label(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>
    if (typeof r.collection === "string" && typeof r.id === "string") return `${r.collection}/${r.id}`
    if (typeof r.id === "string") return r.id
  }
  return "(no id)"
}
