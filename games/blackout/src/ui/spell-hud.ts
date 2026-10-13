import { SPELL_ICONS, SPELL_IDS, SPELL_LIMITS, SPELL_NAMES } from "../../shared/sim/spell-config"
import type { Game } from "../game/game"

/** Two spell slots. Authoritative cooldowns and occupancy; no rune-reading overlay. */
export class SpellHud {
  private root = document.createElement("div")
  private slots = SPELL_IDS.map(() => document.createElement("div"))
  constructor(parent: HTMLElement) {
    this.root.style.cssText = "position:fixed;bottom:48px;left:50%;transform:translateX(-50%);display:flex;gap:8px;pointer-events:none;z-index:12;font:13px 'IBM Plex Mono',monospace"
    this.root.append(...this.slots)
    parent.append(this.root)
  }
  draw(g: Game) {
    const s = g.snap?.spells
    this.root.style.display = s ? "flex" : "none"
    if (!s) return
    SPELL_IDS.forEach((id, i) => {
      const slot = this.slots[i]!, active = g.selectedSpell === id
      const wait = Math.max(0,(s.ready[g.myId]?.[id] ?? 0)-g.snap!.t)
      const count = (id === "moon" ? s.moons : s.skeletons).filter(e=>e.by===g.myId).length
      const full = count >= SPELL_LIMITS[id] || (id === "moon" ? s.moons.length >= SPELL_LIMITS.moons : s.skeletons.length >= SPELL_LIMITS.skeletons)
      const status = full ? "Full" : wait > 0 ? `${wait.toFixed(1)}s` : "Ready"
      slot.style.cssText = `padding:9px 13px;border:1px solid ${active ? "#e8d6a2" : "#565158"};border-radius:5px;background:#161820e8;color:${active ? "#f5e7c5" : "#9c9aa2"};min-width:152px`
      slot.textContent = `${i+1} ${SPELL_ICONS[id]} ${SPELL_NAMES[id]} · ${status}`
    })
  }
}
