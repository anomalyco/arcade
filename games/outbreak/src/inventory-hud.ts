import type { Camera } from "@arcade/kit/client/camera"
import { keyCapHtml } from "@arcade/kit/client/key-cap"
import type { Stack } from "@arcade/kit/sim/ledger"
import { findFinisherTarget } from "../shared/combat"
import { holdProgress, type InteractAction, type InteractTarget } from "../shared/interact"
import { HOTBAR_SIZE, PACK_SIZE, type OutbreakProgression } from "../shared/progression"
import type { Command, SessionView } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { CraftUi } from "./crafting/ui"
import { DEFAULT_CRAFTING_SETTINGS, type CraftingSettings } from "./crafting/settings"
import { DEFAULT_DISCOVERY_SETTINGS, type DiscoverySettings } from "./discovery/settings"
import { DEFAULT_DOCK_SETTINGS, Dock, type DockSettings } from "./hud/dock"
import { hudMotion, snapToPixels } from "./hud/motion"
import { PromptView } from "./hud/prompt"
import { FINISHER_GLYPH, promptGlyph, promptGlyphHtml } from "./hud/prompt-glyphs"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const MARKER_RANGE = 30
const FAMILIAR_KEY = "arcade.outbreak.familiar"

function loadFamiliar(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAMILIAR_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Prompt glyphs (Lab › HUD): on by default, at a CSS pixel size of 16, 20 or 24. */
export type PromptGlyphSettings = { promptIcons: boolean; promptIconSize: number }
export const DEFAULT_PROMPT_GLYPH_SETTINGS: PromptGlyphSettings = { promptIcons: true, promptIconSize: 24 }

/** Where an item lands when taken, for the strip's small tag. */
function destination(progression: OutbreakProgression, item: string): "belt" | "hand" | "pack" {
  const tag = progression.ledger.items.get(item)?.tag
  if (tag === "ammo" || tag === "resource" || tag === "key") return "belt"
  if (tag === "part") return "pack"
  return "hand"
}

/**
 * The inventory HUD: belt pills, the 5-slot hotbar, the Tab pack, the world-anchored strip above whatever you face
 * (a container's contents, a ground drop, the house stash), and markers for drops, pings and noisemakers.
 * It also owns what a digit key means right now, since that depends on which strip is open.
 */
export class InventoryHud {
  packOpen = false
  /** The field-craft strip (hold Q). */
  craftOpen = false
  /** How many finishers the player has performed this session; the small bare key cap fades out after 2. */
  finisherCount = 0
  private wasFinishing = false
  private craftShown = false
  private craftHtml = ""
  private readonly markers = new Map<string, { el: HTMLElement; html: string; w: number; h: number; leaving: boolean }>()

  constructor(
    private readonly els: {
      prompt: HTMLElement | null
      hotbar: HTMLElement | null
      belt: HTMLElement | null
      pack: HTMLElement | null
      craft: HTMLElement | null
      markers: HTMLElement | null
    },
    private readonly seatColour: (index: number) => string,
    /** The Discovery settings: searched containers and drops shown as props, prompt words that fade with use. */
    private readonly discovery: () => DiscoverySettings = () => DEFAULT_DISCOVERY_SETTINGS,
    /** Dock dimming (Lab › HUD). */
    dockSettings: DockSettings & Partial<PromptGlyphSettings> = DEFAULT_DOCK_SETTINGS,
    /** Crafting HUD style and tips (Lab › Crafting). */
    crafting: () => CraftingSettings = () => DEFAULT_CRAFTING_SETTINGS,
  ) {
    this.craft = new CraftUi(els.craft, crafting)
    this.glyphs = "promptIcons" in dockSettings ? (dockSettings as PromptGlyphSettings) : DEFAULT_PROMPT_GLYPH_SETTINGS
    const { belt, hotbar, pack } = els
    const dock = belt?.closest<HTMLElement>("#dock")
    const hud = dock?.closest<HTMLElement>("#hud")
    const sheet = dock?.querySelector<HTMLElement>("#pack-sheet")
    if (belt && hotbar && pack && dock && hud && sheet) this.dock = new Dock({ hud, dock, belt, hotbar, pack, sheet }, dockSettings)
    if (els.prompt) this.prompt = new PromptView(els.prompt)
  }

  /** Read live, so Lab changes apply on the next frame. */
  private readonly glyphs: PromptGlyphSettings

  /** The floating world prompt. */
  readonly prompt: PromptView | null = null

  /** The bottom dock: belt, hand slots and pack. */
  readonly dock: Dock | null = null

  /** What field craft draws and the crafting tips (src/crafting/ui.ts). */
  readonly craft: CraftUi

  /** How often this browser has acted on each kind of prompt; words drop off once an action is familiar. */
  private readonly familiar = loadFamiliar()

  /** Records that the player pressed the interact key on `target`, so its words can fade next time. */
  noteUse(target: InteractTarget | undefined): void {
    if (!target) return
    const key = target.kind
    this.familiar[key] = (this.familiar[key] ?? 0) + 1
    try {
      localStorage.setItem(FAMILIAR_KEY, JSON.stringify(this.familiar))
    } catch {}
  }

  /** Forgets every learned prompt (Lab, proofs). */
  resetFamiliar(): void {
    for (const k of Object.keys(this.familiar)) delete this.familiar[k]
    try {
      localStorage.removeItem(FAMILIAR_KEY)
    } catch {}
  }

  /** The verb beside a key cap, or nothing once the player has used this kind of prompt often enough. */
  private word(target: InteractTarget, label: string): string {
    const s = this.discovery()
    if (s.discoveryFadeWords && (this.familiar[target.kind] ?? 0) >= s.discoveryFadeUses) return ""
    // A searched container's contents are on show; taking them needs no words.
    if (s.discoveryOpenContainers && target.kind === "container" && target.primary.id === "take") return ""
    if (s.discoveryGroundProps && target.kind === "drop") return ""
    return label
  }

  private cap(code: string, target: InteractTarget, action: InteractAction): string {
    const face = this.actionHtml(target, action)
    return face ? `<span class="akp">${keyCapHtml(code)}<span class="akp-label">${face}</span></span>` : keyCapHtml(code)
  }

  /** The store whose contents the strip above `target` lists, if it lists any. */
  private stripStore(view: SessionView, target: InteractTarget | undefined): string | null {
    const store = view.progression.storeFor(target)
    if (!store || target?.kind === "bench") return null
    const d = this.discovery()
    if ((d.discoveryOpenContainers && target?.kind === "container") || (d.discoveryGroundProps && target?.kind === "drop")) return null
    const st = view.progression.ledger.store(store)
    return st?.revealed ? store : null
  }

  /** What a digit (0-based) does now: take from the open strip, swap a pack slot in, or select a hotbar slot. */
  digit(index: number, view: SessionView): Partial<Command> {
    if (this.craftOpen) {
      if (index >= view.progression.craftable().length) return {}
      // A craft that cannot be paid for leaves the strip open beside its "Need …" notice.
      if (this.craft.affordable(view, index)) this.craftOpen = false
      return { pick: { mode: "craft", index } }
    }
    if (this.packOpen && index < PACK_SIZE) return { pick: { mode: "pack", index } }
    const store = this.stripStore(view, view.prompt)
    if (store && index < view.progression.contents(store).length) return { pick: { mode: "take", index } }
    return index < HOTBAR_SIZE ? { hotbarSlot: index } : {}
  }

  togglePack(): void {
    this.packOpen = !this.packOpen
    this.craftOpen = false
  }

  toggleCraft(): void {
    this.craftOpen = !this.craftOpen
    this.packOpen = false
  }

  close(): boolean {
    const was = this.packOpen || this.craftOpen
    this.packOpen = this.craftOpen = false
    return was
  }

  /** Call every drawn frame after the camera update. */
  sync(view: SessionView, cam: Camera, w: number, h: number): void {
    this.syncBar(view)
    this.syncCraft(view)
    this.syncPrompt(view, cam, w, h)
    this.syncMarkers(view, cam, w, h)
  }

  private syncBar(view: SessionView): void {
    this.dock?.sync(view, this.packOpen, this.craftOpen)
  }

  private syncPrompt(view: SessionView, cam: Camera, w: number, h: number): void {
    const prompt = this.prompt
    if (!prompt) return
    const { player: p, town } = view
    const finishingNow = Boolean(p.meleeFinisher) || (p.stompAnim ?? 0) > 0
    if (finishingNow && !this.wasFinishing) this.finisherCount++
    this.wasFinishing = finishingNow
    const target = view.prompt

    if (!target) {
      const finTarget = !p.vault && !p.vehicleId && this.finisherCount < 2 ? findFinisherTarget(p, view.zombies) : null
      const proj = finTarget ? cam.project(finTarget.x, 0.72 + supportHeight(town, finTarget.x, finTarget.y), finTarget.y, w, h) : null
      if (!finTarget || !proj?.ok) {
        prompt.update(null)
        return
      }
      prompt.update({
        target: `finisher:${finTarget.id}`,
        html: `<div class="prompt-line"><span class="akp">${keyCapHtml("Mouse0")}${this.glyphs.promptIcons ? promptGlyphHtml(FINISHER_GLYPH, "Finish off", this.glyphs.promptIconSize) : ""}</span></div>`,
        x: proj.x,
        y: proj.y,
        place: "above",
        gap: 0,
        opacity: this.finisherCount === 0 ? 0.78 : 0.42,
      })
      return
    }
    const isPeeking = Boolean(view.peek)
    // At a workbench the prompt hangs below the bench, clear of the mat and the corkboard; under a page, clear of it.
    const below = target.kind === "bench" || target.kind === "page"
    const anchorHeight = (isPeeking ? 0.15 : below ? 0.1 : 1.45) + supportHeight(town, target.worldX, target.worldY)
    const proj = cam.project(target.worldX, anchorHeight, below ? target.rect[3] + 0.2 : target.worldY, w, h)
    if (!proj.ok) {
      prompt.update(null)
      return
    }
    prompt.update({
      target: `${target.kind}:${target.id}`,
      html: this.promptHtml(view, target),
      x: proj.x,
      y: proj.y,
      place: isPeeking || below ? "below" : "above",
      gap: isPeeking ? 18 : below ? 8 : 0,
      hold: holdProgress(p),
    })
  }

  /**
   * One action's face beside its cap: the glyph (D-25) and any word it still needs, or the label alone with prompt
   * icons off. Words still fade with familiarity (Discovery › Fade words).
   */
  private actionHtml(target: InteractTarget, action: InteractAction): string {
    const g = this.glyphs.promptIcons ? promptGlyph(target.kind, action) : { glyph: null, word: action.label, label: action.label }
    const word = g.word ? this.word(target, g.word) : ""
    const glyph = g.glyph ? promptGlyphHtml(g.glyph, g.label, this.glyphs.promptIconSize) : ""
    return `${glyph}${word ? `<span class="akp-word">${esc(word)}</span>` : ""}`
  }

  /** The key row: E and its action, the hold action on the same ringed cap, and Shift+E when there is one. */
  private lineHtml(prompt: InteractTarget): string {
    const parts: string[] = []
    const tap = this.actionHtml(prompt, prompt.primary)
    if (prompt.secondary) {
      const held = this.actionHtml(prompt, prompt.secondary)
      const cap = keyCapHtml("KeyE", { hold: true })
      parts.push(`<span class="akp akp-dual">${cap}${tap ? `<span class="akp-label">${tap}</span>` : ""}${held ? `<span class="akp-hold"><i aria-hidden="true"></i>${held}</span>` : ""}</span>`)
    } else parts.push(this.cap("KeyE", prompt, prompt.primary))
    if (prompt.alt) parts.push(`<span class="akp">${keyCapHtml("ShiftLeft")}${this.cap("KeyE", prompt, prompt.alt)}</span>`)
    return `<div class="prompt-line">${parts.join('<span class="sep" aria-hidden="true"></span>')}</div>`
  }

  private promptHtml(view: SessionView, prompt: InteractTarget): string {
    const progression = view.progression
    const line = this.lineHtml(prompt)
    const store = this.stripStore(view, prompt)
    if (!store) return line
    const stacks = progression.contents(store)
    const items = stacks.length
      ? stacks.map((s, i) => this.itemHtml(view, s, i, prompt.kind === "stash")).join("")
      : `<span class="item" data-taken="true">Empty</span>`
    return `<div class="strip"><div class="strip-items">${items}</div>${line}</div>`
  }

  /** Field craft (hold Q): rises out of the dock and folds back; `CraftUi` draws what is in it and the tips. */
  private syncCraft(view: SessionView): void {
    this.craft.syncTip(view, this.craftOpen)
    const el = this.els.craft
    if (!el) return
    if (!this.craftOpen) {
      if (this.craftShown) {
        // Folds down into the dock it rose from.
        this.craftShown = false
        void hudMotion.exit(el, "snappy", { y: 6 }).then(() => {
          if (!this.craftShown) el.hidden = true
        })
      }
      return
    }
    if (!this.craftShown) {
      this.craftShown = true
      el.hidden = false
      for (const a of el.getAnimations()) a.cancel()
      el.style.transformOrigin = "50% 100%"
      hudMotion.enter(el, "smooth", { y: 6 })
    }
    const html = this.craft.html(view)
    if (this.craftHtml !== html) {
      this.craftHtml = html
      el.innerHTML = html
      el.hidden = false
      snapToPixels(el)
    }
    el.hidden = false
  }

  /** One stack in a strip: its digit, name and count. Only "pack" (a rare part) and "full" get a tag. */
  private itemHtml(view: SessionView, s: Stack, i: number, stash: boolean): string {
    const progression = view.progression
    const dest = destination(progression, s.item)
    const installed = stash && dest === "pack"
    const room = progression.ledger.room(view.actorId, s.item, 1) > 0
    const tag = installed ? "installed" : !room ? "full" : dest === "pack" ? "pack" : ""
    return `<span class="item" data-dest="${dest}" data-full="${!room && !installed}" data-rare="${dest === "pack"}">${keyCapHtml(`Digit${i + 1}`)}<span>${esc(progression.stackLabel(s))}</span>${tag ? `<small>${tag}</small>` : ""}</span>`
  }

  private syncMarkers(view: SessionView, cam: Camera, w: number, h: number): void {
    const root = this.els.markers
    if (!root) return
    const { progression, player: p, town, time } = view
    const want: { key: string; x: number; y: number; z: number; html: string; kind: string; colour?: string }[] = []
    const props = this.discovery().discoveryGroundProps
    for (const st of progression.ledger.stores.values()) {
      if (props || !st.id.startsWith("drop:") || !st.at) continue
      if (Math.hypot(st.at.x - p.x, st.at.y - p.y) > MARKER_RANGE) continue
      const stacks = progression.contents(st.id)
      if (!stacks.length) continue
      const label = stacks.length === 1 ? progression.stackLabel(stacks[0]!) : `Supplies (${stacks.length})`
      want.push({ key: st.id, x: st.at.x, y: st.at.y, z: 0.35, html: esc(label), kind: "drop" })
    }
    for (const ping of progression.pings) {
      if (time >= ping.until) continue
      want.push({ key: `ping:${ping.by}:${ping.until}`, x: ping.x, y: ping.y, z: 1.3, html: esc(ping.label), kind: "ping", colour: this.seatColour(ping.by) })
    }
    if (!props) progression.lures.forEach((lure, i) => want.push({ key: `lure:${i}`, x: lure.x, y: lure.y, z: 0.4, html: "Noisemaker", kind: "lure" }))
    const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
    const seen = new Set<string>()
    for (const m of want) {
      const proj = cam.project(m.x, m.z + supportHeight(town, m.x, m.y), m.y, w, h)
      if (!proj.ok) continue
      seen.add(m.key)
      let mk = this.markers.get(m.key)
      if (!mk) {
        const el = document.createElement("div")
        el.className = "marker"
        el.dataset.kind = m.kind
        root.appendChild(el)
        mk = { el, html: "", w: 0, h: 0, leaving: false }
        this.markers.set(m.key, mk)
        el.innerHTML = m.html
        mk.html = m.html
        mk.w = el.offsetWidth
        mk.h = el.offsetHeight
        hudMotion.enter(el, "default", { y: 4 })
      }
      if (mk.html !== m.html) {
        mk.el.innerHTML = m.html
        mk.html = m.html
        mk.w = mk.el.offsetWidth
        mk.h = mk.el.offsetHeight
      }
      mk.el.style.setProperty("--c", m.colour ?? "")
      const x = Math.round((proj.x - mk.w / 2) * ratio) / ratio
      const y = Math.round((proj.y - mk.h) * ratio) / ratio
      mk.el.style.translate = `${x}px ${y}px`
    }
    for (const [key, mk] of this.markers) {
      if (seen.has(key) || mk.leaving) continue
      mk.leaving = true
      this.markers.delete(key)
      void hudMotion.exit(mk.el, "snappy").then(() => mk.el.remove())
    }
  }
}
