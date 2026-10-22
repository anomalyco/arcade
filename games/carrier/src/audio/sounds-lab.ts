import type { LabControl, LabPanel, LabSettings } from "@arcade/kit/lab-panel"
import { copyText, type DevSection } from "../dev/dev-panel"
import { type LoopHandle, type Shot, sfx } from "./sfx-bank"
import { CATEGORIES, SLOTS, type Slot, type SlotCategory } from "./sfx-slots"

type Where = "dry" | "near" | "mid" | "far"
const DIST: Record<Exclude<Where, "dry">, number> = { near: 40, mid: 300, far: 1500 }
const BOARD = "Sound board"

/**
 * SOUNDS, the dev panel's audition board (also `?sounds=1`): every sound slot in the game with its candidate takes, one
 * folded group per slot. ▶ plays a take (a loop's ▶ again stops it) dry or in context (through the game's spatial
 * chain and reverb at 40 m, 300 m or 1.5 km, from the chase view or behind the cockpit canopy); Take picks the one the
 * game plays (live); Trim sets the slot's level; each take's rating (1-5 ★, 0 unrated) decides which takes pooled
 * one-shots such as explosions vary between (the 4-5 ★ ones). Picks persist in localStorage and Reset goes back to the
 * shipped picks; Copy picks exports them as JSON, and in the dev server Save writes public/sfx/picks.json, the defaults
 * the shipped game starts from. Nothing plays until a ▶ is pressed.
 */
export class SoundsLab {
  readonly settings = { where: "near" as Where, cockpit: false, category: "all" as SlotCategory | "all" }
  private playing: { key: string; shot: Shot | null; loop: LoopHandle | null } | null = null
  private panel: LabPanel | null = null
  private note = ""
  private shipped: unknown = null
  private lastUi = 0

  readonly section: DevSection = {
    id: "sounds",
    tab: "Sounds",
    bind: (panel) => {
      this.panel = panel
      panel.addControls(this.settings, this.board(), { where: "near", cockpit: false, category: "all" })
      for (const slot of SLOTS) panel.addControls(this.slotSettings(slot), this.slotControls(slot), this.slotDefaults(slot))
    },
    shown: (on) => {
      const mixer = sfx().mixer
      if (on) {
        this.syncDefaults()
        if (this.settings.cockpit) this.cockpit(true)
      } else {
        this.stop()
        mixer.forceCockpit = null
      }
    },
    frame: () => {
      // A finished one-shot lets go of its take.
      const bank = sfx()
      const p = this.playing
      if (p?.shot && bank.mixer.ctx && bank.mixer.ctx.currentTime > p.shot.end) this.stop()
      const now = performance.now()
      if (now - this.lastUi < 500) return
      this.lastUi = now
      this.syncDefaults()
      this.panel?.refresh()
    },
  }

  private board(): LabControl[] {
    const bank = () => sfx()
    return [
      { key: "sounds-status", label: "Sounds", group: BOARD, type: "readout", read: () => {
        const b = bank()
        return `${SLOTS.length} slots · ${SLOTS.reduce((n, s) => n + s.count, 0)} takes · ${b.loaded} loaded · ${b.changed} changed here`
      } },
      { key: "sounds-playing", label: "Playing", group: BOARD, type: "readout", read: () => this.playing?.key.replace(":", " take ") ?? "—" },
      { key: "sounds.where", field: "where", label: "Play", group: BOARD, options: [
        { value: "dry", label: "Dry" },
        { value: "near", label: "Near 40 m" },
        { value: "mid", label: "Mid 300 m" },
        { value: "far", label: "Far 1.5 km" },
      ] },
      { key: "sounds.cockpit", field: "cockpit", label: "From the cockpit", group: BOARD, change: (v) => this.cockpit(!!v) },
      { key: "sounds.category", field: "category", label: "Show", group: BOARD, options: [{ value: "all", label: "All" }, ...CATEGORIES.map((c) => ({ value: c, label: c }))] },
      {
        key: "sounds-actions",
        label: "Picks",
        group: BOARD,
        type: "buttons",
        items: [
          { key: "sounds-stop", label: "■ Stop", run: () => this.stop() },
          { key: "sounds-copy", label: "Copy picks", run: () => this.copy() },
          { key: "sounds-save", label: "Save picks.json", run: () => this.save() },
          { key: "sounds-reset", label: "Reset to shipped", run: () => this.reset() },
        ],
      },
      { key: "sounds-note", label: "Note", group: BOARD, type: "readout", read: () => this.note || "—" },
    ]
  }

