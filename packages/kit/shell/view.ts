import { KEY_LABEL_OPTIONS, onKeyLayoutChange } from "../client/controls"
import { keyCapHtml, keyPromptHtml } from "../client/key-cap"
import type { QualityMode, QualityTier } from "../quality"
import type { ShellFlow } from "./flow"
import type { ShellLobby } from "./lobby"
import type { ShellLoading } from "./page"
import type { ShellRow, ShellSettings } from "./settings"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const QUALITY: readonly [QualityMode, string][] = [["auto", "Auto"], ["high", "High"], ["balanced", "Balanced"], ["low", "Low"]]
const TIER: Record<QualityTier, string> = { high: "High", balanced: "Balanced", low: "Low" }
const SPEAKER = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><path class="as-wave" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/><path class="as-cross" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg>`

export type ShellViewOptions = {
  title: string
  subtitle?: string
  /** Play alone's label and small print (`Play alone` / `you and three campers`). */
  soloLabel?: string
  soloNote?: string
  /** Play with friends' small print. */
  friendsNote?: string
  /** The title's primary button when there is no lobby (`Begin`, `Play`). */
  playLabel?: string
  /** Resume's label (`Back to the woods`). */
  resumeLabel?: string
  /** Leave's label (`Leave room`, `Quit to title`); hidden when null. */
  leaveLabel?: string | null
  /** Whether the title asks for a name (games with rooms). */
  askName?: boolean
  /** The game's controls as key-cap prompts, shown under the title and pause cards. */
  controls?: () => string
  /** Whether M toggles mute (the cap is shown beside Mute). */
  muteKey?: boolean
}

/**
 * The shell's default DOM: the title and pause cards, the Settings view inside them, a loading bar and a reconnect
 * pill, styled by `--shell-*` variables on `.arcade-shell` (or any ancestor) so a game restyles without forking
 * behaviour. Everything it shows comes from the headless models; every control calls their setters.
 */
export class ShellView {
  readonly root: HTMLDivElement
  /** Game content for the title card (survivor picks, a mode chooser); kept across redraws. */
  readonly titleSlot: HTMLDivElement
  private readonly overlay: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly pill: HTMLDivElement
  private readonly loader: HTMLDivElement
  private layout = ""
  private copied = 0
  private readonly offs: (() => void)[] = []
  private raf = 0

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
    this.root.innerHTML = `<div class="as-overlay" hidden><div class="as-card" role="dialog" aria-modal="true"></div></div><div class="as-pill" role="status" hidden></div><div class="as-loading" hidden></div>`
    parent.append(this.root)
    this.overlay = this.root.querySelector(".as-overlay")!
    this.card = this.root.querySelector(".as-card")!
    this.pill = this.root.querySelector(".as-pill")!
    this.loader = this.root.querySelector(".as-loading")!
    this.titleSlot = doc.createElement("div")
    this.titleSlot.className = "as-slot"
    this.overlay.addEventListener("click", (e) => {
      // A click outside the pause card plays again (a click is what pointer lock needs).
      if (e.target === this.overlay && this.flow.overlay === "paused" && !this.flow.settingsOpen) this.flow.resume()
    })
    this.card.addEventListener("click", (e) => this.click(e))
    this.card.addEventListener("input", (e) => this.input(e))
    this.card.addEventListener("change", (e) => this.input(e))
    this.card.addEventListener("keydown", (e) => {
      const t = e.target as HTMLInputElement
      if (e.key === "Enter" && t.dataset.field === "code") this.lobby?.join(t.value)
      else if (e.key === "Enter" && t.dataset.field === "name") t.blur()
    })
    const redraw = () => this.render()
    this.offs.push(settings.subscribe(redraw), flow.subscribe(redraw), onKeyLayoutChange(() => this.render(true)))
    if (lobby) this.offs.push(lobby.subscribe(redraw))
    if (loading) this.offs.push(loading.subscribe(redraw))
    // `blocked` (the Lab panel) changes outside the shell; one boolean read a frame keeps the overlay honest.
    let blocked = flow.overlay
    const tick = () => {
      if (flow.overlay !== blocked) {
        blocked = flow.overlay
        this.render()
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    this.render()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    for (const off of this.offs) off()
    this.root.remove()
  }

  /** Redraws now (the game's own state shown in a section changed). */
  render(force = false): void {
    this.renderLoading()
    this.renderPill()
    const overlay = this.loading && !this.loading.finished ? null : this.flow.overlay
    this.overlay.hidden = overlay === null
    this.root.dataset.screen = overlay ?? "playing"
    if (overlay === null) return
    const settingsOpen = this.flow.settingsOpen
    const l = this.lobby
    const key = [overlay, settingsOpen, l?.room, l?.busy, l?.connection, JSON.stringify(l?.players ?? []), this.flow.lockRefused, this.copied, this.settings.quality?.mode, this.settings.reduceMotion, this.settings.keyLabels].join("|")
    if (force || key !== this.layout) {
      this.layout = key
      this.card.innerHTML = settingsOpen ? this.settingsHtml() : overlay === "title" ? this.titleHtml() : this.pauseHtml()
      if (overlay === "title" && !settingsOpen) this.card.querySelector(".as-slot-host")?.replaceWith(this.titleSlot)
    }
    this.sync()
  }

  private sync(): void {
    const s = this.settings
    for (const input of this.card.querySelectorAll<HTMLInputElement>("input[data-vol]")) {
      const v = s.volume(input.dataset.vol as never)
      if (input.ownerDocument.activeElement !== input) input.value = String(v)
      const out = input.parentElement?.querySelector("output")
      if (out) out.textContent = `${v}%`
    }
    for (const b of this.card.querySelectorAll<HTMLButtonElement>("[data-act=mute]")) {
      b.setAttribute("aria-pressed", String(s.muted))
      const label = b.querySelector(".as-mute-label")
      if (label) label.textContent = s.muted ? "Muted" : "Mute"
    }
    this.root.dataset.muted = String(s.muted || s.volumes.volumeMaster <= 0)
    const note = this.card.querySelector<HTMLElement>("[data-note=quality]")
    if (note && s.quality) note.textContent = s.quality.mode === "auto" ? `Auto is using ${TIER[s.quality.tier]}` : ""
    for (const section of s.sections)
      for (const row of section.rows) {
        const el = this.card.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-row="${section.id}.${row.id}"]`)
        if (!el || el.ownerDocument.activeElement === el) continue
        if (row.kind === "toggle") (el as HTMLInputElement).checked = row.get()
        else el.value = String(row.get())
        const out = el.parentElement?.querySelector("output")
        if (out && row.kind === "range") out.textContent = `${row.get()}${row.unit ?? ""}`
      }
    const name = this.card.querySelector<HTMLInputElement>("input[data-field=name]")
    if (name && this.lobby && name.ownerDocument.activeElement !== name) name.value = this.lobby.name
  }

  private titleHtml(): string {
    const o = this.o
    const l = this.lobby
    const top = `<h1 class="as-title">${esc(o.title)}</h1>${o.subtitle ? `<p class="as-sub">${esc(o.subtitle)}</p>` : ""}`
    const name = l && o.askName ? `<label class="as-name"><span>Your name</span><input type="text" data-field="name" maxlength="16" autocomplete="off" spellcheck="false" /></label>` : ""
    let body: string
    if (l?.room) body = this.roomHtml()
    else if (l?.friends)
      body = `<div class="as-choices"><button class="as-btn as-primary" data-act="solo">${esc(o.soloLabel ?? "Play alone")}${o.soloNote ? `<small>${esc(o.soloNote)}</small>` : ""}</button><button class="as-btn" data-act="friends"${l.busy ? " disabled" : ""}>Play with friends${o.friendsNote ? `<small>${esc(o.friendsNote)}</small>` : ""}</button></div><div class="as-join"><input type="text" data-field="code" placeholder="Room code or invite link" autocomplete="off" spellcheck="false" /><button class="as-btn" data-act="join">Join</button></div>`
    else body = `<button class="as-btn as-primary as-big" data-act="${l ? "solo" : "play"}">${esc(o.playLabel ?? o.soloLabel ?? "Play")}</button>`
    const message = l?.message ? `<p class="as-message">${esc(l.message)}</p>` : ""
    const refused = this.flow.lockRefused ? `<p class="as-message">Click again to take the mouse.</p>` : ""
    return `${this.cornerHtml()}${top}<div class="as-slot-host"></div>${name}${body}${message}${refused}${this.footHtml()}`
  }

  private roomHtml(): string {
    const l = this.lobby!
    const players = l.players.length
      ? `<ul class="as-players">${l.players.map((p) => `<li${p.away ? ` class="as-away"` : ""}><span>${esc(p.name || "…")}${p.you ? " <em>you</em>" : ""}${p.host ? " <em>host</em>" : ""}</span>${l.hasReady ? `<b>${p.ready ? "Ready" : "…"}</b>` : ""}</li>`).join("")}</ul>`
      : ""
    const ready = l.hasReady ? `<button class="as-btn${l.ready ? "" : " as-primary"} as-big" data-act="ready">${l.ready ? "Not ready" : "Ready"}</button>` : ""
    const start = l.hasStart && l.isHost ? `<button class="as-btn as-primary as-big" data-act="start"${l.canStart ? "" : " disabled"}>Start</button>` : ""
    const play = !l.hasReady && !l.hasStart ? `<button class="as-btn as-primary as-big" data-act="play">${esc(this.o.playLabel ?? "Play")}</button>` : ""
    return `${this.inviteHtml()}${players}${ready}${start}${play}<button class="as-link" data-act="leave-room">Play alone instead</button>`
  }

  private inviteHtml(): string {
    const l = this.lobby
    if (!l?.room) return ""
    const label = this.copied > 0 ? "Copied" : this.copied < 0 ? esc(l.inviteLink()) : "Copy invite link"
    return `<div class="as-invite"><span>Room</span><b>${esc(l.room)}</b><button class="as-btn" data-act="copy">${label}</button></div>`
  }

  private pauseHtml(): string {
    const leave = this.o.leaveLabel === null ? "" : `<button class="as-btn" data-act="leave">${esc(this.o.leaveLabel ?? (this.lobby?.room ? "Leave room" : "Quit to title"))}</button>`
    const refused = this.flow.lockRefused ? `<p class="as-message">The browser wants one more click. Click Resume.</p>` : ""
    return `${this.cornerHtml()}<h2 class="as-heading">Paused</h2><button class="as-btn as-primary as-big" data-act="resume">${esc(this.o.resumeLabel ?? "Resume")}</button>${refused}<div class="as-row2"><button class="as-btn" data-act="settings">Settings</button>${leave}</div>${this.inviteHtml()}<p class="as-hint">or click outside this card · ${keyCapHtml("Escape")}</p>${this.footHtml()}`
  }

  private cornerHtml(): string {
    return `<div class="as-corner"><button class="as-icon" data-act="mute" aria-label="Mute" title="Mute${this.o.muteKey === false ? "" : " (M)"}">${SPEAKER}</button><button class="as-icon as-gear" data-act="settings" aria-label="Settings" title="Settings">⚙</button></div>`
  }

  private footHtml(): string {
    const c = this.o.controls?.() ?? ""
    return c ? `<div class="as-controls">${c}</div>` : ""
  }

  private settingsHtml(): string {
    const s = this.settings
    const vol = s.channels.map((c) => `<label class="as-field"><span>${esc(s.labels[c])}</span><input type="range" min="0" max="100" step="5" data-vol="${c}" /><output></output></label>`).join("")
    const mute = `<div class="as-field"><span></span><button class="as-btn as-mute" data-act="mute" aria-pressed="false"><span class="as-mute-label">Mute</span>${this.o.muteKey === false ? "" : keyCapHtml("KeyM")}</button></div>`
    const quality = s.quality
      ? `<div class="as-head">Graphics</div><div class="as-field"><span>Quality</span><div class="as-seg">${QUALITY.map(([m, label]) => `<button data-act="quality" data-mode="${m}" aria-pressed="${s.quality!.mode === m}">${label}</button>`).join("")}</div></div><div class="as-note" data-note="quality"></div>`
      : ""
    const sections = s.sections.map((sec) => `<div class="as-head">${esc(sec.title)}</div>${sec.rows.map((r) => this.rowHtml(sec.id, r)).join("")}`).join("")
    const controls = `<div class="as-head">Controls</div><label class="as-field"><span>Reduce camera motion</span><input type="checkbox" data-act="reduce-motion"${s.reduceMotion ? " checked" : ""} /><i></i></label><div class="as-field"><span>Key labels</span><div class="as-seg as-seg2">${KEY_LABEL_OPTIONS.map((k) => `<button data-act="key-labels" data-mode="${k.value}" aria-pressed="${s.keyLabels === k.value}">${esc(k.label)}</button>`).join("")}</div></div>`
    return `<h2 class="as-heading">Settings</h2><div class="as-settings"><div class="as-head">Sound</div>${vol}${mute}${quality}${sections}${controls}</div><button class="as-btn as-primary" data-act="back">Done</button>`
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
      case "play":
        return this.flow.play()
      case "solo":
        l?.playAlone()
        return this.flow.play()
      case "friends":
        return void l?.playWithFriends()
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
    if (t.dataset.vol) this.settings.setVolume(t.dataset.vol as never, Number(t.value))
    else if (t.dataset.act === "reduce-motion") this.settings.setReduceMotion(t.checked)
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
    const show = Boolean(l?.room) && (l!.connection === "connecting" || l!.connection === "reconnecting" || l!.connection === "lost")
    this.pill.hidden = !show
    if (!show) return
    this.pill.dataset.state = l!.connection
    this.pill.textContent = l!.message ?? (l!.connection === "lost" ? "Disconnected" : l!.connection === "connecting" ? "Connecting…" : "Connection lost. Reconnecting…")
  }

  private renderLoading(): void {
    const ld = this.loading
    const show = Boolean(ld && !ld.finished)
    this.loader.hidden = !show
    if (!show || !ld) return
    const pct = Math.round(ld.progress * 100)
    this.loader.innerHTML = `<div class="as-load"><div class="as-title">${esc(this.o.title)}</div><div class="as-bar"><i style="width:${pct}%"></i></div><div class="as-load-label">${esc(ld.error ?? ld.label)}${ld.error ? "" : ` · ${pct}%`}</div></div>`
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
  --shell-field: rgba(255, 255, 255, 0.06);
  --shell-accent: #f2c96b;
  --shell-accent-ink: #17130a;
  --shell-backdrop: radial-gradient(ellipse at center, rgba(0,0,0,0.1), rgba(0,0,0,0.62));
  --shell-radius: 14px;
  font: 15px/1.35 var(--shell-font);
  color: var(--shell-ink);
}
.arcade-shell [hidden] { display: none !important; }
.arcade-shell .as-overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: var(--shell-backdrop); }
.arcade-shell[data-screen="paused"] .as-overlay { cursor: pointer; }
.arcade-shell .as-card { position: relative; cursor: default; display: flex; flex-direction: column; gap: 14px; width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-sizing: border-box; padding: 28px 28px 22px; border-radius: var(--shell-radius); background: var(--shell-card); box-shadow: inset 0 0 0 1px var(--shell-edge), 0 24px 70px rgba(0,0,0,0.55); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.arcade-shell .as-title { margin: 0 0 2px; text-align: center; font: 700 44px/1 var(--shell-title-font); letter-spacing: 0.12em; }
.arcade-shell .as-heading { margin: 0; text-align: center; font: 600 26px/1.1 var(--shell-title-font); letter-spacing: 0.06em; }
.arcade-shell .as-sub { margin: -6px 0 0; text-align: center; color: var(--shell-dim); }
.arcade-shell .as-slot:empty { display: none; }
.arcade-shell .as-btn { font: 600 15px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 1px solid var(--shell-edge); border-radius: 10px; padding: 10px 14px; cursor: pointer; }
.arcade-shell .as-btn:hover:not(:disabled) { border-color: var(--shell-dim); }
.arcade-shell .as-btn:focus-visible, .arcade-shell .as-icon:focus-visible, .arcade-shell .as-seg button:focus-visible { outline: 2px solid var(--shell-accent); outline-offset: 2px; }
.arcade-shell .as-btn:disabled { opacity: 0.5; cursor: default; }
.arcade-shell .as-primary { color: var(--shell-accent-ink); background: var(--shell-accent); border-color: var(--shell-accent); }
.arcade-shell .as-big { padding: 14px; font-size: 17px; }
.arcade-shell .as-link { background: none; border: 0; color: var(--shell-dim); font: 14px var(--shell-font); text-decoration: underline; cursor: pointer; }
.arcade-shell .as-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.arcade-shell .as-choices .as-btn { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 10px; font-size: 17px; }
.arcade-shell .as-choices small { font: 400 12px var(--shell-font); opacity: 0.8; }
.arcade-shell .as-join, .arcade-shell .as-name { display: flex; gap: 10px; align-items: center; }
.arcade-shell .as-name span { color: var(--shell-dim); white-space: nowrap; }
.arcade-shell input[type=text] { flex: 1; min-width: 0; font: 15px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 1px solid var(--shell-edge); border-radius: 8px; padding: 9px 11px; }
.arcade-shell input[type=text]:focus { outline: none; border-color: var(--shell-dim); }
.arcade-shell .as-invite { display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--shell-dim); }
.arcade-shell .as-invite b { color: var(--shell-ink); letter-spacing: 0.15em; font-size: 17px; }
.arcade-shell .as-players { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.arcade-shell .as-players li { display: flex; justify-content: space-between; padding: 6px 10px; border-radius: 8px; background: var(--shell-field); }
.arcade-shell .as-players em { font-style: normal; font-size: 12px; color: var(--shell-dim); }
.arcade-shell .as-players .as-away { opacity: 0.5; }
.arcade-shell .as-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.arcade-shell .as-row2 .as-btn:only-child { grid-column: 1 / -1; }
.arcade-shell .as-hint, .arcade-shell .as-message { margin: -4px 0 0; text-align: center; font-size: 13px; color: var(--shell-dim); }
.arcade-shell .as-message { color: var(--shell-accent); }
.arcade-shell .as-corner { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; }
.arcade-shell .as-icon { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--shell-dim); background: none; border: 0; border-radius: 8px; cursor: pointer; font-size: 18px; }
.arcade-shell .as-icon:hover { color: var(--shell-ink); background: var(--shell-field); }
.arcade-shell .as-cross { display: none; }
.arcade-shell[data-muted="true"] .as-cross { display: inline; }
.arcade-shell[data-muted="true"] .as-wave { display: none; }
.arcade-shell[data-muted="true"] .as-corner [data-act=mute] { color: var(--shell-accent); }
.arcade-shell .as-controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px; padding-top: 12px; border-top: 1px solid var(--shell-edge); font-size: 12px; color: var(--shell-dim); }
.arcade-shell .as-settings { display: grid; gap: 8px; }
.arcade-shell .as-head { margin-top: 6px; font: 600 11px var(--shell-font); letter-spacing: 0.14em; text-transform: uppercase; color: var(--shell-dim); }
.arcade-shell .as-field { display: grid; grid-template-columns: 11em 1fr 3em; align-items: center; gap: 10px; font-size: 14px; }
.arcade-shell .as-field > span { color: var(--shell-dim); }
.arcade-shell .as-field input[type=range] { width: 100%; accent-color: var(--shell-accent); }
.arcade-shell .as-field input[type=checkbox] { justify-self: start; width: 18px; height: 18px; accent-color: var(--shell-accent); }
.arcade-shell .as-field select { font: 14px var(--shell-font); color: var(--shell-ink); background: var(--shell-field); border: 1px solid var(--shell-edge); border-radius: 8px; padding: 6px 8px; }
.arcade-shell .as-field output { text-align: right; font-variant-numeric: tabular-nums; color: var(--shell-ink); }
.arcade-shell .as-field > .as-seg, .arcade-shell .as-field > .as-mute { grid-column: 2 / -1; }
.arcade-shell .as-mute { justify-self: start; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; font-weight: 500; }
.arcade-shell .as-mute[aria-pressed=true] { color: var(--shell-accent-ink); background: var(--shell-accent); border-color: var(--shell-accent); }
.arcade-shell .as-seg { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--shell-edge); border-radius: 10px; overflow: hidden; }
.arcade-shell .as-seg2 { grid-template-columns: 1fr 1fr; }
.arcade-shell .as-seg button { font: 500 13px var(--shell-font); color: var(--shell-ink); background: transparent; border: 0; padding: 7px 4px; cursor: pointer; }
.arcade-shell .as-seg button + button { border-left: 1px solid var(--shell-edge); }
.arcade-shell .as-seg button[aria-pressed=true] { color: var(--shell-accent-ink); background: var(--shell-accent); }
.arcade-shell .as-note { margin: -4px 0 0 calc(11em + 10px); font-size: 12px; color: var(--shell-dim); min-height: 1em; }
.arcade-shell .as-pill { position: fixed; z-index: 41; top: 14px; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: var(--shell-card); box-shadow: inset 0 0 0 1px var(--shell-edge); font-size: 13px; pointer-events: none; }
.arcade-shell .as-pill[data-state="lost"] { color: var(--shell-accent); }
.arcade-shell .as-loading { position: fixed; inset: 0; z-index: 42; display: flex; align-items: center; justify-content: center; background: #050607; }
.arcade-shell .as-load { display: grid; gap: 14px; width: min(360px, 80vw); text-align: center; }
.arcade-shell .as-bar { height: 4px; border-radius: 2px; background: var(--shell-field); overflow: hidden; }
.arcade-shell .as-bar i { display: block; height: 100%; background: var(--shell-accent); transition: width 0.2s ease-out; }
.arcade-shell .as-load-label { font-size: 13px; color: var(--shell-dim); }
@media (prefers-reduced-motion: reduce) { .arcade-shell .as-bar i { transition: none; } }
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
