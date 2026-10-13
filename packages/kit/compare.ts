const panes = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
const game = document.body.dataset.game!
const authority = game === "blackout" ? 0 : 1
const follower = 1 - authority
const query = new URLSearchParams(location.search)
const seed = query.get("seed") ?? (game === "blackout" ? "1" : "7")
const urls = panes.map((pane, i) => {
  const url = new URL(query.get(i ? "after" : "before") ?? pane.dataset.src!, location.href)
  for (const [key, value] of Object.entries({ peaceful: "1", perf: "1", mux: "1", seed })) url.searchParams.set(key, value)
  if (i === 0) url.searchParams.set("vanilla", "1")
  else { url.searchParams.delete("vanilla"); url.searchParams.set("lab", "1") }
  return url
})
const origins = urls.map((url) => url.origin)
const labels = ["BEFORE", "AFTER"]
const outputs = [document.querySelector<HTMLOutputElement>("#before-stats")!, document.querySelector<HTMLOutputElement>("#after-stats")!]
const badge = document.querySelector<HTMLOutputElement>("#speedup")!
type Message = Record<string, any>
const ready: (Message | null)[] = [null, null]
const stats: (Message | null)[] = [null, null]
let run = "", tick = 0, waiting = false, blocked = false, elapsed = 0, owner = -1
let pending: Message[] = []
let last = performance.now(), progressAt = last
const dt = 1 / 60
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const stateKeys = game === "blackout" ? ["x", "y", "vx", "vy", "aim", "tx", "ty"] : ["x", "y", "vx", "vy", "h"]
const validState = (m: Message) => stateKeys.every((key) => finite(m[key]))
const send = (i: number, message: Message) => panes[i]!.contentWindow?.postMessage({ ...message, run }, origins[i]!)
const both = (message: Message) => panes.forEach((_, i) => send(i, message))
const activate = (source: number) => {
  if (owner === source) return
  pending.push({ type: "mux-release" })
  owner = source
}
const enqueue = (message: Message, source = -1) => {
  if (message.type === "mux-key" && message.kind === "keydown" || message.type === "mux-mouse" && (message.down !== undefined || message.buttons)) activate(source)
  if (message.type === "mux-release" && source !== owner) return
  const move = (m: Message | undefined) => m?.type === "mux-mouse" && m.down === undefined && m.up === undefined && m.wheel === undefined && m.buttons === undefined
  if (move(message) && move(pending.at(-1))) pending[pending.length - 1] = message
  else pending.push(message)
}
const stop = (reason: string) => { blocked = true; outputs.forEach((out, i) => { out.textContent = `${labels[i]} · ${reason}` }) }
addEventListener("message", (event) => {
  const i = panes.findIndex((pane, n) => pane.contentWindow === event.source && event.origin === origins[n])
  const m = event.data as Message
  if (i < 0 || !m || typeof m !== "object" || m.run !== run) return
  if (m.type === "mux-ready") {
    if (ready[i]) return
    if (m.protocol !== 1 || !validState(m)) { stop("incompatible mux client"); return }
    ready[i] = m
    progressAt = performance.now()
    if (ready.every(Boolean) && ["map", "mode", "x", "y"].some((key) => ready[0]![key] !== ready[1]![key])) stop("floor/spawn mismatch")
    return
  }
  if (["mux-key", "mux-mouse", "mux-release"].includes(m.type)) { enqueue(m, i); return }
  if (m.type === "mux-state" && i === authority && waiting && m.tick === tick && validState(m)) {
    send(follower, { ...m, type: "mux-sync", dt, now: tick * dt * 1000 })
    return
  }
  if (m.type === "mux-done" && i === follower && waiting && m.tick === tick) { waiting = false; progressAt = performance.now(); return }
  if (m.type !== "arcade-perf" || !["fps", "frameMs", "p95Ms", "verts", "chunks", "lights"].every((key) => finite(m[key]))) return
  stats[i] = m
  if (!blocked) outputs[i]!.textContent = `${labels[i]} · ${m.frameMs.toFixed(1)} ms / GPU ${finite(m.gpuMs) ? m.gpuMs.toFixed(2) + (m.gpuKind === "queue-wait" ? " wait" : " ms") : "—"} / ${m.verts.toLocaleString()} verts`
  if (stats.every(Boolean)) {
    const hardware = stats.every((s) => s!.gpuKind === "timestamp" && s!.gpuMs > 0)
    const key = hardware ? "gpuMs" : "frameMs"
    if (stats[1]![key] > 0) {
      const speedup = (stats[0]![key] / stats[1]![key] - 1) * 100
      badge.textContent = `${speedup >= 0 ? "+" : ""}${speedup.toFixed(1)}% ${hardware ? "GPU" : "frame"} speedup`
    }
  }
})

const clock = (now: number) => {
  elapsed = document.hidden || !ready.every(Boolean) ? 0 : Math.min(dt * 3, elapsed + (now - last) / 1000)
  last = now
  if (!blocked && ready.every(Boolean) && !waiting && !document.hidden && elapsed >= dt) {
    elapsed -= dt
    waiting = true
    tick++
    for (const m of pending) both(m)
    pending = []
    send(authority, { type: "mux-step", tick, dt, now: tick * dt * 1000 })
  }
  if (!document.hidden && !blocked && now - progressAt > 15000) stop(ready.every(Boolean) ? "sync timed out" : "client not ready")
  requestAnimationFrame(clock)
}
requestAnimationFrame(clock)
const header = document.querySelector("header")!
header.addEventListener("pointerdown", (event) => {
  activate(-1)
  if (!(event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement)) header.focus({ preventScroll: true })
})
for (const kind of ["keydown", "keyup"] as const) addEventListener(kind, (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement && ["Enter", "Space"].includes(event.code)) return
  event.preventDefault()
  if (!event.repeat) enqueue({ type: "mux-key", kind, code: event.code, key: event.key })
})
addEventListener("blur", () => enqueue({ type: "mux-release" }))
document.addEventListener("visibilitychange", () => {
  progressAt = performance.now()
  if (document.hidden) { pending = []; both({ type: "mux-release" }) }
})
const reset = () => {
  run = crypto.randomUUID()
  ready.fill(null); stats.fill(null)
  waiting = blocked = false
  pending = []; owner = -1; tick = elapsed = 0
  progressAt = performance.now()
  panes.forEach((pane, i) => { const url = new URL(urls[i]!); url.searchParams.set("muxRun", run); pane.src = url.href })
  outputs.forEach((out, i) => { out.textContent = `${labels[i]} · connecting` })
  badge.textContent = "— speedup"
}
panes.forEach((pane, i) => pane.addEventListener("load", () => send(i, { type: "mux-hello" })))
document.querySelector("#reset")!.addEventListener("click", reset)
const main = document.querySelector("main")!
const wipe = document.querySelector<HTMLInputElement>("#wipe")!
for (const mode of ["split", "overlay"]) document.querySelector(`#${mode}`)!.addEventListener("click", () => {
  main.classList.toggle("overlay", mode === "overlay")
  wipe.hidden = mode !== "overlay"
  document.querySelector("#split")!.setAttribute("aria-pressed", String(mode === "split"))
  document.querySelector("#overlay")!.setAttribute("aria-pressed", String(mode === "overlay"))
  both({ type: "mux-release" })
  header.focus({ preventScroll: true })
})
wipe.addEventListener("input", () => main.style.setProperty("--wipe", `${wipe.value}%`))
reset()
