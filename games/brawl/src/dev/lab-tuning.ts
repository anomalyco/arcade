import type { LabControl, LabSettings, LabValue } from "@arcade/kit/lab-panel"
import type { EffectDef, HitDef } from "@arcade/kit/sim/abilities"
import { PROP_KINDS } from "../../shared/arena"
import { ROSTER } from "../../shared/characters"
import { DODGE } from "../../shared/characters/types"

const SLOT_NAMES = ["LMB", "Q", "E"] as const

/** Every hit an effect list can land, nested projectiles, dashes and lobs included. */
function hitsOf(effects: readonly EffectDef[], out: HitDef[] = []): HitDef[] {
  for (const e of effects) {
    if ("hit" in e && e.hit) out.push(e.hit)
    if (e.kind === "zone" && e.tick) out.push(e.tick)
    if (e.kind === "projectile") hitsOf([...(e.onHit ?? []), ...(e.onEnd ?? [])], out)
    if (e.kind === "dash") hitsOf(e.then ?? [], out)
  }
  return out
}

/**
 * The Abilities, Props and Dodge knobs: they edit the production character and prop data in place, so the running
 * World (which reads them every cast and tick) changes immediately. Damage and knockback are scales over each
 * ability's authored hits.
 */
export function tuning(onPropsChanged: () => void): { settings: LabSettings; controls: LabControl[] } {
  const settings: LabSettings = {}
  const controls: LabControl[] = []
  const add = (c: LabControl, value: LabValue) => {
    settings[c.key] = value
    controls.push(c)
  }
  for (const c of ROSTER) {
    const visible = (s: Readonly<LabSettings>) => s.character === c.id
    const group = "Abilities"
    const stats = c.name
    add({ key: `${c.id}.speed`, label: "Walk speed", group, subsection: stats, visible, min: 2, max: 9, step: 0.1, unit: "m/s", change: (v) => (c.speed = Number(v)) }, c.speed)
    add({ key: `${c.id}.weight`, label: "Weight", group, subsection: stats, visible, min: 0.5, max: 2, step: 0.02, unit: "×", change: (v) => (c.weight = Number(v)) }, c.weight)
    c.abilities.slice(0, 3).forEach((a, slot) => {
      const sub = `${SLOT_NAMES[slot]} · ${a.name}`
      const hits = hitsOf(a.effects).map((h) => ({ h, damage: h.damage, knock: h.knock }))
      const k = `${c.id}.${a.id}`
      add({ key: `${k}.cooldown`, label: "Cooldown", group, subsection: sub, visible, min: 0, max: 15, step: 0.05, unit: "s", change: (v) => (a.cooldown = Number(v)) }, a.cooldown)
      add({ key: `${k}.windup`, label: "Wind-up", group, subsection: sub, visible, min: 0, max: 1, step: 0.01, unit: "s", change: (v) => (a.windup = Number(v)) }, a.windup)
      if (!hits.length) return
      add({ key: `${k}.damage`, label: "Damage", group, subsection: sub, visible, min: 0, max: 3, step: 0.05, unit: "×", change: (v) => hits.forEach((x) => (x.h.damage = x.damage * Number(v))) }, 1)
      add({ key: `${k}.knock`, label: "Knockback", group, subsection: sub, visible, min: 0, max: 3, step: 0.05, unit: "×", change: (v) => hits.forEach((x) => (x.h.knock = x.knock * Number(v))) }, 1)
    })
  }
  const dash = DODGE.effects.find((e) => e.kind === "dash") as Extract<EffectDef, { kind: "dash" }>
  add({ key: "dodge.cooldown", label: "Cooldown", group: "Dodge (everyone's Space)", min: 0, max: 6, step: 0.05, unit: "s", change: (v) => (DODGE.cooldown = Number(v)) }, DODGE.cooldown)
  add({ key: "dodge.speed", label: "Hop speed", group: "Dodge (everyone's Space)", min: 4, max: 24, step: 0.5, unit: "m/s", change: (v) => (dash.speed = Number(v)) }, dash.speed)

  for (const [kind, d] of Object.entries(PROP_KINDS)) {
    const sub = kind[0]!.toUpperCase() + kind.slice(1)
    add({ key: `prop.${kind}.mass`, label: "Mass", group: "Props", subsection: sub, min: 5, max: d.heavy ? 2000 : 200, step: d.heavy ? 10 : 1, unit: "kg", change: (v) => ((d.mass = Number(v)), onPropsChanged()) }, d.mass)
    add({ key: `prop.${kind}.friction`, label: "Friction", group: "Props", subsection: sub, min: 0.5, max: 15, step: 0.1, unit: "m/s²", change: (v) => (d.friction = Number(v)) }, d.friction)
    if (d.explode) {
      const boom = d.explode
      add({ key: `prop.${kind}.radius`, label: "Blast radius", group: "Props", subsection: sub, min: 0.5, max: 6, step: 0.1, unit: "m", change: (v) => (boom.radius = Number(v)) }, boom.radius)
      add({ key: `prop.${kind}.impulse`, label: "Blast impulse", group: "Props", subsection: sub, min: 2, max: 30, step: 0.5, unit: "m/s", change: (v) => (boom.impulse = Number(v)) }, boom.impulse)
    }
  }
  return { settings, controls }
}
