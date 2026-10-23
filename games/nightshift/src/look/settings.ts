import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * The office look (AR-129). `look` 0 is Today, exactly as shipped; 1 turns on everything below at these values. Each
 * part is also its own row, so Kit can keep some and drop others. Defaults stay at Today until Kit picks (decision).
 */
export const lookDefaults = () => ({
  look: 0,
  /** Colleagues' red CRTs light their desks, chairs and the carpet. */
  screenSpill: .022,
  /** Screen glow on the bezel and the curved glass reflection. */
  screenGlass: 1,
  /** Sodium light through the blinds onto desks and carpet, × Today's. */
  slatLight: 1.35,
  /** Faint dusty shafts in the sodium beams. */
  shafts: .5,
  /** One bounce of coloured light off the floor and walls. */
  lookBounce: 2,
  bounceRange: 3.5,
  /** Worn scanned surfaces (partition fabric, ceiling tile, carpet traffic, desk laminate). */
  wear: 1,
  /** Light the floor sends back up to the dropped ceiling. */
  ceiling: 1.5,
  /** A dying tube by the elevator and dead tubes elsewhere. */
  tubes: 1,
  /** Teal haze at the far end with the elevator glowing through it. */
  haze: .04,
  /** Basement air the screens and practicals light up. */
  basementHaze: .05,
  elevatorGlow: 1,
  /** Darkness: the share of Today's teal ambient and floor fill left, so unlit areas fall close to black. */
  fill: .1,
  /** The one working troffer and the window-side tube, × Today's: pools of light with real dark between them. */
  tubeLight: .3,
  /** Colour of fully hazed distance, × Today's: low lets the far end disappear into dark rather than grey. */
  hazeLight: .35,
  /** Contact shading where partitions and desk legs meet the carpet and under desks. */
  contact: 1,
  /** Quiet wrongness: a desk lamp on in a far cubicle, screens dipping in sync, the elevator tube going out as you near it. */
  wrongness: 1,
  /** Desks dressed as if people left in a hurry. */
  dressing: true,
  /** A worn 1980s elevator car: steel and walnut panels, button panel, flickering ceiling light, grime. */
  car: true,
  /** Chairs pushed back and turned. */
  chairsPushed: true,
})
export type LookSettings = ReturnType<typeof lookDefaults>

const G = "Office look"
export function lookControls(): LabControl[] {
  const row = (key: keyof LookSettings, label: string, min: number, max: number, step: number, unit: string): LabControl => ({ key, label, min, max, step, unit, group: G })
  return [
    { key: "look", label: "Look", group: G, type: "select", options: [{ value: 0, label: "Today" }, { value: 1, label: "Lit office" }] },
    row("screenSpill", "Screen spill", 0, .08, .001, "×"),
    row("screenGlass", "Screen glass", 0, 2, .05, "×"),
    row("slatLight", "Blind light", .5, 3, .05, "×"),
    row("shafts", "Dusty shafts", 0, 2, .05, "×"),
    row("lookBounce", "Bounced light", 0, 6, .05, "×"),
    row("bounceRange", "Bounce range", 1, 8, .25, "m"),
    row("wear", "Worn surfaces", 0, 2, .05, "×"),
    row("ceiling", "Ceiling bounce", 0, 3, .05, "×"),
    row("tubes", "Dead and dying tubes", 0, 1, 1, ""),
    row("fill", "Ambient fill", 0, 1, .01, "× Today"),
    row("tubeLight", "Tube light", 0, 2, .05, "× Today"),
    row("contact", "Contact shading", 0, 2, .05, "×"),
    row("haze", "Far haze", 0, .08, .001, "m⁻¹"),
    row("basementHaze", "Basement haze", 0, .12, .001, "m⁻¹"),
    row("hazeLight", "Haze colour", 0, 3, .05, "× Today"),
    row("elevatorGlow", "Elevator glow", 0, 3, .05, "×"),
    row("wrongness", "Wrongness", 0, 1, .05, "×"),
    { key: "dressing", label: "Dressed desks", group: G, type: "toggle" },
    { key: "chairsPushed", label: "Chairs pushed back", group: G, type: "toggle" },
    { key: "car", label: "Worn elevator car", group: G, type: "toggle" },
  ]
}
