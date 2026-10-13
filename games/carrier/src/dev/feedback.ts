// Ship viewer feedback: note types, the Markdown summary agents read, and a client store that talks to the dev server
// plugin (scripts/feedback-plugin.ts) or falls back to localStorage in production builds. Pure module scope: the plugin
// imports renderMarkdown on the server, so nothing here may touch the DOM until a store is opened.

export type Vec3 = [number, number, number]

/** Orbit camera pose. Yaw 0 = camera off the bow looking aft, 90 = off the port (+X) side; degrees. */
export type CameraPose = {
  target: Vec3
  yaw: number
  pitch: number
  dist: number
  ortho: boolean
  preset: string | null
}

export type NoteInput = {
  text: string
  /** Ship-local metres (+Z bow, +X port, −X starboard, +Y up, origin at the waterline mid-length), or null for a general note. */
  point: Vec3 | null
  /** Surface normal at the pin, for dimming pins on the far side. */
  normal: Vec3 | null
  /** Best guess at the part under the pin, e.g. "hull · island" or "vehicle · jet". */
  part: string | null
  camera: CameraPose
  /** Concept image file name shown at the time, if any. */
  reference: string | null
  env: "studio" | "sea"
  /** Which carriers the viewer showed: "procedural", "blender" or "side" (absent on older notes). */
  mode?: string | null
  /** PNG data URL of the canvas with pins drawn. */
  shot: string | null
}

export type Resolution = { at: string; by: string; reply: string }

