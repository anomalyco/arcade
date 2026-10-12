// Main menu (lobby) plus the shared typographic menu component used by the spawn screen and pause menu.
// Design: numbered, stacked sentence-case items directly on the world; the selected item gets full opacity
// and a short orange rule; tiny mono metadata under the selection; ↑↓ Enter Esc (and ←→ for values).
import type { RoomConfig, RoomSummary } from "../sim/protocol"
import { DEFAULT_ROOM_CONFIG } from "../sim/protocol"
import type { Quality } from "../sim/types"
import { callsign, randomCallsign, settings, updateSettings } from "./settings"
import { getNet } from "./net-adapter"
import type { ControlScheme } from "../input"

export type StartRequest =
  | { mode: "quick" }
  | { mode: "join"; code: string }
  | { mode: "create"; config: Partial<RoomConfig> }
  | { mode: "offline"; config: RoomConfig }

export interface LobbyApi {
  show(): void
  hide(): void
  busy(text: string | null): void
  status(html: string): void
  refreshRooms(): void
}

/** Muted team colours (mirrors TEAM_COLORS in render/aircraft.ts; not imported to keep three.js out of the entry chunk). */
export const TEAM_COLORS = ["#3c6ea8", "#c98a2e", "#4e8a5a", "#b04a44"]
/** Lighter tints of the team colours for text over the world. */
export const TEAM_TINTS = ["#b4d0f0", "#f2c98a", "#b4dcba", "#efb2aa"]
export const TEAM_NAMES = ["Cobalt", "Amber", "Emerald", "Crimson"]

