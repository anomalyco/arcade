import type { LabValue } from "../../lab-navigation"

/**
 * A lab: one focused workspace for one subject (an explosion, a tree, a walk cycle, a HUD). Its `kind` says what the
 * subject is and which panels, choices and add-picker it gets (`LabKind`, kinds.ts). A lab saves the subject's values,
 * its named choices (the subject's preset and the backdrop it is shown against), any extras the kind lets you add,
 * views and variants, and lives in a collection. Design: AR-25 / D-16. The type keeps the name `LabScene` because
 * "lab" already means the whole app in the code.
 */
export const SCENE_SCHEMA = "arcade-lab-scene/v1"
export const COLLECTION_SCHEMA = "arcade-lab-collection/v1"

export type SceneStatus = "draft" | "kept" | "archived"
export const SCENE_STATUSES: readonly SceneStatus[] = ["draft", "kept", "archived"]

/** A command run through the Lab's registry, as `arcade run <command> '<args>'` would. */
export type SceneCommand = { command: string; args?: Record<string, LabValue> }

/** A part from the lab kind's own lists (a preset, a backdrop, an extra), with the values that differ from its defaults. */
export type PartRef = { part: string; settings?: Record<string, LabValue> }

export type SceneHost =
  | { kind: "section"; section: string; setup?: readonly SceneCommand[] }
  | { kind: "page"; url: string }

/** Something the kind's add-picker placed (cones on a vehicle course, walkers in a tree lab). */
export type SceneExtra = PartRef & {
  id: string
  label?: string
  at?: readonly [number, number, number]
  yaw?: number
  locked?: boolean
  hidden?: boolean
}

export type SceneView =
  | { id: string; label: string; kind: "orbit"; yaw: number; pitch: number; distance: number; target?: readonly [number, number, number] }
  | { id: string; label: string; kind: "game" }

/** Named choices by slot ("preset", "backdrop", "light", "look"); the lab kind declares which slots exist. */
export type SceneChoices = Record<string, PartRef>

/** Named changes on top of the lab: choices, values, and commands for what neither can express yet. */
export type SceneVariant = {
  id: string
  label: string
  note?: string
  choices?: SceneChoices
  set?: Record<string, LabValue>
  setup?: readonly SceneCommand[]
  /** Page scenes: the page URL that shows this variant. */
  url?: string
}

export type SceneLayout = {
  /** The subject panel shows these groups and keys first, once. Replaces station Controls cards. */
  featured?: { groups?: readonly string[]; keys?: readonly string[] }
  watch?: readonly string[]
  /** Variation-grid preset offered from the scene. */
  grid?: string
}

export type SceneInfo = {
  board?: { feature: string; decision?: string }
  metrics?: readonly { label: string; value: string; source?: string }[]
  links?: readonly { label: string; href: string }[]
  paths?: readonly string[]
  branches?: readonly string[]
  /** Work status carried over from stations (live, in-progress, review, planned). */
  work?: string
  workNote?: string
  color?: number
}

export type LabScene = {
  schema: typeof SCENE_SCHEMA
  id: string
  collection: string
  /** The lab kind: what the subject is, and so which panels, choices and add-picker the lab gets. */
  kind: string
  title: string
  status: SceneStatus
  created: string
  updated: string
  author?: string
  summary?: string
  /** Game adapters to load before opening. */
  games?: readonly string[]
  host?: SceneHost
  choices: SceneChoices
  extras: readonly SceneExtra[]
  settings: Record<string, LabValue>
  seeds: { room?: number; effect?: number; tuning?: number }
  views: readonly SceneView[]
  view?: string
  variants: readonly SceneVariant[]
  /** The variant the scene opens on. */
  variant?: string
  layout?: SceneLayout
  info?: SceneInfo
  note?: string
}

export type CollectionKind = "area" | "feature" | "review" | "drafts" | "starters"
export const COLLECTION_KINDS: readonly CollectionKind[] = ["area", "feature", "review", "drafts", "starters"]

export type SceneCollection = {
  schema: typeof COLLECTION_SCHEMA
  id: string
  title: string
  kind: CollectionKind
  status: "active" | "archived"
  /** Scene ids in display order; scenes not listed follow, newest first. */
  order: readonly string[]
  summary?: string
  board?: { feature: string; decision?: string }
  created: string
  updated: string
}

/** Where every unsorted scene lands. */
export const DRAFTS = "drafts"

/** `collection/scene`, the id used by links, `arcade scene open` and the store. */
export const sceneRef = (scene: Pick<LabScene, "collection" | "id">) => `${scene.collection}/${scene.id}`

export function parseSceneRef(ref: string): { collection: string; id: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,47})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(ref.trim())
  return m ? { collection: m[1]!, id: m[2]! } : null
}

/** A readable id from a title: "Storm street" → "storm-street". */
export function slug(title: string, taken: Iterable<string> = []): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "scene"
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

