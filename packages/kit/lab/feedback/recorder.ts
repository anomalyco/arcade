// Voice notes with marks, like Scrawl: N starts the mic, hold Shift and move to draw, N again to review and send.
// Dev only: the Lab loads this module when the dev router is present, and the dev server posts the bundle to the board.
import type { StationEvent, StationSnapshot } from "../stations/types"
import "./style.css"

const SCALE = 10000
const MAX_MS = 10 * 60_000
const MAX_FRAMES = 10
const INK = "#ff3b30"

export type FeedbackStroke = { option: string; t0: number; t1: number; mode: "desktop"; vw: number; vh: number; fw: number; fh: number; on?: string; pts: number[] }
export type FeedbackSegment = { t0: number; t1: number; text: string }
export type FeedbackEvent =
  | { t: number; kind: "option"; option: string }
  | { t: number; kind: "setting"; key: string; value: string }
export type FeedbackKeyframe = { t: number; label: string; jpeg: string }

/** What the Lab sends the dev server. Images and audio travel as base64. */
export type FeedbackPayload = {
  version: 1
  station: { id: string; title: string; board?: { feature: string; decision?: string }; variants: { id: string; label: string; boardOption?: string }[] } | null
  variant: string | null
  startedAt: string
  durationMs: number
  audio: { type: string; base64: string } | null
  speech: string
  lang: string
  transcript: FeedbackSegment[]
  strokes: FeedbackStroke[]
  stateLog: { start: { url: string; option: string | null; settings: Record<string, string> }; log: FeedbackEvent[] }
  state: Record<string, unknown>
  keyframes: FeedbackKeyframe[]
  contactSheet: string
  note: string
  send: boolean
  pageUrl: string
}

export type FeedbackResult = { ok?: boolean; error?: string; dir?: string; board?: { feature?: string; decision?: string; url?: string; error?: string; sent?: boolean } }

/** The open station, as the recorder sees it: what's showing, its changes, and a place to say things. */
export type StationFeed = {
  snapshot(): StationSnapshot
  on(listener: (e: StationEvent) => void): () => void
  say(text: string, error?: boolean): void
}

type RecorderOptions = {
  viewport: HTMLElement
  canvas: HTMLCanvasElement
  capture(target: HTMLCanvasElement): Promise<void>
  stations: StationFeed
  state(): Record<string, unknown>
  submit(payload: FeedbackPayload): Promise<FeedbackResult>
  isBusy(): boolean
}

type SpeechRecognitionLike = {
  continuous: boolean; interimResults: boolean; lang: string
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void
}

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }
const base64Of = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let out = ""
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}
const stripDataUrl = (url: string) => url.slice(url.indexOf(",") + 1)
const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly FeedbackStroke[], w: number, h: number) {
  ctx.save()
  ctx.strokeStyle = INK
  ctx.lineWidth = Math.max(3, w / 320)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  for (const s of strokes) {
    ctx.beginPath()
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = (s.pts[i]! / SCALE) * w, y = (s.pts[i + 1]! / SCALE) * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    if (s.pts.length === 3) ctx.lineTo((s.pts[0]! / SCALE) * w + 0.1, (s.pts[1]! / SCALE) * h)
    ctx.stroke()
  }
  ctx.restore()
}

