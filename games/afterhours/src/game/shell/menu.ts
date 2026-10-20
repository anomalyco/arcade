import { CHARACTERS, saveCharacter, savedCharacter } from "../../playerb/body"
import { CREDITS, GAME_TITLE, HOME, MENU } from "./copy"
import { FOV_RANGE, SENSITIVITY_RANGE, type Quality, type ShellSettings } from "./settings"
import { createStatic } from "./static"
import { createTuner } from "./tuner"
import type { ControlsMode } from "./hints"

// The home screen and the pause menu (one overlay, two screens) with the Character, Settings and Credits panels.
// Pure DOM; play.ts decides what the buttons do.

export type MenuScreen = "home" | "pause" | "none"
type Panel = "main" | "character" | "settings" | "credits"

export type MenuHooks = {
  play(): void
  resume(): void
  quit(): void
  settingsChanged(s: ShellSettings): void
  characterChanged(id: string): void
  /** Any pointer or key input on the menu (unlocks audio). */
  input(): void
  /** Every frame the loading screen draws, with its signal strength (0..1). */
  tunerFrame(signal: number): void
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The documents' typewriter face (public/fonts/SpecialElite-hud.woff2) for the menu and title card. */
/** The menu's faces: the typewriter (items, subtitle, title card) and Rubik Glitch for the ASHWOOD title. */
function registerFont() {
  const faces = [
    new FontFace("Static Type", `url(${new URL("fonts/SpecialElite-hud.woff2", document.baseURI).href})`, { display: "swap" }),
    new FontFace("Ashwood Title", `url(${new URL("fonts/RubikGlitch-title.woff2", document.baseURI).href})`, { display: "block" }),
  ]
  for (const face of faces) {
    document.fonts.add(face)
    void face.load().catch(() => {})
  }
}

export function createMenu(root: HTMLElement, settings: ShellSettings, hooks: MenuHooks) {
  registerFont()
  const el = document.createElement("div")
  el.id = "shell"
  el.dataset.screen = "home"
  el.dataset.world = "loading"
  el.dataset.panel = "main"
  el.innerHTML = `
    <canvas class="shell-tuner" aria-hidden="true"></canvas>
    <canvas class="shell-static" aria-hidden="true"></canvas>
    <div class="shell-veil" aria-hidden="true"></div>
    <div class="shell-osd shell-osd-tl" aria-hidden="true">${esc(HOME.osdChannel)}</div>
    <div class="shell-osd shell-osd-bl" aria-hidden="true">${esc(HOME.osdStamp)}</div>
    <main class="shell-main">
      <h1 class="shell-title" data-text="${esc(GAME_TITLE)}">${esc(GAME_TITLE)}</h1>
      <div class="shell-sub">${esc(HOME.subtitle)}</div>
      <div class="shell-heading">${esc(MENU.paused)}</div>
      <nav class="shell-nav" data-panel="main"></nav>
      <section class="shell-panel" data-panel="character"></section>
      <section class="shell-panel" data-panel="settings"></section>
      <section class="shell-panel" data-panel="credits"></section>
    </main>
    <div class="shell-prompt">${esc(HOME.prompt)}</div>
    <div class="shell-load"><span></span></div>`
  root.append(el)
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!
  const nav = $<HTMLElement>(".shell-nav")
  const loadLabel = $<HTMLElement>(".shell-load span")
  const noise = createStatic($<HTMLCanvasElement>(".shell-static"))
  const tuner = createTuner($<HTMLCanvasElement>(".shell-tuner"), hooks.tunerFrame)
  tuner.start()

  let panel: Panel = "main"
  let screen: MenuScreen = "home"
  let waiting = false

  const button = (label: string, onClick: () => void, cls = "") => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = cls
    b.textContent = label
    b.addEventListener("click", () => {
      hooks.input()
      onClick()
    })
    return b
  }

  const playButton = button(MENU.play, () => {
    hooks.play()
  }, "shell-play")
  // The press shows at once (pointerdown, before the click and before the title card fades up), so Play never looks dead.
  const starting = (on: boolean) => {
    playButton.classList.toggle("starting", on)
    playButton.textContent = on ? MENU.starting : MENU.play
    // A press that never became a click (dragged off the button): back to Play.
    if (on) setTimeout(() => screen === "home" && !playButton.classList.contains("waiting") && starting(false), 2000)
  }
  playButton.addEventListener("pointerdown", (e) => e.button === 0 && starting(true))
  playButton.addEventListener("keydown", (e) => (e.code === "Enter" || e.code === "Space") && starting(true))
  function renderNav() {
    nav.replaceChildren()
    if (screen === "home") {
      nav.append(playButton, button(MENU.character, () => open("character")), button(MENU.settings, () => open("settings")), button(MENU.credits, () => open("credits")))
    } else {
      nav.append(button(MENU.resume, () => hooks.resume()), button(MENU.settings, () => open("settings")), button(MENU.quit, () => hooks.quit()))
    }
  }

  // Character: the roster (shared with bodyb.html and the Lab through localStorage).
  const charPanel = $<HTMLElement>('.shell-panel[data-panel="character"]')
  function renderCharacters() {
    const picked = savedCharacter()
    charPanel.replaceChildren()
    const list = document.createElement("div")
    list.className = "shell-list"
    for (const c of CHARACTERS) {
      const b = button(c.name, () => {
        saveCharacter(c.id)
        hooks.characterChanged(c.id)
        renderCharacters()
        ;(charPanel.querySelector(`[data-id="${c.id}"]`) as HTMLElement | null)?.focus()
      }, c.id === picked ? "picked" : "")
      b.dataset.id = c.id
      b.setAttribute("aria-pressed", String(c.id === picked))
      list.append(b)
    }
    charPanel.append(heading(MENU.character), list, button(MENU.back, () => open("main"), "shell-back"))
  }

  function heading(text: string) {
    const h = document.createElement("h2")
    h.textContent = text
    return h
  }

  // Settings.
  const setPanel = $<HTMLElement>('.shell-panel[data-panel="settings"]')
  function changed() {
    hooks.settingsChanged(settings)
  }
  function slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, set: (v: number) => void) {
    const row = document.createElement("label")
    row.className = "shell-row"
    row.innerHTML = `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output></output>`
    const input = row.querySelector("input")!
    const out = row.querySelector("output")!
    out.textContent = fmt(value)
    input.addEventListener("input", () => {
      const v = Number(input.value)
      out.textContent = fmt(v)
      set(v)
      changed()
    })
    return row
  }
  function choice<T extends string | boolean>(label: string, options: { value: T; label: string }[], get: () => T, set: (v: T) => void) {
    const row = document.createElement("div")
    row.className = "shell-row"
    row.innerHTML = `<span>${esc(label)}</span>`
    const group = document.createElement("div")
    group.className = "shell-choice"
    group.setAttribute("role", "group")
    group.setAttribute("aria-label", label)
    const sync = () => {
      for (const b of group.children) {
        const on = (b as HTMLElement).dataset.value === String(get())
        b.classList.toggle("picked", on)
        b.setAttribute("aria-pressed", String(on))
      }
    }
    for (const o of options) {
      const b = button(o.label, () => {
        set(o.value)
        sync()
        changed()
      })
      b.dataset.value = String(o.value)
      group.append(b)
    }
    sync()
    row.append(group)
    return row
  }
  function renderSettings() {
    const pct = (v: number) => `${Math.round(v * 100)}%`
    setPanel.replaceChildren(
      heading(MENU.settings),
      slider("Master volume", settings.master, 0, 1, 0.05, pct, (v) => (settings.master = v)),
      slider("Sound effects", settings.sfx, 0, 1, 0.05, pct, (v) => (settings.sfx = v)),
      slider("Ambience", settings.ambience, 0, 1, 0.05, pct, (v) => (settings.ambience = v)),
      slider("Menu static", settings.menuStatic, 0, 1, 0.05, pct, (v) => (settings.menuStatic = v)),
      slider("Mouse sensitivity", settings.sensitivity, SENSITIVITY_RANGE[0], SENSITIVITY_RANGE[1], 0.05, (v) => `${v.toFixed(2)}×`, (v) => (settings.sensitivity = v)),
      choice("Invert Y", [{ value: false, label: "Off" }, { value: true, label: "On" }], () => settings.invertY, (v) => (settings.invertY = v)),
      slider("Field of view", settings.fov, FOV_RANGE[0], FOV_RANGE[1], 1, (v) => `${v}°`, (v) => (settings.fov = v)),
      choice<ControlsMode>("Show controls", [{ value: "always", label: "Always" }, { value: "auto", label: "Fade after a while" }, { value: "off", label: "Off" }], () => settings.controls, (v) => (settings.controls = v)),
      choice<Quality>("Graphics", [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }], () => settings.quality, (v) => (settings.quality = v)),
      button(MENU.back, () => open("main"), "shell-back"),
    )
  }

  // Credits: the CC BY attribution list straight from public/models/CREDITS.md, plus the fixed notices in copy.ts.
  const credPanel = $<HTMLElement>('.shell-panel[data-panel="credits"]')
  let creditsLoaded = false
  function renderCredits() {
    const body = document.createElement("div")
    body.className = "shell-credits"
    const p = (text: string, cls = "") => `<p${cls ? ` class="${cls}"` : ""}>${esc(text)}</p>`
    body.innerHTML = [p(CREDITS.intro), p(CREDITS.mixamo), p(CREDITS.cmu), p(CREDITS.textures), p(CREDITS.font), p(CREDITS.titleFont), `<h3>${esc(CREDITS.modelsHeading)}</h3><ul class="shell-models"><li>…</li></ul>`, p(CREDITS.cc0)].join("")
    credPanel.replaceChildren(heading(MENU.credits), body, button(MENU.back, () => open("main"), "shell-back"))
    if (creditsLoaded) return
    creditsLoaded = true
    fetch(new URL("models/CREDITS.md", document.baseURI))
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((md) => {
        const section = md.split(/^## Required attribution.*$/m)[1] ?? ""
        const items = [...section.matchAll(/^- "(.+?)" by (.+?) \((https?:[^)]+)\), (CC [^,]+)/gm)].map(
          ([, title, author, url, licence]) => `<li><a href="${esc(url!)}" target="_blank" rel="noopener">“${esc(title!)}”</a> by ${esc(author!)} <span>${esc(licence!)}</span></li>`,
        )
        el.querySelector(".shell-models")!.innerHTML = items.join("")
        modelsHtml = items.join("")
      })
      .catch(() => {
        creditsLoaded = false
      })
  }
  let modelsHtml = ""

  function open(next: Panel) {
    panel = next
    el.dataset.panel = next
    if (next === "character") renderCharacters()
    if (next === "settings") renderSettings()
    if (next === "credits") {
      renderCredits()
      if (modelsHtml) el.querySelector(".shell-models")!.innerHTML = modelsHtml
    }
    focusFirst()
  }

  function focusFirst() {
    const scope = panel === "main" ? nav : el.querySelector<HTMLElement>(`.shell-panel[data-panel="${panel}"]`)!
    const target = scope.querySelector<HTMLElement>(".picked, button:not(:disabled), input") ?? scope.querySelector<HTMLElement>("button")
    target?.focus({ preventScroll: true })
  }

  el.addEventListener("pointerdown", () => hooks.input())
  el.addEventListener("pointermove", (e) => {
    const b = (e.target as HTMLElement).closest?.("button")
    if (b && el.contains(b) && document.activeElement !== b) b.focus({ preventScroll: true })
  })

  /** Keyboard navigation (the shell routes keys here while the menu is up). Returns true when handled. */
  function key(e: KeyboardEvent): boolean {
    if (screen === "none") return false
    hooks.input()
    if (e.code === "Escape") {
      if (panel !== "main") open("main")
      else if (screen === "pause") hooks.resume()
      return true
    }
    if (e.code === "ArrowDown" || e.code === "ArrowUp") {
      const scope = panel === "main" ? nav : el.querySelector<HTMLElement>(`.shell-panel[data-panel="${panel}"]`)!
      const items = [...scope.querySelectorAll<HTMLElement>("button, input")]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(i + (e.code === "ArrowDown" ? 1 : -1) + items.length) % items.length]
      next?.focus({ preventScroll: true })
      e.preventDefault()
      return true
    }
    return false
  }

  renderNav()

  return {
    el,
    key,
    get screen() {
      return screen
    },
    show(next: MenuScreen) {
      screen = next
      el.dataset.screen = next
      if (next === "none") {
        noise.stop()
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        return
      }
      if (el.dataset.world === "ready") noise.start()
      starting(false)
      renderNav()
      open("main")
    },
    /** World boot progress (0..1). */
    progress(label: string, f: number) {
      const pct = Math.floor(Math.min(1, f) * 100)
      loadLabel.textContent = `${waiting ? MENU.waiting : HOME.loading} · ${pct}%`
      tuner.progress(f)
      el.dataset.stage = label
    },
    /** Play was pressed before the world finished loading. */
    setWaiting(on: boolean) {
      waiting = on
      playButton.classList.toggle("waiting", on)
      playButton.textContent = on ? MENU.waiting : MENU.play
    },
    /** Copies the world's frame into the tuner's picture (right after it was drawn). */
    snapshot(source: HTMLCanvasElement) {
      if (el.dataset.world !== "ready") tuner.snapshot(source)
    },
    /** The world is ready: the picture locks in, then the OSD and the title come up. */
    async lock() {
      el.dataset.world = "locking"
      loadLabel.textContent = HOME.ready
      await tuner.lock()
      el.dataset.world = "ready"
      if (screen !== "none") {
        noise.start()
        focusFirst()
      }
      setTimeout(() => tuner.stop(), 900)
    },
    /** Sound has started: the "press any key" prompt goes. */
    soundOn() {
      el.dataset.sound = "on"
    },
    fail(message: string) {
      el.dataset.world = "failed"
      loadLabel.textContent = message
      playButton.disabled = true
    },
  }
}