export function emptyScene(input: { id: string; kind: string; collection?: string; title: string; now: string; author?: string; host?: SceneHost }): LabScene {
  return {
    schema: SCENE_SCHEMA,
    id: input.id,
    collection: input.collection ?? DRAFTS,
    kind: input.kind,
    title: input.title,
    status: "draft",
    created: input.now,
    updated: input.now,
    author: input.author,
    host: input.host,
    choices: {},
    extras: [],
    settings: {},
    seeds: {},
    views: [],
    variants: [],
  }
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] }

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SLOT = /^[a-z][a-z0-9-]{0,31}$/
const COLLECTION_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const FEATURE = /^[A-Z]+-\d+$/
const DECISION = /^D-\d+$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isValue = (v: unknown): v is LabValue => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v))
const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(isNum)

function values(v: unknown, at: string, problems: string[]) {
  if (v === undefined) return
  if (!isRecord(v)) return void problems.push(`${at} must be an object of values`)
  for (const [k, x] of Object.entries(v)) if (!isValue(x)) problems.push(`${at}.${k} must be a finite number, string or boolean`)
}

function commands(v: unknown, at: string, problems: string[]) {
  if (v === undefined) return
  if (!Array.isArray(v)) return void problems.push(`${at} must be a list of commands`)
  v.forEach((c, i) => {
    if (!isRecord(c) || typeof c.command !== "string" || !c.command) problems.push(`${at}[${i}] needs a command`)
    else values(c.args, `${at}[${i}].args`, problems)
  })
}

function choices(v: unknown, at: string, problems: string[]) {
  if (!isRecord(v)) return void problems.push(`${at} must be an object`)
  for (const [slot, ref] of Object.entries(v)) {
    if (!SLOT.test(slot)) problems.push(`${at}.${slot}: slot names are lowercase letters, digits and dashes`)
    else if (!isRecord(ref) || typeof ref.part !== "string" || !ref.part) problems.push(`${at}.${slot}.part is required`)
    else values(ref.settings, `${at}.${slot}.settings`, problems)
  }
}

function board(v: unknown, at: string, problems: string[]) {
  if (v === undefined) return
  if (!isRecord(v) || typeof v.feature !== "string" || !FEATURE.test(v.feature)) return void problems.push(`${at}.feature must look like AR-12`)
  if (v.decision !== undefined && (typeof v.decision !== "string" || !DECISION.test(v.decision))) problems.push(`${at}.decision must look like D-6`)
}

/** Checks untrusted scene JSON (a repo file, a link, local storage) and returns it unchanged or every problem found. */
export function checkScene(input: unknown): Checked<LabScene> {
  const problems: string[] = []
  if (!isRecord(input)) return { ok: false, problems: ["scene must be an object"] }
  const s = input
  if (s.schema !== SCENE_SCHEMA) problems.push(`schema must be "${SCENE_SCHEMA}"`)
  if (typeof s.id !== "string" || !SCENE_ID.test(s.id)) problems.push("id must be lowercase letters, digits and dashes (up to 64)")
  if (typeof s.collection !== "string" || !COLLECTION_ID.test(s.collection)) problems.push("collection must be lowercase letters, digits and dashes (up to 48)")
  if (typeof s.kind !== "string" || !SLOT.test(s.kind)) problems.push("kind must be a lab kind id")
  if (typeof s.title !== "string" || !s.title.trim()) problems.push("title is required")
  if (!SCENE_STATUSES.includes(s.status as SceneStatus)) problems.push(`status must be ${SCENE_STATUSES.join(", ")}`)
  if (!isDate(s.created) || !isDate(s.updated)) problems.push("created and updated must be ISO dates")
  if (s.games !== undefined && !(Array.isArray(s.games) && s.games.every(g => typeof g === "string"))) problems.push("games must be a list of game ids")
  if (s.host !== undefined) {
    const h = s.host
    if (!isRecord(h)) problems.push("host must be an object")
    else if (h.kind === "section") {
      if (typeof h.section !== "string" || !h.section) problems.push("host.section is required")
      commands(h.setup, "host.setup", problems)
    } else if (h.kind === "page") {
      if (typeof h.url !== "string" || !h.url.startsWith("/arcade/")) problems.push("host.url must be an Arcade path")
    } else problems.push('host.kind must be "section" or "page"')
  }
  choices(s.choices, "choices", problems)
  if (!Array.isArray(s.extras)) problems.push("extras must be a list")
  else {
    const ids = new Set<string>()
    s.extras.forEach((t, i) => {
      const at = `extras[${i}]`
      if (!isRecord(t)) return void problems.push(`${at} must be an object`)
      if (typeof t.id !== "string" || !t.id) problems.push(`${at}.id is required`)
      else if (ids.has(t.id)) problems.push(`${at}.id "${t.id}" is used twice`)
      else ids.add(t.id)
      if (typeof t.part !== "string" || !t.part) problems.push(`${at}.part is required`)
      if (t.at !== undefined && !isVec3(t.at)) problems.push(`${at}.at must be three finite numbers`)
      if (t.yaw !== undefined && !isNum(t.yaw)) problems.push(`${at}.yaw must be a finite number`)
      values(t.settings, `${at}.settings`, problems)
    })
  }
  if (s.settings === undefined) problems.push("settings must be an object of values")
  else values(s.settings, "settings", problems)
  if (!isRecord(s.seeds)) problems.push("seeds must be an object")
  else for (const [k, v] of Object.entries(s.seeds)) if (!["room", "effect", "tuning"].includes(k) || !Number.isInteger(v)) problems.push(`seeds.${k} must be an integer room, effect or tuning seed`)
  if (!Array.isArray(s.views)) problems.push("views must be a list")
  else s.views.forEach((v, i) => {
    const at = `views[${i}]`
    if (!isRecord(v) || typeof v.id !== "string" || typeof v.label !== "string") return void problems.push(`${at} needs an id and label`)
    if (v.kind === "orbit") {
      if (![v.yaw, v.pitch, v.distance].every(isNum) || (v.distance as number) <= 0) problems.push(`${at} needs finite yaw, pitch and a positive distance`)
      if (v.target !== undefined && !isVec3(v.target)) problems.push(`${at}.target must be three finite numbers`)
    } else if (v.kind !== "game") problems.push(`${at}.kind must be "orbit" or "game"`)
  })
  if (s.view !== undefined && !(Array.isArray(s.views) && s.views.some(v => isRecord(v) && v.id === s.view))) problems.push(`view "${String(s.view)}" is not one of the views`)
  if (!Array.isArray(s.variants)) problems.push("variants must be a list")
  else {
    const ids = new Set<string>()
    s.variants.forEach((v, i) => {
      const at = `variants[${i}]`
      if (!isRecord(v) || typeof v.id !== "string" || !v.id || typeof v.label !== "string") return void problems.push(`${at} needs an id and label`)
      if (ids.has(v.id)) problems.push(`${at}.id "${v.id}" is used twice`)
      ids.add(v.id)
      if (v.choices !== undefined) choices(v.choices, `${at}.choices`, problems)
      values(v.set, `${at}.set`, problems)
      commands(v.setup, `${at}.setup`, problems)
      if (v.url !== undefined && (typeof v.url !== "string" || !v.url.startsWith("/arcade/"))) problems.push(`${at}.url must be an Arcade path`)
    })
    if (s.variant !== undefined && !ids.has(String(s.variant))) problems.push(`variant "${String(s.variant)}" is not one of the variants`)
  }
  if (s.info !== undefined) {
    if (!isRecord(s.info)) problems.push("info must be an object")
    else board(s.info.board, "info.board", problems)
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: input as LabScene }
}

