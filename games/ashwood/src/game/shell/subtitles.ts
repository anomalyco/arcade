import { installHudType } from "../../world/doors/hud"

// Story subtitles, shared by every system that speaks (the 3-08 radio call, later others): one line at a time at the
// bottom centre, the HUD's typewriter face on a soft dark backing so it reads over any surface (styles in
// src/style.css, `.story-subtitles`). A speaker tag before the line; no speaker sets it as an italic aside.
//
//   showSubtitle("YOU", "Ashwood Outpost to County.", 3.2)
//   hideSubtitle()

let el: HTMLDivElement | null = null
let timer = 0

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function ensure() {
  if (el || typeof document === "undefined") return el
  installHudType()
  el = document.createElement("div")
  el.className = "story-subtitles"
  el.setAttribute("aria-live", "polite")
  document.body.append(el)
  return el
}

/** Shows `text` (plain text) for `seconds`, replacing any line on screen. */
export function showSubtitle(speaker: string, text: string, seconds: number) {
  const e = ensure()
  if (!e) return
  clearTimeout(timer)
  e.innerHTML = `${speaker ? `<span class="who">${esc(speaker)}</span>` : ""}<span class="${speaker ? "line" : "line aside"}">${esc(text)}</span>`
  e.classList.add("on")
  timer = window.setTimeout(hideSubtitle, seconds * 1000)
}

export function hideSubtitle() {
  clearTimeout(timer)
  el?.classList.remove("on")
}
