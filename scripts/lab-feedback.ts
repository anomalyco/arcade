// Dev-server routes for the Lab Overworld (dev only; production builds and Workers never include them):
//   GET  /__arcade/lab/changes?paths=a,b&branches=x,y*   recent commits and unmerged branches for a station
//   POST /__arcade/lab/feedback                           a voice note bundle: saved locally, then posted to the team board
// Pages authenticate with the dev router's page token. The board token stays in this process and is never logged.
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { timingSafeEqual } from "node:crypto"
import { isAllowedLoopbackHost, isAllowedPageOrigin, isLoopbackAddress } from "./dev-control-server"

const run = promisify(execFile)
const ROUTE = /^(?:\/arcade\/[a-z0-9-]+)?\/__arcade\/lab\/(changes|feedback)$/
const MAX_BODY = 48 * 1024 * 1024
const ARTIFACTS = process.env.LAB_FEEDBACK_DIR ?? join(homedir(), "code/home/artifacts/lab-feedback")
const CACHE = join(homedir(), ".cache/arcade/lab-feedback-board.json")
const PROJECT = process.env.BOARD_PROJECT ?? "arcade"

type Segment = { t0: number; t1: number; text: string }
type Stroke = { option: string; t0: number; t1: number; pts: number[]; [key: string]: unknown }
type Payload = {
  version: 1
  station: { id: string; title: string; board?: { feature: string; decision?: string }; variants: { id: string; label: string; boardOption?: string }[] } | null
  variant: string | null
  startedAt: string
  durationMs: number
  audio: { type: string; base64: string } | null
  speech: string
  lang: string
  transcript: Segment[]
  strokes: Stroke[]
  stateLog: { start: { url: string; option: string | null; settings: Record<string, string> }; log: { t: number; kind: string; [key: string]: unknown }[] }
  state: Record<string, unknown>
  keyframes: { t: number; label: string; jpeg: string }[]
  contactSheet: string
  note: string
  send: boolean
  pageUrl: string
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

const sameToken = (expected: string, actual: unknown) => {
  if (typeof actual !== "string") return false
  const a = Buffer.from(expected), b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { fail(new Error("Feedback bundle too large")); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on("end", () => done(Buffer.concat(chunks)))
    req.on("error", fail)
  })
}

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }
const pad = (n: number) => String(n).padStart(2, "0")
/** Local time, as Kit reads it: 20261014-162900. */
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const audioExt = (type: string) => (type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm")
const titleCase = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase())

// ── board client ───────────────────────────────────────────────────────────────────────────────────────────────
type BoardCreds = { url: string; token: string }

function boardCreds(): BoardCreds | null {
  for (const path of [process.env.BOARD_LOCAL, join(homedir(), ".config/team-board/relay.json")]) {
    if (!path || !existsSync(path)) continue
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as { url?: string; token?: string }
      if (saved.url && saved.token) return { url: saved.url.replace(/\/$/, ""), token: saved.token }
    } catch { /* try the next file */ }
  }
  return null
}

type Cache = { agent?: string; decisions: Record<string, string> }
const loadCache = (): Cache => { try { return { decisions: {}, ...JSON.parse(readFileSync(CACHE, "utf8")) } } catch { return { decisions: {} } } }
const saveCache = (c: Cache) => { mkdirSync(join(CACHE, ".."), { recursive: true }); writeFileSync(CACHE, JSON.stringify(c, null, 2)) }

