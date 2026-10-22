/**
 * Lo-fi phosphor boot screen for a game's load: a black CRT with a boot log, one line per real load stage, a chunky
 * block progress bar, scanlines, glow and a blinking cursor. It paints before the game bundle or WebGPU is ready:
 * `bootScreenHead()`/`bootScreenBody()` go into index.html at build time (`scripts/boot-screen.ts` Vite plugin), and
 * the game adopts that markup with `new BootScreen(plan)` once its bundle runs.
 *
 *   const boot = new BootScreen({ program: 500, video: 100, props: 2000, frame: 600 })
 *   boot.done("program", "1.6M")                         // the first line is already in the HTML, spinning
 *   const bytes = boot.fetch("props", url, "READ CRT.GLB") // streams; the bar follows received bytes
 *   const line = boot.stage("frame", "FIRST FRAME"); …; line.done()
 *   boot.ready(["SESSION 087"]); …; await boot.dismiss() // fades to black
 *   boot.fail("DISK ERROR", "Retry")                      // in-world error with a retry (reload)
 *
 * The bar only advances on reported work: each stage contributes its planned weight times its reported fraction.
 * Spinner and cursor are compositor-only CSS animations, so they keep moving while the main thread decodes.
 * The screen never takes pointer input (clicks reach the game) except for its retry button after a failure.
 * Soft CRT hum and drive-seek ticks start only after a gesture during the load, never on their own.
 */

export type BootPlan = Record<string, number>

const ROOT = "arcade-boot"
const SPIN = `<span class="${ROOT}-spin" aria-hidden="true"><span>|<br>/<br>-<br>\\</span></span>`
const BAR_CELLS = 32
const LABEL_WIDTH = 30

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const leader = (label: string) => (label.length >= LABEL_WIDTH ? label + " " : label + " " + ".".repeat(LABEL_WIDTH - label.length - 1) + " ")
const bar = (fraction: number) => {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.floor(fraction * BAR_CELLS)))
  return `[${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}] ${String(Math.floor(fraction * 100)).padStart(3)}%`
}
/** Bytes as a period disk listing would: 902K, 1.6M. */
export const bootBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1024))}K`)

export type BootMarkupOptions = {
  /** Lines printed instantly at the top, before the memory count. No brand names. */
  header?: string[]
  /** Label of the first stage, already spinning in the HTML while the game bundle downloads. */
  first?: string
  /** Phosphor colour. */
  tone?: "green" | "amber"
}

/** `<style>` for index.html's head. */
export function bootScreenHead({ tone = "green" }: BootMarkupOptions = {}) {
  const ink = tone === "amber" ? "#ffb347" : "#7dff9a", glow = tone === "amber" ? "255,160,40" : "60,255,120"
  return `<style id="${ROOT}-style">
