import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { cleanPlayerName } from "@arcade/kit/sim/matchmaking"
import {
  clampSurvivorVariant,
  DEFAULT_LOADOUT,
  isLoadoutId,
  isSurvivorVariant,
  LOADOUTS,
  loadoutSpec,
  type LoadoutId,
  type SurvivorVariant,
} from "../../shared/loadout"
import { MAX_SURVIVORS } from "../../shared/coop-sim"
import { MAX_NAME, ROOM_CODE } from "../../shared/net-protocol"
import { copyInviteLink, inviteLink, playerName, savePlayerName } from "../coop-hud"
import { requestTraining } from "../onboarding/state"
import type { NetSession } from "../net-session"
import { SURVIVORS, survivorSpec, type SurvivorLookSpec } from "./survivors"
import { lobbyKeyAction } from "./keys"
import { lobbyWaitingOn } from "./waiting"
import { parseRunSeed, runSeedCode, runSeedLink, type RunSeed } from "./run-seed"

export type LobbyMode = "closed" | "start" | "coop" | "pause"

export type OutbreakLobbyCallbacks = {
  onStartSolo: (variant: SurvivorVariant, loadout: LoadoutId, name: string) => void
  onHostCoop: (variant: SurvivorVariant, loadout: LoadoutId, name: string) => void
  onJoinCoop: (room: string, variant: SurvivorVariant, loadout: LoadoutId, name: string) => void
  onLeaveCoop: () => void
  onReturnToLobby: () => void
  onPickChange: (patch: { variant?: SurvivorVariant; loadout?: LoadoutId; name?: string }) => void
}

const VARIANT_STORAGE_KEY = "outbreak.survivor.variant"
const LOADOUT_STORAGE_KEY = "outbreak.survivor.loadout"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const hexCss = (n: number) => `#${n.toString(16).padStart(6, "0")}`

/** True when the page URL should open the Start / Loadout screen by default. */
export function shouldShowStartScreen(search: string = location.search): boolean {
  const q = new URLSearchParams(search)
  if (q.has("lobby") || q.has("menu")) return q.get("lobby") !== "0" && q.get("menu") !== "0"
  if (q.has("room")) return false
  if (typeof window !== "undefined" && window.self !== window.top) return false
  for (const key of ["solo", "bench", "seed", "peaceful", "lab", "bot", "quality", "hour", "infiniteAmmo", "world", "foliage"]) {
    if (q.has(key)) return false
  }
  return true
}

function readStoredVariant(): SurvivorVariant {
  try {
    const raw = Number(localStorage.getItem(VARIANT_STORAGE_KEY))
    if (isSurvivorVariant(raw)) return raw
  } catch {
    // Private browsing or blocked storage.
  }
  return 0
}

function readStoredLoadout(): LoadoutId {
  try {
    const raw = localStorage.getItem(LOADOUT_STORAGE_KEY)
    if (isLoadoutId(raw)) return raw
  } catch {
    // Private browsing or blocked storage.
  }
  return DEFAULT_LOADOUT
}

function saveChoices(variant: SurvivorVariant, loadout: LoadoutId): void {
  try {
    localStorage.setItem(VARIANT_STORAGE_KEY, String(variant))
    localStorage.setItem(LOADOUT_STORAGE_KEY, loadout)
  } catch {
    // Private browsing or blocked storage.
  }
}

function parseRoomInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    if (trimmed.includes("room=")) {
      const u = new URL(trimmed, "https://anoma.ly")
      const r = u.searchParams.get("room")?.toLowerCase() ?? ""
      if (ROOM_CODE.test(r)) return r
    }
  } catch {
    // Fall back to direct room code check.
  }
  const code = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "")
  return ROOM_CODE.test(code) ? code : null
}

function avatarBadgeSvg(spec: SurvivorLookSpec): string {
  const torso = hexCss(spec.torso)
  const legs = hexCss(spec.legs)
  return `<svg class="ob-lobby-figure" viewBox="0 0 28 36" aria-hidden="true">
    <circle cx="14" cy="7.5" r="4.2" fill="#c79c7e" stroke="rgba(0,0,0,0.65)" stroke-width="1"/>
    <path d="M9.8 6.4C10.2 3.8 17.8 3.8 18.2 6.4Z" fill="#362c25"/>
    <rect x="7.5" y="12.5" width="13" height="11.5" rx="2.6" fill="${torso}" stroke="rgba(0,0,0,0.65)" stroke-width="1"/>
    <rect x="9" y="23.5" width="4.4" height="9.5" rx="1.5" fill="${legs}" stroke="rgba(0,0,0,0.6)" stroke-width="0.9"/>
    <rect x="14.6" y="23.5" width="4.4" height="9.5" rx="1.5" fill="${legs}" stroke="rgba(0,0,0,0.6)" stroke-width="0.9"/>
  </svg>`
}

export class OutbreakLobby {
  readonly root: HTMLElement
  mode: LobbyMode = "closed"
  variant: SurvivorVariant
  loadout: LoadoutId
  name: string
  private joinCode = ""
  private joinError: string | null = null
  private copiedUntil = 0
  private lastKey = ""
  private net: NetSession | null = null
  private practising = false
  private run: RunSeed = { seed: 7, houseSeed: 7, terrain: 0.22 }

