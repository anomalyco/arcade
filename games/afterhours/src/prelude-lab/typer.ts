import { keyClick } from "./sound"

// One prelude player: lays out the whole text (untyped characters hidden, so lines never shift as they type), then
// reveals it on a schedule built from the rhythm, holds it for the dwell time, fades it out, and optionally loops.

export type Rhythm = "even" | "human" | "teletype" | "line"
export type CursorStyle = "none" | "bar" | "block" | "underscore"
export type CursorBlink = "always" | "idle" | "solid"
export type Fade = "fade" | "lines" | "dim" | "cut" | "hold"
export type SoundKind = "off" | "typewriter" | "teletype"

export type TypeSettings = {
  label: string
  cps: number
  rhythm: Rhythm
  cursor: CursorStyle
  blink: CursorBlink
  /** Keep the cursor after the last character (else it disappears when typing ends). */
  cursorAfter: boolean
  sound: SoundKind
  volume: number
  /** Seconds the finished text holds before the fade. */
  dwell: number
  fade: Fade
  /** Seconds of the fade. */
  fadeTime: number
  align: "draft" | "center" | "left"
}

type Step = { t: number; line: number; col: number; ch: string }

/** Seconds of black before the first character. */
const LEAD = 0.9
/** Seconds of black between loops. */
const GAP = 1.4

function schedule(lines: string[], s: TypeSettings): Step[] {
  const steps: Step[] = []
  const base = 1 / Math.max(1, s.cps)
  let t = LEAD
  const r = Math.random
  lines.forEach((line, li) => {
    if (s.rhythm === "line") {
      steps.push({ t, line: li, col: line.length, ch: line[0] ?? " " })
      t += line.length ? Math.max(0.5, line.length * base * 0.55) : base * 6
      return
    }
    if (s.rhythm === "teletype") {
      let c = 0
      while (c < line.length) {
        const n = Math.min(line.length - c, 3 + Math.floor(r() * 6))
        for (let k = 0; k < n; k++) {
          c++
          steps.push({ t, line: li, col: c, ch: line[c - 1]! })
          t += base / 3.2
        }
        // The mechanical pause: averages the chunk back to the set speed.
        t += n * base * (1 - 1 / 3.2) * (0.7 + r() * 0.6)
      }
      t += line.length ? 0.42 : 0.18
      return
    }
    for (let c = 1; c <= line.length; c++) {
      const ch = line[c - 1]!
      steps.push({ t, line: li, col: c, ch })
      if (s.rhythm === "even") t += base
      else {
        t += base * (0.55 + r() * 0.9)
        if (ch === " ") t += base * 0.35
        if (ch === "," || ch === ";" || ch === ":") t += base * 5
        if (ch === "." || ch === "?" || ch === "!") t += base * 8
        if (r() < 0.03) t += 0.18 + r() * 0.25
      }
    }
    t += line.length ? (s.rhythm === "even" ? base * 4 : base * 12 + r() * 0.15) : base * 4
  })
  return steps
}

export function createTyper(frame: HTMLElement, audible: () => boolean) {
  const text = document.createElement("div")
  text.className = "pl-text"
  frame.append(text)
  let rows: { typed: HTMLSpanElement; rest: HTMLSpanElement; caret: HTMLElement; line: string; p: HTMLElement }[] = []
  let steps: Step[] = []
  let next = 0
  let t0 = 0
  let raf = 0
  let phase: "typing" | "dwell" | "fading" | "done" = "done"
  let doneAt = 0
  let settings: TypeSettings
  let source = ""
  let loop = true
  let align: "center" | "left" = "center"

  function layout() {
    text.innerHTML = ""
    const block = document.createElement("div")
    block.className = "pl-block"
    text.append(block)
    text.style.transition = "none"
    text.style.opacity = "1"
    text.dataset.align = align
    text.dataset.cursor = settings.cursor
    text.dataset.blink = settings.blink
    rows = source.split("\n").map((line) => {
      const p = document.createElement("p")
      if (!line) p.className = "blank"
      const typed = document.createElement("span")
      const caret = document.createElement("i")
      const rest = document.createElement("span")
      rest.className = "rest"
      rest.textContent = line || " "
      p.append(typed, caret, rest)
      block.append(p)
      return { typed, rest, caret, line, p }
    })
  }

  function setCaret(row: number | null) {
    rows.forEach((r, i) => r.p.classList.toggle("at", i === row))
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    const e = (now - t0) / 1000
    if (phase === "typing") {
      let sounded = false
      while (next < steps.length && steps[next]!.t <= e) {
        const st = steps[next++]!
        const r = rows[st.line]!
        r.typed.textContent = r.line.slice(0, st.col)
        r.rest.textContent = r.line.slice(st.col) || (st.col ? "" : " ")
        if (settings.rhythm === "line") r.p.classList.add("shown")
        setCaret(st.line)
        if (!sounded && settings.sound !== "off" && audible()) {
          sounded = true
          keyClick(settings.sound, st.ch, st.col === r.line.length, settings.volume)
        }
      }
      text.classList.toggle("idle", next < steps.length && steps[next]!.t - e > 0.25)
      if (next >= steps.length && e > (steps.at(-1)?.t ?? 0) + 0.2) {
        phase = "dwell"
        doneAt = e
        text.classList.add("idle")
        if (!settings.cursorAfter) setCaret(null)
      }
    } else if (phase === "dwell" && e - doneAt >= settings.dwell) {
      phase = "fading"
      doneAt = e
      fadeOut()
    } else if (phase === "fading" && e - doneAt >= settings.fadeTime + GAP) {
      if (loop && settings.fade !== "hold") play(source, settings, loop)
      else phase = "done"
    }
  }

  function fadeOut() {
    const f = settings.fade
    const d = settings.fadeTime
    if (f === "hold") return
    if (f === "cut") return void (text.style.opacity = "0")
    if (f === "lines") {
      rows.forEach((r, i) => {
        r.p.style.transition = `opacity ${(d * 0.5).toFixed(2)}s ease ${((i / Math.max(1, rows.length - 1)) * d * 0.5).toFixed(2)}s`
        r.p.style.opacity = "0"
      })
      return
    }
    text.style.transition = `opacity ${d}s ease`
    text.style.opacity = f === "dim" ? "0.16" : "0"
  }

  function play(src: string, s: TypeSettings, loops = true) {
    cancelAnimationFrame(raf)
    source = src
    settings = { ...s }
    loop = loops
    align = s.align === "draft" ? ((frame.dataset.draftAlign as "center" | "left") ?? "center") : s.align
    layout()
    steps = schedule(rows.map((r) => r.line), settings)
    for (const r of rows) {
      r.typed.textContent = ""
      r.rest.textContent = r.line || " "
    }
    next = 0
    phase = "typing"
    setCaret(0)
    text.classList.add("idle")
    t0 = performance.now()
    raf = requestAnimationFrame(tick)
  }

  return {
    play,
    stop() {
      cancelAnimationFrame(raf)
    },
    /** Seconds the typing takes with these settings (approximate for the random rhythms). */
    duration: () => steps.at(-1)?.t ?? 0,
  }
}