@property --${ROOT}-mem{syntax:"<integer>";inherits:false;initial-value:0}
#${ROOT}{position:fixed;inset:0;z-index:20;background:#000;color:${ink};font:clamp(11px,1.55vw,17px)/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;transition:opacity .45s ease-in;-webkit-font-smoothing:none;user-select:none;pointer-events:none}
#${ROOT}::before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(#0000 0 2px,#0007 2px 3px),radial-gradient(ellipse at center,#0000 55%,#000c 100%)}
#${ROOT}[data-failed]{pointer-events:auto}
#${ROOT}[data-gone]{opacity:0}
#${ROOT} pre{margin:0;font:inherit;white-space:pre;text-shadow:0 0 .35em rgba(${glow},.55),0 0 .08em rgba(${glow},.9);animation:${ROOT}-flicker 4.7s steps(1) infinite}
#${ROOT} .${ROOT}-dim{opacity:.55}
#${ROOT} .${ROOT}-mem::before{counter-reset:m var(--${ROOT}-mem);content:counter(m) "K";animation:${ROOT}-count .7s steps(20,end) forwards}
#${ROOT} .${ROOT}-spin{display:inline-block;width:1ch;height:1.45em;overflow:hidden;vertical-align:top}
#${ROOT} .${ROOT}-spin>span{display:block;animation:${ROOT}-spin .48s steps(4) infinite}
#${ROOT} .${ROOT}-cursor{animation:${ROOT}-blink 1.06s steps(1) infinite}
#${ROOT} .${ROOT}-prompt{display:inline-block;text-transform:none;text-shadow:none;--akc-face:${ink};--akc-ink:#000;--akc-edge:${ink}}
#${ROOT} button{font:inherit;color:#000;background:${ink};border:0;padding:0 .6ch;margin-left:1ch;text-transform:inherit;letter-spacing:inherit;cursor:pointer;pointer-events:auto}
@keyframes ${ROOT}-count{to{--${ROOT}-mem:640}}
@keyframes ${ROOT}-spin{to{transform:translateY(-5.8em)}}
@keyframes ${ROOT}-blink{50%{opacity:0}}
@keyframes ${ROOT}-flicker{0%{opacity:1}31%{opacity:.94}32%{opacity:1}77%{opacity:.97}78%{opacity:1}}
@media (prefers-reduced-motion:reduce){#${ROOT} pre,#${ROOT} .${ROOT}-cursor{animation:none}#${ROOT} .${ROOT}-spin>span{animation-duration:2s}#${ROOT}{transition-duration:.2s}}
#${ROOT}[data-reduced] pre,#${ROOT}[data-reduced] .${ROOT}-cursor{animation:none}#${ROOT}[data-reduced] .${ROOT}-spin>span{animation-duration:2s}
</style>`
}

/** Static first-paint markup for the top of index.html's body. */
export function bootScreenBody({ header = ["SYSTEM ROM 2.13", "(C) 1987"], first = "LOADING PROGRAM" }: BootMarkupOptions = {}) {
  const head = header.map((l) => `<span class="${ROOT}-dim">${esc(l)}</span>`).join("\n")
  return `<div id="${ROOT}" role="status" aria-live="polite" aria-label="Loading"><pre data-boot-log>${head}
MEMORY TEST ${" ".repeat(LABEL_WIDTH - 12)}<span class="${ROOT}-mem"></span> OK

<span data-boot-lines><span data-boot-stage="program" data-boot-label="${esc(first)}">${esc(leader(first))}${SPIN}</span></span>

<span data-boot-bar>${bar(0)}</span>
<span data-boot-tail></span><span class="${ROOT}-cursor">█</span></pre></div>`
}

/** One load stage: a boot-log line with a spinner until it is done. */
export class BootLine {
  fraction = 0
  finished = false
  private detail?: string
  constructor(private screen: BootScreen, readonly id: string, readonly el: HTMLElement, readonly label: string) {}
  /** Report real progress, 0..1; never moves backwards. The line and bar redraw at most once a frame. */
  progress(fraction: number, detail?: string) {
    if (this.finished) return
    this.fraction = Math.max(this.fraction, Math.min(1, fraction))
    if (detail !== undefined) this.detail = detail
    this.screen.update(this)
  }
  /** @internal */
  draw() {
    if (!this.finished && this.detail !== undefined) this.el.innerHTML = `${esc(leader(this.label))}${esc(this.detail)} ${SPIN}`
  }
  done(status = "OK") {
    if (this.finished) return
    this.finished = true
    this.fraction = 1
    this.el.textContent = leader(this.label) + status
    this.screen.tick(true)
    this.screen.update()
  }
  /** Stops the line without progress: FAIL for the cause, "--" for work abandoned by another failure. */
  stop(status: string) {
    if (this.finished) return
    this.finished = true
    this.el.textContent = leader(this.label) + status
  }
}

export class BootScreen {
  readonly root: HTMLElement
  private lines: HTMLElement
  private barEl: HTMLElement
  private tail: HTMLElement
  private stages = new Map<string, BootLine>()
  private hum?: BootHum
  private gone = false
  isReady = false
  failed = false
  /** Muted boot audio (the game's own mute, tests). */
  muted = false

  constructor(private plan: BootPlan, options: BootMarkupOptions = {}) {
    if (!document.getElementById(`${ROOT}-style`)) document.head.insertAdjacentHTML("beforeend", bootScreenHead(options))
    if (!document.getElementById(ROOT)) document.body.insertAdjacentHTML("afterbegin", bootScreenBody(options))
    this.root = document.getElementById(ROOT)!
    this.lines = this.root.querySelector("[data-boot-lines]")!
    this.barEl = this.root.querySelector("[data-boot-bar]")!
    this.tail = this.root.querySelector("[data-boot-tail]")!
    const first = this.root.querySelector<HTMLElement>('[data-boot-stage="program"]')
    if (first) this.stages.set("program", new BootLine(this, "program", first, first.dataset.bootLabel ?? "LOADING PROGRAM"))
    const gesture = () => {
      if (this.isReady || this.failed || this.gone || this.muted) return
      this.hum ??= new BootHum()
    }
    addEventListener("pointerdown", gesture)
    addEventListener("keydown", gesture)
  }

  /** Disables flicker and cursor blink (the game's own reduce-motion setting; the OS setting applies via CSS). */
  set reducedMotion(on: boolean) { this.root.toggleAttribute("data-reduced", on) }

  /** Starts a stage (or returns the running one) and prints its line. */
  stage(id: string, label = id.toUpperCase()): BootLine {
    let line = this.stages.get(id)
    if (line) return line
    const el = document.createElement("span")
    el.dataset.bootStage = id
    el.innerHTML = `${esc(leader(label))}${SPIN}`
    if (this.lines.childNodes.length) this.lines.append("\n")
    this.lines.append(el)
    line = new BootLine(this, id, el, label)
    this.stages.set(id, line)
    this.tick(false)
    this.update()
    return line
  }

  done(id: string, status?: string) { this.stage(id).done(status) }

  /**
   * Fetches with streamed byte progress on the stage's line. `share` is the part of the stage's weight the
   * download counts for; the caller finishes the line (`done`) when the bytes are decoded.
   */
  async fetch(id: string, url: string, label: string, share = 0.7): Promise<Uint8Array<ArrayBuffer>> {
    const line = this.stage(id, label), name = label.replace(/^READ /, "")
    const failed = (detail = "") => { line.stop("FAIL"); return new BootError(`DISK ERROR READING ${name}${detail}`) }
    const response = await fetch(url).catch(() => { throw failed() })
    if (!response.ok) throw failed(` (${response.status})`)
    const total = Number(response.headers.get("content-length")) || 0
    if (!response.body || !total) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      line.progress(share, bootBytes(bytes.byteLength))
      return bytes
    }
    const reader = response.body.getReader(), out = new Uint8Array(total)
    let received = 0, lastTick = 0
    for (;;) {
      const { done, value } = await reader.read().catch(() => { throw failed() })
      if (done) break
      if (received + value.byteLength > total) throw failed()
      out.set(value, received)
      received += value.byteLength
      line.progress((received / total) * share, `${bootBytes(received)}/${bootBytes(total)}`)
      if (received - lastTick > 196608) { lastTick = received; this.tick(false) }
    }
    if (received !== total) throw failed()
    line.progress(share, bootBytes(total))
    return out
  }

  /** Resolves once the log has had a chance to paint, before a long synchronous step (bounded for hidden tabs). */
  paint(): Promise<void> {
    return new Promise((resolve) => {
      const fallback = setTimeout(resolve, 100)
      requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); resolve() }, 0))
    })
  }

  /** Counts the pipelines created on `device` from now on, for a "compiling shaders" line. */
  watchPipelines(device: GPUDevice): () => number {
    let count = 0
    const render = device.createRenderPipeline.bind(device), compute = device.createComputePipeline.bind(device)
    device.createRenderPipeline = (descriptor) => (count++, render(descriptor))
    device.createComputePipeline = (descriptor) => (count++, compute(descriptor))
    return () => count
  }

  /** Fraction of the planned weight that has actually completed. */
  get progress() {
    let sum = 0, done = 0
    for (const [id, weight] of Object.entries(this.plan)) {
      sum += weight
      done += weight * (this.stages.get(id)?.fraction ?? 0)
    }
    return sum ? done / sum : 0
  }

  private dirty = new Set<BootLine>()
  private frame = 0
  /** Redraws the bar (and a line's progress) on the next frame; several reports in one frame cost one redraw. */
  update(line?: BootLine) {
    if (line) this.dirty.add(line)
    if (this.frame) return
    const draw = () => {
      if (!this.frame) return
      cancelAnimationFrame(this.frame); this.frame = 0
      for (const l of this.dirty) l.draw()
      this.dirty.clear()
      if (!this.failed && !this.isReady) this.barEl.textContent = bar(this.progress)
    }
    // A timeout fallback keeps hidden tabs current without per-chunk DOM work.
    this.frame = requestAnimationFrame(draw)
    setTimeout(draw, 250)
  }

  /** All stages complete: prints the final lines and an optional prompt (trusted HTML, e.g. a key-cap Begin). */
  ready(lines: string[] = ["READY."], promptHtml = "") {
    if (this.isReady || this.failed) return
    this.isReady = true
    for (const line of this.stages.values()) line.done()
    this.barEl.textContent = bar(1)
    this.tail.innerHTML = esc(lines.join("\n")) + (promptHtml ? `\n\n<span class="${ROOT}-prompt">${promptHtml}</span>` : "")
    this.root.setAttribute("data-ready", "")
    this.root.setAttribute("aria-label", "Ready")
  }

  /** In-world failure, with a retry that reloads the page. */
  fail(message: string, retry = "RETRY") {
    if (this.gone) return
    this.failed = true
    this.root.removeAttribute("data-ready")
    this.root.setAttribute("data-failed", "")
    for (const line of this.stages.values()) line.stop("--")
    this.barEl.textContent = message.toUpperCase()
    this.tail.innerHTML = `ABORT, RETRY?<button type="button">${esc(retry)}</button>`
    this.tail.querySelector("button")!.addEventListener("click", () => location.reload())
    this.root.setAttribute("aria-label", message)
    this.hum?.stop()
  }

  /** Fades the text and hum out to black, then removes the screen. */
  dismiss(): Promise<void> {
    if (this.gone) return Promise.resolve()
    this.gone = true
    this.hum?.stop()
    this.root.setAttribute("data-gone", "")
    return new Promise((resolve) => {
      const finish = () => { this.root.remove(); resolve() }
      this.root.addEventListener("transitionend", finish, { once: true })
      setTimeout(finish, 700)
    })
  }

  /** A drive-seek tick; `settle` is the heavier click at the end of a stage. Silent until a gesture. */
  tick(settle: boolean) { if (!this.muted) this.hum?.tick(settle) }
}

export class BootError extends Error {}

/** Soft 60 Hz CRT hum and drive-seek ticks, synthesized; created only inside a user gesture. */
class BootHum {
  private ctx = new AudioContext()
  private master = this.ctx.createGain()
  private noise: AudioBuffer
  private last = 0

  constructor() {
    const c = this.ctx, now = c.currentTime
    this.master.gain.setValueAtTime(0, now)
    this.master.gain.linearRampToValueAtTime(1, now + 0.6)
    this.master.connect(c.destination)
    const low = c.createBiquadFilter()
    low.type = "lowpass"; low.frequency.value = 220
    const hum = c.createGain()
    hum.gain.value = 0.018
    low.connect(hum).connect(this.master)
    for (const [hz, type] of [[60, "sawtooth"], [120, "sine"]] as const) {
      const o = c.createOscillator()
      o.type = type; o.frequency.value = hz
      o.connect(low); o.start()
    }
    this.noise = c.createBuffer(1, Math.ceil(c.sampleRate * 0.03), c.sampleRate)
    const data = this.noise.getChannelData(0)
    let seed = 87
    for (let i = 0; i < data.length; i++) { seed = (seed * 16807) % 2147483647; data[i] = seed / 1073741823.5 - 1 }
    void c.resume()
  }

  tick(settle: boolean) {
    const c = this.ctx, now = c.currentTime
    if (c.state === "closed" || now - this.last < 0.035) return
    this.last = now
    const src = c.createBufferSource(), band = c.createBiquadFilter(), gain = c.createGain()
    src.buffer = this.noise
    band.type = "bandpass"; band.frequency.value = settle ? 900 : 2600; band.Q.value = 1.4
    gain.gain.setValueAtTime(settle ? 0.09 : 0.045, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (settle ? 0.028 : 0.009))
    src.connect(band).connect(gain).connect(this.master)
    src.start(now); src.stop(now + 0.03)
  }

  stop() {
    const c = this.ctx
    if (c.state === "closed") return
    this.master.gain.setTargetAtTime(0, c.currentTime, 0.08)
    setTimeout(() => void c.close(), 500)
  }
}