export function checkCollection(input: unknown): Checked<SceneCollection> {
  const problems: string[] = []
  if (!isRecord(input)) return { ok: false, problems: ["collection must be an object"] }
  const c = input
  if (c.schema !== COLLECTION_SCHEMA) problems.push(`schema must be "${COLLECTION_SCHEMA}"`)
  if (typeof c.id !== "string" || !COLLECTION_ID.test(c.id)) problems.push("id must be lowercase letters, digits and dashes (up to 48)")
  if (typeof c.title !== "string" || !c.title.trim()) problems.push("title is required")
  if (!COLLECTION_KINDS.includes(c.kind as CollectionKind)) problems.push(`kind must be ${COLLECTION_KINDS.join(", ")}`)
  if (c.status !== "active" && c.status !== "archived") problems.push('status must be "active" or "archived"')
  if (!Array.isArray(c.order) || !c.order.every(id => typeof id === "string")) problems.push("order must be a list of scene ids")
  if (!isDate(c.created) || !isDate(c.updated)) problems.push("created and updated must be ISO dates")
  board(c.board, "board", problems)
  return problems.length ? { ok: false, problems } : { ok: true, value: input as SceneCollection }
}

const KEY_ORDER: readonly (keyof LabScene)[] = [
  "schema", "id", "collection", "kind", "title", "status", "summary", "author", "created", "updated", "games", "host",
  "choices", "extras", "settings", "seeds", "views", "view", "variants", "variant", "layout", "info", "note",
]

/** A scene as a repo file: fixed key order, two-space indent, trailing newline, so diffs stay small. */
export function sceneJson(scene: LabScene): string {
  const ordered: Record<string, unknown> = {}
  for (const k of KEY_ORDER) if (scene[k] !== undefined) ordered[k] = scene[k]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// ── share links ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A lab as a URL-safe string for `#lab=…`, so a draft can be shared without a server. */
export function encodeSceneLink(scene: LabScene): string {
  const bytes = new TextEncoder().encode(JSON.stringify(scene))
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Reads a shared link back as a draft in Drafts; the sender's collection and status don't carry over. */
export function decodeSceneLink(text: string, now: string): Checked<LabScene> {
  let parsed: unknown
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0))))
  } catch {
    return { ok: false, problems: ["link is not a scene"] }
  }
  const checked = checkScene(parsed)
  if (!checked.ok) return checked
  return { ok: true, value: { ...checked.value, collection: DRAFTS, status: "draft", updated: now } }
}
