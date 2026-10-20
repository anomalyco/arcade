import { TITLE_CARD } from "./copy"

// The prelude: the whole text (copy.ts TITLE_CARD) typed out once on one black screen, an even typewriter rhythm with
// a block cursor that blinks only while idle; it stays up for the dwell, dims, and resolves into the intro. The full
// text is laid out from the start (untyped characters hidden), so lines never shift as they type. `skip()` (Space,
// click) first completes the text, then continues. The black stays up; the caller fades it away when the intro starts.

const wait = (s: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, s * 1000)
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })

export function createTitleCard(root: HTMLElement) {
  const el = document.createElement("div")
  el.className = "title-card"
  el.innerHTML = `<div class="title-card-text"></div><div class="title-card-skip"></div>`
  root.append(el)
  const text = el.firstElementChild as HTMLDivElement
  const skipHint = el.lastElementChild as HTMLDivElement
  skipHint.textContent = TITLE_CARD.skip
  /** Aborts the step under way: the typing (completes the text), then the dwell and dim (continues). */
  let step: AbortController | null = null

  function layout() {
    text.innerHTML = ""
    text.style.transition = "none"
    text.style.opacity = "1"
    return TITLE_CARD.lines.map((line) => {
      const p = document.createElement("p")
      if (!line) p.className = "blank"
      const typed = document.createElement("span")
      const caret = document.createElement("i")
      const rest = document.createElement("span")
      rest.className = "rest"
      rest.textContent = line
      p.append(typed, caret, rest)
      text.append(p)
      return { p, typed, rest, line }
    })
  }

  return {
    el,
    /** First call completes the typing; the next continues into the intro. */
    skip() {
      step?.abort()
    },
    /** Types the prelude, holds, dims; resolves at the end, after a second skip, or when `signal` aborts (quit). */
    async play(signal: AbortSignal) {
      el.classList.remove("out")
      el.classList.add("on")
      skipHint.classList.remove("on")
      setTimeout(() => skipHint.classList.add("on"), 1500)
      const rows = layout()
      const base = 1 / TITLE_CARD.typeRate
      const at = (row: number | null) => rows.forEach((r, i) => r.p.classList.toggle("at", i === row))

      // Typing: one character per tick of an even clock; the caret blinks only while idle (lead, line ends).
      let typing = (step = new AbortController())
      const stop = AbortSignal.any([signal, typing.signal])
      at(0)
      text.classList.add("idle")
      await wait(TITLE_CARD.lead, stop)
      for (let i = 0; i < rows.length && !stop.aborted; i++) {
        const r = rows[i]!
        at(i)
        text.classList.remove("idle")
        for (let c = 1; c <= r.line.length && !stop.aborted; c++) {
          r.typed.textContent = r.line.slice(0, c)
          r.rest.textContent = r.line.slice(c)
          await wait(base, stop)
        }
        text.classList.add("idle")
        await wait(base * TITLE_CARD.lineEnd, stop)
      }
      // Done (or skipped): everything shown, the caret resting after the last line.
      for (const r of rows) {
        r.typed.textContent = r.line
        r.rest.textContent = ""
      }
      at(rows.length - 1)
      text.classList.add("idle")
      if (signal.aborted) return

      // Dwell, then dim; a skip here continues straight away.
      typing = step = new AbortController()
      const hold = AbortSignal.any([signal, typing.signal])
      await wait(TITLE_CARD.dwell, hold)
      if (!signal.aborted) {
        skipHint.classList.remove("on")
        text.style.transition = `opacity ${hold.aborted ? 0.6 : TITLE_CARD.dimTime}s ease`
        text.style.opacity = String(TITLE_CARD.dimTo)
        await wait(hold.aborted ? 0.6 : TITLE_CARD.dimTime, signal)
      }
      step = null
    },
    /** Fades the black away over `seconds` (the world shows through). */
    fadeOut(seconds = 1.6) {
      el.style.setProperty("--fade", `${seconds}s`)
      el.classList.add("out")
      setTimeout(() => el.classList.remove("on", "out"), seconds * 1000)
    },
    hide() {
      step?.abort()
      el.classList.remove("on", "out")
    },
  }
}
