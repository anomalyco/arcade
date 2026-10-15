import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { keyCapHtml, keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { Stack } from "@arcade/kit/sim/ledger"
import { holdProgress, type InteractTarget } from "../shared/interact"
import { BELT_ITEMS, HOTBAR_SIZE, PACK_SIZE, type OutbreakProgression, type Recipe } from "../shared/progression"
import type { Command, SessionView } from "../shared/session"
import { supportHeight } from "../shared/terrain"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const MARKER_RANGE = 30

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
    /** Every survivor in the world, for the light their flashlights add at a bench. */
    private readonly squad: () => readonly { x: number; y: number; flashlightOn: boolean; flashlightOutput: number }[],
  ) {}

  /** The store whose contents the strip above `target` lists, if it lists any. */
  private stripStore(view: SessionView, target: InteractTarget | undefined): string | null {
    const store = view.progression.storeFor(target)
    if (!store || target?.kind === "bench") return null
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
    if (view.prompt?.kind === "bench" && index < view.progression.benchRows().length) return { pick: { mode: "bench", index } }
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
    const key = `${belt?.rev}|${hotbar?.rev}|${pack?.rev}|${p.flashlightOn}|${p.magAmmo}|${p.reserveAmmo}|${this.packOpen}|${keyLabel("KeyF")}|${keyLabel("Tab")}`
    if (key === this.lastBar) return
    this.lastBar = key

    if (this.els.belt && belt) {
      const pills = BELT_ITEMS.filter((item) => item === "ammo" || item === "plank" || (belt.counts[item] ?? 0) > 0 || progression.seen(item)).map((item) => {
        const n = belt.counts[item] ?? 0
        const cap = ledger.capFor(belt, item)
        return `<span class="pill" data-item="${item}" data-full="${n >= cap}"><b>${esc(ledger.label(item, true))}</b> ${n}<small>/${cap}</small></span>`
      })
      this.els.belt.innerHTML = pills.join("")
    }

    if (this.els.hotbar && hotbar) {
      this.els.hotbar.innerHTML = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
        const s = hotbar.slots[i]
        const sel = i === hotbar.selected
        const on = (s?.item === "flashlight" && p.flashlightOn) || (s?.item === "pistol" && sel)
        let label = "—"
        if (s) {
          const def = ledger.items.get(s.item)
          label = esc(def?.shortLabel ?? s.item)
          if (s.item === "flashlight") label += ` (${esc(keyLabel("KeyF"))})`
          else if (s.item === "pistol") label += ` ${s.charge ?? 0}/${ledger.count(actorId, "ammo")}`
          else if (s.charge !== undefined && def?.charge && !def.charge.ammo) label += ` ${s.charge}/${def.charge.max}`
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
    if (!prompt) {
      el.hidden = true
      this.lastStrip = ""
      return
    }
    const isPeeking = Boolean(view.peek)
    const anchorHeight = (isPeeking ? 0.15 : 1.45) + supportHeight(town, prompt.worldX, prompt.worldY)
    const proj = cam.project(prompt.worldX, anchorHeight, prompt.worldY, w, h)
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
    el.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, ${isPeeking ? "18px" : "-100%"})`
  }

  private promptHtml(view: SessionView, prompt: InteractTarget, hold: number): string {
    const progression = view.progression
    const parts = [keyPromptHtml("KeyE", prompt.primary.label)]
    if (prompt.alt) parts.push(`<span class="akp">${keyCapHtml("ShiftLeft")}${keyPromptHtml("KeyE", prompt.alt.label)}</span>`)
    if (prompt.secondary) parts.push(keyPromptHtml("KeyE", prompt.secondary.label, { hold: true, progress: hold }))
    const line = parts.join('<span class="sep">·</span>')
    if (prompt.kind === "bench") return this.benchHtml(view, prompt, line)
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

  /** Cost line ("2 Scrap, 1 Battery") with what is missing marked. */
  private costHtml(view: SessionView, cost: Readonly<Record<string, number>>, station?: string): { html: string; ok: boolean } {
    const ledger = view.progression.ledger
    let ok = true
    const html = Object.entries(cost)
      .map(([item, n]) => {
        const have = ledger.count(view.actorId, item) + (station ? ledger.count(station, item) : 0)
        if (have < n) ok = false
        const name = ledger.label(item, true)
        return `<span data-short="${have < n}">${n} ${esc(n === 1 && name === "Planks" ? "Plank" : name)}</span>`
      })
      .join(", ")
    return { html, ok }
  }

  private benchHtml(view: SessionView, prompt: InteractTarget, line: string): string {
    const progression = view.progression
    const ledger = progression.ledger
    const benchId = prompt.id
    const tier = progression.tier(benchId)
    const light = progression.benchLight(benchId, view.hour, this.squad())
    const lit = light + 1e-6 >= progression.tuning.researchLight
    const stock = progression.contents(benchId).filter((s) => ledger.items.get(s.item)?.tag !== "part")
    const parts = [ledger.count(benchId, "toolbox") ? "Toolbox" : "", ledger.count(benchId, "car-battery") ? "Generator" : ""].filter(Boolean)
    const ch = view.player.channel
    const rows = progression.benchRows().map((r: Recipe, i) => {
      const learned = progression.learned(r.id)
      const locked = !learned && r.tier > tier
      const cost = learned ? r.craft : r.research
      const priced = cost ? this.costHtml(view, cost, benchId) : { html: "", ok: true }
      const verb = learned ? (r.produces ? "Craft" : "Learned") : "Research"
      const sub = locked ? "Needs the toolbox installed (tier 2)" : learned && !r.produces ? r.note : !learned && !lit ? `${r.note}. Too dark to research` : r.note
      const running = ch && ch.label.endsWith(r.label) && (ch.kind === "research" || ch.kind === "craft") ? Math.min(1, ch.elapsed / Math.max(0.01, ch.duration)) : null
      const off = locked || (learned && !r.produces) || !priced.ok || (!learned && !lit)
      const prog = running !== null ? `<i class="prog" style="width:${(running * 100).toFixed(1)}%"></i>` : ""
      return `<div class="row" data-off="${off}" data-done="${learned}">${learned && !r.produces ? '<span class="tick">✓</span>' : keyCapHtml(`Digit${i + 1}`)}<div><b>${verb} ${esc(r.label)}</b><small>${esc(sub)}</small></div>${learned && !r.produces ? "" : `<em>${priced.html}</em>`}${prog}</div>`
    })
    const empty = `<div class="row" data-off="true"><span></span><div><b>No recipes yet</b><small>Scrap, chem, planks and batteries each reveal what they make</small></div></div>`
    const info = [`Tier ${tier}${parts.length ? ` · ${parts.join(", ")}` : ""}`, `<span data-short="${!lit}">${lit ? "Light: good" : "Light: too dark"}</span>`].join(" · ")
    const stockLine = stock.length ? `Stock: ${esc(stock.map((s) => `${s.count} ${ledger.label(s.item, true)}`).join(", "))}` : "Stock: empty"
    const range = rows.length > 1 ? `${keyCapHtml("Digit1")}–${keyCapHtml(`Digit${rows.length}`)}` : keyCapHtml("Digit1")
    const hint = rows.length ? `${line}<span class="sep">·</span><span class="akp">${range}<span class="akp-label">Research or craft</span></span>` : line
    return `<div class="strip bench"><div class="strip-t">Workbench<span>${info}</span></div><div class="strip-s">${stockLine}</div>${rows.length ? rows.join("") : empty}<div class="strip-h">${hint}</div></div>`
  }

  private syncCraft(view: SessionView): void {
    const el = this.els.craft
    if (!el) return
    if (!this.craftOpen) {
      el.hidden = true
      return
    }
    const progression = view.progression
    const recipes = progression.craftable()
    const bench = view.prompt?.kind === "bench" ? view.prompt.id : undefined
    const rows = recipes.map((r, i) => {
      const priced = this.costHtml(view, r.craft!, bench)
      return `<div class="row" data-off="${!priced.ok}">${keyCapHtml(`Digit${i + 1}`)}<div><b>${esc(r.label)}</b><small>${esc(r.note)}</small></div><em>${priced.html}</em></div>`
    })
    const html = rows.length
      ? `<div class="strip-t">Field craft<span>${progression.tuning.craftTime.toFixed(1)} s each</span></div>${rows.join("")}<div class="strip-h"><span class="akp">${keyCapHtml("Digit1")}<span class="akp-label">Craft</span></span><span class="sep">·</span>${keyPromptHtml("KeyQ", "Close")}</div>`
      : `<div class="strip-t">Field craft</div><div class="row" data-off="true"><span></span><div><b>Nothing learned yet</b><small>Research recipes at a house workbench; the whole squad learns them</small></div></div>`
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
    for (const st of progression.ledger.stores.values()) {
      if (!st.id.startsWith("drop:") || !st.at) continue
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
    for (const lure of progression.lures) want.push({ x: lure.x, y: lure.y, z: 0.4, html: "Noisemaker", kind: "lure" })
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
