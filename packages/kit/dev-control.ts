import { LabCommandRegistry, type LabCommandInvokeResult } from "./lab-commands"
import type { LabPanel } from "./lab-panel"
import {
  COMMAND_ALIASES,
  coerceControlValue,
  findControlRow,
  formatControlValue,
  readStageCameraState,
  registerPanelLabCommands,
  registerStageCameraCommands,
  round2,
} from "./dev-control/commands"
import { captureWebGPUOr2DCanvas, detectGameName, synthesizeHubCanvas, type NoteOverlayStateReader } from "./dev-control/screenshot"
import {
  isTourPageStep,
  openStudioLightboxDom,
  renderNoteCardDom,
  renderStudioPageDom,
  renderStudioStripDom,
  resolveNoteTargetRectFromPage,
} from "./dev-control/studio-ui"
import {
  STUDIO_SESSION_KEY,
  buildTourStepUrl,
  isLabPath,
  normalizeNoteArgs,
  normalizeNoteTarget,
  registerUiNoteCommand,
  resolveAccentColors,
  resolveNavigationPath,
  resolveTourAssetUrl,
  validateTourDefinition,
} from "./dev-control/tours"
import type {
  DevControlAdapter,
  DevControlBusyState,
  DevNotePayload,
  DevNoteResolvedRect,
  DevNoteTarget,
  DevPageKind,
  DevPageSummary,
  PanelLabCommandOptions,
  StageCameraCommandOptions,
  TourDefinition,
  TourPageImage,
  TourSetupCommand,
  TourStepDefinition,
} from "./dev-control/types"

declare global {
  interface ImportMetaEnv {
    DEV: boolean
  }
  interface Window {
    __arcadeDevControl?: PageControlRuntime
    __arcadeSubmitListeners?: Set<() => void>
    __arcadeSubmitHooked?: boolean
  }
}

export {
  buildTourStepUrl,
  coerceControlValue,
  findControlRow,
  formatControlValue,
  normalizeNoteArgs,
  normalizeNoteTarget,
  readStageCameraState,
  registerPanelLabCommands,
  registerStageCameraCommands,
  registerUiNoteCommand,
  resolveNavigationPath,
  resolveTourAssetUrl,
  validateTourDefinition,
}
export type {
  DevControlAdapter,
  DevControlBusyState,
  DevNotePayload,
  DevNoteResolvedRect,
  DevNoteTarget,
  DevPageKind,
  DevPageSummary,
  PanelLabCommandOptions,
  StageCameraCommandOptions,
  TourDefinition,
  TourPageImage,
  TourSetupCommand,
  TourStepDefinition,
}

function isStationEmbed(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.frameElement?.closest("[data-station-page]"))
  } catch {
    return false
  }
}

// Singleton per-page DevControl runtime (active in DEV or when embedded in a Lab page station)
class PageControlRuntime implements NoteOverlayStateReader {
  readonly panels = new Set<LabPanel>()
  private adapter: DevControlAdapter | null = null
  private defaultAdapter: DevControlAdapter | null = null
  private ws: WebSocket | null = null
  private reconnectTimer = 0
  private indicatorEl: HTMLElement | null = null
  private indicatorTimer = 0
  private noteEl: HTMLElement | null = null
  private ringEl: HTMLElement | null = null
  private ringRaf = 0
  private activeNote: DevNotePayload | null = null
  private baseDocumentTitle: string | null = null
  private studioTour: TourDefinition | null = null
  private studioStep = 1
  private studioCollapsed = false
  private studioStripEl: HTMLElement | null = null
  private studioPageEl: HTMLElement | null = null
  private studioLightboxEl: HTMLElement | null = null
  private tourStepAppliedInPlace = false
  private lastActiveAt = Date.now()
  private fallbackReady = false
  readonly pageId: string
  private routerConfig: { controlPath: string; pageToken: string } | null = null

  constructor() {
    this.pageId = this.resolvePageId()
    if (!import.meta.env?.DEV && !isStationEmbed()) return
    if (typeof window === "undefined" || typeof document === "undefined") return
    this.routerConfig = this.readRouterConfig()
    this.restoreStudioSession()
    this.syncWindowTourName()
    window.addEventListener("keydown", e => this.handleNoteKeydown(e), { capture: true })
    if (!this.routerConfig) return

    const bumpActivity = () => {
      this.lastActiveAt = Date.now()
      this.sendStatus()
    }
    window.addEventListener("focus", bumpActivity)
    window.addEventListener("blur", () => this.sendStatus())
    document.addEventListener("visibilitychange", () => this.sendStatus())
    window.addEventListener("hashchange", () => {
      this.lastActiveAt = Date.now()
      const meta = this.readUrlTourMeta()
      if (meta && this.studioTour && meta.id === this.studioTour.id && meta.step !== this.studioStep) {
        this.studioStep = meta.step
        this.saveStudioSession()
      }
      this.syncStudioUI()
      this.sendStatus()
    })
    window.addEventListener("popstate", () => {
      const meta = this.readUrlTourMeta()
      if (meta && this.studioTour && meta.id === this.studioTour.id) {
        this.studioStep = meta.step
        this.saveStudioSession()
      }
      this.syncStudioUI()
      this.sendStatus()
    })
    this.connect()
    this.pollUntilReady()
  }

  getActiveNote(): DevNotePayload | null {
    return this.activeNote
  }

