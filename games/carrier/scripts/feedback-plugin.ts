// Dev-server-only feedback store for the ship viewer (ship.html).
//
//   GET    /__feedback/ship            open notes as { notes }; ?all=1 includes resolved; ?format=md returns ship.md
//   POST   /__feedback/ship            add a note (NoteInput JSON, shot = PNG data URL) -> 201 { note }
//                                      or { op: "resolve", id, by?, reply? } to resolve
//   DELETE /__feedback/ship?id=X       resolve (history kept); &by=agent&reply=text; &purge=1 erases it entirely
//
// History is the append-only feedback/ship.jsonl ({ op: "add", ...note } and { op: "resolve", id, at, by, reply }),
// screenshots go to feedback/shots/<id>.png, and feedback/ship.md is regenerated after every change. Every request is
// isolated: bad input gets a 4xx, nothing throws into the dev server.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import type { Plugin } from "vite"
import { makeId, renderMarkdown, type CameraPose, type Note, type NoteInput, type Resolution, type Vec3 } from "../src/dev/feedback"

const ROUTE = "/__feedback/ship"
const MAX_BODY = 64 * 1024 * 1024
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

type Line = ({ op: "add" } & Note) | ({ op: "resolve"; id: string } & Resolution)

class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export function feedbackPlugin(opts: { dir?: string } = {}): Plugin {
  let root = process.cwd()
  const paths = () => {
    const dir = opts.dir ?? join(root, "feedback")
    return { dir, jsonl: join(dir, "ship.jsonl"), md: join(dir, "ship.md"), shots: join(dir, "shots") }
  }
  // Serialise every mutation so concurrent requests cannot interleave appends and the summary.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => T): Promise<T> => {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }

  function readLines(): Line[] {
    const { jsonl } = paths()
    if (!existsSync(jsonl)) return []
    const out: Line[] = []
    for (const raw of readFileSync(jsonl, "utf8").split("\n")) {
      if (!raw.trim()) continue
      try {
        out.push(JSON.parse(raw) as Line)
      } catch {
        // A hand-edited or truncated line: skip it rather than lose the rest.
      }
    }
    return out
  }

  function replay(lines: Line[]): Note[] {
    const notes = new Map<string, Note>()
    for (const l of lines) {
      if (l.op === "add") {
        const { op: _op, ...note } = l
        notes.set(l.id, { ...note, resolved: null })
      } else if (l.op === "resolve") {
        const n = notes.get(l.id)
        if (n) n.resolved = { at: l.at, by: l.by, reply: l.reply }
      }
    }
    return [...notes.values()]
  }

  function writeSummary(notes: Note[]): void {
    const { dir, md } = paths()
    mkdirSync(dir, { recursive: true })
    writeFileSync(md, renderMarkdown(notes))
  }

  function append(line: Line): void {
    const { dir, jsonl } = paths()
    mkdirSync(dir, { recursive: true })
    appendFileSync(jsonl, `${JSON.stringify(line)}\n`)
  }

  function addNote(input: NoteInput): Note {
    const lines = readLines()
    const n = lines.reduce((m, l) => (l.op === "add" && l.n > m ? l.n : m), 0) + 1
    const id = makeId(n)
    let shot: string | null = null
    if (input.shot) {
      const png = decodePng(input.shot)
      const { shots } = paths()
      mkdirSync(shots, { recursive: true })
      writeFileSync(join(shots, `${id}.png`), png)
      shot = `feedback/shots/${id}.png`
    }
    const note: Note = { ...input, id, n, at: new Date().toISOString(), shot, resolved: null }
    append({ op: "add", ...note })
    writeSummary(replay([...lines, { op: "add", ...note }]))
    return note
  }

  function resolveNote(id: string, by: string, reply: string): Note {
    const notes = replay(readLines())
    const note = notes.find((n) => n.id === id)
    if (!note) throw new BadRequest(`no note ${id}`, 404)
    if (!note.resolved) {
      const res: Resolution = { at: new Date().toISOString(), by: by.slice(0, 40) || "designer", reply: reply.slice(0, 2000) }
      append({ op: "resolve", id, ...res })
      note.resolved = res
    }
    writeSummary(notes)
    return note
  }