  constructor(
    parent: HTMLElement,
    private readonly callbacks: OutbreakLobbyCallbacks,
  ) {
    installLobbyStyles()
    const q = new URLSearchParams(location.search)
    this.name = playerName(q)
    this.variant = isSurvivorVariant(Number(q.get("variant")))
      ? (Number(q.get("variant")) as SurvivorVariant)
      : readStoredVariant()
    const qLoadout = q.get("loadout")
    this.loadout = isLoadoutId(qLoadout) ? qLoadout : readStoredLoadout()

    this.root = document.createElement("section")
    this.root.id = "outbreak-lobby"
    this.root.className = "ob-lobby-backdrop"
    this.root.setAttribute("aria-label", "Outbreak loadout and co-op lobby")
    this.root.hidden = true
    this.root.addEventListener("click", (e) => this.onClick(e))
    this.root.addEventListener("input", (e) => this.onInput(e))
    this.root.addEventListener("keydown", (e) => this.onFormKeyDown(e))
    window.addEventListener("keydown", (e) => this.onGlobalKeyDown(e), true)
    parent.appendChild(this.root)
  }

  get isOpen(): boolean {
    return this.mode !== "closed"
  }

  /**
   * The practice space is live behind the lobby (`src/onboarding`, set when the session is made): the panel docks to
   * the side over the world and the game keeps every key but Enter.
   */
  get practice(): boolean {
    return this.practising
  }

  set practice(on: boolean) {
    if (on === this.practising) return
    this.practising = on
    this.root.classList.toggle("is-practice", on)
    if (this.isOpen) this.render(true)
  }

  /** Slides the practice panel out of the way while the bag is open. */
  tuck(on: boolean): void {
    const v = String(on)
    if (this.root.dataset.tucked !== v) this.root.dataset.tucked = v
  }

  openStart(): void {
    this.mode = "start"
    this.joinError = null
    this.root.hidden = false
    this.render(true)
  }

  syncRun(run: RunSeed): void {
    this.run = { seed: run.seed, houseSeed: run.houseSeed, terrain: run.terrain }
  }

  openPause(): void {
    if (this.isOpen) return
    this.mode = "pause"
    this.practice = false
    this.tuck(false)
    this.root.hidden = false
    window.dispatchEvent(new Event("outbreak-menu-open"))
    this.render(true)
    this.root.querySelector<HTMLButtonElement>('[data-act="resume"]')?.focus()
  }

  openCoop(net: NetSession): void {
    this.net = net
    this.mode = "coop"
    this.joinError = null
    this.root.hidden = false
    this.render(true)
  }

  close(): void {
    const active = document.activeElement
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur()
    this.mode = "closed"
    this.root.hidden = true
    this.lastKey = ""
  }

  sync(net: NetSession | null): void {
    this.net = net
    if (net) {
      if (net.connected) {
        this.variant = net.variant
        this.loadout = net.loadout
        saveChoices(this.variant, this.loadout)
      }
      if (this.mode === "coop" && net.connected && net.phase === "running") {
        this.close()
        return
      }
    }
    if (this.mode !== "closed") this.render()
  }

  inspect() {
    return {
      open: this.isOpen,
      mode: this.mode,
      practice: this.practising,
      name: this.name,
      variant: this.variant,
      loadout: this.loadout,
      phase: this.net?.phase ?? null,
      isHost: this.net?.isHost ?? false,
      ready: this.net?.ready ?? false,
      roster: this.net?.roster ?? [],
    }
  }

  private commitName(raw: string): void {
    const cleaned = cleanPlayerName(raw, MAX_NAME, "Survivor")
    this.name = cleaned
    savePlayerName(cleaned)
    if (this.net) this.callbacks.onPickChange({ name: cleaned })
  }

  private selectVariant(v: SurvivorVariant): void {
    if (this.mode === "coop" && this.net) {
      const takenByOther = this.net.roster.some((p) => p.id !== this.net!.id && p.variant === v)
      if (takenByOther) return
      this.variant = v
      saveChoices(this.variant, this.loadout)
      this.callbacks.onPickChange({ variant: v })
      this.render(true)
      return
    }
    this.variant = v
    saveChoices(this.variant, this.loadout)
    this.callbacks.onPickChange({ variant: v })
    this.render(true)
  }

  private selectLoadout(id: LoadoutId): void {
    this.loadout = id
    saveChoices(this.variant, this.loadout)
    this.callbacks.onPickChange({ loadout: id })
    this.render(true)
  }

  private onInput(e: Event): void {
    const target = e.target as HTMLInputElement | null
    if (!target) return
    if (target.dataset.role === "run-seed") {
      target.setCustomValidity("")
      return
    }
    if (target.dataset.role === "name") {
      const cleaned = cleanPlayerName(target.value, MAX_NAME, "Survivor")
      this.name = cleaned
      savePlayerName(cleaned)
      if (this.net) this.callbacks.onPickChange({ name: cleaned })
    } else if (target.dataset.role === "join-code") {
      this.joinCode = target.value
      if (this.joinError) {
        this.joinError = null
        this.render(true)
      }
    }
  }

