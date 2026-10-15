import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { keyCapHtml, keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { Stack } from "@arcade/kit/sim/ledger"
import { findFinisherTarget } from "../shared/combat"
import { holdProgress, type InteractTarget } from "../shared/interact"
import { BELT_ITEMS, HOTBAR_SIZE, PACK_SIZE, type OutbreakProgression } from "../shared/progression"
import type { Command, SessionView } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { itemIcon } from "./discovery/icons"
import { DEFAULT_DISCOVERY_SETTINGS, type DiscoverySettings } from "./discovery/settings"

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
  private lastBar = ""
  private lastStrip = ""
  private markers: HTMLElement[] = []

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
  ) {}

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
    this.lastStrip = ""
  }

  /** Forgets every learned prompt (Lab, proofs). */
  resetFamiliar(): void {
    for (const k of Object.keys(this.familiar)) delete this.familiar[k]
    try {
      localStorage.removeItem(FAMILIAR_KEY)
    } catch {}
    this.lastStrip = ""
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

  private cap(code: string, target: InteractTarget, label: string, options?: Parameters<typeof keyPromptHtml>[2]): string {
    const word = this.word(target, label)
    return word ? keyPromptHtml(code, word, options) : keyCapHtml(code, options)
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
      if (index < view.progression.craftable().length) this.craftOpen = false
      return index < view.progression.craftable().length ? { pick: { mode: "craft", index } } : {}
    }
    if (this.packOpen && index < PACK_SIZE) return { pick: { mode: "pack", index } }
    const store = this.stripStore(view, view.prompt)
    if (store && index < view.progression.contents(store).length) return { pick: { mode: "take", index } }
    return index < HOTBAR_SIZE ? { hotbarSlot: index } : {}
  }

  togglePack(): void {
    this.packOpen = !this.packOpen
    this.craftOpen = false
    this.lastBar = ""
  }

  toggleCraft(): void {
    this.craftOpen = !this.craftOpen
    this.packOpen = false
    this.lastBar = ""
  }

  close(): boolean {
    const was = this.packOpen || this.craftOpen
    this.packOpen = this.craftOpen = false
    this.lastBar = ""
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
    const { progression, actorId, player: p } = view
    const ledger = progression.ledger
    const belt = ledger.store(`${actorId}/belt`)
    const hotbar = ledger.store(`${actorId}/hotbar`)
    const pack = ledger.store(`${actorId}/pack`)
    const key = `${belt?.rev}|${hotbar?.rev}|${pack?.rev}|${p.flashlightOn}|${p.magAmmo}|${p.reserveAmmo}|${p.meleeDurability}|${this.packOpen}|${this.craftOpen}|${keyLabel("KeyF")}|${keyLabel("Tab")}`
    if (key === this.lastBar) return
    this.lastBar = key

    if (this.els.belt && belt) {
      const pills = BELT_ITEMS.filter((item) => item === "ammo" || item === "plank" || (belt.counts[item] ?? 0) > 0 || progression.seen(item)).map((item) => {
        const n = belt.counts[item] ?? 0
        const cap = ledger.capFor(belt, item)
        return `<span class="pill" data-item="${item}" data-full="${n >= cap}"><b>${esc(ledger.label(item, true))}</b> ${n}<small>/${cap}</small></span>`
      })
      this.els.belt.innerHTML = pills.join("")
      this.els.belt.dataset.open = String(this.packOpen || this.craftOpen)
    }

    if (this.els.hotbar && hotbar) {
      this.els.hotbar.innerHTML = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
        const s = hotbar.slots[i]
        const sel = i === hotbar.selected
        const on = (s?.item === "flashlight" && p.flashlightOn) || (sel && Boolean(s))
        let label = "—"
        if (s) {
          const def = ledger.items.get(s.item)
          label = esc(def?.shortLabel ?? s.item)
          if (s.item === "flashlight") label += ` (${esc(keyLabel("KeyF"))})`
          else if (s.item === "pistol") label += ` ${s.charge ?? 0}/${ledger.count(actorId, "ammo")}`
          else if (s.count > 1) label += ` ×${s.count}`
        }
        return `<div class="slot" data-slot="${i + 1}" data-selected="${sel}" data-on="${Boolean(on)}" data-empty="${!s}"><kbd>${i + 1}</kbd><b>${label}</b></div>`
      }).join("")
    }

    if (this.els.pack && pack) {
      const used = ledger.usedSlots(pack)
      const cells: string[] = []
      if (this.packOpen) {
        pack.slots.forEach((s, i) => {
          if (!s) cells.push(`<div class="pk" data-empty="true"><kbd>${i + 1}</kbd>—</div>`)
          else cells.push(`<div class="pk" data-heavy="${(ledger.items.get(s.item)?.slots ?? 1) > 1}"><kbd>${i + 1}</kbd>${esc(ledger.label(s.item))}</div>`)
        })
      }
      this.els.pack.innerHTML = `<span class="tag">${keyCapHtml("Tab")} Pack ${used}/${PACK_SIZE}</span>${cells.join("")}`
      this.els.pack.dataset.open = String(this.packOpen)
    }
  }

  private syncPrompt(view: SessionView, cam: Camera, w: number, h: number): void {
    const el = this.els.prompt
    if (!el) return
    const { player: p, town, prompt } = view
    const finishingNow = Boolean(p.meleeFinisher) || (p.stompAnim ?? 0) > 0
    if (finishingNow && !this.wasFinishing) this.finisherCount++
    this.wasFinishing = finishingNow

    if (!prompt) {
      const finTarget =
        !p.vault && !p.vehicleId && this.finisherCount < 2 ? findFinisherTarget(p, view.zombies) : null
      if (!finTarget) {
        el.hidden = true
        el.style.opacity = ""
        this.lastStrip = ""
        return
      }
      const anchorHeight = 0.72 + supportHeight(town, finTarget.x, finTarget.y)
      const proj = cam.project(finTarget.x, anchorHeight, finTarget.y, w, h)
      if (!proj.ok) {
        el.hidden = true
        el.style.opacity = ""
        return
      }
      const html = keyCapHtml("Mouse0")
      if (html !== this.lastStrip) {
        el.innerHTML = html
        this.lastStrip = html
      }
      el.dataset.strip = "false"
      el.style.opacity = this.finisherCount === 0 ? "0.78" : "0.42"
      el.hidden = false
      el.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, -100%)`
      return
    }
    el.style.opacity = ""
    const isPeeking = Boolean(view.peek)
    // At a workbench the prompt hangs below the bench, clear of the mat and the corkboard; under a page, clear of it.
    const below = prompt.kind === "bench" || prompt.kind === "page"
    const anchorHeight = (isPeeking ? 0.15 : below ? 0.1 : 1.45) + supportHeight(town, prompt.worldX, prompt.worldY)
    const proj = cam.project(prompt.worldX, anchorHeight, below ? prompt.rect[3] + 0.2 : prompt.worldY, w, h)
    if (!proj.ok) {
      el.hidden = true
      return
    }
    const html = this.promptHtml(view, prompt, holdProgress(p))
    if (html !== this.lastStrip) {
      el.innerHTML = html
      this.lastStrip = html
    }
    el.dataset.strip = String(html.startsWith('<div class="strip'))
    el.hidden = false
    el.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, ${isPeeking ? "18px" : below ? "8px" : "-100%"})`
  }

  private promptHtml(view: SessionView, prompt: InteractTarget, hold: number): string {
    const progression = view.progression
    const parts = [this.cap("KeyE", prompt, prompt.primary.label)]
    if (prompt.alt) parts.push(`<span class="akp">${keyCapHtml("ShiftLeft")}${this.cap("KeyE", prompt, prompt.alt.label)}</span>`)
    if (prompt.secondary) parts.push(this.cap("KeyE", prompt, prompt.secondary.label, { hold: true, progress: hold }))
    const line = parts.join('<span class="sep">·</span>')
    const store = this.stripStore(view, prompt)
    if (!store) return line
    const stacks = progression.contents(store)
    const title = prompt.label ?? "Contents"
    const items = stacks.length
      ? stacks
          .map((s, i) => this.itemHtml(view, s, i, prompt.kind === "stash"))
          .join("")
      : `<span class="item" data-taken="true">Empty</span>`
    const range = stacks.length > 1 ? `${keyCapHtml("Digit1")}–${keyCapHtml(`Digit${Math.min(stacks.length, 9)}`)}` : keyCapHtml("Digit1")
    const hint = stacks.length ? `${line}<span class="sep">·</span><span class="akp">${range}<span class="akp-label">Take one</span></span>` : line
    return `<div class="strip"><div class="strip-t">${esc(title)}</div><div class="strip-items">${items}</div><div class="strip-h">${hint}</div></div>`
  }

  /**
   * Field craft (hold Q): one row per learned recipe, drawn as what it makes and what it takes. No names; a cost the
   * survivor cannot meet is dimmed. Nothing learned yet shows a blank card.
   */
  private syncCraft(view: SessionView): void {
    const el = this.els.craft
    if (!el) return
    if (!this.craftOpen) {
      el.hidden = true
      return
    }
    const progression = view.progression
    const ledger = progression.ledger
    const bench = view.prompt?.kind === "bench" ? view.prompt.id : undefined
    const rows = progression.craftable().map((r, i) => {
      let ok = true
      const cost = Object.entries(r.craft ?? {})
        .map(([item, n]) => {
          const have = ledger.count(view.actorId, item) + (bench ? ledger.count(bench, item) : 0)
          if (have < n) ok = false
          return `<span class="cost" data-short="${have < n}">${Array.from({ length: n }, () => itemIcon(item, 18)).join("")}</span>`
        })
        .join("")
      return `<div class="craft-row" data-off="${!ok}">${keyCapHtml(`Digit${i + 1}`)}${itemIcon(r.produces!, 26)}<span class="from">${cost}</span></div>`
    })
    const html = rows.length ? `${rows.join("")}<div class="strip-h">${keyCapHtml("KeyQ")}</div>` : `<div class="craft-row" data-blank="true"></div>`
    if (el.innerHTML !== html) el.innerHTML = html
    el.hidden = false
  }

  private itemHtml(view: SessionView, s: Stack, i: number, stash: boolean): string {
    const progression = view.progression
    const dest = destination(progression, s.item)
    const installed = stash && dest === "pack"
    const room = progression.ledger.room(view.actorId, s.item, 1) > 0
    const tag = installed ? "installed" : room ? dest : "full"
    return `<span class="item" data-dest="${dest}" data-full="${!room && !installed}" data-rare="${dest === "pack"}">${keyCapHtml(`Digit${i + 1}`)}${esc(progression.stackLabel(s))}<small>${tag}</small></span>`
  }

  private syncMarkers(view: SessionView, cam: Camera, w: number, h: number): void {
    const root = this.els.markers
    if (!root) return
    const { progression, player: p, town, time } = view
    const want: { x: number; y: number; z: number; html: string; kind: string; colour?: string }[] = []
    const props = this.discovery().discoveryGroundProps
    for (const st of progression.ledger.stores.values()) {
      if (props || !st.id.startsWith("drop:") || !st.at) continue
      if (Math.hypot(st.at.x - p.x, st.at.y - p.y) > MARKER_RANGE) continue
      const stacks = progression.contents(st.id)
      if (!stacks.length) continue
      const label = stacks.length === 1 ? progression.stackLabel(stacks[0]!) : `Supplies (${stacks.length})`
      want.push({ x: st.at.x, y: st.at.y, z: 0.35, html: esc(label), kind: "drop" })
    }
    for (const ping of progression.pings) {
      if (time >= ping.until) continue
      want.push({ x: ping.x, y: ping.y, z: 1.3, html: esc(ping.label), kind: "ping", colour: this.seatColour(ping.by) })
    }
    if (!props) for (const lure of progression.lures) want.push({ x: lure.x, y: lure.y, z: 0.4, html: "Noisemaker", kind: "lure" })
    while (this.markers.length < want.length) {
      const el = document.createElement("div")
      el.className = "marker"
      root.appendChild(el)
      this.markers.push(el)
    }
    this.markers.forEach((el, i) => {
      const m = want[i]
      if (!m) {
        el.hidden = true
        return
      }
      const proj = cam.project(m.x, m.z + supportHeight(town, m.x, m.y), m.y, w, h)
      if (!proj.ok) {
        el.hidden = true
        return
      }
      el.hidden = false
      el.dataset.kind = m.kind
      if (el.innerHTML !== m.html) el.innerHTML = m.html
      el.style.setProperty("--c", m.colour ?? "")
      el.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, -100%)`
    })
  }
}