  /** A slot's pick, trim and ratings as settings over the bank (which keeps them in localStorage). */
  private slotSettings(slot: Slot): LabSettings {
    const bank = () => sfx()
    const s: LabSettings = {}
    Object.defineProperty(s, "take", { enumerable: true, get: () => bank().take(slot.id), set: (v) => bank().setPick(slot.id, Number(v)) })
    Object.defineProperty(s, "trim", { enumerable: true, get: () => bank().trim(slot.id), set: (v) => bank().setTrim(slot.id, Number(v)) })
    for (let t = 1; t <= slot.count; t++)
      Object.defineProperty(s, `rate${t}`, { enumerable: true, get: () => bank().ratings(slot.id)[t - 1] ?? 0, set: (v) => bank().setRating(slot.id, t, Number(v)) })
    return s
  }

  /** The shipped pick, trim and ratings: what Reset restores (they arrive with the bank's boot, see syncDefaults). */
  private slotDefaults(slot: Slot): LabSettings {
    const p = sfx().shipped[slot.id]
    const out: LabSettings = { take: p?.take ?? 1, trim: p?.trim ?? 0 }
    for (let t = 1; t <= slot.count; t++) out[`rate${t}`] = p?.ratings?.[t - 1] ?? 0
    return out
  }

  private slotControls(slot: Slot): LabControl[] {
    const group = slot.label
    const shown = () => this.settings.category === "all" || this.settings.category === slot.category
    const takes = Array.from({ length: slot.count }, (_, i) => i + 1)
    const row = <C extends LabControl>(c: C): C => ({ ...c, group, folded: true, visible: shown })
    return [
      row({ key: `sound.${slot.id}.play`, label: slot.loop ? "Audition (loop)" : "Audition", type: "buttons", items: takes.map((t) => ({ key: `sound-${slot.id}-${t}`, label: `▶ ${t}`, run: () => this.play(slot, t) })) }),
      row({ key: `sound.${slot.id}.take`, field: "take", label: "Take the game plays", options: takes.map((t) => ({ value: t, label: `Take ${t}` })) }),
      row({ key: `sound.${slot.id}.trim`, field: "trim", label: "Trim", min: -18, max: 12, step: 0.5, unit: "dB" }),
      ...takes.map((t) => row({ key: `sound.${slot.id}.rate${t}`, field: `rate${t}`, label: `Take ${t} rating`, min: 0, max: 5, step: 1, unit: "★", subsection: "Ratings" })),
    ]
  }

  /** Once the bank has fetched the shipped picks, Reset and the modified marks follow them. */
  private syncDefaults(): void {
    const bank = sfx()
    if (bank.shipped === this.shipped || !this.panel) return
    this.shipped = bank.shipped
    const defaults = this.panel.navigation.defaults
    for (const slot of SLOTS) for (const [field, value] of Object.entries(this.slotDefaults(slot))) defaults[`sound.${slot.id}.${field}`] = value
    this.panel.refresh()
  }

  private cockpit(on: boolean): void {
    const mixer = sfx().mixer
    mixer.forceCockpit = on ? 1 : null
    mixer.setCockpit(on ? 1 : 0)
  }

  private stop(): void {
    const p = this.playing
    if (!p) return
    p.shot?.stop(0.08)
    p.loop?.stop(0.15)
    this.playing = null
  }

  private async play(slot: Slot, take: number): Promise<void> {
    const bank = sfx()
    bank.mixer.start()
    const key = `${slot.id}:${take}`
    const was = this.playing?.key === key
    this.stop()
    if (was) return
    const buf = await bank.fetch(slot.id, take)
    if (!buf) {
      this.note = `${slot.id}-${take} could not load.`
      return
    }
    const where = this.settings.where
    const place = where === "dry" ? { reverb: 0 } : { local: { x: 12, y: 3, z: -DIST[where] }, travel: false }
    if (slot.loop) {
      const loop = bank.loop(slot.id, { take, ...place })
      loop?.set({ gain: 1 })
      this.playing = { key, shot: null, loop }
    } else this.playing = { key, shot: bank.play(slot.id, { take, ...place }), loop: null }
  }

  private async copy(): Promise<void> {
    const json = JSON.stringify(sfx().export(), null, 1)
    this.note = await copyText(json, `picks for ${SLOTS.length} slots`)
  }

  private async save(): Promise<void> {
    const r = await fetch("/__sfx/picks", { method: "POST", body: JSON.stringify(sfx().export()) }).catch(() => null)
    this.note = r?.ok ? "Saved public/sfx/picks.json: the next build ships these picks." : "Save failed (only works in the dev server)."
  }

  private reset(): void {
    sfx().reset()
    this.note = "Back to the shipped picks."
    this.panel?.refresh()
  }
}