class Board {
  constructor(private readonly creds: BoardCreds) {}
  get origin() { return this.creds.url }
  private withProject(path: string) { return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(PROJECT)}` }
  async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.creds.url}${this.withProject(path)}`, { ...init, headers: { Authorization: `Bearer ${this.creds.token}`, "Content-Type": "application/json", ...init.headers } })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok) throw new Error(`${path}: ${body.error ?? res.status}`)
    return body as T
  }
  async media(data: Buffer, type: string, name: string): Promise<string> {
    return (await this.api<{ url: string }>("/api/media", { method: "POST", headers: { "Content-Type": type, "X-Filename": name }, body: new Uint8Array(data) })).url
  }
  async mcp(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.creds.url}${this.withProject("/mcp")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.creds.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    })
    const text = await res.text()
    const line = text.startsWith("{") ? text : text.split("\n").find(l => l.startsWith("data:"))?.slice(5)
    const msg = JSON.parse(line ?? "{}")
    const out = (msg.result?.content ?? []).map((c: { text: string }) => c.text).join("\n")
    if (msg.error || msg.result?.isError) throw new Error(`${tool}: ${msg.error?.message ?? out}`)
    return out
  }
}

async function agentName(board: Board, cache: Cache): Promise<string> {
  if (cache.agent) return cache.agent
  const out = await board.mcp("join", { session: "arcade-lab-feedback", task: "Files Kit's voice notes from the Lab Overworld stations" })
  const name = out.match(/name: ([^\s·]+)/)?.[1]
  if (!name) throw new Error("The board didn't return an agent name")
  cache.agent = name
  saveCache(cache)
  return name
}

/** The station's decision: pinned in its file, remembered from earlier notes, found by title, or asked for now. */
async function stationDecision(board: Board, station: NonNullable<Payload["station"]>, feature: string): Promise<string> {
  if (station.board?.decision) return station.board.decision
  const cache = loadCache()
  const key = `${PROJECT}:${feature}:${station.id}`
  if (cache.decisions[key]) return cache.decisions[key]!
  const title = `${titleCase(station.title)} Station`.slice(0, 40)
  const snapshot = await board.api<{ board: { decisions: { id: string; feature: string; title: string | null; status: string }[] } }>("/api/board")
  const found = snapshot.board.decisions.find(d => d.feature === feature && d.title === title && d.status !== "parked" && d.status !== "shipped")
  let id = found?.id
  if (!id) {
    const as = await agentName(board, cache)
    const options = station.variants.length ? station.variants.slice(0, 12).map(v => ({ name: v.label.slice(0, 60) })) : [{ name: "As it is now" }]
    const out = await board.mcp("decision_create", {
      as,
      feature,
      title,
      question: `Voice notes from the Lab Overworld's ${station.title} station. Options are its variants; each note is filed on the one that was showing.`.slice(0, 160),
      options,
      prototype: "none",
    })
    id = out.match(/Asked (D-\d+)/)?.[1]
    if (!id) throw new Error("The board didn't return a decision id")
  }
  cache.decisions[key] = id
  saveCache(cache)
  return id
}

/** Variant id → the decision's option letter. Pinned decisions use each variant's `boardOption`. */
function optionFor(station: NonNullable<Payload["station"]>, variant: string | null): string | null {
  if (!variant) return null
  const v = station.variants.find(x => x.id === variant)
  if (!v) return null
  if (station.board?.decision) return v.boardOption ?? null
  const i = station.variants.indexOf(v)
  return i >= 0 && i < 12 ? String.fromCharCode(65 + i) : null
}

