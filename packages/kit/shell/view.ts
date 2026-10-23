import { KEY_LABEL_OPTIONS, onKeyLayoutChange } from "../client/controls"
import { keyCapHtml, keyPromptHtml } from "../client/key-cap"
import type { QualityMode, QualityTier } from "../quality"
import type { ShellFlow } from "./flow"
import type { ShellLobby } from "./lobby"
import type { ShellLoading } from "./page"
import type { ShellRow, ShellSettings } from "./settings"
import type { ShellVoice } from "./voice"

/** A speaker with two waves and a cross; `data-level` on an ancestor shows muted, low or high. */
export const SPEAKER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="as-w1" d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path class="as-w2" d="M18.5 7a7 7 0 0 1 0 10"/><path class="as-x" d="M16 9l5 6M21 9l-5 6"/></g></svg>`

export type ShellVolumeLevel = "muted" | "low" | "high"

/** The icon a volume shows: muted (or at 0), low (under half) or high. */
export const volumeLevel = (muted: boolean, volume: number): ShellVolumeLevel => (muted || volume <= 0 ? "muted" : volume < 50 ? "low" : "high")

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const QUALITY: readonly [QualityMode, string][] = [["auto", "Auto"], ["high", "High"], ["balanced", "Balanced"], ["low", "Low"]]
const TIER: Record<QualityTier, string> = { ultra: "Ultra", high: "High", balanced: "Balanced", low: "Low" }

/** What the shell's overlay is showing; `null` in play. Themes read it as `data-phase` on `.arcade-shell`. */
export type ShellPhase = "loading" | "title" | "paused" | "settings"

export type ShellViewOptions = {
  voice?: ShellVoice
  title: string
  subtitle?: string
  /** Play alone's label and small print (`Play alone` / `you and three campers`). */
  soloLabel?: string
  soloNote?: string
  /** Play with friends' small print. */
  friendsNote?: string
  /** Quick match's label (`Quick play`). */
  quickLabel?: string
  /** The title's primary button when there is no lobby (`Begin`, `Play`). */
  playLabel?: string
  /** Resume's label (`Back to the woods`). */
  resumeLabel?: string
  /** Leave's label (`Leave room`, `Quit to title`); hidden when null. */
  leaveLabel?: string | null
  /** The line under the wordmark on the Escape menu (default `Paused`); `""` keeps the subtitle there. */
  pausedLabel?: string
  /** Whether the title asks for a name (games with rooms). */
  askName?: boolean
  /** The game's controls as key-cap prompts, shown in the hint row along the bottom of the title and Escape menu. */
  controls?: () => string
  /** Whether M toggles mute right now (the cap is shown beside the volume and on Settings' Mute). */
  muteKey?: boolean | (() => boolean)
  /**
   * A theme's own furniture around the menu (a camcorder's OSD, a case file's stamp): HTML drawn full-screen, under
   * the menu and without pointer events, redrawn when the phase changes. Style it from the game's CSS.
   */
  decor?: (phase: ShellPhase) => string
}

/**
 * The shell's default DOM, drawn over the game's own world rather than in a box: the wordmark at a fixed place, a
 * column of menu items under it, a hint row of the game's controls and the master volume along the bottom. Loading,
 * the title, the Escape menu and Settings share that layout, so the wordmark never moves and Play and Resume sit on
 * the same spot. Styled by `--shell-*` variables on `.arcade-shell` (or any ancestor), so a game restyles without
 * forking behaviour; `data-phase` and `decor` let a theme dress each screen. Everything it shows comes from the
 * headless models; every control calls their setters.
 */
export class ShellView {
  readonly root: HTMLDivElement
  /** Game content for the title (survivor picks, a mode chooser), above the menu; kept across redraws. */
  readonly titleSlot: HTMLDivElement
  /** Game content for the Escape menu under its items (Outbreak's seed and restart tools); kept across redraws. */
  readonly pauseSlot: HTMLDivElement
  private readonly overlay: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly sub: HTMLParagraphElement
  private readonly foot: HTMLDivElement
  private readonly decor: HTMLDivElement
  private readonly pill: HTMLDivElement
  private readonly curtain: HTMLDivElement
  private readonly aside: HTMLDivElement
  private layout = ""
  private phase: ShellPhase | null | undefined = undefined
  private decorPhase: ShellPhase | null = null
  private copied = 0
  private readonly offs: (() => void)[] = []
  private raf = 0
  private curtainTimer = 0
  private footShown = ""

  constructor(
    parent: HTMLElement,
    private readonly o: ShellViewOptions,
    private readonly settings: ShellSettings,
    private readonly flow: ShellFlow,
    private readonly lobby: ShellLobby | null,
    private readonly loading: ShellLoading | null,
  ) {
    installShellStyles(parent.ownerDocument)
    const doc = parent.ownerDocument
    this.root = doc.createElement("div")
    this.root.className = "arcade-shell"
    this.root.innerHTML = `<div class="as-loading" hidden></div><div class="as-overlay" inert><div class="as-decor" aria-hidden="true"></div><div class="as-frame"><div class="as-brand"><h1 class="as-title">${esc(o.title)}</h1><p class="as-sub" role="status"></p></div><div class="as-card" role="dialog" aria-modal="true"></div><div class="as-aside"></div></div><div class="as-foot"></div></div><div class="as-pill" role="status" hidden></div>`
    parent.append(this.root)
    this.overlay = this.root.querySelector(".as-overlay")!
    this.card = this.root.querySelector(".as-card")!
    this.sub = this.root.querySelector(".as-sub")!
    this.foot = this.root.querySelector(".as-foot")!
    this.decor = this.root.querySelector(".as-decor")!
    this.pill = this.root.querySelector(".as-pill")!
    this.curtain = this.root.querySelector(".as-loading")!
    this.aside = this.root.querySelector(".as-aside")!
    this.titleSlot = doc.createElement("div")
    this.titleSlot.className = "as-slot"
    this.pauseSlot = doc.createElement("div")
    this.pauseSlot.className = "as-slot"
    this.overlay.addEventListener("click", (e) => {
      const t = e.target as HTMLElement
      // A click on the world (anywhere but a control) plays again from the Escape menu: a click is what pointer lock needs.
      if (this.flow.overlay === "paused" && !this.flow.settingsOpen && !t.closest("button, input, select, label, a, .as-slot, .as-vol, [data-act]")) this.flow.resume()
      else this.click(e)
    })
    this.card.addEventListener("scroll", () => this.fade(), { passive: true })
    doc.defaultView?.addEventListener("resize", this.onResize)
    this.overlay.addEventListener("input", (e) => this.input(e))
    this.overlay.addEventListener("change", (e) => this.input(e))
    this.overlay.addEventListener("keydown", (e) => {
      const t = e.target as HTMLInputElement
      if (e.key === "Enter" && t.dataset.field === "code") this.lobby?.join(t.value)
      else if (e.key === "Enter" && t.dataset.field === "name") t.blur()
    })
    // A range keeps focus after a drag; letting go hands the keys back (M, Escape, the game's own).
    this.overlay.addEventListener("pointerup", (e) => {
      const t = e.target as HTMLInputElement
      if (t.type === "range") t.blur()
    })
    const redraw = () => this.render()
    this.offs.push(settings.subscribe(redraw), flow.subscribe(redraw), onKeyLayoutChange(() => this.render(true)))
    if (o.voice) this.offs.push(o.voice.subscribe(() => this.render()))
    if (lobby) this.offs.push(lobby.subscribe(redraw))
    if (loading) this.offs.push(loading.subscribe(redraw))
    // `blocked` (the Lab panel) changes outside the shell; one boolean read a frame keeps the overlay honest.
    let blocked = flow.overlay
    const tick = () => {
      if (flow.overlay !== blocked) {
        blocked = flow.overlay
        this.render()
      } else if (this.phase === "settings") this.syncQuality()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    // The scroll fade is measured when the menu's content changes (a game's slot included), never per frame.
    const win = doc.defaultView
    if (win?.MutationObserver) {
      const content = new win.MutationObserver(() => this.fade())
      content.observe(this.card, { childList: true, subtree: true })
      this.offs.push(() => content.disconnect())
    }
    this.render()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.curtainTimer)
    this.root.ownerDocument.defaultView?.removeEventListener("resize", this.onResize)
    for (const off of this.offs) off()
    this.root.remove()
  }

  /** Redraws now (the game's own state shown in a section changed). */
  render(force = false): void {
    this.renderPill()
    const loading = Boolean(this.loading && !this.loading.finished)
    const overlay = this.flow.overlay
    const phase: ShellPhase | null = loading ? "loading" : overlay === null ? null : this.flow.settingsOpen ? "settings" : overlay
    const changed = phase !== this.phase
    // The first paint is the resting state: only a change of screen animates.
    const enter = changed && this.phase !== undefined && phase !== null
    this.phase = phase
    this.root.dataset.screen = loading ? "loading" : overlay ?? "playing"
    // Also on <html>, so a game can step its own HUD aside while the shell is up (`html[data-shell] #hud`).
    const html = this.root.ownerDocument.documentElement
    if (phase) this.root.dataset.phase = html.dataset.shell = phase
    else {
      delete this.root.dataset.phase
      delete html.dataset.shell
    }
    this.overlay.toggleAttribute("data-open", phase !== null)
    this.overlay.inert = phase === null
    if (phase === null) {
      // The button that started play mustn't keep focus: Space or Enter in the game would press it again.
      const focused = this.root.ownerDocument.activeElement as HTMLElement | null
      if (focused && this.overlay.contains(focused)) focused.blur()
      return this.renderCurtain(loading)
    }
    if (phase !== this.decorPhase && this.o.decor) this.decor.innerHTML = this.o.decor(phase)
    this.decorPhase = phase
    const l = this.lobby
    const key = [phase, this.muteCap(), l?.room, l?.linkedRoom, l?.busy, l?.connection, JSON.stringify(l?.players ?? []), this.copied, this.settings.quality?.mode, this.settings.reduceMotion, this.settings.keyLabels, l?.hasSolo, this.o.voice?.enabled, this.o.voice?.pending, this.o.voice?.error].join("|")
    if (force || key !== this.layout) {
      this.layout = key
      this.card.toggleAttribute("data-enter", enter)
      this.card.innerHTML = phase === "settings" ? this.settingsHtml() : phase === "title" ? this.titleHtml() : phase === "paused" ? this.pauseHtml() : this.loadingHtml()
      if (phase === "paused") this.card.querySelector(".as-slot-host")?.replaceWith(this.pauseSlot)
      // The title's game content (picks, a roster, stats) sits beside the menu, so the menu starts where Resume does.
      if (phase === "title") this.aside.replaceChildren(this.titleSlot)
      else this.aside.replaceChildren()
      this.aside.toggleAttribute("data-enter", enter)
      // Items arrive one after another, top to bottom (`--i` scales `--shell-stagger`).
      ;[...this.card.children].forEach((el, i) => (el as HTMLElement).style.setProperty("--i", String(i)))
      if (changed) this.card.scrollTop = 0
    }
    // The hint row and the M cap follow the game (a flare used up, M handed to the map) without a rebuild a frame.
    const foot = this.footHtml()
    if (force || foot !== this.footShown) {
      this.footShown = foot
      this.foot.innerHTML = foot
    }
    if (changed) {
      // Restart the bottom row's entrance (it stays mounted between screens).
      this.foot.removeAttribute("data-enter")
      if (enter) {
        void this.foot.offsetWidth
        this.foot.setAttribute("data-enter", "")
      }
    }
    this.renderCurtain(loading)
    this.sync()
    this.fade()
  }

  private readonly onResize = () => this.fade()

  /** Whether the M cap shows: M mutes right now. */
  private muteCap(): boolean {
    const m = this.o.muteKey
    return typeof m === "function" ? m() : m !== false
  }

  /** Marks which edges of a scrolling menu have more content, for the CSS fade. */
  private fade(): void {
    const c = this.card
    const over = c.scrollHeight - c.clientHeight > 1
    const start = over && c.scrollTop > 1
    const end = over && c.scrollTop + c.clientHeight < c.scrollHeight - 1
    const fade = start && end ? "both" : start ? "start" : end ? "end" : ""
    if (c.dataset.fade !== fade) c.dataset.fade = fade
    const hints = this.foot.querySelector<HTMLElement>(".as-controls")
    if (hints) {
      const more = hints.scrollWidth - hints.clientWidth > 1
      if (hints.dataset.fade !== String(more)) hints.dataset.fade = String(more)
    }
  }

  private sync(): void {
    const s = this.settings
    const voice = this.o.voice
    if (voice) {
      for (const el of this.card.querySelectorAll<HTMLInputElement>("[data-voice]")) {
        const kind = el.dataset.voice
        if (kind === "enabled") el.checked = voice.enabled
        if (kind === "volume") {
          const v = Math.round(voice.volume * 100)
          if (el.ownerDocument.activeElement !== el) el.value = String(v)
          const out = el.parentElement?.querySelector("output")
          if (out) out.textContent = `${v}%`
        }
      }
      for (const b of this.card.querySelectorAll<HTMLButtonElement>("[data-act=voice-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === voice.mode))
      const mic = this.card.querySelector<HTMLElement>("[data-act=voice-mic]")
      if (mic) { mic.textContent = voice.micMuted ? "Unmute mic" : "Mute mic"; mic.setAttribute("aria-pressed", String(voice.micMuted)) }
      for (const el of this.card.querySelectorAll<HTMLInputElement>("[data-voice-player]")) el.checked = voice.muted.has(el.dataset.voicePlayer!)
    }
    for (const input of this.overlay.querySelectorAll<HTMLInputElement>("input[data-vol]")) {
      const v = s.volume(input.dataset.vol as never)
      if (input.ownerDocument.activeElement !== input) input.value = String(v)
      const out = input.parentElement?.querySelector("output")
      if (out) out.textContent = input.dataset.vol === "master" && s.muted ? "Muted" : `${v}%`
    }
    for (const b of this.overlay.querySelectorAll<HTMLButtonElement>("[data-act=mute]")) {
      b.setAttribute("aria-pressed", String(s.muted))
      const label = b.querySelector(".as-mute-label")
      if (label) label.textContent = s.muted ? "Muted" : "Mute"
    }
    this.root.dataset.muted = String(s.muted)
    const vol = this.foot.querySelector<HTMLElement>(".as-vol")
    if (vol) vol.dataset.level = volumeLevel(s.muted, s.volume("master"))
    this.syncQuality()
    for (const section of s.sections)
      for (const row of section.rows) {
        const el = this.card.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-row="${section.id}.${row.id}"]`)
        if (!el || el.ownerDocument.activeElement === el) continue
        if (row.kind === "toggle") (el as HTMLInputElement).checked = row.get()
        else el.value = String(row.get())
        const out = el.parentElement?.querySelector("output")
        if (out && row.kind === "range") out.textContent = `${row.get()}${row.unit ?? ""}`
      }
    // Each slider's fill as a percentage, for themes that draw their own track.
    for (const r of this.overlay.querySelectorAll<HTMLInputElement>("input[type=range]")) {
      const min = Number(r.min) || 0, max = Number(r.max) || 100
      r.style.setProperty("--v", `${(((Number(r.value) - min) / (max - min || 1)) * 100).toFixed(1)}%`)
    }
    // The line under the wordmark: what needs saying now (a bad code, a refused lock), else the screen's own line.
    // It holds two lines' height whatever it says, so the menu under it never moves.
    const titleVoice = this.phase === "title" ? voice : undefined
    const message = (this.phase === "title" && this.lobby?.message) || titleVoice?.error || (this.flow.lockRefused && this.phase !== "settings" ? "Click again to play." : "")
    const line = message || (titleVoice?.pending ? "Connecting microphone…" : this.subText())
    if (this.sub.textContent !== line) this.sub.textContent = line
    this.sub.classList.toggle("as-alert", Boolean(message))
    this.root.toggleAttribute("data-arming", this.flow.arming)
    const name = this.card.querySelector<HTMLInputElement>("input[data-field=name]")
    if (name && this.lobby && name.ownerDocument.activeElement !== name) name.value = this.lobby.name
  }

  private subText(): string {
    if (this.phase === "settings") return "Settings"
    if (this.phase === "paused" && this.o.pausedLabel !== "") return this.o.pausedLabel ?? "Paused"
    return this.o.subtitle ?? ""
  }

  private loadingHtml(): string {
    return `<div class="as-load"><div class="as-bar"><i></i></div><div class="as-load-label"><span></span><b></b></div></div>`
  }

  private item(act: string, label: string, o: { primary?: boolean; note?: string; disabled?: boolean } = {}): string {
    return `<button class="as-btn${o.primary ? " as-primary" : ""}" data-act="${act}"${o.disabled ? " disabled" : ""}><span>${esc(label)}</span>${o.note ? `<small>${esc(o.note)}</small>` : ""}</button>`
  }

  private titleHtml(): string {
    const o = this.o
    const l = this.lobby
    const name = l && o.askName ? `<label class="as-name as-row"><span>Name</span><input type="text" data-field="name" placeholder="Your name" maxlength="16" autocomplete="off" spellcheck="false" /></label>` : ""
    let body: string
    if (l?.room) body = this.roomHtml()
    else if (l?.linkedRoom) body = `${this.item("join-linked", `Join room ${l.linkedRoom.toUpperCase()}`, { primary: true })}${l.hasSolo ? this.item("solo", o.soloLabel ?? "Play alone") : ""}${name}`
    else if (l?.friends)
      body = `${l.hasQuick ? this.item("quick", o.quickLabel ?? "Quick match", { primary: true, disabled: l.busy }) : ""}${l.hasSolo ? this.item("solo", o.soloLabel ?? "Play alone", { primary: !l.hasQuick, note: o.soloNote }) : ""}${this.item("friends", "Play with friends", { primary: !l.hasQuick && !l.hasSolo, note: o.friendsNote, disabled: l.busy })}<div class="as-join as-row"><span>Room</span><input type="text" data-field="code" placeholder="Room code or invite link" autocomplete="off" spellcheck="false" /><button class="as-inline" data-act="join">Join</button></div>${name}`
    else body = `${this.item(l ? "solo" : "play", o.playLabel ?? o.soloLabel ?? "Play", { primary: true })}${name}`
    return `${body}${this.voiceHtml(false)}${this.item("settings", "Settings")}`
  }

  private syncQuality(): void {
    const note = this.card.querySelector<HTMLElement>("[data-note=quality]")
    const q = this.settings.quality
    if (!note || !q) return
    const scale = q.resolutionScale ?? 1
    const text = q.mode === "auto" || q.mode !== q.tier || scale < 1
      ? `${q.mode === "auto" ? "Auto" : TIER[q.mode]}: ${TIER[q.tier]}${scale < 1 ? ` · ${Math.round(scale * 100)}% resolution` : ""}`
      : ""
    if (note.textContent !== text) note.textContent = text
  }

  private roomHtml(): string {
    const l = this.lobby!
    const players = l.players.length
      ? `<ul class="as-players">${l.players.map((p) => `<li${p.away ? ` class="as-away"` : ""}><span>${esc(p.name || "…")}${p.you ? " <em>you</em>" : ""}${p.host ? " <em>host</em>" : ""}</span>${l.hasReady ? `<b>${p.ready ? "Ready" : "…"}</b>` : ""}</li>`).join("")}</ul>`
      : ""
    const ready = l.hasReady ? this.item("ready", l.ready ? "Not ready" : "Ready", { primary: !l.ready }) : ""
    const start = l.hasStart && l.isHost ? this.item("start", "Start", { primary: true, disabled: !l.canStart }) : ""
    const play = !l.hasReady && !l.hasStart ? this.item("play", this.o.playLabel ?? "Play", { primary: true }) : ""
    return `${play}${ready}${start}${this.inviteHtml()}${players}${this.item("leave-room", l.hasSolo ? "Play alone instead" : "Leave room")}`
  }

  private inviteHtml(): string {
    const l = this.lobby
    if (!l?.room) return ""
    const label = this.copied > 0 ? "Copied" : this.copied < 0 ? esc(l.inviteLink()) : "Copy invite link"
    return `<div class="as-invite as-row"><span>Room</span><b>${esc(l.room)}</b><button class="as-inline" data-act="copy">${label}</button></div>`
  }

  private pauseHtml(): string {
    const leave = this.o.leaveLabel === null ? "" : this.item("leave", this.o.leaveLabel ?? (this.lobby?.room ? "Leave room" : "Quit to title"))
    return `${this.item("resume", this.o.resumeLabel ?? "Resume", { primary: true })}${this.item("settings", "Settings")}${leave}${this.inviteHtml()}<div class="as-slot-host"></div>`
  }

  private footHtml(): string {
    const c = this.o.controls?.() ?? ""
    const hints = `<div class="as-controls">${c}</div>`
    if (!this.settings.channels.length) return hints
    const cap = this.muteCap()
    const m = cap ? keyCapHtml("KeyM") : ""
    const tip = `Mute${cap ? " (M)" : ""}`
    return `${hints}<div class="as-vol" data-level="high"><button class="as-icon as-vol-btn" data-act="mute" aria-label="${tip}" title="${tip}">${SPEAKER_ICON}</button><input type="range" min="0" max="100" step="5" data-vol="master" aria-label="Volume" /><output></output>${m}</div>`
  }

  private settingsHtml(): string {
    const s = this.settings
    const vol = s.channels.map((c) => `<label class="as-field"><span>${esc(s.labels[c])}</span><input type="range" min="0" max="100" step="5" data-vol="${c}" /><output></output></label>`).join("")
    const sound = s.channels.length > 0
    const mute = `<div class="as-field"><span></span><button class="as-pick as-mute" data-act="mute" aria-pressed="false"><span class="as-mute-label">Mute</span>${this.muteCap() ? keyCapHtml("KeyM") : ""}</button></div>`
    const quality = s.quality
      ? `<div class="as-head">Graphics</div><div class="as-field"><span>Quality</span><div class="as-seg">${(s.quality.modes ?? QUALITY.map(([m]) => m)).map((m) => `<button data-act="quality" data-mode="${m}" aria-pressed="${s.quality!.mode === m}">${m === "auto" ? "Auto" : TIER[m]}</button>`).join("")}</div></div><div class="as-note" data-note="quality" role="status"></div>`
      : ""
    const sections = s.sections.map((sec) => `<div class="as-head">${esc(sec.title)}</div>${sec.rows.map((r) => this.rowHtml(sec.id, r)).join("")}`).join("")
    const controls = `<div class="as-head">Controls</div><label class="as-field"><span>Reduce camera motion</span><input type="checkbox" data-act="reduce-motion"${s.reduceMotion ? " checked" : ""} /><i></i></label><div class="as-field"><span>Key labels</span><div class="as-seg as-seg2">${KEY_LABEL_OPTIONS.map((k) => `<button data-act="key-labels" data-mode="${k.value}" aria-pressed="${s.keyLabels === k.value}">${esc(k.label)}</button>`).join("")}</div></div>`
    return `<div class="as-settings">${sound ? `<div class="as-head">Sound</div>${vol}${mute}` : ""}${this.voiceHtml(true)}${quality}${sections}${controls}</div>${this.item("back", "Done", { primary: true })}`
  }

  /** The title offers voice as one menu item; Settings holds the rest once it is on. */
  private voiceHtml(settings: boolean): string {
    const v = this.o.voice
    if (!v) return ""
    if (!settings) return this.item("voice-toggle", v.enabled ? "Turn off voice chat" : "Turn on voice chat", { disabled: v.pending })
    const toggle = `<label class="as-field"><span>Voice chat</span><input type="checkbox" data-voice="enabled"${v.enabled ? " checked" : ""} /><i></i></label>`
    const message = v.pending ? "Connecting microphone…" : v.error
    const status = message ? `<div class="as-note" role="status">${esc(message)}</div>` : ""
    if (!v.enabled) return `<div class="as-head">Voice</div>${toggle}${status}`
    const players = this.lobby?.players.filter((p) => !p.you).map((p) => `<label class="as-field"><span>Mute ${esc(p.name || "…")}</span><input type="checkbox" data-voice-player="${esc(p.id)}" /><i></i></label>`).join("") ?? ""
    const mode = `<div class="as-field"><span>Nearby voice</span><div class="as-seg as-seg2">${(["open", "push"] as const).map((m) => `<button data-act="voice-mode" data-mode="${m}" aria-pressed="${v.mode === m}">${m === "open" ? "Open mic" : "Push to talk"}</button>`).join("")}</div></div>`
    return `<div class="as-head">Voice</div>${toggle}${status}<label class="as-field"><span>Voice volume</span><input type="range" data-voice="volume" min="0" max="100" step="5" /><output></output></label>${mode}<div class="as-field"><span>Microphone</span><button class="as-pick as-mute" data-act="voice-mic" aria-pressed="false">Mute mic</button></div>${players}`
  }

  private rowHtml(section: string, r: ShellRow): string {
    const id = `${section}.${r.id}`
    if (r.kind === "range") return `<label class="as-field"><span>${esc(r.label)}</span><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" data-row="${id}" /><output></output></label>`
    if (r.kind === "toggle") return `<label class="as-field"><span>${esc(r.label)}</span><input type="checkbox" data-row="${id}" /><i></i></label>`
    return `<label class="as-field"><span>${esc(r.label)}</span><select data-row="${id}">${r.options.map((op) => `<option value="${esc(op.value)}">${esc(op.label)}</option>`).join("")}</select><i></i></label>`
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
    if (!t || (t as HTMLButtonElement).disabled) return
    const l = this.lobby
    switch (t.dataset.act) {
      case "voice-mic":
        return this.o.voice?.toggleMic()
      case "voice-toggle":
        return void this.o.voice?.setEnabled(!this.o.voice.enabled)
      case "voice-mode":
        return this.o.voice?.setMode(t.dataset.mode === "push" ? "push" : "open")
      case "play":
        return this.flow.play()
      case "solo":
        l?.playAlone()
        return this.flow.play()
      case "friends":
        return void l?.playWithFriends()
      case "quick":
        return void l?.quickMatch()
      case "join-linked":
        return void (l?.linkedRoom && l.join(l.linkedRoom))
      case "join":
        return void l?.join(this.card.querySelector<HTMLInputElement>("input[data-field=code]")?.value ?? "")
      case "copy":
        return void l?.copyInvite().then((ok) => {
          this.copied = ok ? 1 : -1
          this.render()
          setTimeout(() => {
            this.copied = 0
            this.render()
          }, 2400)
        })
      case "ready":
        return l?.setReady(!l.ready)
      case "start":
        return l?.start()
      case "leave-room":
        return l?.leaveRoom()
      case "resume":
        return this.flow.resume()
      case "leave":
        return this.flow.leave()
      case "settings":
        return this.flow.openSettings(true)
      case "back":
        return this.flow.openSettings(false)
      case "mute":
        return this.settings.toggleMute()
      case "quality":
        return this.settings.setQuality(t.dataset.mode as QualityMode)
      case "key-labels":
        return this.settings.setKeyLabels(t.dataset.mode === "layout" ? "layout" : "qwerty")
    }
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement
    if (t.dataset.voice) {
      if (t.dataset.voice === "enabled") void this.o.voice?.setEnabled(t.checked)
      if (t.dataset.voice === "volume") {
        this.o.voice?.setVolume(Number(t.value) / 100)
        const out = t.parentElement?.querySelector("output")
        if (out) out.textContent = `${t.value}%`
      }
      return
    }
    if (t.dataset.voicePlayer) return this.o.voice?.mute(t.dataset.voicePlayer, t.checked)
    if (t.dataset.vol) {
      this.settings.setVolume(t.dataset.vol as never, Number(t.value))
    } else if (t.dataset.act === "reduce-motion") this.settings.setReduceMotion(t.checked)
    else if (t.dataset.field === "name") this.lobby?.setName(t.value)
    else if (t.dataset.row) {
      const [sid, rid] = t.dataset.row.split(".")
      const row = this.settings.sections.find((s) => s.id === sid)?.rows.find((r) => r.id === rid)
      if (!row) return
      if (row.kind === "toggle") row.set(t.checked)
      else if (row.kind === "range") row.set(Number(t.value))
      else row.set(t.value)
      this.settings.changed()
    }
  }

  private renderPill(): void {
    const l = this.lobby
    const show = Boolean(l?.room) && (l!.connection === "connecting" || l!.connection === "reconnecting" || l!.connection === "lost" || (l!.connection === "online" && Boolean(l!.message)))
    this.pill.hidden = !show
    if (!show) return
    this.pill.dataset.state = l!.connection
    this.pill.textContent = l!.message ?? (l!.connection === "lost" ? "Disconnected" : l!.connection === "connecting" ? "Connecting…" : "Connection lost. Reconnecting…")
  }

  /** The dark behind loading: it lifts off the world once loaded, under the wordmark that stays where it is. */
  private renderCurtain(loading: boolean): void {
    const ld = this.loading
    if (!ld) return
    const c = this.curtain
    if (loading) {
      clearTimeout(this.curtainTimer)
      this.curtainTimer = 0
      c.hidden = false
      c.removeAttribute("data-done")
      const pct = Math.round(ld.progress * 100)
      const bar = this.card.querySelector<HTMLElement>(".as-bar i")
      if (bar) bar.style.width = `${pct}%`
      const label = this.card.querySelector<HTMLElement>(".as-load-label span")
      if (label) label.textContent = ld.error ?? ld.label
      const num = this.card.querySelector<HTMLElement>(".as-load-label b")
      if (num) num.textContent = ld.error ? "" : `${pct}%`
    } else if (!c.hidden && !c.hasAttribute("data-done")) {
      c.toggleAttribute("data-done", true)
      this.curtainTimer = window.setTimeout(() => (c.hidden = true), 1200)
    }
  }
}

/** Key-cap prompts for the keys the shell itself owns, for a game's controls line. */
export const shellKeysHtml = (muteKey = true) => [keyPromptHtml("Escape", "Menu"), muteKey ? keyPromptHtml("KeyM", "Mute") : ""].filter(Boolean).join(" ")

export const SHELL_CSS = `
.arcade-shell {
  --shell-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --shell-title-font: var(--shell-font);
  --shell-ink: #eef1f4;
  --shell-dim: #a9b1ba;
  --shell-card: rgba(12, 14, 17, 0.82);
  --shell-edge: rgba(255, 255, 255, 0.14);
  --shell-field: rgba(255, 255, 255, 0.07);
  --shell-accent: #f2c96b;
  --shell-accent-ink: #17130a;
  --shell-backdrop: radial-gradient(ellipse at center, rgba(0,0,0,0.1), rgba(0,0,0,0.5));
  /* The scrim the menu reads against: darkest behind the column and the bottom row, clear over the rest of the world. */
  --shell-scrim: linear-gradient(90deg, rgba(0,0,0,0.66), rgba(0,0,0,0.4) 34%, rgba(0,0,0,0) 68%), linear-gradient(0deg, rgba(0,0,0,0.5), rgba(0,0,0,0) 22%);
  --shell-curtain: #050607;
  --shell-radius: 10px;
  /* Layout: where the column starts, how wide it is, and where the wordmark sits. */
  --shell-x: clamp(28px, 7vw, 132px);
  --shell-top: clamp(40px, 19vh, 220px);
  --shell-col: min(420px, calc(100vw - 2 * var(--shell-x)));
  --shell-aside: 520px;
  --shell-title-size: 48px;
  --shell-item-size: 19px;
  /* Motion: entrances rise and fade in a stagger; exits are shorter and only fade. */
  --shell-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --shell-in: 0.34s;
  --shell-out: 0.18s;
  --shell-stagger: 0.035s;
  --shell-rise: 6px;
  font: 15px/1.35 var(--shell-font);
  color: var(--shell-ink);
}
.arcade-shell [hidden] { display: none !important; }
.arcade-shell .as-loading { position: fixed; inset: 0; z-index: 39; background: var(--shell-curtain); transition: opacity 0.9s ease-out; }
.arcade-shell .as-loading[data-done] { opacity: 0; pointer-events: none; }
.arcade-shell .as-overlay { position: fixed; inset: 0; z-index: 40; background: var(--shell-scrim), var(--shell-backdrop); opacity: 0; visibility: hidden; transition: opacity var(--shell-out) ease-in, visibility 0s linear var(--shell-out); }
.arcade-shell .as-overlay[data-open] { opacity: 1; visibility: visible; transition: opacity var(--shell-in) var(--shell-ease); }
/* Loading draws on the curtain, not the scrim (the world isn't there yet). */
.arcade-shell[data-phase="loading"] .as-overlay { background: none; }
.arcade-shell[data-screen="paused"] .as-overlay { cursor: pointer; }
.arcade-shell[data-arming] .as-overlay, .arcade-shell[data-arming] .as-overlay * { cursor: progress; }
.arcade-shell .as-decor { position: absolute; inset: 0; pointer-events: none; }
.arcade-shell .as-frame { position: absolute; left: var(--shell-x); right: var(--shell-x); top: var(--shell-top); bottom: 96px; display: grid; grid-template-columns: var(--shell-col) minmax(0, var(--shell-aside)); grid-template-rows: auto minmax(0, 1fr); column-gap: clamp(32px, 6vw, 96px); align-content: start; }
.arcade-shell .as-brand { grid-area: 1 / 1; cursor: default; }
/* The title slot: beside the menu on a wide screen, between the wordmark and the menu on a narrow one. */
.arcade-shell .as-aside { grid-area: 2 / 2; align-self: start; max-height: 100%; min-height: 0; overflow: auto; margin-top: 22px; scrollbar-width: none; }
.arcade-shell .as-aside:empty { display: none; }
.arcade-shell .as-aside .as-slot { margin: 0; }
.arcade-shell .as-aside[data-enter] { animation: as-fade calc(var(--shell-in) * 1.6) var(--shell-ease) both; }
@media (max-width: 1080px) {
  .arcade-shell .as-frame { grid-template-columns: var(--shell-col); grid-template-rows: auto auto minmax(0, 1fr); }
  .arcade-shell .as-aside { grid-area: 2 / 1; }
  .arcade-shell .as-card { grid-row: 3; }
}
.arcade-shell .as-title { margin: 0; font: 700 var(--shell-title-size)/1 var(--shell-title-font); letter-spacing: 0.12em; text-wrap: balance; }
/* Two lines' height whatever it holds (a subtitle, Paused, Settings, a message), so the menu never moves. */
.arcade-shell .as-sub { margin: 12px 0 0; min-height: 2.7em; max-height: 2.7em; overflow: hidden; color: var(--shell-dim); text-wrap: balance; }
.arcade-shell .as-sub.as-alert { color: var(--shell-accent); }
.arcade-shell .as-card { grid-area: 2 / 1; align-self: start; max-height: 100%; position: relative; min-height: 0; overflow: auto; margin-top: 20px; cursor: default; padding: 2px 16px 8px; margin-inline: -16px; display: flex; flex-direction: column; gap: 2px; scrollbar-width: none; --fade: 32px; overscroll-behavior: contain; }
.arcade-shell .as-card::-webkit-scrollbar { display: none; }
/* A menu taller than the window scrolls inside itself and fades out at the edge with more to see, never clips. */
.arcade-shell .as-card[data-fade=end] { -webkit-mask-image: linear-gradient(#000 calc(100% - var(--fade)), transparent); mask-image: linear-gradient(#000 calc(100% - var(--fade)), transparent); }
.arcade-shell .as-card[data-fade=start] { -webkit-mask-image: linear-gradient(transparent, #000 var(--fade)); mask-image: linear-gradient(transparent, #000 var(--fade)); }
.arcade-shell .as-card[data-fade=both] { -webkit-mask-image: linear-gradient(transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent); mask-image: linear-gradient(transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent); }
.arcade-shell .as-slot { margin-bottom: 12px; }
.arcade-shell .as-slot:empty { display: none; }
/* Menu items: words on the column's edge, the highlight bleeding out into the padding. The primary item is lit until
   the pointer picks another. */
.arcade-shell .as-btn { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 8px 16px; box-sizing: border-box; text-align: left; font: 600 var(--shell-item-size)/1.25 var(--shell-font); color: var(--shell-ink); background: transparent; border: 0; border-radius: var(--shell-radius); cursor: pointer; opacity: 0.72; transition: opacity 0.12s, background-color 0.12s, color 0.12s; }
.arcade-shell .as-btn::before { content: ""; position: absolute; left: 0; top: 50%; width: 3px; height: 1.1em; margin-top: -0.55em; border-radius: 2px; background: var(--shell-accent); transform: scaleY(0); transition: transform 0.16s var(--shell-ease); }
.arcade-shell .as-card > .as-btn { width: calc(100% + 32px); margin-inline: -16px; }
.arcade-shell .as-btn > span { white-space: nowrap; }
/* A game's own buttons inside the menu (a slot's tools, a pair in .as-row2): compact, on the field colour. */
.arcade-shell .as-slot .as-btn { justify-content: center; text-align: center; font-size: 14px; padding: 8px 10px; background: var(--shell-field); opacity: 0.85; }
.arcade-shell .as-slot .as-btn::before { display: none; }
.arcade-shell .as-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.arcade-shell .as-row2 .as-btn:only-child { grid-column: 1 / -1; }
.arcade-shell .as-link { padding: 0; background: none; border: 0; color: var(--shell-dim); font: 14px var(--shell-font); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.arcade-shell .as-link:hover, .arcade-shell .as-link:focus-visible { color: var(--shell-ink); }
.arcade-shell .as-btn small { font: 400 13px var(--shell-font); color: var(--shell-dim); }
.arcade-shell .as-btn:hover:not(:disabled), .arcade-shell .as-btn:focus-visible, .arcade-shell .as-card:not(:has(.as-btn:hover, .as-btn:focus-visible)) .as-primary:not(:disabled) { opacity: 1; background: var(--shell-field); }
.arcade-shell .as-btn:hover:not(:disabled)::before, .arcade-shell .as-btn:focus-visible::before, .arcade-shell .as-card:not(:has(.as-btn:hover, .as-btn:focus-visible)) .as-primary:not(:disabled)::before { transform: none; }
.arcade-shell .as-btn:disabled { opacity: 0.35; cursor: default; }
.arcade-shell .as-btn:focus-visible, .arcade-shell .as-icon:focus-visible, .arcade-shell .as-seg button:focus-visible, .arcade-shell .as-inline:focus-visible, .arcade-shell .as-pick:focus-visible { outline: 2px solid var(--shell-accent); outline-offset: 2px; }
/* A row with a field in it (Join, Name, the room's invite): label on the column's edge, the field underlined. */
.arcade-shell .as-row { display: flex; align-items: center; gap: 12px; min-height: 40px; color: var(--shell-dim); font-size: 14px; }
.arcade-shell .as-row > span:first-child { flex: none; min-width: 3.4em; }
.arcade-shell .as-row b { color: var(--shell-ink); letter-spacing: 0.15em; font-size: 17px; }
.arcade-shell input[type=text] { flex: 1; min-width: 0; font: 15px var(--shell-font); color: var(--shell-ink); background: transparent; border: 0; border-bottom: 1px solid var(--shell-edge); border-radius: 0; padding: 7px 0; }
.arcade-shell input[type=text]::placeholder { color: var(--shell-dim); opacity: 0.6; }
.arcade-shell input[type=text]:focus { outline: none; border-bottom-color: var(--shell-accent); }
.arcade-shell .as-inline { flex: none; font: 600 13px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 0; border-radius: var(--shell-radius); padding: 6px 10px; cursor: pointer; }
.arcade-shell .as-inline:hover { background: var(--shell-edge); }
.arcade-shell .as-invite .as-inline { margin-left: auto; }
.arcade-shell .as-players { list-style: none; margin: 4px 0 8px; padding: 0; display: grid; gap: 2px; }
.arcade-shell .as-players li { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--shell-edge); }
.arcade-shell .as-players em { font-style: normal; font-size: 12px; color: var(--shell-dim); }
.arcade-shell .as-players .as-away { opacity: 0.5; }
.arcade-shell .as-icon { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--shell-dim); background: none; border: 0; border-radius: var(--shell-radius); cursor: pointer; font-size: 18px; }
.arcade-shell .as-icon:hover { color: var(--shell-ink); background: var(--shell-field); }
/* The bottom row: the game's controls as a hint line on the left, the master volume on the right. */
.arcade-shell .as-foot { position: absolute; left: var(--shell-x); right: var(--shell-x); bottom: 28px; display: flex; align-items: center; gap: 32px; font-size: 12px; color: var(--shell-dim); }
.arcade-shell[data-phase="loading"] .as-foot { visibility: hidden; }
.arcade-shell .as-controls { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 18px; overflow: hidden; white-space: nowrap; --akc-size: 1.6em; --akc-face: rgba(255, 255, 255, 0.12); --akc-ink: var(--shell-ink); --akc-edge: rgba(0, 0, 0, 0.5); }
.arcade-shell .as-controls[data-fade="true"] { -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent); }
.arcade-shell .as-controls .akc-cap { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
.arcade-shell .as-controls .akc-hold { padding: 0.16em; }
.arcade-shell .as-controls .akc-hold::before { display: none; }
.arcade-shell .as-vol { flex: none; margin-left: auto; display: flex; align-items: center; gap: 10px; transition: opacity 0.2s; }
.arcade-shell[data-phase="settings"] .as-vol { opacity: 0; visibility: hidden; }
.arcade-shell .as-vol input[type=range] { width: 132px; margin: 0; accent-color: var(--shell-accent); cursor: pointer; transition: opacity 0.12s; }
.arcade-shell .as-vol output { min-width: 3.4em; font-variant-numeric: tabular-nums; color: var(--shell-ink); }
.arcade-shell .as-vol .akc { --akc-size: 1.6em; --akc-face: rgba(255, 255, 255, 0.12); --akc-ink: var(--shell-dim); }
.arcade-shell .as-vol .akc-cap { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
.arcade-shell[data-muted="true"] .as-vol input[type=range] { opacity: 0.4; }
.arcade-shell[data-muted="true"] .as-vol output { color: var(--shell-accent); }
.arcade-shell .as-x { display: none; }
.arcade-shell .as-vol[data-level=muted] .as-x { display: inline; }
.arcade-shell .as-vol[data-level=muted] .as-w1, .arcade-shell .as-vol[data-level=muted] .as-w2, .arcade-shell .as-vol[data-level=low] .as-w2 { display: none; }
.arcade-shell .as-vol[data-level=muted] .as-vol-btn { color: var(--shell-accent); }
/* Settings, in the same column. */
.arcade-shell .as-settings { display: grid; gap: 8px; margin-bottom: 12px; }
.arcade-shell .as-head { margin-top: 10px; font: 600 11px var(--shell-font); letter-spacing: 0.14em; text-transform: uppercase; color: var(--shell-dim); }
.arcade-shell .as-head:first-child { margin-top: 0; }
.arcade-shell .as-field { display: grid; grid-template-columns: 10.5em 1fr 3em; align-items: center; gap: 10px; font-size: 14px; }
/* A field with nothing after its control (a text field) gives the control the whole width. */
.arcade-shell .as-field:not(:has(> output, > i)) { grid-template-columns: 10.5em 1fr; }
.arcade-shell .as-field > span { color: var(--shell-dim); }
.arcade-shell .as-field input[type=range] { width: 100%; accent-color: var(--shell-accent); }
.arcade-shell .as-field input[type=checkbox] { justify-self: start; width: 18px; height: 18px; accent-color: var(--shell-accent); }
.arcade-shell .as-field select { font: 14px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 0; border-radius: var(--shell-radius); padding: 6px 8px; }
.arcade-shell .as-field output { text-align: right; font-variant-numeric: tabular-nums; color: var(--shell-ink); }
.arcade-shell .as-field > .as-seg, .arcade-shell .as-field > .as-mute { grid-column: 2 / -1; }
.arcade-shell .as-pick { font: 500 13px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 0; border-radius: var(--shell-radius); cursor: pointer; }
.arcade-shell .as-mute { justify-self: start; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; }
.arcade-shell .as-mute[aria-pressed=true] { color: var(--shell-accent-ink); background: var(--shell-accent); }
.arcade-shell .as-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 2px; border-radius: calc(var(--shell-radius) + 2px); background: var(--shell-field); }
.arcade-shell .as-seg2 { grid-template-columns: 1fr 1fr; }
.arcade-shell .as-seg button { font: 500 13px var(--shell-font); color: var(--shell-ink); background: transparent; border: 0; border-radius: var(--shell-radius); padding: 6px 4px; cursor: pointer; }
.arcade-shell .as-seg button[aria-pressed=true] { color: var(--shell-accent-ink); background: var(--shell-accent); }
.arcade-shell .as-note { margin: -4px 0 0 calc(10.5em + 10px); font-size: 12px; color: var(--shell-dim); min-height: 1em; }
/* Loading, where the menu will be: the bar, what it's doing and how far. */
.arcade-shell .as-load { display: grid; gap: 10px; padding-top: 10px; }
.arcade-shell .as-bar { height: 2px; background: var(--shell-field); overflow: hidden; }
.arcade-shell .as-bar i { display: block; width: 0; height: 100%; background: var(--shell-accent); transition: width 0.25s ease-out; }
.arcade-shell .as-load-label { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; color: var(--shell-dim); }
.arcade-shell .as-load-label b { font-weight: 500; font-variant-numeric: tabular-nums; color: var(--shell-ink); }
.arcade-shell .as-pill { position: fixed; z-index: 41; top: 14px; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: var(--shell-card); box-shadow: inset 0 0 0 1px var(--shell-edge); font-size: 13px; pointer-events: none; }
.arcade-shell .as-pill[data-state="lost"] { color: var(--shell-accent); }
/* Entrances: a changed screen's items rise into place one after another; the bottom row fades in with them. */
@keyframes as-rise { from { opacity: 0; transform: translateY(var(--shell-rise)); } }
@keyframes as-fade { from { opacity: 0; } }
.arcade-shell .as-card[data-enter] > * { animation: as-rise var(--shell-in) var(--shell-ease) both; animation-delay: calc(var(--i, 0) * var(--shell-stagger)); }
.arcade-shell .as-foot[data-enter] { animation: as-fade calc(var(--shell-in) * 1.6) var(--shell-ease) both; }
@media (prefers-reduced-motion: reduce) {
  .arcade-shell { --shell-rise: 0px; --shell-stagger: 0s; }
  .arcade-shell .as-bar i, .arcade-shell .as-btn::before { transition: none; }
}
/* The in-HUD volume control (ShellVolumeButton): the speaker; hover drops the slider to its left. */
.arcade-shell.as-volume { display: inline-flex; align-items: center; gap: 4px; pointer-events: auto; font-size: 13px; }
/* Both sit on the card colour so the icon reads over a bright sky as well as dark water. */
.arcade-shell.as-volume .as-vol-btn, .arcade-shell.as-volume .as-vol-btn:hover { color: var(--shell-ink); background: var(--shell-card); box-shadow: inset 0 0 0 1px var(--shell-edge); border-radius: var(--shell-radius); }
.arcade-shell.as-volume .as-vol-btn:hover { box-shadow: inset 0 0 0 1px var(--shell-dim); }
.arcade-shell.as-volume .as-vol-pop { display: flex; align-items: center; gap: 10px; box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: var(--shell-radius); background: var(--shell-card); box-shadow: inset 0 0 0 1px var(--shell-edge); visibility: hidden; opacity: 0; transform: translateX(6px); transition: opacity 0.12s, transform 0.12s, visibility 0s 0.12s; }
.arcade-shell.as-volume:hover .as-vol-pop, .arcade-shell.as-volume:focus-within .as-vol-pop { visibility: visible; opacity: 1; transform: none; transition: opacity 0.12s, transform 0.12s; }
.arcade-shell.as-volume input[type=range] { width: 110px; margin: 0; accent-color: var(--shell-accent); cursor: pointer; }
.arcade-shell.as-volume output { min-width: 3.6em; text-align: right; font-variant-numeric: tabular-nums; color: var(--shell-dim); }
.arcade-shell.as-volume[data-level=muted] .as-x { display: inline; }
.arcade-shell.as-volume[data-level=muted] .as-w1, .arcade-shell.as-volume[data-level=muted] .as-w2, .arcade-shell.as-volume[data-level=low] .as-w2 { display: none; }
.arcade-shell.as-volume[data-level=muted] .as-vol-btn { color: var(--shell-accent); }
@media (prefers-reduced-motion: reduce) { .arcade-shell.as-volume .as-vol-pop { transition: none; } }
`

let installed = false

/** Adds the shell stylesheet once (before the game's own styles, so a game's rules win). */
export function installShellStyles(doc: Document | undefined = globalThis.document): void {
  if (installed || !doc?.head) return
  installed = true
  if (doc.getElementById("arcade-shell")) return
  const style = doc.createElement("style")
  style.id = "arcade-shell"
  style.textContent = SHELL_CSS
  doc.head.prepend(style)
}