  private onFormKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLInputElement | null
    if (!target || target.tagName !== "INPUT") return
    e.stopPropagation()
    if (e.key === "Enter") {
      e.preventDefault()
      if (target.dataset.role === "join-code") {
        this.triggerJoin()
      } else {
        target.blur()
      }
    }
  }

  private onGlobalKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen) return
    if (this.mode === "pause" && e.code === "Escape") {
      e.preventDefault()
      e.stopImmediatePropagation()
      this.close()
      return
    }
    const active = document.activeElement
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.code === "Backquote") return
    if (this.mode === "pause") {
      // Keep native button activation and tab navigation, without starting a run or queuing gameplay input.
      e.stopImmediatePropagation()
      return
    }
    if (this.mode === "coop" && !this.net) return
    const action = lobbyKeyAction(e.code, {
      mode: this.mode === "coop" ? "coop" : "start",
      practice: this.practice,
      training: !this.practice,
      ready: Boolean(this.net?.ready),
      canStart: this.canStartCoop(),
    })
    // Over the practice space the game keeps every key the lobby does not use; the paused menu keeps them all.
    if (action || !this.practice) e.stopImmediatePropagation()
    if (!action) return
    e.preventDefault()
    if (action.act === "variant") this.selectVariant(action.variant)
    else this.act(action.act)
  }

  private act(act: string): void {
    const net = this.net
    if (act === "solo") this.triggerSolo()
    else if (act === "training") this.triggerSolo(true)
    else if (act === "host") this.triggerHost()
    else if (act === "join") this.triggerJoin()
    else if (act === "leave") this.callbacks.onLeaveCoop()
    else if (!net) return
    else if (act === "copy") void this.copyInvite(net.options.room)
    else if (act === "ready" || act === "unready") {
      net.setReady(act === "ready")
      this.render(true)
    } else if (act === "toggle-ready") {
      net.setReady(!net.ready)
      this.render(true)
    } else if (act === "start" && this.canStartCoop()) net.start()
  }

  private onClick(e: MouseEvent): void {
    // Over the practice space a focused button would take the next Space (vault) as a click.
    if (this.practice) queueMicrotask(() => {
      const active = document.activeElement as HTMLElement | null
      if (active?.tagName === "BUTTON") active.blur()
    })
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-act], [data-variant], [data-loadout]")
    if (!el) return
    if (el.dataset.variant !== undefined) {
      const v = clampSurvivorVariant(Number(el.dataset.variant))
      this.selectVariant(v)
      return
    }
    if (el.dataset.loadout !== undefined) {
      const id = el.dataset.loadout
      if (isLoadoutId(id)) this.selectLoadout(id)
      return
    }
    const act = el.dataset.act
    if (act === "resume") {
      this.close()
    } else if (act === "loadout") {
      this.openStart()
      this.callbacks.onReturnToLobby()
    } else if (act === "copy-seed") {
      const button = el as HTMLButtonElement
      void this.copySeed(button)
    } else if (act === "play-seed") {
      const input = this.root.querySelector<HTMLInputElement>('[data-role="run-seed"]')!
      const seed = parseRunSeed(input.value)
      input.setCustomValidity(seed ? "" : "Enter a seed from 0 to 4294967295, or a town.house seed.")
      if (!input.reportValidity() || !seed) return
      location.assign(this.localRunLink({ ...this.run, ...seed }))
    } else if (act === "restart-run") {
      location.assign(this.localRunLink(this.run))
    } else if (act === "new-town") {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
      location.assign(this.localRunLink({ ...this.run, seed, houseSeed: seed }))
    } else if (act) {
      this.act(act === "ready" ? "toggle-ready" : act)
    }
  }

  private localRunLink(run: RunSeed): string {
    const replay = new URL(runSeedLink(run))
    return `${location.pathname}${replay.search}`
  }

  private async copySeed(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(runSeedLink(this.run))
      button.textContent = "Link copied"
    } catch {
      button.textContent = "Copy unavailable"
    }
  }

  /** Starts solo; the first time in a browser (or with `training`, always) it begins in the training room (AR-89). */
  private triggerSolo(training = false): void {
    this.syncNameFromDom()
    saveChoices(this.variant, this.loadout)
    requestTraining(training)
    this.close()
    this.callbacks.onStartSolo(this.variant, this.loadout, this.name)
  }

  private triggerHost(): void {
    this.syncNameFromDom()
    saveChoices(this.variant, this.loadout)
    this.callbacks.onHostCoop(this.variant, this.loadout, this.name)
  }

  private triggerJoin(): void {
    this.syncNameFromDom()
    const input = this.root.querySelector<HTMLInputElement>('[data-role="join-code"]')
    if (input) this.joinCode = input.value
    const code = parseRoomInput(this.joinCode)
    if (!code) {
      this.joinError = "Enter a 4–8 character room code or invite link."
      this.render(true)
      return
    }
    this.joinError = null
    saveChoices(this.variant, this.loadout)
    this.callbacks.onJoinCoop(code, this.variant, this.loadout, this.name)
  }

  private syncNameFromDom(): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-role="name"]')
    if (input && input.value.trim()) this.commitName(input.value)
  }

  private async copyInvite(room: string): Promise<void> {
    this.copiedUntil = (await copyInviteLink(room)) ? performance.now() + 1600 : 0
    this.render(true)
    setTimeout(() => this.render(true), 1650)
  }

  private canStartCoop(): boolean {
    if (!this.net || !this.net.connected || this.net.phase !== "lobby") return false
    if (this.net.isHost) return true
    const connected = this.net.roster.filter((p) => p.connected)
    return connected.length > 0 && connected.every((p) => p.ready)
  }

  render(force = false): void {
    if (this.mode === "closed") return
    if (this.mode === "pause") {
      if (!force) return
      this.root.innerHTML = `<div class="ob-lobby-dialog hud-panel" role="dialog" aria-modal="true" aria-labelledby="ob-pause-title">
        <h1 id="ob-pause-title" class="ob-lobby-title">Paused</h1>
        <button type="button" class="ob-lobby-btn is-primary" data-act="resume">Resume ${keyCapHtml("Escape")}</button>
        <label class="ob-lobby-callsign"><span class="ob-lobby-label">Seed</span>
          <input class="ob-lobby-input" data-role="run-seed" value="${runSeedCode(this.run)}" inputmode="decimal" autocomplete="off" spellcheck="false" />
        </label>
        <div class="ob-lobby-primary-actions">
          <button type="button" class="ob-lobby-btn" data-act="copy-seed">Copy replay link</button>
          <button type="button" class="ob-lobby-btn" data-act="play-seed">Play seed</button>
        </div>
        <div class="ob-lobby-primary-actions">
          <button type="button" class="ob-lobby-btn" data-act="restart-run">Restart</button>
          <button type="button" class="ob-lobby-btn" data-act="new-town">New town</button>
          <button type="button" class="ob-lobby-btn" data-act="loadout">Lobby</button>
        </div>
      </div>`
      return
    }
    const activeEl = document.activeElement as HTMLInputElement | null
    const editingInput = activeEl && this.root.contains(activeEl) && activeEl.tagName === "INPUT"
    if (editingInput && !force) return

    const net = this.net
    const copied = performance.now() < this.copiedUntil
    const stateKey = JSON.stringify({
      mode: this.mode,
      name: this.name,
      variant: this.variant,
      loadout: this.loadout,
      joinCode: this.joinCode,
      joinError: this.joinError,
      practice: this.practising,
      copied,
      net: net
        ? {
            room: net.options.room,
            id: net.id,
            connected: net.connected,
            status: net.status,
            phase: net.phase,
            hostId: net.hostId,
            ready: net.ready,
            roster: net.roster,
          }
        : null,
    })
    if (!force && stateKey === this.lastKey) return
    this.lastKey = stateKey

    // Over the practice space only Enter is the lobby's; the other keys practise.
    const menuCap = (code: string) => (this.practice ? "" : keyCapHtml(code))
    const survivorCards = SURVIVORS.map((s, idx) => {
      const selected = this.variant === s.variant
      const owner =
        this.mode === "coop" && net
          ? net.roster.find((p) => p.variant === s.variant && p.id !== net.id)
          : undefined
      const taken = Boolean(owner)
      const badge = selected
        ? `<span class="ob-lobby-tag is-you">Selected</span>`
        : owner
          ? `<span class="ob-lobby-tag is-taken">${esc(owner.name)}</span>`
          : this.practice
            ? ""
            : `<span class="ob-lobby-cap">${keyCapHtml(`Digit${idx + 1}`)}</span>`
      return `<button type="button" class="ob-lobby-card${selected ? " is-selected" : ""}${taken ? " is-taken" : ""}" data-variant="${s.variant}" aria-pressed="${selected}" ${taken ? 'aria-disabled="true"' : ""} style="--surv-accent:${s.css}">
        <div class="ob-lobby-card-top">
          ${avatarBadgeSvg(s)}
          <div class="ob-lobby-card-meta">
            <div class="ob-lobby-card-title"><span class="ob-lobby-dot" style="background:${s.css}"></span>${esc(s.name)}</div>
            <div class="ob-lobby-card-role">${esc(s.role)}</div>
          </div>
          ${badge}
        </div>
        <div class="ob-lobby-card-detail">${esc(s.detail)}</div>
      </button>`
    }).join("")

    const loadoutCards = LOADOUTS.map((l) => {
      const selected = this.loadout === l.id
      return `<button type="button" class="ob-lobby-kit${selected ? " is-selected" : ""}" data-loadout="${l.id}" aria-pressed="${selected}">
        <div class="ob-lobby-kit-head">
          <span class="ob-lobby-kit-name">${esc(l.label)}</span>
          <span class="ob-lobby-kit-role">${esc(l.role)}</span>
        </div>
        <div class="ob-lobby-kit-desc">${esc(l.summary)}</div>
      </button>`
    }).join("")

    if (this.mode === "start") {
      this.root.innerHTML = `<div class="ob-lobby-dialog hud-panel" role="dialog" aria-modal="true" aria-labelledby="ob-lobby-title">
        <header class="ob-lobby-header">
          <div>
            <div class="ob-lobby-eyebrow">FIRST NIGHT · 17:30 DUSK</div>
            <h1 id="ob-lobby-title" class="ob-lobby-title">OUTBREAK</h1>
            <p class="ob-lobby-sub">Choose your survivor and starting kit. Run solo or open a co-op room for up to six survivors.</p>
          </div>
          <label class="ob-lobby-callsign">
            <span class="ob-lobby-label">CALLSIGN</span>
            <input type="text" class="ob-lobby-input" data-role="name" maxlength="${MAX_NAME}" value="${esc(this.name)}" spellcheck="false" autocomplete="off" />
          </label>
        </header>

        <div class="ob-lobby-section">
          <div class="ob-lobby-section-head">
            <span class="ob-lobby-label">SURVIVOR</span>
            <span class="ob-lobby-hint">Keys 1–4 · Distinct coat in co-op</span>
          </div>
          <div class="ob-lobby-grid-4" role="radiogroup" aria-label="Survivor">${survivorCards}</div>
        </div>

        <div class="ob-lobby-section">
          <div class="ob-lobby-section-head">
            <span class="ob-lobby-label">STARTING KIT</span>
            <span class="ob-lobby-hint">Issued in hand &amp; supply belt</span>
          </div>
          <div class="ob-lobby-grid-4" role="radiogroup" aria-label="Starting kit">${loadoutCards}</div>
        </div>

        <footer class="ob-lobby-footer">
          <div class="ob-lobby-primary-actions">
            <button type="button" class="ob-lobby-btn is-primary" data-act="solo">
              <span>Play Solo</span>
              ${keyCapHtml("Enter")}
            </button>
            <button type="button" class="ob-lobby-btn is-accent" data-act="host">
              <span>Host Co-op</span>
              ${menuCap("KeyH")}
            </button>
            ${
              this.practice
                ? ""
                : `<button type="button" class="ob-lobby-btn" data-act="training">
              <span>Training Room</span>
              ${keyCapHtml("KeyT")}
            </button>`
            }
          </div>
          <div class="ob-lobby-join-bar">
            <input type="text" class="ob-lobby-input ob-lobby-code-input" data-role="join-code" placeholder="Room code or link…" value="${esc(this.joinCode)}" spellcheck="false" autocomplete="off" aria-label="Room code" />
            <button type="button" class="ob-lobby-btn" data-act="join">Join Room</button>
          </div>
        </footer>
        ${this.joinError ? `<div class="ob-lobby-error" role="alert">${esc(this.joinError)}</div>` : ""}
      </div>`
      return
    }

    const room = net?.options.room ?? ""
    const link = inviteLink(room)
    const roster = net?.roster ?? []
    const seatsHtml = Array.from({ length: MAX_SURVIVORS }, (_, seatIdx) => {
      const p = roster.find((r) => r.index === seatIdx)
      if (!p) {
        return `<div class="ob-lobby-seat is-empty" data-seat="${seatIdx}">
          <span class="ob-lobby-seat-num">${seatIdx + 1}</span>
          <div class="ob-lobby-seat-body">
            <div class="ob-lobby-seat-name">Open Seat</div>
            <div class="ob-lobby-seat-sub">Share the invite link to bring a survivor</div>
          </div>
          <span class="ob-lobby-status is-open">OPEN</span>
        </div>`
      }
      const look = survivorSpec(p.variant ?? p.index)
      const kit = loadoutSpec(p.loadout)
      const isYou = p.id === net?.id
      const isHost = Boolean(p.host || p.id === net?.hostId)
      const statusLabel = !p.connected ? "DROPPED" : p.ready ? "READY" : "NOT READY"
      const statusClass = !p.connected ? "is-dropped" : p.ready ? "is-ready" : "is-wait"
      return `<div class="ob-lobby-seat${isYou ? " is-you" : ""}" data-seat="${seatIdx}" style="--surv-accent:${look.css}">
        <span class="ob-lobby-seat-dot" style="background:${look.css}"></span>
        <div class="ob-lobby-seat-body">
          <div class="ob-lobby-seat-row">
            <span class="ob-lobby-seat-name">${esc(p.name)}</span>
            ${isYou ? `<span class="ob-lobby-badge is-you">YOU</span>` : ""}
            ${isHost ? `<span class="ob-lobby-badge is-host">HOST</span>` : ""}
          </div>
          <div class="ob-lobby-seat-sub">${esc(look.name)} (${esc(look.role)}) · ${esc(kit.label)}</div>
        </div>
        <span class="ob-lobby-status ${statusClass}">${statusLabel}</span>
      </div>`
    }).join("")

    const connectedCount = roster.filter((p) => p.connected).length
    const readyCount = roster.filter((p) => p.connected && p.ready).length
    const isHost = Boolean(net?.isHost)
    const canStart = this.canStartCoop()
    // Playtest (Oct 20): "I'm stuck waiting... Oh, you gotta click Ready." Say who the room is waiting on.
    const waitingOn = lobbyWaitingOn(roster, net?.id)
    const statusBanner = net?.status
      ? `<span class="ob-lobby-banner is-warn">${esc(net.status)}</span>`
      : `<span class="ob-lobby-banner">Night paused at 17:30 · ${readyCount}/${Math.max(1, connectedCount)} ready${waitingOn.text ? ` · ${esc(waitingOn.text)}` : ""}</span>`

    this.root.innerHTML = `<div class="ob-lobby-dialog hud-panel is-coop" role="dialog" aria-modal="true" aria-labelledby="ob-lobby-title">
      <header class="ob-lobby-header">
        <div>
          <div class="ob-lobby-eyebrow">CO-OP SAFEHOUSE LOBBY · ROOM <strong class="ob-lobby-code">${esc(room.toUpperCase())}</strong></div>
          <h1 id="ob-lobby-title" class="ob-lobby-title">SQUAD MUSTER</h1>
          <div class="ob-lobby-sub-row">${statusBanner}</div>
        </div>
        <label class="ob-lobby-callsign">
          <span class="ob-lobby-label">CALLSIGN</span>
          <input type="text" class="ob-lobby-input" data-role="name" maxlength="${MAX_NAME}" value="${esc(this.name)}" spellcheck="false" autocomplete="off" />
        </label>
      </header>

      <div class="ob-lobby-invite-bar">
        <div class="ob-lobby-invite-info">
          <span class="ob-lobby-label">INVITE LINK</span>
          <code class="ob-lobby-invite-url">${esc(link)}</code>
        </div>
        <button type="button" class="ob-lobby-btn is-accent" data-act="copy">
          <span>${copied ? "Copied Link" : "Copy Invite Link"}</span>
          ${menuCap("KeyC")}
        </button>
      </div>

      <div class="ob-lobby-section">
        <div class="ob-lobby-section-head">
          <span class="ob-lobby-label">SQUAD ROSTER (${connectedCount}/${MAX_SURVIVORS})</span>
          <span class="ob-lobby-hint">Everyone spawns together when the host starts or all ready up</span>
        </div>
        <div class="ob-lobby-roster" role="list" aria-label="Squad roster">${seatsHtml}</div>
      </div>

      <div class="ob-lobby-section">
        <div class="ob-lobby-section-head">
          <span class="ob-lobby-label">YOUR SURVIVOR</span>
          <span class="ob-lobby-hint">Keys 1–4 · Duplicate looks are locked per squad</span>
        </div>
        <div class="ob-lobby-grid-4" role="radiogroup" aria-label="Survivor">${survivorCards}</div>
      </div>

      <div class="ob-lobby-section">
        <div class="ob-lobby-section-head">
          <span class="ob-lobby-label">YOUR STARTING KIT</span>
          <span class="ob-lobby-hint">Synced to the room ledger</span>
        </div>
        <div class="ob-lobby-grid-4" role="radiogroup" aria-label="Starting kit">${loadoutCards}</div>
      </div>

      <footer class="ob-lobby-footer">
        <button type="button" class="ob-lobby-btn" data-act="leave">
          <span>Leave Room</span>
          ${menuCap("Escape")}
        </button>
        <div class="ob-lobby-primary-actions">
          <button type="button" class="ob-lobby-btn${net?.ready ? " is-ready" : " is-primary is-call"}" data-act="ready" aria-pressed="${Boolean(net?.ready)}">
            <span>${net?.ready ? "Ready ✓" : this.practice ? "Ready" : "Click to Ready Up"}</span>
            ${this.practice ? (net?.ready ? "" : keyCapHtml("Enter")) : keyCapHtml("KeyR")}
          </button>
          ${
            isHost
              ? `<button type="button" class="ob-lobby-btn is-primary" data-act="start" ${canStart ? "" : "disabled"}>
                  <span>Start Night</span>
                  ${!this.practice || net?.ready ? keyCapHtml("Enter") : ""}
                </button>`
              : `<button type="button" class="ob-lobby-btn${net?.ready ? " is-primary" : ""}" data-act="start" ${canStart ? "" : "disabled"}>
                  <span>${canStart ? "Start Night" : waitingOn.button}</span>
                </button>`
          }
        </div>
      </footer>
    </div>`
  }
}