// ── local bundle ───────────────────────────────────────────────────────────────────────────────────────────────
function summary(p: Payload, rev: string, extra: { board?: string; transcript?: Segment[]; transcriber?: string }) {
  const station = p.station?.title ?? "Overworld"
  const variant = p.station?.variants.find(v => v.id === p.variant)?.label
  const transcript = extra.transcript ?? p.transcript
  const lines = [
    `# Lab voice note · ${station}${variant ? ` · ${variant}` : ""}`,
    "",
    `- When: ${p.startedAt} (${clock(p.durationMs)})`,
    `- Page: ${p.pageUrl}`,
    `- Revision: ${rev}`,
    ...(extra.board ? [`- Board: ${extra.board}`] : []),
    ...(p.note ? ["", "## Typed note", "", p.note] : []),
    "",
    `## Transcript${extra.transcriber ? ` (${extra.transcriber})` : p.transcript.length ? " (browser)" : ""}`,
    "",
    ...(transcript.length ? transcript.map(s => `- ${clock(s.t0)} ${s.text}`) : ["Not transcribed yet. The board transcribes the recording with Whisper; transcript.md appears here when it's done."]),
    "",
    "## Timeline",
    "",
    ...[
      ...p.strokes.map((s, i) => {
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0
        for (let j = 0; j < s.pts.length; j += 3) { const x = s.pts[j]! / 1e4, y = s.pts[j + 1]! / 1e4; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
        return { t: s.t0, text: `✎ mark ${i + 1} on ${s.option}: x ${x0.toFixed(2)}–${x1.toFixed(2)}, y ${y0.toFixed(2)}–${y1.toFixed(2)}` }
      }),
      ...p.stateLog.log.map(e => ({ t: e.t, text: e.kind === "option" ? `variant → ${String(e.option)}` : `${String(e.key)} → ${String(e.value)}` })),
      ...p.keyframes.map((f, i) => ({ t: f.t, text: `frame ${String(i + 1).padStart(2, "0")} (${f.label})` })),
    ].sort((a, b) => a.t - b.t).map(e => `- ${clock(e.t)} ${e.text}`),
    "",
    "## Files",
    "",
    "- contact-sheet.png: the keyframes with marks",
    "- frames/: each keyframe",
    "- state.json: station, variant, preset JSON, seeds, camera and transport when the note started",
    "- feedback.json: strokes (normalised 0–10000, ms), transcript and state log as sent to the board",
    `- audio.${audioExt(p.audio?.type ?? "")}: the recording`,
  ]
  return lines.join("\n") + "\n"
}

export function createLabFeedback(opts: { root: string; pageToken: string; pageHosts: readonly string[] }) {
  const changeCache = new Map<string, { at: number; body: unknown }>()

  const git = async (...args: string[]) => (await run("git", args, { cwd: opts.root, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()

  async function changes(url: URL) {
    const paths = (url.searchParams.get("paths") ?? "").split(",").map(p => p.trim()).filter(p => p && !p.includes("..") && !p.startsWith("/")).slice(0, 12)
    const patterns = (url.searchParams.get("branches") ?? "").split(",").map(p => p.trim()).filter(p => /^[\w./*-]+$/.test(p)).slice(0, 12)
    const key = `${paths.join(",")}|${patterns.join(",")}`
    const hit = changeCache.get(key)
    if (hit && Date.now() - hit.at < 30_000) return hit.body
    const commits = paths.length
      ? (await git("log", "-n", "5", "--format=%h%x09%s%x09%cr", "--", ...paths).catch(() => "")).split("\n").filter(Boolean).map(l => { const [sha, subject, when] = l.split("\t"); return { sha, subject, when } })
      : []
    const branches: { name: string; ahead: number; subject: string; when: string }[] = []
    if (patterns.length) {
      const refs = (await git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:relative)%09%(subject)", "refs/heads").catch(() => "")).split("\n").filter(Boolean)
      const match = (name: string) => patterns.some(p => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p))
      for (const line of refs) {
        const [name, when, subject] = line.split("\t") as [string, string, string]
        if (!match(name)) continue
        const ahead = Number(await git("rev-list", "--count", `origin/main..${name}`).catch(() => "0"))
        if (ahead > 0) branches.push({ name, ahead, subject, when })
        if (branches.length >= 4) break
      }
    }
    const body = { commits, branches }
    changeCache.set(key, { at: Date.now(), body })
    return body
  }

  async function feedback(p: Payload) {
    const started = new Date(p.startedAt || Date.now())
    const stationId = (p.station?.id ?? "overworld").replace(/[^a-z0-9-]/g, "")
    const dir = join(ARTIFACTS, `${stamp(started)}-${stationId}`)
    mkdirSync(join(dir, "frames"), { recursive: true })
    const rev = await git("rev-parse", "--short", "HEAD").catch(() => "unknown")
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => "")
    const audio = p.audio ? Buffer.from(p.audio.base64, "base64") : null
    const sheet = p.contactSheet ? Buffer.from(p.contactSheet, "base64") : null
    if (audio) writeFileSync(join(dir, `audio.${audioExt(p.audio!.type)}`), audio)
    if (sheet) writeFileSync(join(dir, "contact-sheet.png"), sheet)
    p.keyframes.forEach((f, i) => writeFileSync(join(dir, "frames", `frame-${String(i + 1).padStart(2, "0")}.jpg`), Buffer.from(f.jpeg, "base64")))
    writeFileSync(join(dir, "state.json"), JSON.stringify({ station: p.station, variant: p.variant, startedAt: p.startedAt, durationMs: p.durationMs, pageUrl: p.pageUrl, rev, branch, state: p.state }, null, 2))
    writeFileSync(join(dir, "feedback.json"), JSON.stringify({ speech: p.speech, lang: p.lang, transcript: p.transcript, strokes: p.strokes, stateLog: p.stateLog, note: p.note, keyframes: p.keyframes.map(f => ({ t: f.t, label: f.label })) }, null, 2))
    writeFileSync(join(dir, "summary.md"), summary(p, rev, {}))

    if (!p.send) return { ok: true, dir }
    const creds = boardCreds()
    if (!creds) return { ok: true, dir, board: { error: "No board credentials (set BOARD_LOCAL or ~/.config/team-board/relay.json)" } }
    const board = new Board(creds)
    const station = p.station ?? { id: "overworld", title: "Lab Overworld", board: { feature: "AR-21" }, variants: [] }
    const feature = station.board?.feature ?? "AR-21"
    try {
      const decision = await stationDecision(board, station, feature)
      const option = optionFor(station, p.variant)
      const letters = new Map(station.variants.map(v => [v.id, optionFor(station, v.id)]))
      const strokes = p.strokes.map(s => ({ ...s, option: letters.get(s.option) ?? (/^[\w.-]{1,24}$/.test(s.option) ? s.option : "A") }))
      const letter = (id: string | null) => (id ? letters.get(id) ?? id : null)
      const stateLog = {
        start: { ...p.stateLog.start, option: letter(p.stateLog.start.option) },
        log: p.stateLog.log.map(e => (e.kind === "option" ? { ...e, option: letter(String(e.option)) } : e)),
      }
      const audioUrl = audio ? await board.media(audio, p.audio!.type, `lab-${stationId}.${audioExt(p.audio!.type)}`) : null
      const sheetUrl = sheet ? await board.media(sheet, "image/png", `lab-${stationId}-contact-sheet.png`) : null
      const variantLabel = station.variants.find(v => v.id === p.variant)?.label
      const title = `Voice note · ${station.title}${variantLabel ? ` · ${variantLabel}` : ""}`
      let attachment: unknown = null
      if (audioUrl) {
        attachment = await board.api(`/api/decisions/${decision}/feedback`, {
          method: "POST",
          body: JSON.stringify({
            option,
            url: audioUrl,
            title,
            annotation: {
              duration: p.durationMs,
              speech: p.speech,
              lang: p.lang,
              transcript: p.transcript,
              ...(p.note ? { note: p.note } : {}),
              strokes,
              source: { url: p.pageUrl, rev },
              state: stateLog,
            },
          }),
        })
      } else {
        await board.api(`/api/features/${feature}/comments`, { method: "POST", body: JSON.stringify({ text: `${title} (no audio)${p.note ? `: ${p.note}` : ""}`, ref: { decision, option } }) })
      }
      if (sheetUrl) await board.api(`/api/features/${feature}/attachments`, { method: "POST", body: JSON.stringify({ title: `Contact sheet · ${station.title}${variantLabel ? ` · ${variantLabel}` : ""}`, url: sheetUrl, kind: "image", ref: { decision, option } }) })
      const sent = await board.api<{ summary?: string; delivery?: { id: string } }>("/api/deliveries", { method: "POST", body: JSON.stringify({ decision }) })
      const link = `${board.origin}/?open=${feature}&project=${PROJECT}`
      const result = { feature, decision, option, url: link, audio: audioUrl, contactSheet: sheetUrl, sent: true, delivery: sent.delivery?.id ?? null }
      writeFileSync(join(dir, "board.json"), JSON.stringify({ ...result, attachment }, null, 2))
      writeFileSync(join(dir, "summary.md"), summary(p, rev, { board: `${feature} · ${decision}${option ? ` option ${option}` : ""} · ${link}` }))
      if (audioUrl && !p.transcript.length) void awaitTranscript(board, decision, audioUrl, dir, p, rev, `${feature} · ${decision} · ${link}`)
      return { ok: true, dir, board: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeFileSync(join(dir, "board-error.txt"), `${message}\n`)
      return { ok: true, dir, board: { error: message } }
    }
  }

  /** Whisper runs on the board after the upload; copy its transcript next to the bundle when it lands. */
  async function awaitTranscript(board: Board, decision: string, audioUrl: string, dir: string, p: Payload, rev: string, boardLine: string) {
    for (let i = 0; i < 36; i++) {
      await new Promise(done => setTimeout(done, 5000))
      try {
        const view = await board.api<{ feedback: { url?: string; annotation?: { asr?: string; transcript?: Segment[] } }[] }>(`/api/decisions/${decision}`)
        const item = view.feedback.find(f => f.url === audioUrl)
        const asr = item?.annotation?.asr
        if (asr === "failed") { writeFileSync(join(dir, "transcript.md"), "The board couldn't transcribe this recording.\n"); return }
        if (asr === "done") {
          const segments = item?.annotation?.transcript ?? []
          writeFileSync(join(dir, "transcript.md"), segments.length ? segments.map(s => `${clock(s.t0)} ${s.text}`).join("\n") + "\n" : "(no speech detected)\n")
          writeFileSync(join(dir, "summary.md"), summary(p, rev, { board: boardLine, transcript: segments, transcriber: "Whisper on the board" }))
          return
        }
      } catch { /* try again */ }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const route = url.pathname.match(ROUTE)?.[1]
    if (!route) return false
    let hostname = ""
    try { hostname = new URL(`http://${req.headers.host ?? ""}`).hostname.toLowerCase() } catch { /* rejected below */ }
    const hostOk = isAllowedLoopbackHost(hostname) || opts.pageHosts.includes(hostname)
    const origin = req.headers.origin
    const site = String(req.headers["sec-fetch-site"] ?? "")
    const originOk = origin ? isAllowedPageOrigin(origin, req.headers.host, opts.pageHosts) : req.method === "GET" && (site === "" || site === "same-origin")
    if (!isLoopbackAddress(req.socket.remoteAddress) || !hostOk || !originOk) { json(res, 403, { error: "Lab feedback is only for pages served by this dev server." }); return true }
    if (!sameToken(opts.pageToken, req.headers["x-arcade-page-token"])) { json(res, 403, { error: "Missing or stale page token; reload the page." }); return true }
    try {
      if (route === "changes" && req.method === "GET") { json(res, 200, await changes(url)); return true }
      if (route === "feedback" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)).toString("utf8")) as Payload
        if (payload?.version !== 1) { json(res, 400, { error: "Unknown feedback bundle version" }); return true }
        const result = await feedback(payload)
        console.log(`[lab feedback] ${result.dir}${result.board && "decision" in result.board ? ` → ${result.board.feature} ${result.board.decision}` : result.board && "error" in result.board ? ` (board: ${result.board.error})` : ""}`)
        json(res, 200, result)
        return true
      }
      json(res, 405, { error: `${req.method} not allowed` })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  return { handle }
}