/** Small square swatch in the team colour. */
export function teamGlyph(team: number): string {
  return `<i class="sw" style="--c:${TEAM_COLORS[team]}" aria-hidden="true"></i>`
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export function toast(text: string, error = false): void {
  const host = $("toast")
  const el = document.createElement("div")
  el.textContent = text.toLowerCase()
  if (error) el.className = "err"
  host.appendChild(el)
  setTimeout(() => el.remove(), 3300)
  while (host.childElementCount > 4) host.firstElementChild!.remove()
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

// ---------------------------------------------------------------------------------------------- controls

// Mirrors CONTROL_SCHEMES / CONTROL_SCHEME_LABELS / controlScheme() / setControlScheme() from input.ts.
// Importing input.ts here would drag the whole Input module into the instant-paint entry chunk (+8 kB).
const CONTROL_SCHEMES: readonly ControlScheme[] = ["keys", "aim", "point", "battlefield"]
const CONTROL_SCHEME_LABELS: Record<ControlScheme, string> = { keys: "Keyboard flight + mouse aim (default)", aim: "Mouse-aim (instructor)", point: "Point & turn", battlefield: "Battlefield (mouse = roll)" }
const controlScheme = (): ControlScheme => settings.controlScheme === "aim" || settings.controlScheme === "battlefield" || settings.controlScheme === "point" ? settings.controlScheme : "keys"
const setControlScheme = (scheme: ControlScheme) => updateSettings({ controlStyle: scheme === "aim" || scheme === "point" ? "aim" : "direct", controlScheme: scheme })

const kb = (...keys: string[]) => keys.map(x => `<kbd>${x}</kbd>`).join("")

/** Default scheme rows: keyboard flies, mouse aims the guns. */
function keyFlightRows(): { title: string; rows: [string, string][] }[] {
  return [
    { title: "flight · keyboard + mouse aim", rows: [
      ["Pitch", `${kb("w")} nose down · ${kb("s")} nose up`],
      ["Roll · strafe (heli)", `${kb("a", "d")} · heli flips ${kb("←", "→")}`],
      ["Rudder / pedals", kb("q", "e")],
      ["Throttle", `${kb("shift")} up + boost · ${kb("z")} down · wheel`],
      ["Collective (heli)", `${kb("space")} up · ${kb("z")} down`],
      ["Airbrake · auto-hover", kb("x")],
    ] },
    { title: "combat", rows: [
      ["Aim guns", "mouse moves the gun reticle (push it to the edge to steer)"],
      ["Guns · missiles", `${kb("lmb")} · ${kb("rmb")} ${kb("v")}`], ["Flares · ability", `${kb("f")} · ${kb("r")}`],
      ["Switch seat", `${kb("1")} ${kb("2")} · gunners aim with the mouse`],
    ] },
    { title: "view & comms", rows: [
      ["Free-look · camera", `hold ${kb("c")} · ${kb("t")}`], ["Chat · scores · menu", `${kb("enter")} · ${kb("tab")} · ${kb("esc")}`],
    ] },
  ]
}

/** Control rows for a scheme, grouped into sections (help screen, pause menu). */
export function controlRows(scheme: ControlScheme = controlScheme()): { title: string; rows: [string, string][] }[] {
  if (scheme === "keys") return keyFlightRows()
  const flight: [string, string][] = scheme === "battlefield"
    ? [
        ["Nose up / down", `mouse ↑↓ (forward = down) · ${kb("↑")} down ${kb("↓")} up`],
        ["Roll", `mouse ←→ · ${kb("←", "→")}`],
        ["Yaw / pedals", `${kb("a", "d")} · ${kb("q", "e")}`],
      ]
    : scheme === "aim"
    ? [
        ["Steer", "move the mouse where you want to fly"],
        ["Roll (barrel rolls, inverted)", kb("q", "e")],
        ["Pitch override (loops)", `${kb("↓")} up ${kb("↑")} down`],
        ["Rudder / strafe (heli)", kb("a", "d")],
        ["Manual mouse (roll + pitch)", `hold ${kb("alt")} · toggle ${kb("m")}`],
      ]
    : [
        ["Turn", `mouse ←→ · ${kb("←", "→")}`],
        ["Nose up / down", `mouse ↑↓ · ${kb("↓")} up ${kb("↑")} down`],
        ["Roll", kb("q", "e")],
        ["Rudder / strafe (heli)", kb("a", "d")],
      ]
  flight.push(["Throttle / collective", kb("w", "s")], ["Boost · airbrake / auto-hover", `${kb("shift")} · ${kb("x")}`])
  return [
    { title: `flight · ${CONTROL_SCHEME_LABELS[scheme].toLowerCase()}`, rows: flight },
    { title: "combat", rows: [
      ["Guns", `${kb("lmb")} ${kb("space")}`], ["Missiles", `${kb("rmb")} ${kb("v")}`], ["Flares · ability", `${kb("f")} · ${kb("r")}`],
      ["Switch seat", `${kb("1")} ${kb("2")} · gunners aim with the mouse`],
    ] },
    { title: "view & comms", rows: [
      ["Free-look · camera", `hold ${kb("c")} · ${kb("t")}`], ["Chat · scores · menu", `${kb("enter")} · ${kb("tab")} · ${kb("esc")}`],
    ] },
  ]
}

/** Controls reference table for the current scheme. */
export function controlsTable(): string {
  return `<table class="keys">${controlRows().map(sec =>
    `<tr><th colspan="2">${escapeHtml(sec.title)}</th></tr>` + sec.rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")).join("")}</table>`
}

// ---------------------------------------------------------------------------------------------- menu

export interface MenuItem {
  label: string
  /** Mono line shown under the item while selected. */
  meta?: string | (() => string)
  /** Value shown at the end of the row (mono). */
  value?: () => string
  /** ←→ (and click) change the value. */
  adjust?: (dir: 1 | -1) => void
  /** Enter / click. */
  run?: () => void
  /** Inline text field: "value" sits at the row end, "label" replaces the label. */
  input?: { el: HTMLInputElement; at: "value" | "label" }
  disabled?: () => boolean
  /** Smaller row (secondary actions). */
  small?: boolean
}

export interface MenuScreen {
  /** Crumb above the list, e.g. "03 — create a lobby". */
  crumb?: string
  items?: MenuItem[]
  size?: "big" | "mid"
  /** Static content instead of (or after) items. */
  html?: string
  note?: string
  /** Key hints shown while this screen is on top. */
  hints?: [string, string][]
  /** Initial selection. */
  sel?: number
}

/**
 * A stack of typographic menu screens rendered into `host`. Keyboard: ↑↓ select, Enter run, ←→ adjust,
 * Esc back (or `onEscape` at the root). Hover selects; click runs/adjusts.
 */
export class MenuNav {
  private stack: { screen: MenuScreen; sel: number }[] = []
  private els: HTMLElement[] = []
  private metaEl: HTMLElement | null = null
  onEscape: (() => void) | null = null
  /** ←→ on an item without `adjust` (e.g. team switch on the spawn screen). */
  onSide: ((dir: 1 | -1) => void) | null = null
  onHints: ((hints: [string, string][]) => void) | null = null
  onMove: ((i: number) => void) | null = null

  constructor(readonly host: HTMLElement, private sound: (() => void) | null = null) {
    host.addEventListener("pointermove", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".mi")
      if (b?.dataset.i) this.select(Number(b.dataset.i), false)
    })
    host.addEventListener("click", e => {
      const t = e.target as HTMLElement
      const b = t.closest<HTMLElement>(".mi")
      if (!b?.dataset.i || t.tagName === "INPUT") return
      const i = Number(b.dataset.i)
      this.select(i, false)
      const arr = t.closest(".arr")
      this.activate(i, arr?.classList.contains("l") ? -1 : 1, !!arr)
    })
    host.addEventListener("focusin", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".mi")
      if (b?.dataset.i) this.select(Number(b.dataset.i), false)
    })
  }

  get depth(): number { return this.stack.length }
  get top(): MenuScreen | null { return this.stack[this.stack.length - 1]?.screen ?? null }
  get index(): number { return this.stack[this.stack.length - 1]?.sel ?? 0 }

  private item(i: number): MenuItem | undefined { return this.top?.items?.[i] }

  push(screen: MenuScreen): void { this.stack.push({ screen, sel: screen.sel ?? 0 }); this.render() }
  replace(screen: MenuScreen): void { this.stack[this.stack.length - 1] = { screen, sel: Math.min(this.index, (screen.items?.length ?? 1) - 1) }; this.render() }
  reset(screen: MenuScreen): void { this.stack = [{ screen, sel: screen.sel ?? 0 }]; this.render() }
  pop(): boolean { if (this.stack.length <= 1) return false; this.stack.pop(); this.render(); return true }

  /** Re-render values/meta without rebuilding (keeps input focus). */
  refresh(): void {
    const items = this.top?.items ?? []
    items.forEach((it, i) => {
      const el = this.els[i]
      if (!el) return
      el.classList.toggle("off", !!it.disabled?.())
      const v = el.querySelector<HTMLElement>(".v")
      if (v && it.value && !it.input) v.innerHTML = this.valueHtml(it)
    })
    this.paintMeta()
  }

  private valueHtml(it: MenuItem): string {
    const v = escapeHtml(it.value?.() ?? "")
    return it.adjust ? `<span class="arr l">‹</span>${v}<span class="arr">›</span>` : v
  }

  render(): void {
    const s = this.top
    if (!s) return
    const items = s.items ?? []
    this.host.innerHTML = `<div class="crumb">${s.crumb ?? ""}</div>` +
      (items.length ? `<div class="menu ${s.size ?? "big"}">${items.map((it, i) => {
        const label = it.input?.at === "label" ? "" : escapeHtml(it.label)
        return `<div class="mi${it.small ? " sm" : ""}" data-i="${i}" role="button" tabindex="-1"><span class="ix">${String(i + 1).padStart(2, "0")}</span><span class="rule"></span><span class="t">${label}</span><span class="v">${it.value && !it.input ? this.valueHtml(it) : ""}</span></div>`
      }).join("")}</div>` : "") + (s.html ?? "") + (s.note ? `<div class="note">${s.note}</div>` : "")
    this.els = Array.from(this.host.querySelectorAll<HTMLElement>(".mi"))
    items.forEach((it, i) => {
      if (!it.input) return
      const slot = this.els[i].querySelector(it.input.at === "label" ? ".t" : ".v")!
      slot.appendChild(it.input.el)
    })
    this.metaEl = null
    this.select(this.index, false, true)
    this.refresh()
    this.onHints?.(s.hints ?? (this.stack.length > 1 ? [["↑↓", "select"], ["enter", "confirm"], ["esc", "back"]] : [["↑↓", "select"], ["enter", "confirm"]]))
  }

  select(i: number, sound = true, force = false): void {
    const entry = this.stack[this.stack.length - 1]
    if (!entry) return
    const n = this.els.length
    if (!n) return
    i = Math.max(0, Math.min(n - 1, i))
    if (i === entry.sel && !force) return
    entry.sel = i
    this.els.forEach((el, k) => el.classList.toggle("sel", k === i))
    if (sound) this.sound?.()
    this.paintMeta()
    this.onMove?.(i)
  }

  private paintMeta(): void {
    const it = this.item(this.index)
    const el = this.els[this.index]
    const meta = typeof it?.meta === "function" ? it.meta() : it?.meta
    if (!meta || !el) { this.metaEl?.remove(); this.metaEl = null; return }
    if (!this.metaEl || this.metaEl.previousElementSibling !== el) {
      this.metaEl?.remove()
      this.metaEl = document.createElement("div")
      this.metaEl.className = "meta"
      el.after(this.metaEl)
    }
    if (this.metaEl.innerHTML !== meta) this.metaEl.innerHTML = meta
  }

  private activate(i: number, dir: 1 | -1 = 1, viaArrow = false): void {
    const it = this.item(i)
    if (!it || it.disabled?.()) return
    if (it.input && !it.run) { it.input.el.focus(); return }
    if (it.adjust && (viaArrow || !it.run)) { it.adjust(dir); this.sound?.(); this.refresh(); return }
    if (it.run) { this.sound?.(); it.run() }
  }

  /** Returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.top) return false
    const inInput = (e.target as HTMLElement)?.tagName === "INPUT"
    const items = this.top.items ?? []
    const step = (d: number) => {
      let i = this.index
      for (let k = 0; k < items.length; k++) {
        i = (i + d + items.length) % items.length
        if (!items[i].disabled?.()) break
      }
      this.select(i)
    }
    switch (e.key) {
      case "ArrowDown": if (inInput) (e.target as HTMLElement).blur(); step(1); return true
      case "ArrowUp": if (inInput) (e.target as HTMLElement).blur(); step(-1); return true
      case "ArrowLeft": case "ArrowRight": {
        if (inInput) return false
        const it = this.item(this.index), d = e.key === "ArrowLeft" ? -1 : 1
        if (it?.adjust) { it.adjust(d); this.sound?.(); this.refresh() } else this.onSide?.(d)
        return true
      }
      case "Enter": {
        if (inInput) {
          const it = this.item(this.index)
          ;(e.target as HTMLElement).blur()
          if (it?.run) it.run()
          return true
        }
        this.activate(this.index)
        return true
      }
      case "Escape":
        if (inInput) { (e.target as HTMLElement).blur(); return true }
        if (!this.pop()) this.onEscape?.()
        else this.sound?.()
        return true
    }
    return false
  }
}

/** Render key hints ("↑↓ select …") into a footer element. */
export function hintsHtml(hints: [string, string][]): string {
  return hints.map(([k, t]) => `<span><kbd>${escapeHtml(k)}</kbd> ${escapeHtml(t)}</span>`).join("")
}