let stylesInstalled = false

function installLobbyStyles(): void {
  if (stylesInstalled || typeof document === "undefined" || !document.head) return
  stylesInstalled = true
  if (document.getElementById("outbreak-lobby-styles")) return
  const style = document.createElement("style")
  style.id = "outbreak-lobby-styles"
  style.textContent = `
.ob-lobby-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: radial-gradient(circle at 50% 38%, rgba(12, 11, 10, 0.58) 0%, rgba(6, 6, 7, 0.86) 100%);
  backdrop-filter: blur(5px);
  pointer-events: auto;
  font-family: var(--hud-font-sans, "Inter", system-ui, sans-serif);
  color: var(--hud-text, #ece4d4);
}
.ob-lobby-Backdrop[hidden],
.ob-lobby-backdrop[hidden] {
  display: none !important;
}
.ob-lobby-dialog {
  width: min(780px, 100%);
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  padding: 22px 24px;
  border-radius: 14px;
  background: var(--hud-surface-strong, rgba(16, 15, 13, 0.94));
  border: 1px solid var(--hud-edge, rgba(255, 244, 214, 0.14));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.72), 0 1px 0 rgba(255, 248, 228, 0.07) inset;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ob-lobby-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.ob-lobby-eyebrow {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.12em;
  color: var(--hud-amber, #e0a448);
  text-transform: uppercase;
  margin-bottom: 3px;
}
.ob-lobby-code {
  color: var(--hud-text, #ece4d4);
  letter-spacing: 0.16em;
}
.ob-lobby-title {
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--hud-text, #ece4d4);
}
.ob-lobby-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.68));
  max-width: 48ch;
  line-height: 1.4;
}
.ob-lobby-sub-row {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ob-lobby-banner {
  font-size: 12px;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.72));
}
.ob-lobby-banner.is-warn {
  color: var(--hud-amber, #e0a448);
}
.ob-lobby-callsign {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 170px;
}
.ob-lobby-label {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.62));
  text-transform: uppercase;
}
.ob-lobby-hint {
  font-size: 11px;
  color: var(--hud-text-faint, rgba(236, 228, 212, 0.42));
}
.ob-lobby-input {
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid rgba(255, 244, 214, 0.18);
  background: rgba(8, 8, 9, 0.75);
  color: var(--hud-text, #ece4d4);
  font: 600 13px/1.2 var(--hud-font-sans, system-ui, sans-serif);
  outline: none;
}
.ob-lobby-input:focus {
  border-color: var(--hud-amber, #e0a448);
  box-shadow: 0 0 0 2px rgba(224, 164, 72, 0.22);
}
.ob-lobby-invite-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 9px;
  background: rgba(255, 244, 214, 0.04);
  border: 1px solid rgba(255, 244, 214, 0.1);
  flex-wrap: wrap;
}
.ob-lobby-invite-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.ob-lobby-invite-url {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--hud-text, #ece4d4);
  word-break: break-all;
}
.ob-lobby-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ob-lobby-section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.ob-lobby-grid-4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 680px) {
  .ob-lobby-grid-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.ob-lobby-card,
.ob-lobby-kit {
  appearance: none;
  text-align: left;
  padding: 10px 11px;
  border-radius: 9px;
  background: rgba(255, 248, 228, 0.03);
  border: 1px solid rgba(255, 244, 214, 0.11);
  color: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color 110ms ease, background 110ms ease, transform 90ms ease;
}
.ob-lobby-card:hover:not(.is-taken),
.ob-lobby-kit:hover {
  background: rgba(255, 248, 228, 0.065);
  border-color: rgba(255, 244, 214, 0.24);
}
.ob-lobby-card.is-selected {
  background: rgba(224, 164, 72, 0.1);
  border-color: var(--surv-accent, var(--hud-amber, #e0a448));
  box-shadow: 0 0 0 1px var(--surv-accent, var(--hud-amber, #e0a448)) inset;
}
.ob-lobby-kit.is-selected {
  background: rgba(224, 164, 72, 0.1);
  border-color: var(--hud-amber, #e0a448);
  box-shadow: 0 0 0 1px rgba(224, 164, 72, 0.45) inset;
}
.ob-lobby-card.is-taken {
  opacity: 0.48;
  cursor: not-allowed;
}
.ob-lobby-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ob-lobby-figure {
  width: 24px;
  height: 31px;
  flex: none;
}
.ob-lobby-card-meta {
  flex: 1;
  min-width: 0;
}
.ob-lobby-card-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-text, #ece4d4);
}
.ob-lobby-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
}
.ob-lobby-card-role {
  font-size: 11px;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.65));
}
.ob-lobby-card-detail {
  font-size: 11px;
  color: var(--hud-text-faint, rgba(236, 228, 212, 0.48));
  line-height: 1.3;
}
.ob-lobby-cap {
  font-size: 11px;
}
.ob-lobby-tag {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 9.5px;
  font-weight: 700;
  padding: 2px 5px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ob-lobby-tag.is-you {
  background: rgba(224, 164, 72, 0.2);
  color: var(--hud-amber, #e0a448);
}
.ob-lobby-tag.is-taken {
  background: rgba(255, 255, 255, 0.08);
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.65));
}
.ob-lobby-kit-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
}
.ob-lobby-kit-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-text, #ece4d4);
}
.ob-lobby-kit-role {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  font-weight: 650;
  color: var(--hud-amber, #e0a448);
}
.ob-lobby-kit-desc {
  font-size: 11px;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.62));
  line-height: 1.32;
}
.ob-lobby-roster {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 600px) {
  .ob-lobby-roster {
    grid-template-columns: 1fr;
  }
}
.ob-lobby-seat {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  background: rgba(255, 248, 228, 0.035);
  border: 1px solid rgba(255, 244, 214, 0.1);
}
.ob-lobby-seat.is-you {
  border-color: var(--surv-accent, var(--hud-amber, #e0a448));
  background: rgba(255, 248, 228, 0.06);
}
.ob-lobby-seat.is-empty {
  opacity: 0.56;
  border-style: dashed;
}
.ob-lobby-seat-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  flex: none;
}
.ob-lobby-seat-num {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 11px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.6));
  flex: none;
}
.ob-lobby-seat-body {
  flex: 1;
  min-width: 0;
}
.ob-lobby-seat-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ob-lobby-seat-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-text, #ece4d4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ob-lobby-seat-sub {
  font-size: 11px;
  color: var(--hud-text-dim, rgba(236, 228, 212, 0.62));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ob-lobby-badge {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 9.5px;
  font-weight: 700;
  padding: 1.5px 5px;
  border-radius: 4px;
  letter-spacing: 0.05em;
}
.ob-lobby-badge.is-you {
  background: rgba(255, 248, 228, 0.12);
  color: var(--hud-text, #ece4d4);
}
.ob-lobby-badge.is-host {
  background: rgba(224, 164, 72, 0.2);
  color: var(--hud-amber, #e0a448);
}
.ob-lobby-status {
  font-family: var(--hud-font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 700;
  padding: 3px 7px;
  border-radius: 999px;
  letter-spacing: 0.06em;
  flex: none;
}
.ob-lobby-status.is-ready {
  background: rgba(114, 182, 108, 0.2);
  color: var(--hud-green, #72b66c);
  border: 1px solid rgba(114, 182, 108, 0.4);
}
.ob-lobby-status.is-wait {
  background: rgba(224, 164, 72, 0.14);
  color: var(--hud-amber, #e0a448);
  border: 1px solid rgba(224, 164, 72, 0.3);
}
.ob-lobby-status.is-dropped {
  background: rgba(212, 82, 72, 0.18);
  color: var(--hud-red, #d45248);
}
.ob-lobby-status.is-open {
  color: var(--hud-text-faint, rgba(236, 228, 212, 0.4));
}
.ob-lobby-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 244, 214, 0.09);
  flex-wrap: wrap;
}
.ob-lobby-primary-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ob-lobby-join-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ob-lobby-code-input {
  width: 165px;
}
.ob-lobby-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 244, 214, 0.18);
  background: rgba(255, 248, 228, 0.06);
  color: var(--hud-text, #ece4d4);
  font: 650 13px/1 var(--hud-font-sans, system-ui, sans-serif);
  cursor: pointer;
  transition: background 110ms ease, border-color 110ms ease;
}
.ob-lobby-btn:hover:not(:disabled) {
  background: rgba(255, 248, 228, 0.12);
  border-color: rgba(255, 244, 214, 0.3);
}
.ob-lobby-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ob-lobby-btn.is-primary {
  background: rgba(224, 164, 72, 0.22);
  border-color: rgba(224, 164, 72, 0.55);
  color: #f9efd8;
}
.ob-lobby-btn.is-primary:hover:not(:disabled) {
  background: rgba(224, 164, 72, 0.32);
  border-color: rgba(224, 164, 72, 0.78);
}
.ob-lobby-btn.is-accent {
  background: rgba(111, 180, 232, 0.16);
  border-color: rgba(111, 180, 232, 0.42);
}
.ob-lobby-btn.is-accent:hover:not(:disabled) {
  background: rgba(111, 180, 232, 0.25);
}
.ob-lobby-btn.is-call { animation: ob-lobby-call 1.6s ease-in-out infinite }
@keyframes ob-lobby-call { 50% { box-shadow: 0 0 0 4px rgba(224, 164, 72, 0.28) } }
@media (prefers-reduced-motion: reduce) { .ob-lobby-btn.is-call { animation: none } }
.ob-lobby-btn.is-ready {
  background: rgba(114, 182, 108, 0.22);
  border-color: rgba(114, 182, 108, 0.55);
  color: #dff5dc;
}
.ob-lobby-error {
  font-size: 12px;
  color: var(--hud-red, #d45248);
  margin-top: -6px;
}
/* Practice space (AR-89, Kit: "While loading out you can train"): the world stays live and the lobby docks left. */
.ob-lobby-backdrop.is-practice {
  display: block;
  padding: 0;
  background: none;
  backdrop-filter: none;
  pointer-events: none;
}
.ob-lobby-backdrop.is-practice .ob-lobby-dialog {
  position: absolute;
  left: 14px;
  top: 12px;
  width: 316px;
  max-height: calc(100vh - 150px);
  padding: 14px 15px;
  gap: 12px;
  pointer-events: auto;
  background: rgb(16 15 13 / 0.96);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 140ms ease;
}
.ob-lobby-backdrop.is-practice[data-tucked="true"] .ob-lobby-dialog {
  transform: translateX(calc(-100% - 20px));
  opacity: 0;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) { .ob-lobby-backdrop.is-practice .ob-lobby-dialog { transition: none } }
.is-practice .ob-lobby-header { gap: 10px }
.is-practice .ob-lobby-title { font-size: 19px }
.is-practice .ob-lobby-sub,
.is-practice .ob-lobby-hint,
.is-practice .ob-lobby-card-detail,
.is-practice .ob-lobby-seat.is-empty { display: none }
.is-practice .ob-lobby-callsign { min-width: 0; width: 100% }
.is-practice .ob-lobby-tag.is-you { display: none }
.is-practice .ob-lobby-kit-head { flex-direction: column; align-items: flex-start; gap: 2px }
body:has(.ob-lobby-backdrop.is-practice:not([hidden]):not([data-tucked="true"])) #coop { visibility: hidden }
.is-practice .ob-lobby-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px }
.is-practice .ob-lobby-card,
.is-practice .ob-lobby-kit { padding: 7px 8px; gap: 3px }
.is-practice .ob-lobby-kit .ob-lobby-kit-desc { display: none }
.is-practice .ob-lobby-kit.is-selected { grid-column: 1 / -1 }
.is-practice .ob-lobby-kit.is-selected .ob-lobby-kit-desc { display: block }
.is-practice .ob-lobby-roster { grid-template-columns: 1fr; gap: 5px }
.is-practice .ob-lobby-seat { padding: 6px 9px }
.is-practice .ob-lobby-invite-bar { padding: 8px 10px }
.is-practice .ob-lobby-footer {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  position: sticky;
  bottom: -14px;
  z-index: 1;
  margin: 0 -15px -14px;
  padding: 10px 15px 14px;
  background: rgb(16 15 13 / 0.98);
}
.is-practice .is-coop .ob-lobby-footer { flex-direction: column-reverse }
.is-practice .ob-lobby-invite-info { display: none }
.is-practice .ob-lobby-invite-bar .ob-lobby-btn { flex: 1; justify-content: center }
.is-practice .ob-lobby-primary-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px }
.is-practice .ob-lobby-primary-actions .ob-lobby-btn { justify-content: center }
.is-practice .ob-lobby-primary-actions .ob-lobby-btn:first-child { grid-column: 1 / -1 }
.is-practice .is-coop .ob-lobby-primary-actions .ob-lobby-btn:first-child { grid-column: auto }
.is-practice .ob-lobby-join-bar .ob-lobby-code-input { flex: 1; width: auto; min-width: 0 }
`
  document.head.appendChild(style)
}