  function purgeNote(id: string): void {
    const { jsonl, shots } = paths()
    const lines = readLines()
    if (!lines.some((l) => l.id === id)) throw new BadRequest(`no note ${id}`, 404)
    const keep = lines.filter((l) => l.id !== id)
    writeFileSync(jsonl, keep.map((l) => `${JSON.stringify(l)}\n`).join(""))
    if (/^[\w-]+$/.test(id)) rmSync(join(shots, `${id}.png`), { force: true })
    writeSummary(replay(keep))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local")
    if (req.method === "GET") {
      const notes = replay(readLines())
      if (url.searchParams.get("format") === "md") return send(res, 200, renderMarkdown(notes), "text/markdown; charset=utf-8")
      const all = url.searchParams.has("all")
      return json(res, 200, { notes: all ? notes : notes.filter((n) => !n.resolved) })
    }
    if (req.method === "POST") {
      const body = await readJson(req)
      if (body.op === "resolve") {
        const note = await serial(() => resolveNote(str(body.id, "id"), optStr(body.by, "agent"), optStr(body.reply, "")))
        return json(res, 200, { note })
      }
      const input = parseInput(body)
      const note = await serial(() => addNote(input))
      return json(res, 201, { note })
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id")
      if (!id) throw new BadRequest("id required")
      if (url.searchParams.has("purge")) {
        await serial(() => purgeNote(id))
        return json(res, 200, { purged: id })
      }
      const note = await serial(() => resolveNote(id, url.searchParams.get("by") ?? "designer", url.searchParams.get("reply") ?? ""))
      return json(res, 200, { note })
    }
    throw new BadRequest("method not allowed", 405)
  }

  return {
    name: "carrier-feedback",
    apply: "serve",
    config() {
      // Screenshots and the log are written while the page is open; they are not source.
      return { server: { watch: { ignored: ["**/feedback/**"] } } }
    },
    configResolved(config) {
      root = config.root
    },
    configureServer(server) {
      try {
        writeSummary(replay(readLines()))
      } catch (e) {
        server.config.logger.warn(`[feedback] could not write ship.md: ${String(e)}`)
      }
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]
        if (path !== ROUTE) return next()
        handle(req, res).catch((e: unknown) => {
          const status = e instanceof BadRequest ? e.status : 500
          if (status === 500) server.config.logger.error(`[feedback] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
          if (!res.headersSent) json(res, status, { error: e instanceof Error ? e.message : String(e) })
          else res.end()
        })
      })
    },
  }
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status
  res.setHeader("content-type", type)
  res.setHeader("cache-control", "no-store")
  res.end(body)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), "application/json")
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on("data", (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY) {
        failed = true
        chunks.length = 0
        reject(new BadRequest(`body over ${MAX_BODY >> 20} MB`, 413))
        return
      }
      chunks.push(c)
    })
    req.on("error", (e) => {
      if (!failed) reject(new BadRequest(`read failed: ${e.message}`))
      failed = true
    })
    req.on("end", () => {
      if (failed) return
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object")
        resolve(v as Record<string, unknown>)
      } catch (e) {
        reject(new BadRequest(`bad JSON: ${e instanceof Error ? e.message : String(e)}`))
      }
    })
  })
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new BadRequest(`${name} must be a string`)
  return v
}
const optStr = (v: unknown, d: string): string => (typeof v === "string" ? v : d)
const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`${name} must be a finite number`)
  return v
}
const vec3 = (v: unknown, name: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3) throw new BadRequest(`${name} must be [x, y, z]`)
  return [num(v[0], name), num(v[1], name), num(v[2], name)]
}
const optVec3 = (v: unknown, name: string): Vec3 | null => (v === null || v === undefined ? null : vec3(v, name))
const optText = (v: unknown, name: string, max: number): string | null => {
  if (v === null || v === undefined) return null
  return str(v, name).slice(0, max)
}

function parseInput(b: Record<string, unknown>): NoteInput {
  const c = b.camera
  if (!c || typeof c !== "object") throw new BadRequest("camera required")
  const cam = c as Record<string, unknown>
  const camera: CameraPose = {
    target: vec3(cam.target, "camera.target"),
    yaw: num(cam.yaw, "camera.yaw"),
    pitch: num(cam.pitch, "camera.pitch"),
    dist: num(cam.dist, "camera.dist"),
    ortho: cam.ortho === true,
    preset: optText(cam.preset, "camera.preset", 40),
  }
  const text = str(b.text, "text").slice(0, 8000)
  const shot = optText(b.shot, "shot", MAX_BODY)
  return {
    text,
    point: optVec3(b.point, "point"),
    normal: optVec3(b.normal, "normal"),
    part: optText(b.part, "part", 200),
    camera,
    reference: optText(b.reference, "reference", 200),
    env: b.env === "sea" ? "sea" : "studio",
    mode: optText(b.mode, "mode", 20),
    shot,
  }
}

function decodePng(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,/.exec(dataUrl)
  if (!m) throw new BadRequest("shot must be a PNG data URL")
  const buf = Buffer.from(dataUrl.slice(m[0].length), "base64")
  if (buf.length < PNG_SIG.length || PNG_SIG.some((b, i) => buf[i] !== b)) throw new BadRequest("shot is not a PNG")
  return buf
}