const cycle = <T,>(list: readonly T[], cur: T, d: number): T => list[(list.indexOf(cur) + d + list.length) % list.length]

/** Settings screen (shared by the lobby and pause menu). */
export function settingsScreen(nav: MenuNav, onQuality: (q: Quality) => void, crumb = "settings"): MenuScreen {
  const qualities: Quality[] = ["low", "balanced", "high"]
  return {
    crumb, size: "mid",
    items: [
      { label: "Graphics", value: () => settings.quality, adjust: d => { const q = cycle(qualities, settings.quality, d); updateSettings({ quality: q }); onQuality(q) },
        meta: () => ({ low: "1× resolution · no shadows or post", balanced: "soft shadows · anti-aliasing", high: "full resolution · sharper shadows" })[settings.quality] },
      { label: "Sound", value: () => (settings.muted ? "off" : "on"), adjust: () => updateSettings({ muted: !settings.muted }) },
      { label: "Steering", value: () => CONTROL_SCHEME_LABELS[controlScheme()].replace(/ \(.*\)$/, "").toLowerCase(), adjust: d => setControlScheme(cycle(CONTROL_SCHEMES, controlScheme(), d)),
        meta: () => ({ keys: "keys fly, mouse aims the guns", point: "mouse turns and pitches the nose", battlefield: "mouse x rolls, a/d yaw", aim: "fly toward a mouse cursor" })[controlScheme()] },
      { label: "Mouse sensitivity", value: () => settings.sensitivity.toFixed(2), adjust: d => updateSettings({ sensitivity: Math.round(Math.max(0.2, Math.min(3, settings.sensitivity + d * 0.1)) * 100) / 100 }) },
      { label: "Invert mouse Y", value: () => (settings.invertY ? "on" : "off"), adjust: () => updateSettings({ invertY: !settings.invertY }), meta: "on = mouse away moves the nose down" },
      { label: "Controls", run: () => nav.push({ crumb: `${crumb} — controls`, html: controlsTable(), hints: [["esc", "back"]] }), meta: "full key reference" },
    ],
  }
}

