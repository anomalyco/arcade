import type { ClassId } from "../../sim/protocol"
import { CLASSES } from "../../sim/classes"
import { cls, h, segBar, setSegBar } from "./dom"
import { unitGlyph } from "./glyphs"

export const CLASS_ORDER = Object.keys(CLASSES) as ClassId[]

const max = (k: "maxHp" | "fuel" | "power") => Math.max(1, ...CLASS_ORDER.map((id) => CLASSES[id][k]))

// Horizontal strip of unit class cards. `compact` drops the description for the lobby.
export function createClassStrip(onPick: (id: ClassId) => void, compact = false) {
  const el = h("div", compact ? "classes compact" : "classes")
  const mHp = max("maxHp")
  const mFuel = max("fuel")
  const mPow = max("power")
  const cards = CLASS_ORDER.map((id) => {
    const c = CLASSES[id]
    const card = h("button", "cls-card")
    card.innerHTML = `
      <div class="cls-art">${unitGlyph(id, 92, 46)}</div>
      <div class="cls-name"></div>
      <div class="cls-role"></div>
      <div class="cls-stats"></div>
      <div class="cls-passive"></div>
    `
    ;(card.querySelector(".cls-name") as HTMLElement).textContent = c.name.toUpperCase()
    ;(card.querySelector(".cls-role") as HTMLElement).textContent = c.role.toUpperCase()
    ;(card.querySelector(".cls-passive") as HTMLElement).textContent = c.passive
    card.title = c.desc
    const stats = card.querySelector(".cls-stats") as HTMLElement
    for (const [label, v, m] of [
      ["ARMOR", c.maxHp, mHp],
      ["FUEL", c.fuel, mFuel],
      ["POWER", c.power, mPow],
    ] as const) {
      const b = segBar(8)
      setSegBar(b, v / m)
      stats.append(h("div", "cls-stat", [h("span", "", [label]), b]))
    }
    card.addEventListener("click", () => onPick(id))
    el.append(card)
    return { id, card }
  })

  function update(selected: ClassId): void {
    for (const { id, card } of cards) cls(card, "sel", id === selected)
  }

  return { el, update }
}
