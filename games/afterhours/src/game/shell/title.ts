import { TITLE_CARD } from "./copy"

// The title card: typewriter lines on black, card by card, with slow fades (copy and timings in copy.ts). Resolves
// when it has finished or `skip` fires; the black stays up (the caller fades it away when the intro starts).

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

  async function card(lines: string[], hold: number, signal: AbortSignal) {
    text.innerHTML = ""
    text.style.transition = "none"
    text.style.opacity = "0"
    const spans = lines.map((_, i) => {
      const p = document.createElement("p")
      if (i === 0) p.className = "lead"
      const typed = document.createElement("span")
      const caret = document.createElement("i")
      p.append(typed, caret)
      text.append(p)
      return { p, typed, caret }
    })
    void text.offsetWidth
    text.style.transition = `opacity ${TITLE_CARD.fadeIn}s ease`
    text.style.opacity = "1"
    for (let i = 0; i < lines.length && !signal.aborted; i++) {
      const line = lines[i]!
      const s = spans[i]!
      s.p.classList.add("typing")
      for (let c = 1; c <= line.length && !signal.aborted; c++) {
        s.typed.textContent = line.slice(0, c)
        // A typewriter's rhythm: a little longer after punctuation and between words.
        const ch = line[c - 1]
        const k = ch === "," || ch === "." ? 5 : ch === " " ? 1.6 : 0.7 + Math.random() * 0.6
        await wait(k / TITLE_CARD.typeRate, signal)
      }
      s.p.classList.remove("typing")
      if (i < lines.length - 1) await wait(TITLE_CARD.linePause, signal)
    }
    spans.at(-1)?.p.classList.add("typing")
    await wait(hold, signal)
    text.style.transition = `opacity ${TITLE_CARD.fadeOut}s ease`
    text.style.opacity = "0"
    await wait(TITLE_CARD.fadeOut, signal)
  }

  return {
    el,
    /** Plays every card; resolves at the end or as soon as `signal` aborts (skip / quit). */
    async play(signal: AbortSignal) {
      el.classList.remove("out")
      el.classList.add("on")
      skipHint.classList.remove("on")
      setTimeout(() => skipHint.classList.add("on"), 1500)
      await wait(TITLE_CARD.lead, signal)
      const cards = TITLE_CARD.cards
      for (let i = 0; i < cards.length && !signal.aborted; i++) {
        await card(cards[i]!.lines, cards[i]!.hold, signal)
        if (i < cards.length - 1) await wait(TITLE_CARD.gap, signal)
      }
      text.style.transition = `opacity 0.4s ease`
      text.style.opacity = "0"
      skipHint.classList.remove("on")
      if (!signal.aborted) await wait(TITLE_CARD.tail, signal)
    },
    /** Fades the black away over `seconds` (the world shows through). */
    fadeOut(seconds = 1.6) {
      el.style.setProperty("--fade", `${seconds}s`)
      el.classList.add("out")
      setTimeout(() => el.classList.remove("on", "out"), seconds * 1000)
    },
    hide() {
      el.classList.remove("on", "out")
    },
  }
}