// ---------------------------------------------------------------------------------------------- lobby

export function initLobby(opts: { onStart(req: StartRequest): void; onQuality(q: Quality): void; onClick?(): void }): LobbyApi {
  const lobby = $("lobby")
  const name = $<HTMLInputElement>("callsign")
  name.value = settings.name.toLowerCase()
  name.placeholder = randomCallsign().toLowerCase()
  name.addEventListener("input", () => updateSettings({ name: name.value.toUpperCase().slice(0, 16) }))
  name.addEventListener("blur", () => { name.value = settings.name.toLowerCase() })
  name.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") { e.stopPropagation(); name.blur() } })

  const hints = $("hints")
  const nav = new MenuNav($("screen"), () => opts.onClick?.())
  nav.onHints = h => { hints.innerHTML = hintsHtml(h) }

  let rooms: RoomSummary[] | null = null
  let roomErr = false
  const roomsMeta = () => roomErr ? "server unreachable · practice still works" : rooms === null ? "looking for lobbies…" : `online · ${rooms.length} ${rooms.length === 1 ? "lobby" : "lobbies"} open`

  // Create lobby
  const cfg = { ...DEFAULT_ROOM_CONFIG, bots: 0, timeLimit: DEFAULT_ROOM_CONFIG.timeLimit / 60 }
  const botCfg = { on: false, perTeam: 4, skill: 1 }
  const SKILLS = [{ name: "easy", v: 0.25 }, { name: "normal", v: 0.5 }, { name: "hard", v: 0.85 }]
  const nameIn = document.createElement("input")
  nameIn.maxLength = 32
  nameIn.value = cfg.name
  nameIn.spellcheck = false
  nameIn.addEventListener("input", () => { cfg.name = nameIn.value })
  const readConfig = (): RoomConfig => ({
    ...DEFAULT_ROOM_CONFIG, name: (cfg.name || DEFAULT_ROOM_CONFIG.name).slice(0, 32), teams: cfg.teams, bots: botCfg.on ? botCfg.perTeam : 0,
    ...(botCfg.on ? { botSkill: SKILLS[botCfg.skill].v } : {}),
    maxPerTeam: cfg.maxPerTeam, scoreLimit: cfg.scoreLimit, timeLimit: cfg.timeLimit * 60, listed: cfg.listed,
  })
  const scoreSteps = [25, 50, 75, 100, 150, 200, 300], timeSteps = [5, 10, 15, 20, 30, 45, 60]
  const createScreen = (): MenuScreen => ({
    crumb: "04 — <b>create a lobby</b>", size: "mid",
    hints: [["↑↓", "select"], ["←→", "change"], ["enter", "confirm"], ["esc", "back"]],
    items: [
      { label: "Bots", value: () => (botCfg.on ? "on" : "off"), adjust: () => { botCfg.on = !botCfg.on; nav.replace(createScreen()) },
        meta: () => botCfg.on ? "ai pilots fill each team; they make room as people join" : "humans only — turn on to fight ai pilots" },
      ...(botCfg.on ? [
        { label: "Bots per team", value: () => String(botCfg.perTeam), adjust: (d: 1 | -1) => { botCfg.perTeam = Math.max(1, Math.min(10, botCfg.perTeam + d)) },
          meta: "target pilots per team — each human who joins replaces a bot" },
        { label: "Bot skill", value: () => SKILLS[botCfg.skill].name, adjust: (d: 1 | -1) => { botCfg.skill = Math.max(0, Math.min(2, botCfg.skill + d)) } },
      ] as MenuItem[] : []),
      { label: "Name", input: { el: nameIn, at: "value" } },
      { label: "Teams", value: () => String(cfg.teams), adjust: d => { cfg.teams = Math.max(2, Math.min(4, cfg.teams + d)) } },
      { label: "Pilots per team", value: () => String(cfg.maxPerTeam), adjust: d => { cfg.maxPerTeam = Math.max(1, Math.min(10, cfg.maxPerTeam + d)) } },
      { label: "Score limit", value: () => String(cfg.scoreLimit), adjust: d => { cfg.scoreLimit = cycle(scoreSteps, scoreSteps.includes(cfg.scoreLimit) ? cfg.scoreLimit : 50, d) } },
      { label: "Time limit", value: () => `${cfg.timeLimit} min`, adjust: d => { cfg.timeLimit = cycle(timeSteps, timeSteps.includes(cfg.timeLimit) ? cfg.timeLimit : 15, d) } },
      { label: "Visibility", value: () => (cfg.listed ? "public" : "invite only"), adjust: () => { cfg.listed = !cfg.listed }, meta: () => cfg.listed ? "listed in browse lobbies" : "only people with the link can join" },
      { label: "Create online", run: () => opts.onStart({ mode: "create", config: readConfig() }), meta: "you get an invite link to share" },
      { label: "Play offline", small: true, run: () => opts.onStart({ mode: "offline", config: readConfig() }), meta: "same settings, solo, no server" },
    ],
  })

  // Join with code
  const codeIn = document.createElement("input")
  codeIn.maxLength = 8
  codeIn.placeholder = "code"
  codeIn.spellcheck = false
  codeIn.autocomplete = "off"
  codeIn.addEventListener("input", () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })
  const join = () => {
    const c = codeIn.value.trim().toUpperCase()
    if (!c) { codeIn.focus(); return }
    opts.onStart({ mode: "join", code: c })
  }
  const joinScreen = (): MenuScreen => ({
    crumb: "05 — <b>join with a code</b>", size: "big",
    items: [
      { label: "Code", input: { el: codeIn, at: "label" }, run: join, meta: "type the 4–8 character room code" },
      { label: "Join", run: join },
    ],
  })

  // Browse
  const browseScreen = (): MenuScreen => {
    const items: MenuItem[] = (rooms ?? []).map(r => ({
      label: r.name,
      value: () => `${r.players > r.humans ? "bots · " : ""}${r.players >= r.maxPlayers ? "full" : `${r.players}/${r.maxPlayers}`}`,
      meta: `${escapeHtml(r.code.toLowerCase())} · ${r.teams} teams · ${r.humans} pilot${r.humans === 1 ? "" : "s"}${r.players > r.humans ? ` · <b>bots</b>` : ""}`,
      disabled: () => r.players >= r.maxPlayers,
      run: () => opts.onStart({ mode: "join", code: r.code }),
    }))
    items.push({ label: "Refresh", small: true, run: () => refreshRooms(), meta: () => roomsMeta() })
    return {
      crumb: "06 — <b>browse lobbies</b>", size: "mid", items,
      note: rooms === null ? "looking for lobbies…" : roomErr ? "can't reach the server right now. <b>practice</b> still works offline." : rooms.length ? "" : "no open lobbies. <b>quick play</b> starts one.",
    }
  }

  const invite = new URLSearchParams(location.search).get("join")
  const inviteCode = invite ? invite.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) : ""
  if (inviteCode) codeIn.value = inviteCode

  const rootScreen = (): MenuScreen => ({
    size: "big",
    items: [
      ...(inviteCode ? [{ label: `Join ${inviteCode}`, run: () => opts.onStart({ mode: "join", code: inviteCode }), meta: "you were invited to this room" }] : []),
      { label: "Quick play", run: () => opts.onStart({ mode: "quick" }), meta: () => `join the fullest open lobby · ${roomsMeta()}` },
      { label: "Play with bots", run: () => opts.onStart({ mode: "offline", config: { ...DEFAULT_ROOM_CONFIG, name: "Bots", teams: 2, bots: 4, botSkill: 0.5, listed: false } }),
        meta: "offline · 2 teams · 4 ai pilots per team · normal skill" },
      { label: "Practice", run: () => opts.onStart({ mode: "offline", config: { ...DEFAULT_ROOM_CONFIG, name: "Practice", teams: 2, bots: 0, listed: false } }),
        meta: "solo free flight · no enemies" },
      { label: "Create a lobby", run: () => nav.push(createScreen()), meta: "bots on or off · teams · limits · privacy" },
      { label: "Join with a code", run: () => { nav.push(joinScreen()); codeIn.focus() }, meta: "a friend's room code" },
      { label: "Browse lobbies", run: () => { nav.push(browseScreen()); refreshRooms() }, meta: () => roomsMeta() },
      { label: "Settings", run: () => nav.push(settingsScreen(nav, opts.onQuality, "07 — <b>settings</b>")), meta: "graphics · sound · steering · controls" },
    ],
  })
  nav.reset(rootScreen())

  window.addEventListener("keydown", e => {
    if (lobby.hidden || !$("busy").hidden) return
    if (e.target === name) return
    if (nav.handleKey(e)) e.preventDefault()
  })

  let refreshing = false
  const refreshRooms = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const net = await getNet()
      rooms = await net.listRooms()
      roomErr = false
    } catch {
      rooms = []
      roomErr = true
    } finally {
      refreshing = false
    }
    if (nav.top?.crumb?.startsWith("06")) nav.replace(browseScreen())
    else nav.refresh()
  }
  refreshRooms()

  const statusEl = $("load-status")
  const busyEl = $("busy")
  return {
    show() { lobby.hidden = false; document.body.classList.add("in-lobby"); nav.reset(rootScreen()); refreshRooms() },
    hide() { lobby.hidden = true; document.body.classList.remove("in-lobby") },
    busy(text) {
      busyEl.hidden = text === null
      if (text !== null) busyEl.firstElementChild!.textContent = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
    },
    status(html) {
      if (/unavailable|failed/i.test(html)) { statusEl.hidden = false; statusEl.className = "status err"; statusEl.textContent = "3d unavailable — webgl failed to start" }
      else statusEl.hidden = /awake|ready/i.test(html)
    },
    refreshRooms,
  }
}

export { callsign }