export function createFeedbackRecorder(opts: RecorderOptions) {
  const { viewport, stations } = opts
  let session: {
    start: number
    startedAt: string
    recorder: MediaRecorder
    stream: MediaStream
    chunks: Blob[]
    speech: string
    recognition: SpeechRecognitionLike | null
    transcript: FeedbackSegment[]
    strokes: FeedbackStroke[]
    log: FeedbackEvent[]
    keyframes: FeedbackKeyframe[]
    startState: FeedbackPayload["stateLog"]["start"]
    station: StationSnapshot["station"]
    variant: string | null
    off: () => void
    timer: number
  } | null = null
  let reviewing = false

  const ink = document.createElement("canvas")
  ink.className = "fb-ink"
  viewport.append(ink)
  const pill = document.createElement("div")
  pill.className = "fb-pill"
  pill.hidden = true
  viewport.append(pill)
  const ictx = ink.getContext("2d")!

  let pointer: { x: number; y: number } | null = null
  let drawing: { stroke: FeedbackStroke; start: number } | null = null
  let shift = false

  const rect = () => viewport.getBoundingClientRect()
  const now = () => (session ? Math.round(performance.now() - session.start) : 0)
  const option = () => session?.variant ?? stations.snapshot().variant?.id ?? "current"

  function sizeInk() {
    const r = rect(), dpr = Math.min(2, devicePixelRatio || 1)
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr)
    if (ink.width !== w || ink.height !== h) { ink.width = w; ink.height = h }
  }
  function redraw() {
    sizeInk()
    ictx.clearRect(0, 0, ink.width, ink.height)
    if (!session) return
    drawStrokes(ictx, drawing ? [...session.strokes, drawing.stroke] : session.strokes, ink.width, ink.height)
  }

  function addPoint(clientX: number, clientY: number) {
    if (!drawing) return
    const r = rect()
    const x = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * SCALE)
    const y = Math.round(Math.min(1, Math.max(0, (clientY - r.top) / r.height)) * SCALE)
    const pts = drawing.stroke.pts, n = pts.length
    if (n >= 3 && Math.abs(pts[n - 3]! - x) < 8 && Math.abs(pts[n - 2]! - y) < 8) return
    if (n / 3 >= 2000) return
    pts.push(x, y, Math.round(performance.now() - drawing.start))
    redraw()
  }
  function beginStroke() {
    if (!session || drawing || !pointer) return
    const r = rect()
    const t = now()
    drawing = { start: performance.now(), stroke: { option: option(), t0: t, t1: t, mode: "desktop", vw: innerWidth, vh: innerHeight, fw: Math.round(r.width), fh: Math.round(r.height), pts: [] } }
    addPoint(pointer.x, pointer.y)
  }
  function endStroke() {
    if (!session || !drawing) return
    const s = drawing.stroke
    drawing = null
    s.t1 = now()
    if (s.pts.length >= 3 && session.strokes.length < 300) {
      session.strokes.push(s)
      scheduleFrame(`mark ${session.strokes.length}`, 250)
    }
    redraw()
  }

  window.addEventListener("pointermove", e => {
    pointer = { x: e.clientX, y: e.clientY }
    if (!session) return
    if (e.shiftKey && !drawing && !reviewing) beginStroke()
    if (drawing) addPoint(e.clientX, e.clientY)
  }, { capture: true })

  // ── keyframes ────────────────────────────────────────────────────────────────────────────────────────────────
  let frameTimer = 0
  function scheduleFrame(label: string, delay: number) {
    clearTimeout(frameTimer)
    frameTimer = window.setTimeout(() => void grabFrame(label), delay)
  }
  async function grabFrame(label: string) {
    if (!session) return
    const s = session
    const t = now()
    const shot = document.createElement("canvas")
    await opts.capture(shot)
    if (!shot.width || !shot.height) return
    const scale = Math.min(1, 1280 / shot.width)
    const out = document.createElement("canvas")
    out.width = Math.round(shot.width * scale); out.height = Math.round(shot.height * scale)
    const c = out.getContext("2d")!
    c.drawImage(shot, 0, 0, out.width, out.height)
    drawStrokes(c, s.strokes, out.width, out.height)
    const frame = { t, label, jpeg: stripDataUrl(out.toDataURL("image/jpeg", 0.82)) }
    if (s.keyframes.length >= MAX_FRAMES) s.keyframes.splice(MAX_FRAMES - 2, 1)
    s.keyframes.push(frame)
  }

  // ── start / stop ─────────────────────────────────────────────────────────────────────────────────────────────
  async function start() {
    if (session || reviewing) return
    if (opts.isBusy()) { stations.say("Stop Play mode before recording a note.", true); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (error) {
      stations.say(`No microphone: ${error instanceof Error ? error.message : String(error)}`, true)
      return
    }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t)) ?? ""
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48_000 } : undefined)
    const chunks: Blob[] = []
    recorder.addEventListener("dataavailable", e => { if (e.data.size) chunks.push(e.data) })
    recorder.start(1000)
    const snap = stations.snapshot()
    const startState = {
      url: location.href,
      option: snap.variant?.id ?? null,
      settings: Object.fromEntries(Object.entries({ station: snap.station?.id ?? "lab", section: snap.section ?? "lab", view: snap.view }).map(([k, v]) => [k, String(v)])),
    }
    session = {
      start: performance.now(),
      startedAt: new Date().toISOString(),
      recorder, stream, chunks,
      speech: "unsupported",
      recognition: null,
      transcript: [],
      strokes: [],
      log: [],
      keyframes: [],
      startState,
      station: snap.station,
      variant: snap.variant?.id ?? null,
      off: () => {},
      timer: 0,
    }
    const s = session
    s.off = stations.on(e => {
      if (!session) return
      if (e.kind === "variant") { s.variant = e.variant; s.log.push({ t: now(), kind: "option", option: e.variant }); scheduleFrame(e.variant, 700) }
      else { s.log.push({ t: now(), kind: "setting", key: "station", value: e.station ?? "lab" }); s.station = stations.snapshot().station; s.variant = null; scheduleFrame(e.station ?? "lab", 900) }
    })
    startSpeech(s)
    viewport.dataset.recording = "true"
    pill.hidden = false
    s.timer = window.setInterval(() => {
      renderPill()
      if (now() > MAX_MS) void stop()
    }, 250)
    renderPill()
    redraw()
    scheduleFrame("start", 60)
  }

  function startSpeech(s: NonNullable<typeof session>) {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor || navigator.webdriver) return
    try {
      const r = new Ctor()
      r.continuous = true
      r.interimResults = false
      r.lang = navigator.language || "en-US"
      let last = 0
      r.onresult = e => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]!
          if (!res.isFinal) continue
          const t1 = Math.round(performance.now() - s.start), text = res[0].transcript.trim()
          if (text) s.transcript.push({ t0: last, t1, text })
          last = t1
        }
        s.speech = "browser"
      }
      r.onerror = e => { if (s.speech !== "browser") s.speech = e.error === "not-allowed" ? "denied" : "error" }
      r.onend = () => { if (session === s) try { r.start() } catch { /* already running */ } }
      r.start()
      s.recognition = r
    } catch {
      s.speech = "error"
    }
  }

  function renderPill() {
    if (!session) return
    const station = session.station?.title ?? "Lab"
    const variant = session.station?.variants?.find(v => v.id === session!.variant)?.label
    pill.innerHTML = `<i></i><b>${clock(now())}</b><span>${html(station)}${variant ? ` · ${html(variant)}` : ""}</span><span class="fb-dim"><kbd>⇧</kbd> draw · <kbd>⌘Z</kbd> undo · <kbd>N</kbd> finish · <kbd>Esc</kbd> cancel</span>`
  }

  function teardown() {
    if (!session) return
    const s = session
    clearInterval(s.timer)
    s.off()
    if (s.recognition) { s.recognition.onend = null; try { s.recognition.stop() } catch { /* stopped */ } }
    for (const track of s.stream.getTracks()) track.stop()
    session = null
    drawing = null
    delete viewport.dataset.recording
    pill.hidden = true
    redraw()
  }

  function cancel() {
    if (!session) return
    try { session.recorder.stop() } catch { /* stopped */ }
    teardown()
    stations.say("Voice note discarded")
  }

  async function stop() {
    if (!session) return
    const s = session
    endStroke()
    clearTimeout(frameTimer)
    await grabFrame("end")
    const durationMs = now()
    const stopped = new Promise<void>(done => s.recorder.addEventListener("stop", () => done(), { once: true }))
    try { s.recorder.stop() } catch { /* stopped */ }
    await Promise.race([stopped, new Promise(done => setTimeout(done, 1500))])
    const type = s.recorder.mimeType || "audio/webm"
    const audio = new Blob(s.chunks, { type })
    teardown()
    const sheet = await contactSheet(s, durationMs)
    review({
      version: 1,
      station: s.station ? { id: s.station.id, title: s.station.title, board: s.station.board, variants: (s.station.variants ?? []).map(v => ({ id: v.id, label: v.label, ...(v.boardOption ? { boardOption: v.boardOption } : {}) })) } : null,
      variant: s.variant,
      startedAt: s.startedAt,
      durationMs,
      audio: audio.size ? { type: type.split(";")[0]!, base64: await base64Of(audio) } : null,
      speech: s.speech,
      lang: navigator.language || "en-US",
      transcript: s.transcript,
      strokes: s.strokes,
      stateLog: { start: s.startState, log: s.log },
      state: { station: { ...stations.snapshot(), station: s.station?.id ?? null }, ...opts.state() },
      keyframes: s.keyframes,
      contactSheet: sheet,
      note: "",
      send: true,
      pageUrl: location.href,
    })
  }

  async function contactSheet(s: NonNullable<typeof session>, durationMs: number): Promise<string> {
    const frames = s.keyframes
    const cols = Math.min(3, Math.max(1, frames.length)), rows = Math.max(1, Math.ceil(frames.length / cols))
    const tw = 520, images = await Promise.all(frames.map(f => new Promise<HTMLImageElement>(done => { const img = new Image(); img.onload = () => done(img); img.onerror = () => done(img); img.src = `data:image/jpeg;base64,${f.jpeg}` })))
    const aspect = images[0]?.naturalWidth ? images[0].naturalHeight / images[0].naturalWidth : 0.6
    const th = Math.round(tw * aspect), pad = 12, head = 44, cap = 26
    const out = document.createElement("canvas")
    out.width = pad + cols * (tw + pad)
    out.height = head + rows * (th + cap + pad) + pad
    const c = out.getContext("2d")!
    c.fillStyle = "#0c0d0f"; c.fillRect(0, 0, out.width, out.height)
    c.fillStyle = "#d8dbe0"; c.font = "600 16px -apple-system, system-ui, sans-serif"
    const variantLabel = s.station?.variants?.find(v => v.id === s.variant)?.label
    c.fillText(`${s.station?.title ?? "Lab"}${variantLabel ? ` · ${variantLabel}` : ""} · ${clock(durationMs)} · ${s.strokes.length} mark${s.strokes.length === 1 ? "" : "s"}`, pad, 28)
    c.fillStyle = "#8b9098"; c.font = "12px ui-monospace, Menlo, monospace"
    c.textAlign = "right"; c.fillText(new Date(s.startedAt).toLocaleString(), out.width - pad, 28); c.textAlign = "left"
    frames.forEach((f, i) => {
      const x = pad + (i % cols) * (tw + pad), y = head + Math.floor(i / cols) * (th + cap + pad)
      if (images[i]?.naturalWidth) c.drawImage(images[i]!, x, y, tw, th)
      const said = s.transcript.filter(seg => seg.t1 >= f.t - 1500 && seg.t0 <= f.t + 1500).map(seg => seg.text).join(" ")
      c.fillStyle = "#d8dbe0"; c.font = "12px ui-monospace, Menlo, monospace"
      const text = `${clock(f.t)} · ${f.label}${said ? ` · “${said}”` : ""}`
      c.fillText(text.length > 70 ? `${text.slice(0, 69)}…”` : text, x, y + th + 17)
    })
    return stripDataUrl(out.toDataURL("image/png"))
  }

  // ── review card ──────────────────────────────────────────────────────────────────────────────────────────────
  function review(payload: FeedbackPayload) {
    reviewing = true
    const back = document.createElement("div")
    back.className = "fb-review"
    back.dataset.fbReview = ""
    const said = payload.transcript.map(t => t.text).join(" ")
    const marks = payload.strokes.length
    back.innerHTML = `
      <div class="fb-card" role="dialog" aria-label="Voice note">
        <header><b>Voice note</b><span>${html(payload.station?.title ?? "Lab")}${payload.variant ? ` · ${html(payload.station?.variants.find(v => v.id === payload.variant)?.label ?? payload.variant)}` : ""} · ${clock(payload.durationMs)} · ${marks} mark${marks === 1 ? "" : "s"}</span></header>
        <img alt="Contact sheet" src="data:image/png;base64,${payload.contactSheet}">
        <p class="fb-said">${said ? `“${html(said)}”` : payload.audio ? "The board transcribes the recording with Whisper after it's sent." : "No audio was captured."}</p>
        <textarea placeholder="Add a typed note (optional)" rows="2"></textarea>
        <footer>
          <button type="button" class="fb-btn fb-send" data-action="send">Send to ${html(payload.station?.board?.feature ?? "AR-21")} <kbd>⏎</kbd></button>
          <button type="button" class="fb-btn" data-action="save">Save only</button>
          <button type="button" class="fb-btn" data-action="discard">Discard <kbd>Esc</kbd></button>
        </footer>
        <p class="fb-status" hidden></p>
      </div>`
    viewport.append(back)
    const note = back.querySelector("textarea")!
    const status = back.querySelector<HTMLElement>(".fb-status")!
    const buttons = [...back.querySelectorAll<HTMLButtonElement>("button")]
    const close = () => { back.remove(); reviewing = false; window.removeEventListener("keydown", keys, true); opts.canvas.focus({ preventScroll: true }) }
    async function submit(send: boolean) {
      for (const b of buttons) b.disabled = true
      status.hidden = false
      status.textContent = send ? "Sending…" : "Saving…"
      const result = await opts.submit({ ...payload, note: note.value.trim(), send }).catch(error => ({ error: String(error) }) as FeedbackResult)
      if (result.error && !result.dir) {
        status.textContent = result.error
        status.dataset.error = "true"
        for (const b of buttons) b.disabled = false
        return
      }
      close()
      const where = result.dir ? result.dir.replace(/^.*\/lab-feedback\//, "lab-feedback/") : ""
      if (send && result.board?.decision) stations.say(`Sent to ${result.board.feature} · ${result.board.decision}${where ? ` · saved ${where}` : ""}`)
      else if (send && result.board?.error) stations.say(`Saved ${where}, but the board said: ${result.board.error}`, true)
      else stations.say(`Saved ${where}`)
    }
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); stations.say("Voice note discarded") }
      else if (e.key === "Enter" && (e.target !== note || e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); void submit(true) }
      else if (e.target !== note) e.stopImmediatePropagation()
    }
    window.addEventListener("keydown", keys, true)
    back.querySelector('[data-action="send"]')!.addEventListener("click", () => void submit(true))
    back.querySelector('[data-action="save"]')!.addEventListener("click", () => void submit(false))
    back.querySelector('[data-action="discard"]')!.addEventListener("click", () => { close(); stations.say("Voice note discarded") })
    back.querySelector<HTMLButtonElement>('[data-action="send"]')!.focus()
  }

  // ── keys while recording ─────────────────────────────────────────────────────────────────────────────────────
  const typing = (e: KeyboardEvent) => {
    const t = e.composedPath()[0]
    // Lists with type-to-filter (the Library) own printable keys like a text field.
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && (t.isContentEditable || Boolean(t.closest("[data-typeahead]"))))
  }
  window.addEventListener("keydown", e => {
    if (e.key === "Shift") { shift = true; if (session && !reviewing) { ink.style.pointerEvents = "auto"; beginStroke() } return }
    if (reviewing || typing(e)) return
    if (session) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.stopImmediatePropagation()
        session.strokes.pop(); redraw(); return
      }
    }
    if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !opts.isBusy()) {
      if (document.querySelector(".knobs-layers>.knobs-palette, .lab-modal-backdrop:not([hidden])")) return
      e.preventDefault(); e.stopImmediatePropagation()
      toggle()
    }
  }, { capture: true })
  window.addEventListener("keyup", e => {
    if (e.key !== "Shift") return
    shift = false
    ink.style.pointerEvents = ""
    endStroke()
  }, { capture: true })
  window.addEventListener("blur", () => { if (shift) { shift = false; ink.style.pointerEvents = ""; endStroke() } })
  new ResizeObserver(() => redraw()).observe(viewport)

  function toggle() {
    if (session) void stop()
    else void start()
    return true
  }

  return { toggle, active: () => Boolean(session) || reviewing, start, stop, cancel }
}