export type Note = Omit<NoteInput, "shot"> & {
  id: string
  /** Pin number, stable for the life of the note. */
  n: number
  at: string
  /** Server: path relative to games/carrier (feedback/shots/<id>.png). Local fallback: a small JPEG data URL. */
  shot: string | null
  resolved: Resolution | null
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
export const fmtPoint = (p: Vec3) => `x ${f1(p[0])}, y ${f1(p[1])}, z ${f1(p[2])}`
export const fmtCamera = (c: CameraPose) =>
  `${c.preset ?? "free"}${c.ortho ? " (ortho)" : ""} · yaw ${Math.round(c.yaw)}°, pitch ${Math.round(c.pitch)}°, dist ${Math.round(c.dist)} m, target ${fmtPoint(c.target)}`

function noteBlock(n: Note, shots: boolean): string {
  const lines = [`### #${n.n} · ${n.part ?? (n.point ? "ship" : "general")}`, "", n.text.trim() || "(empty)", ""]
  lines.push(`- id: \`${n.id}\` · ${n.at}`)
  if (n.point)
    lines.push(
      n.part?.startsWith("hornet")
        ? `- pin: ${fmtPoint(n.point)} (art/hornet.glb frame, m; +Z nose, +X pilot's left (port), +Y up, y 0 = lowest belly point)`
        : `- pin: ${fmtPoint(n.point)} (ship-local m; +Z bow, +X port, −X starboard, +Y up, y 0 = waterline)`,
    )
  lines.push(`- camera: ${fmtCamera(n.camera)} · env ${n.env}${n.mode ? ` · showing ${n.mode}` : ""}`)
  if (n.reference) lines.push(`- reference: concept/${n.reference}`)
  if (shots && n.shot && !n.shot.startsWith("data:")) lines.push(`- screenshot: ${n.shot}`)
  if (n.resolved) lines.push(`- resolved ${n.resolved.at} by ${n.resolved.by}${n.resolved.reply ? `: ${n.resolved.reply}` : ""}`)
  return lines.join("\n")
}

/** The human and agent readable summary: open notes first (oldest first), then the most recent resolved ones. */
export function renderMarkdown(notes: Note[], opts: { resolvedLimit?: number; shots?: boolean } = {}): string {
  const open = notes.filter((n) => !n.resolved).sort((a, b) => a.n - b.n)
  const done = notes
    .filter((n) => n.resolved)
    .sort((a, b) => (b.resolved!.at < a.resolved!.at ? -1 : 1))
    .slice(0, opts.resolvedLimit ?? 40)
  const shots = opts.shots ?? true
  const out = [
    "# Ship feedback",
    "",
    "Notes the designer left in the ship viewer (`ship.html`). Generated from `feedback/ship.jsonl`; do not edit by hand.",
    "Paths are relative to `games/carrier/`. Pin coordinates are ship-local metres of the carrier named first in the part",
    "(`procedural` = `buildCarrier()`, `blender` = `art/carrier.glb`, `hornet` = `art/hornet.glb`), whatever the viewer layout was.",
    "A part like `procedural · hornet · body` is the Hornet parked on that carrier (point in the carrier's frame).",
    "",
    "When a note is addressed, resolve it (kept in history) with:",
    "`curl -X DELETE 'http://localhost:5197/__feedback/ship?id=<id>&by=agent&reply=<what+changed>'`",
    "",
    `## Open (${open.length})`,
    "",
  ]
  if (!open.length) out.push("Nothing open.", "")
  for (const n of open) out.push(noteBlock(n, shots), "")
  if (done.length) {
    out.push(`## Resolved (latest ${done.length})`, "")
    for (const n of done) out.push(noteBlock(n, shots), "")
  }
  return out.join("\n")
}

export interface FeedbackStore {
  readonly kind: "server" | "local"
  list(all: boolean): Promise<Note[]>
  add(input: NoteInput): Promise<Note>
  resolve(id: string, reply: string): Promise<void>
  /** Erases a note entirely (a misclick), unlike resolve which keeps it in history. */
  remove(id: string): Promise<void>
  /** Everything as Markdown plus JSON, for the "copy all" button. */
  exportText(): Promise<string>
  /** URL for a note's screenshot, or null. */
  shotUrl(n: Note): string | null
}

class ServerStore implements FeedbackStore {
  readonly kind = "server"
  constructor(
    private url: string,
    private root: string,
  ) {}

  async list(all: boolean): Promise<Note[]> {
    const r = await fetch(`${this.url}${all ? "?all=1" : ""}`)
    if (!r.ok) throw new Error(`feedback list ${r.status}`)
    return ((await r.json()) as { notes: Note[] }).notes
  }

  async add(input: NoteInput): Promise<Note> {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
    if (!r.ok) throw new Error(`feedback save ${r.status}: ${await r.text()}`)
    return ((await r.json()) as { note: Note }).note
  }

  async resolve(id: string, reply: string): Promise<void> {
    const q = new URLSearchParams({ id, by: "designer", reply })
    const r = await fetch(`${this.url}?${q}`, { method: "DELETE" })
    if (!r.ok) throw new Error(`feedback resolve ${r.status}`)
  }

  async remove(id: string): Promise<void> {
    const r = await fetch(`${this.url}?${new URLSearchParams({ id, purge: "1" })}`, { method: "DELETE" })
    if (!r.ok) throw new Error(`feedback delete ${r.status}`)
  }

  async exportText(): Promise<string> {
    const notes = await this.list(true)
    return `${renderMarkdown(notes)}\n\n\`\`\`json\n${JSON.stringify(notes, null, 2)}\n\`\`\`\n`
  }

  shotUrl(n: Note): string | null {
    return n.shot ? `${this.root}${n.shot}` : null
  }
}

const LOCAL_KEY = "carrier.ship-feedback.v1"

/** Production fallback: notes in localStorage, screenshots shrunk to small JPEGs (dropped if storage is full). */
class LocalStore implements FeedbackStore {
  readonly kind = "local"

  private read(): Note[] {
    try {
      const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]") as unknown
      return Array.isArray(v) ? (v as Note[]) : []
    } catch {
      return []
    }
  }

  private write(notes: Note[]): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(notes))
    } catch {
      // Over quota: keep the text, drop the oldest screenshots first.
      for (const n of notes) {
        if (!n.shot) continue
        n.shot = null
        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(notes))
          return
        } catch {
          continue
        }
      }
    }
  }

  async list(all: boolean): Promise<Note[]> {
    const notes = this.read()
    return all ? notes : notes.filter((n) => !n.resolved)
  }

  async add(input: NoteInput): Promise<Note> {
    const notes = this.read()
    const n = notes.reduce((m, x) => Math.max(m, x.n), 0) + 1
    const shot = input.shot ? await shrink(input.shot, 640) : null
    const note: Note = { ...input, id: makeId(n), n, at: new Date().toISOString(), shot, resolved: null }
    notes.push(note)
    this.write(notes)
    return note
  }

  async resolve(id: string, reply: string): Promise<void> {
    const notes = this.read()
    const n = notes.find((x) => x.id === id)
    if (n) n.resolved = { at: new Date().toISOString(), by: "designer", reply }
    this.write(notes)
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((x) => x.id !== id))
  }

  async exportText(): Promise<string> {
    const notes = this.read()
    const bare = notes.map((n) => ({ ...n, shot: null }))
    return `${renderMarkdown(bare, { shots: false })}\n\n\`\`\`json\n${JSON.stringify(bare, null, 2)}\n\`\`\`\n`
  }

  shotUrl(n: Note): string | null {
    return n.shot
  }
}

export function makeId(n: number): string {
  return `s${String(n).padStart(3, "0")}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`
}

async function shrink(dataUrl: string, width: number): Promise<string | null> {
  try {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const s = Math.min(1, width / img.naturalWidth)
    const c = document.createElement("canvas")
    c.width = Math.round(img.naturalWidth * s)
    c.height = Math.round(img.naturalHeight * s)
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL("image/jpeg", 0.7)
  } catch {
    return null
  }
}

/**
 * Uses the dev server endpoint when it answers with JSON, else localStorage. `base` is the page's directory URL, so
 * the same code works at / in dev and /arcade/carrier/ in production.
 */
export async function openFeedback(base: string): Promise<FeedbackStore> {
  const url = new URL("__feedback/ship", base).href
  try {
    const r = await fetch(url)
    if (r.ok && (r.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await r.json()) as { notes?: unknown }
      if (Array.isArray(body.notes)) return new ServerStore(url, base)
    }
  } catch {
    // No plugin: production or a static preview.
  }
  return new LocalStore()
}