  getStudioTour(): TourDefinition | null {
    return this.studioTour
  }

  getStudioStep(): number {
    return this.studioStep
  }

  isStudioStripExpanded(): boolean {
    return Boolean(this.studioTour && this.studioTour.singleTab !== false && !this.studioCollapsed)
  }

  private readUrlTourMeta(): { id: string; step: number; singleTab?: boolean; applied?: boolean } | null {
    try {
      const sp = new URLSearchParams(location.search)
      const id = sp.get("tour")?.trim()
      const step = Number(sp.get("step"))
      const multiTabParam = sp.get("multiTab") === "1" || sp.get("singleTab") === "0"
      if (id && Number.isFinite(step) && step >= 1) {
        return {
          id,
          step: Math.round(step),
          singleTab: !multiTabParam,
          ...(this.tourStepAppliedInPlace ? { applied: true } : {}),
        }
      }
      const hashMatch = (location.hash || "").match(/^#tour\/([a-zA-Z0-9_-]+)(?:\/(\d+))?/)
      if (hashMatch) {
        return {
          id: hashMatch[1]!,
          step: hashMatch[2] ? Math.max(1, Number(hashMatch[2])) : 1,
          singleTab: true,
          ...(this.tourStepAppliedInPlace ? { applied: true } : {}),
        }
      }
    } catch {}
    return null
  }

  private restoreStudioSession() {
    const urlMeta = this.readUrlTourMeta()
    try {
      const raw = sessionStorage.getItem(STUDIO_SESSION_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { tour?: TourDefinition; step?: number; collapsed?: boolean }
        if (parsed && parsed.tour && Array.isArray(parsed.tour.steps)) {
          if (!urlMeta || urlMeta.id === parsed.tour.id) {
            this.studioTour = parsed.tour
            this.studioStep = urlMeta ? urlMeta.step : Math.max(1, Math.min(parsed.tour.steps.length, Number(parsed.step) || 1))
            this.studioCollapsed = Boolean(parsed.collapsed)
          }
        }
      }
    } catch {}
    if (urlMeta) {
      this.studioStep = urlMeta.step
      if (this.studioTour && this.studioTour.id !== urlMeta.id) {
        this.studioTour = null
      }
    }
  }

  private saveStudioSession() {
    try {
      if (!this.studioTour || this.studioTour.singleTab === false) {
        sessionStorage.removeItem(STUDIO_SESSION_KEY)
        return
      }
      sessionStorage.setItem(
        STUDIO_SESSION_KEY,
        JSON.stringify({
          tour: this.studioTour,
          step: this.studioStep,
          collapsed: this.studioCollapsed,
        }),
      )
    } catch {}
  }

  closeStudioTour() {
    this.studioTour = null
    this.tourStepAppliedInPlace = false
    try {
      sessionStorage.removeItem(STUDIO_SESSION_KEY)
    } catch {}
    if (this.studioStripEl) this.studioStripEl.hidden = true
    this.hideStudioPage()
    this.clearNote()
    document.documentElement.removeAttribute("data-arcade-studio-open")
    document.documentElement.removeAttribute("data-arcade-studio-collapsed")
    document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
    try {
      const u = new URL(location.href)
      let changed = false
      for (const k of ["tour", "step", "singleTab"]) {
        if (u.searchParams.has(k)) {
          u.searchParams.delete(k)
          changed = true
        }
      }
      if (u.hash.startsWith("#tour/")) {
        u.hash = "#games"
        changed = true
      }
      if (changed) history.replaceState(null, "", u.pathname + u.search + u.hash)
    } catch {}
    this.sendStatus()
  }

  private syncWindowTourName() {
    const meta = this.readUrlTourMeta()
    if (meta) {
      try {
        window.name = `arcade-tour:${meta.id}:${meta.step}`
      } catch {}
    }
  }

  private handleNoteKeydown(event: KeyboardEvent) {
    const target = event.composedPath()[0] as HTMLElement | null
    const inText =
      Boolean(target) &&
      ((target instanceof HTMLInputElement && (target.type === "text" || target.type === "search" || target.type === "number")) ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable))

    if (this.studioLightboxEl && !this.studioLightboxEl.hidden && event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      this.studioLightboxEl.hidden = true
      return
    }

    if (this.studioTour && this.studioTour.singleTab !== false && !inText && this.studioTour.steps.length > 1) {
      const isAltPrev =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.code === "BracketLeft" || event.key === "[" || event.key === "“" || (event.key === "ArrowLeft" && !document.activeElement?.hasAttribute("data-lab")))
      const isAltNext =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.code === "BracketRight" || event.key === "]" || event.key === "‘" || (event.key === "ArrowRight" && !document.activeElement?.hasAttribute("data-lab")))
      if (isAltPrev || isAltNext) {
        event.preventDefault()
        event.stopPropagation()
        const count = this.studioTour.steps.length
        const nextStep = isAltPrev ? (this.studioStep > 1 ? this.studioStep - 1 : count) : this.studioStep < count ? this.studioStep + 1 : 1
        void this.goToTourStep(nextStep)
        return
      }
    }

    if (!this.activeNote) return
    if (inText || (target && target.tagName === "SELECT")) {
      return
    }
    if (event.key === "Escape" && this.activeNote.dismissible !== false) {
      const modalOpen = Boolean(document.querySelector(".lab-palette-backdrop:not([hidden]), .lab-modal-backdrop:not([hidden])"))
      if (modalOpen) return
      this.clearNote()
      this.sendStatus()
    }
  }

  resolveNoteTargetRect(target: DevNoteTarget, revealSetting = false): DevNoteResolvedRect | null {
    return resolveNoteTargetRectFromPage(target, [...this.panels], this.activeAdapter(), revealSetting)
  }

  private updateTargetRing(initial = false) {
    if (this.ringRaf) {
      cancelAnimationFrame(this.ringRaf)
      this.ringRaf = 0
    }
    const note = this.activeNote
    if (!note?.target) {
      if (this.ringEl) this.ringEl.hidden = true
      return
    }

    const rect = this.resolveNoteTargetRect(note.target, initial)
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      if (this.ringEl) this.ringEl.hidden = true
    } else {
      if (!this.ringEl || !document.body.contains(this.ringEl)) {
        const ring = document.createElement("div")
        ring.dataset.arcadeNoteRing = ""
        ring.setAttribute("aria-hidden", "true")
        document.body.append(ring)
        this.ringEl = ring
      }
      const colors = resolveAccentColors(note.accent)
      const pad = 6
      const borderRadius = rect.shape === "pill" ? "999px" : "8px"
      this.ringEl.hidden = false
      this.ringEl.style.cssText = `position:fixed;left:${Math.round(rect.x - pad)}px;top:${Math.round(rect.y - pad)}px;width:${Math.round(rect.width + pad * 2)}px;height:${Math.round(rect.height + pad * 2)}px;border-radius:${borderRadius};border:2px solid ${colors.text};box-shadow:0 0 0 4px ${colors.glow},0 0 18px ${colors.glow};pointer-events:none;z-index:9998;box-sizing:border-box;animation:arcade-note-pulse 1.8s ease-in-out infinite;`
    }

    this.ringRaf = requestAnimationFrame(() => this.updateTargetRing(false))
  }

  private navigateTourStep(direction: "prev" | "next") {
    if (this.studioTour && this.studioTour.singleTab !== false) {
      const count = this.studioTour.steps.length
      const nextStep = direction === "prev" ? Math.max(1, this.studioStep - 1) : Math.min(count, this.studioStep + 1)
      if (nextStep !== this.studioStep) {
        void this.goToTourStep(nextStep)
      }
      return
    }
    const note = this.activeNote
    if (!note) return
    const targetUrl = direction === "prev" ? note.prevUrl : note.nextUrl
    const targetStep =
      typeof note.stepIndex === "number" ? (direction === "prev" ? note.stepIndex - 1 : note.stepIndex + 1) : undefined

    if (note.singleTab && targetUrl) {
      location.assign(targetUrl)
      return
    }

    if (note.tourId && targetStep !== undefined) {
      const targetWinName = `arcade-tour:${note.tourId}:${targetStep}`
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "tour.focus",
            tourId: note.tourId,
            step: targetStep,
            url: targetUrl,
            singleTab: Boolean(note.singleTab),
          }),
        )
      }
      try {
        const existing = window.open("", targetWinName)
        if (existing && existing !== window && existing.location?.href && existing.location.href !== "about:blank") {
          existing.focus()
          return
        }
        if (existing && existing.location?.href === "about:blank") {
          existing.close()
        }
      } catch {}
    }

    if (targetUrl) {
      location.assign(targetUrl)
    }
  }

  private canApplyStepInPlace(step: TourStepDefinition, targetUrl: string): boolean {
    try {
      const cur = new URL(location.href)
      const dst = new URL(targetUrl, location.origin)
      if (cur.origin !== dst.origin || cur.pathname !== dst.pathname) return false
      if (cur.searchParams.has("bench") !== dst.searchParams.has("bench")) return false
      const stripParams = (sp: URLSearchParams, isLab: boolean) => {
        const copy = new URLSearchParams(sp)
        copy.delete("tour")
        copy.delete("step")
        copy.delete("singleTab")
        copy.delete("multiTab")
        if (isLab) copy.delete("section")
        copy.sort()
        return copy.toString()
      }
      const isLab = isLabPath(cur.pathname)
      return stripParams(cur.searchParams, isLab) === stripParams(dst.searchParams, isLab)
    } catch {
      void step
      return false
    }
  }

  private async invokeCommandDirect(adapter: DevControlAdapter, rawCmd: string, args?: Record<string, unknown>) {
    const cmdId = this.resolveCommandId(adapter.commands, rawCmd)
    const out = adapter.commands.invoke(cmdId, args, {
      pickedObject: null,
      groundHit: null,
      source: "cli",
    })
    if (out.ok && out.result instanceof Promise) {
      try {
        await out.result
      } catch {}
    }
    return out
  }

  /** Runs one of this page's commands from a same-origin embedder (the Lab Overworld's page stations). */
  async invokeLocal(command: string, args?: Record<string, unknown>) {
    const out = await this.invokeCommandDirect(this.activeAdapter(), command, args)
    return out.ok && out.result instanceof Promise ? { ...out, result: await out.result.catch(() => null) } : out
  }

  async goToTourStep(stepNumber: number): Promise<void> {
    const tour = this.studioTour
    if (!tour || stepNumber < 1 || stepNumber > tour.steps.length) return
    const step = tour.steps[stepNumber - 1]!
    this.studioStep = stepNumber
    this.saveStudioSession()
    const targetUrl = buildTourStepUrl(location.origin, step.url, tour.id, stepNumber, true)

    if (this.canApplyStepInPlace(step, targetUrl)) {
      this.tourStepAppliedInPlace = true
      history.replaceState(null, "", targetUrl)
      this.renderStudioStrip()
      await this.applyStepInPlace(tour, stepNumber)
      this.sendStatus()
      return
    }

    this.tourStepAppliedInPlace = false
    location.assign(targetUrl)
  }

  private async applyStepInPlace(tour: TourDefinition, stepNumber: number): Promise<void> {
    await this.waitForReady()
    const step = tour.steps[stepNumber - 1]
    if (!step) return
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)

    if (isTourPageStep(step)) {
      this.studioPageEl = renderStudioPageDom(tour, step, this.studioPageEl, (imgs, tid, idx) => {
        this.studioLightboxEl = openStudioLightboxDom(imgs, tid, idx, this.studioLightboxEl)
      })
    } else {
      this.hideStudioPage()
      if (isLabPath(location.pathname)) {
        const parsed = new URL(step.url, location.origin)
        const urlSection =
          parsed.searchParams.get("section")?.trim() ||
          parsed.hash.replace(/^#/, "").split("/")[0]?.trim() ||
          ""
        const isGridStep =
          step.kind === "grid" || step.setup.some(c => c.command === "grid.open" || c.command === "grid" || c.command === "grid.focus")
        if (!isGridStep && adapter.commands.get("grid.close")) {
          await this.invokeCommandDirect(adapter, "grid.close")
        }
        const hasSectionCmd = step.setup.some(c =>
          [
            "scene.select-section",
            "look.preset",
            "look.set",
            "foliage.preset",
            "foliage.set",
            "vignette.preset",
            "vignette.camera",
            "grid.open",
            "grid",
          ].includes(c.command),
        )
        const desiredSection = urlSection || (!hasSectionCmd ? "spawn" : "")
        if (desiredSection && adapter.getSection?.() !== desiredSection) {
          await this.invokeCommandDirect(adapter, "scene.select-section", { section: desiredSection })
        }
      } else if (location.pathname.endsWith("/dev.html")) {
        const parsed = new URL(step.url, location.origin)
        const targetHash = parsed.hash || "#games"
        if (location.hash !== targetHash) {
          location.hash = targetHash
          await new Promise(r => setTimeout(r, 60))
        }
      }
    }

    for (const cmd of step.setup) {
      const currentAdapter = this.activeAdapter()
      this.ensureStandardCommands(currentAdapter)
      await this.invokeCommandDirect(currentAdapter, cmd.command, cmd.args)
    }

    const prevUrl =
      stepNumber > 1 ? buildTourStepUrl(location.origin, tour.steps[stepNumber - 2]!.url, tour.id, stepNumber - 1, true) : undefined
    const nextUrl =
      stepNumber < tour.steps.length
        ? buildTourStepUrl(location.origin, tour.steps[stepNumber]!.url, tour.id, stepNumber + 1, true)
        : undefined

    this.showNote({
      title: step.title,
      ...(step.body ? { body: step.body } : {}),
      step: `${stepNumber}/${tour.steps.length}`,
      ...(step.accent ? { accent: step.accent } : {}),
      ...(step.target ? { target: step.target } : {}),
      dismissible: step.dismissible ?? true,
      tourId: tour.id,
      stepIndex: stepNumber,
      stepCount: tour.steps.length,
      ...(prevUrl ? { prevUrl } : {}),
      ...(nextUrl ? { nextUrl } : {}),
      singleTab: true,
    })
  }

  private renderStudioStrip() {
    const meta = this.readUrlTourMeta()
    this.studioStripEl = renderStudioStripDom({
      tour: this.studioTour,
      stepNumber: this.studioStep,
      collapsed: this.studioCollapsed,
      singleTabAllowed: meta?.singleTab !== false,
      existingStripEl: this.studioStripEl,
      onSelectStep: stepNum => void this.goToTourStep(stepNum),
      onToggleCollapse: () => {
        this.studioCollapsed = !this.studioCollapsed
        this.saveStudioSession()
        this.renderStudioStrip()
        if (this.activeNote) this.showNote(this.activeNote)
      },
      onClose: () => this.closeStudioTour(),
    })
  }

  private hideStudioPage() {
    if (this.studioPageEl) {
      this.studioPageEl.hidden = true
    }
    if (this.studioLightboxEl) {
      this.studioLightboxEl.hidden = true
    }
  }

  private syncStudioUI() {
    if (typeof document === "undefined" || !document.body) return
    this.renderStudioStrip()
    if (this.studioTour && this.studioTour.singleTab !== false) {
      const currentStep = this.studioTour.steps[this.studioStep - 1]
      const onTourHash = location.hash.startsWith("#tour/")
      if (currentStep && isTourPageStep(currentStep) && (onTourHash || location.pathname.endsWith("/dev.html"))) {
        this.studioPageEl = renderStudioPageDom(this.studioTour, currentStep, this.studioPageEl, (imgs, tid, idx) => {
          this.studioLightboxEl = openStudioLightboxDom(imgs, tid, idx, this.studioLightboxEl)
        })
      } else {
        this.hideStudioPage()
      }
    } else {
      this.hideStudioPage()
    }
  }

  showNote(note: DevNotePayload): DevNoteResolvedRect | null {
    if (note.tourId && note.stepIndex && this.studioTour && this.studioTour.id === note.tourId) {
      this.studioStep = note.stepIndex
      this.saveStudioSession()
    }
    this.syncStudioUI()
    if (this.baseDocumentTitle === null) {
      const current = document.title || ""
      this.baseDocumentTitle = current.startsWith("▸ ") ? current.slice(2) : current
    }
    this.activeNote = note
    document.title = note.title.startsWith("▸ ") ? note.title : `▸ ${note.title}`
    if (note.tourId && note.stepIndex) {
      try {
        window.name = `arcade-tour:${note.tourId}:${note.stepIndex}`
      } catch {}
    }

    this.noteEl = renderNoteCardDom({
      note,
      existingNoteEl: this.noteEl,
      stripExpanded: this.isStudioStripExpanded(),
      onNavigateStep: dir => this.navigateTourStep(dir),
      onDismiss: () => {
        this.clearNote()
        this.sendStatus()
      },
    })

    const initialRect = note.target ? this.resolveNoteTargetRect(note.target, true) : null
    this.updateTargetRing(false)
    this.sendStatus()
    return initialRect
  }

  clearNote() {
    this.activeNote = null
    if (this.ringRaf) {
      cancelAnimationFrame(this.ringRaf)
      this.ringRaf = 0
    }
    if (this.noteEl) this.noteEl.hidden = true
    if (this.ringEl) this.ringEl.hidden = true
    if (this.baseDocumentTitle !== null) {
      document.title = this.baseDocumentTitle
    }
  }

  private isPageReady(): boolean {
    if (this.adapter !== null) return true
    if (isLabPath(location.pathname) || location.pathname.endsWith("/dev.html")) {
      return this.fallbackReady
    }
    if (location.pathname.includes("/outbreak/")) {
      const h = (globalThis as { __arcadeHarness?: { ready?: boolean } }).__arcadeHarness
      return Boolean(h?.ready) || this.fallbackReady
    }
    if (this.panels.size > 0) return true
    if ((globalThis as { carrier?: unknown }).carrier !== undefined) return true
    return this.fallbackReady
  }

  private pollUntilReady() {
    const started = Date.now()
    const isStructuredPage =
      isLabPath(location.pathname) ||
      location.pathname.endsWith("/dev.html") ||
      location.pathname.includes("/outbreak/")
    const maxWait = isStructuredPage ? 6000 : 1200
    const timer = window.setInterval(() => {
      if (this.isPageReady()) {
        window.clearInterval(timer)
        this.syncStudioUI()
        this.sendStatus()
        return
      }
      if (Date.now() - started > maxWait) {
        this.fallbackReady = true
        window.clearInterval(timer)
        this.syncStudioUI()
        this.sendStatus()
      }
    }, 40)
  }

  private async waitForReady(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.isPageReady() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 40))
    }
  }

  private resolvePageId(): string {
    try {
      const key = "arcade.control.pageId"
      const existing = sessionStorage.getItem(key)
      if (existing) return existing
      const id = `page_${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(key, id)
      return id
    } catch {
      return `page_${Math.random().toString(36).slice(2, 10)}`
    }
  }

  private readRouterConfig(): { controlPath: string; pageToken: string } | null {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')?.content
    if (!meta) return null
    try {
      const parsed = JSON.parse(meta) as { controlPath?: string; pageToken?: string }
      if (typeof parsed.controlPath === "string" && typeof parsed.pageToken === "string") {
        return { controlPath: parsed.controlPath, pageToken: parsed.pageToken }
      }
    } catch {}
    return null
  }

  setAdapter(adapter: DevControlAdapter | null) {
    this.adapter = adapter
    if (adapter) {
      this.ensureStandardCommands(adapter)
    }
    this.syncStudioUI()
    this.sendStatus()
  }

  addPanel(panel: LabPanel) {
    this.panels.add(panel)
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    this.syncStudioUI()
    this.sendStatus()
  }

  registerCommands(setup: (commands: LabCommandRegistry) => void) {
    const adapter = this.activeAdapter()
    setup(adapter.commands)
    this.sendStatus()
  }

  removePanel(panel: LabPanel) {
    this.panels.delete(panel)
    this.sendStatus()
  }

  private activeAdapter(): DevControlAdapter {
    if (this.adapter) return this.adapter
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    return this.defaultAdapter
  }

  private createDefaultGameAdapter(): DevControlAdapter {
    const commands = new LabCommandRegistry()
    const getCarrier = () => (globalThis as { carrier?: Record<string, any> }).carrier
    const classifyCarrierWeather = (c: Record<string, any>): string => {
      const w = c.lab?.mode === "manual" ? c.lab.target : c.weather?.current
      const rain = Number(w?.rain ?? 0)
      return rain < 0.05 ? "clear" : rain < 0.35 ? "light" : rain < 0.7 ? "medium" : "heavy"
    }
    registerPanelLabCommands(commands, {
      getPanels: () => [...this.panels],
      extraGet: path => {
        const c = getCarrier()
        if (!c) return undefined
        if (!path) {
          return {
            weather: classifyCarrierWeather(c),
            hour: round2(c.daynight?.state?.hour ?? 12),
            exposure: round2(c.grade?.exposure ?? 0),
            overcast: round2(c.atmosphere?.overcast ?? 0),
          }
        }
        const key = path.toLowerCase()
        if (key === "weather") return { key: "weather", label: "Weather", value: classifyCarrierWeather(c) }
        if (key === "hour" || key === "tod") return { key: "hour", label: "Time of day", value: round2(c.daynight?.state?.hour ?? 12) }
        if (c.grade && key in c.grade) return { key, label: key, group: "Grade", value: c.grade[key] }
        if (c.atmosphere && key in c.atmosphere) return { key, label: key, group: "Atmosphere", value: c.atmosphere[key] }
        return undefined
      },
      extraSet: (path, value) => {
        const c = getCarrier()
        if (!c) return null
        const key = path.toLowerCase()
        if (key === "weather" && c.lab?.force) {
          const valid = ["clear", "light", "medium", "heavy"]
          const str = String(value).toLowerCase()
          if (!valid.includes(str)) {
            throw new Error(`Invalid Carrier weather "${String(value)}". Expected: ${valid.join(", ")}.`)
          }
          const before = classifyCarrierWeather(c)
          c.lab.force(str, 0)
          c.lab.frame?.(0, 0)
          return { key: "weather", label: "Weather", before, value: classifyCarrierWeather(c) }
        }
        if ((key === "hour" || key === "tod") && c.daynight?.setManual) {
          const num = Number(value)
          if (!Number.isFinite(num) || num < 0 || num > 24) {
            throw new Error(`Invalid hour "${String(value)}". Expected 0..24.`)
          }
          const before = round2(c.daynight?.state?.hour ?? 12)
          c.daynight.setManual(num, 0)
          return { key: "hour", label: "Time of day", before, value: num }
        }
        if (c.grade && key in c.grade && typeof c.grade[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.grade[key]
          c.grade[key] = num
          return { key, label: key, before, value: num }
        }
        if (c.atmosphere && key in c.atmosphere && typeof c.atmosphere[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.atmosphere[key]
          c.atmosphere[key] = num
          return { key, label: key, before, value: num }
        }
        return null
      },
    })
    return {
      kind: "game",
      commands,
      getCanvas: () => document.querySelector<HTMLCanvasElement>("canvas"),
      isBusy: () => {
        for (const p of this.panels) {
          if (p.isInteracting()) return { busy: true, reason: "User is scrubbing a Lab control" }
        }
        return { busy: false }
      },
      getState: () => {
        const labAll = commands.get("lab.get")?.run({ pickedObject: null, groundHit: null, args: {} }) as
          | { settings?: Record<string, unknown> }
          | undefined
        const canvas = document.querySelector<HTMLCanvasElement>("canvas")
        const c = getCarrier()
        return {
          game: detectGameName(location.pathname),
          settings: labAll?.settings ?? {},
          note: this.activeNote,
          ...(c?.camera
            ? {
                camera: {
                  orbit: round2(((c.camera.yaw ?? 0) * 180) / Math.PI),
                  elevation: round2(((c.camera.pitch ?? 0) * 180) / Math.PI),
                  distance: round2(c.camera.dist ?? 0),
                  target: [round2(c.camera.x ?? 0), 0, round2(c.camera.z ?? 0)],
                },
              }
            : {}),
          canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        }
      },
    }
  }

  private ensureStandardCommands(adapter: DevControlAdapter) {
    const { commands } = adapter
    if (!commands.get("ui.note")) {
      registerUiNoteCommand(commands, {
        onShow: note => this.showNote(note),
        onClear: () => this.clearNote(),
        getDocumentTitle: () => document.title,
      })
    }

    if (!commands.get("nav.open")) {
      commands.register({
        id: "nav.open",
        label: "Navigate Page",
        shortLabel: "Open",
        category: "Scene",
        undoable: false,
        args: {
          target: { type: "string", required: true, description: "Page shorthand or /arcade/... path" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const target = String(args?.target ?? "")
          const resolved = resolveNavigationPath(target)
          const targetUrl = new URL(resolved, location.origin)
          const sameDoc = targetUrl.pathname === location.pathname && targetUrl.search === location.search && Boolean(targetUrl.hash)
          if (sameDoc) {
            location.hash = targetUrl.hash
            if (targetUrl.hash.startsWith("#catalogue")) {
              const deadline = Date.now() + 5000
              while (this.adapter?.kind !== "catalogue" && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 40))
              }
            } else {
              await new Promise(r => setTimeout(r, 60))
            }
            this.sendStatus()
            return { navigated: resolved, inPage: true, url: location.href }
          }
          setTimeout(() => {
            location.assign(targetUrl.href)
          }, 15)
          return { navigating: true, navigated: resolved, inPage: false, url: targetUrl.href }
        },
      })
    }

    if (!commands.get("state")) {
      commands.register({
        id: "state",
        label: "Get Scene & Page State",
        shortLabel: "State",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: async () => {
          const regState = commands.state()
          const pageState = regState ?? (await adapter.getState())
          return {
            page: this.buildSummary(),
            note: this.activeNote,
            ...pageState,
          }
        },
      })
    }

    if (!commands.get("screenshot")) {
      commands.register({
        id: "screenshot",
        label: "Capture Canvas Screenshot",
        shortLabel: "Screenshot",
        category: "Scene",
        undoable: false,
        args: {
          maxSize: { type: "number", min: 0, max: 4096, description: "Max long-edge pixel dimension (default 1280, 0 for native)" },
          raw: { type: "boolean", description: "Omit 2D note overlay when compositing with live DOM" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const maxSize = typeof args?.maxSize === "number" ? args.maxSize : 1280
          const includeOverlay = args?.raw !== true
          const studioPageVisible = Boolean(document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])"))
          const canvas = adapter.getCanvas?.() ?? document.querySelector<HTMLCanvasElement>("canvas")
          if (studioPageVisible || !canvas || (canvas.closest("[hidden]") && adapter.kind === "hub")) {
            const synth = synthesizeHubCanvas()
            return await captureWebGPUOr2DCanvas(synth, undefined, maxSize, includeOverlay, this)
          }
          return await captureWebGPUOr2DCanvas(canvas, adapter.captureCanvas, maxSize, includeOverlay, this)
        },
      })
    }
  }

  showIndicator(text: string, isError = false) {
    const adapter = this.activeAdapter()
    adapter.onIndicator?.(text, isError)
    if (!this.indicatorEl || !document.body.contains(this.indicatorEl)) {
      const el = document.createElement("div")
      el.dataset.arcadeCliIndicator = ""
      el.setAttribute("role", "status")
      el.setAttribute("aria-live", "polite")
      el.style.cssText =
        "position:fixed;top:44px;right:14px;z-index:9999;pointer-events:none;font:600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 10px;border-radius:999px;background:rgba(14,19,24,0.92);color:#7cc5d6;border:1px solid rgba(124,197,214,0.42);box-shadow:0 4px 14px rgba(0,0,0,0.35);transition:opacity 0.15s ease"
      document.body.append(el)
      this.indicatorEl = el
    }
    this.indicatorEl.textContent = text
    this.indicatorEl.style.color = isError ? "#ff8a8a" : "#7cc5d6"
    this.indicatorEl.style.borderColor = isError ? "rgba(255,138,138,0.45)" : "rgba(124,197,214,0.42)"
    this.indicatorEl.hidden = false
    if (this.indicatorTimer) window.clearTimeout(this.indicatorTimer)
    this.indicatorTimer = window.setTimeout(() => {
      if (this.indicatorEl) this.indicatorEl.hidden = true
    }, 2200)
  }

  buildSummary(): DevPageSummary {
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    const tourMeta = this.readUrlTourMeta()
    return {
      id: this.pageId,
      kind: adapter.kind,
      url: location.href,
      pathname: location.pathname,
      hash: location.hash,
      title: document.title || adapter.kind,
      focused: document.hasFocus(),
      visible: !document.hidden,
      mode: adapter.getMode?.() ?? "view",
      section: adapter.getSection?.(),
      note: this.activeNote,
      tour: tourMeta,
      commands: adapter.commands.describe(),
      updatedAt: Date.now(),
      lastActiveAt: this.lastActiveAt,
    }
  }

  sendStatus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.isPageReady()) return
    try {
      this.ws.send(JSON.stringify({ type: "status", page: this.buildSummary() }))
    } catch {}
  }

  private async waitIfBusy(adapter: DevControlAdapter, waitMs = 600): Promise<DevControlBusyState> {
    for (const panel of this.panels) {
      if (panel.isInteracting()) {
        return { busy: true, reason: "User is actively scrubbing or editing a Lab control." }
      }
    }
    if (!adapter.isBusy) return { busy: false }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const state = adapter.isBusy()
      if (!state.busy) return state
      await new Promise(r => setTimeout(r, 50))
    }
    return adapter.isBusy()
  }

  private formatIndicatorText(command: string, args?: Record<string, unknown>): string {
    const short = command.replace(/\./g, " ")
    if ((command === "scene.set-param" || command === "lab.set") && (args?.key ?? args?.path) !== undefined) {
      return `CLI: lab set ${String(args?.key ?? args?.path)} = ${String(args?.value)}`
    }
    if ((command === "object.select" || command === "select") && (args?.id ?? args?.target) !== undefined) {
      return `CLI: select ${String(args?.id ?? args?.target)}`
    }
    if ((command === "ground.spawn-here" || command === "spawn") && args?.asset !== undefined) {
      return `CLI: spawn ${String(args.asset)}`
    }
    if ((command === "scene.set-env" || command === "env") && args?.name !== undefined) {
      return `CLI: env ${String(args.name)}`
    }
    if (command === "look.preset" && args?.preset !== undefined) {
      return `CLI: look preset ${String(args.preset)}`
    }
    if (command === "look.set" && args?.key !== undefined) {
      return `CLI: look set ${String(args.key)} = ${String(args?.value)}`
    }
    if (command === "look.randomize") {
      return `CLI: look randomize ${String(args?.group ?? "all")}`
    }
    if (command === "nav.open" && args?.target !== undefined) {
      return `CLI: open ${String(args.target)}`
    }
    return `CLI: ${short}`
  }

  private resolveCommandId(commands: LabCommandRegistry, requested: string): string {
    if (commands.get(requested)) return requested
    const mapped = COMMAND_ALIASES[requested]
    if (mapped && commands.get(mapped)) return mapped
    return requested
  }

  private isReadOnlyCommand(id: string): boolean {
    return (
      id === "state" ||
      id === "screenshot" ||
      id === "camera.get" ||
      id === "lab.get" ||
      id === "preset.export" ||
      id === "ui.note" ||
      id === "ui.note.clear"
    )
  }

  private async handleRpc(msg: { requestId: string; command: string; args?: Record<string, unknown> }) {
    await this.waitForReady()
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    const cmdId = this.resolveCommandId(adapter.commands, msg.command)
    const cmd = adapter.commands.get(cmdId)

    if (cmd && !this.isReadOnlyCommand(cmd.id)) {
      const busy = await this.waitIfBusy(adapter)
      if (busy.busy) {
        const reason = busy.reason ?? "User is actively interacting with the viewport."
        this.showIndicator(`CLI blocked: ${reason}`, true)
        const outcome: LabCommandInvokeResult = {
          ok: false,
          id: cmd.id,
          code: "busy",
          error: `Blocked by live user input: ${reason}`,
        }
        this.ws?.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
        return
      }
    }

    const rawOutcome = adapter.commands.invoke(cmdId, msg.args, {
      pickedObject: null,
      groundHit: null,
      source: "cli",
    })

    let outcome: LabCommandInvokeResult = rawOutcome
    if (rawOutcome.ok && rawOutcome.result instanceof Promise) {
      try {
        const awaited = await rawOutcome.result
        outcome = { ...rawOutcome, state: adapter.commands.state(), result: awaited }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        outcome = {
          ok: false,
          id: rawOutcome.id,
          code: /unavailable|play mode/i.test(message) ? "unavailable" : "invalid_args",
          error: message,
        }
      }
    }

    if (outcome.ok && !this.isReadOnlyCommand(outcome.id)) {
      this.showIndicator(this.formatIndicatorText(outcome.id, msg.args), false)
    } else if (!outcome.ok) {
      this.showIndicator(`CLI: ${msg.command} (${outcome.code ?? "error"})`, true)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
    }
  }

  private connect() {
    if (!this.routerConfig) return
    // A page embedded in a Lab station is driven through its embedder, not as a separate CLI target.
    try { if (window.frameElement?.closest("[data-station-page]")) return } catch { /* cross-origin parent */ }
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const wsUrl = `${proto}//${location.host}${this.routerConfig.controlPath}?token=${encodeURIComponent(this.routerConfig.pageToken)}&pageId=${encodeURIComponent(this.pageId)}`
    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.onopen = () => {
        this.syncStudioUI()
        this.sendStatus()
        const urlMeta = this.readUrlTourMeta()
        const tourId = urlMeta?.id ?? this.studioTour?.id
        const step = urlMeta?.step ?? this.studioStep
        if (tourId) {
          try {
            ws.send(JSON.stringify({ type: "tour.get", tourId, step }))
          } catch {}
        }
      }
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string
            requestId?: string
            command?: string
            args?: Record<string, unknown>
            url?: string
            tour?: TourDefinition
            step?: number
          }
          if (msg.type === "invoke" && msg.requestId && msg.command) {
            void this.handleRpc({ requestId: msg.requestId, command: msg.command, args: msg.args })
          } else if (msg.type === "tour.state" && msg.tour) {
            const urlMeta = this.readUrlTourMeta()
            this.studioTour = msg.tour
            if (urlMeta && urlMeta.id === msg.tour.id) {
              this.studioStep = urlMeta.step
            } else if (typeof msg.step === "number" && msg.step >= 1) {
              this.studioStep = msg.step
            }
            this.saveStudioSession()
            this.syncStudioUI()
            if (this.activeNote) this.showNote(this.activeNote)
          } else if (msg.type === "tour.activate") {
            try {
              window.focus()
            } catch {}
            if (this.noteEl) {
              this.noteEl.style.animation = "none"
              void this.noteEl.offsetWidth
              this.noteEl.style.animation = "arcade-note-card-flash 0.28s ease-out"
            }
            this.lastActiveAt = Date.now()
            this.sendStatus()
          } else if (msg.type === "tour.navigate" && typeof msg.url === "string" && msg.url) {
            location.assign(msg.url)
          } else if (msg.type === "ping") {
            this.sendStatus()
          }
        } catch {}
      }
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null
        if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
        this.reconnectTimer = window.setTimeout(() => this.connect(), 600)
      }
      ws.onerror = () => {
        ws.close()
      }
    } catch {}
  }
}

function getRuntime(): PageControlRuntime | null {
  if (!import.meta.env?.DEV && !isStationEmbed()) return null
  if (typeof window === "undefined" || typeof document === "undefined") return null
  window.__arcadeDevControl ??= new PageControlRuntime()
  return window.__arcadeDevControl
}

if (import.meta.env?.DEV || isStationEmbed()) {
  getRuntime()
}

export function registerDevControl(adapter: DevControlAdapter): { notifyUpdate: () => void; dispose: () => void } {
  const rt = getRuntime()
  rt?.setAdapter(adapter)
  return {
    notifyUpdate: () => rt?.sendStatus(),
    dispose: () => rt?.setAdapter(null),
  }
}

export function attachLabPanelControl(panel: LabPanel): () => void {
  const rt = getRuntime()
  rt?.addPanel(panel)
  return () => rt?.removePanel(panel)
}

export function registerGameCommands(setup: (commands: LabCommandRegistry) => void): void {
  const rt = getRuntime()
  rt?.registerCommands(setup)
}

export function ensureDevControlConnected(): void {
  getRuntime()
}
