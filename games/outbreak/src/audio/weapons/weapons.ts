import type { StoreState } from "@arcade/kit/sim/ledger"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { MELEE_WEAPONS, type CombatMeleeEvent, type CombatMeleeHit, type CombatShotEvent, type MeleeWeaponId } from "../../../shared/combat"
import { OUT_HIT, OUT_SHATTER, OUT_WALL, OUT_WINDOW, tossItem, type ThrowableItem } from "../../../shared/interactions/throwables"
import type { Town } from "../../../shared/map"
import type { ImpactMaterial } from "../impacts"
import { indoors, surfaceAt, type FootSurface, type SurfaceExtras } from "../space"
import type { SoundEvent } from "../types"
import { MELEE_HIT_LAYER, meleeDrawKind, WEAPON_KEYS, type WeaponKey } from "./catalog"
import type { BrassFloor, StrikeSurface, WeaponSpace } from "./dsp"

/** What the Lab asks of the weapon sounds (Backquote › Sound › Weapons), read once a frame. */
export type WeaponMix = {
  /** Layered weapon sounds; off is Today (the library's shared pistol, three melee hits, borrowed fire sounds). */
  on: boolean
  weapons: Record<WeaponKey, boolean>
  /** Bullet impacts by surface. */
  impacts: boolean
  /** Distance (m) where a report hands over from its near layers to its far version. */
  nearRange: number
}

export const todayWeaponMix = (): WeaponMix => ({ on: false, weapons: Object.fromEntries(WEAPON_KEYS.map((k) => [k, true])) as Record<WeaponKey, boolean>, impacts: true, nearRange: 18 })

const smooth = (a: number, b: number, v: number) => {
  const u = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

/** How far to look for walls either side of a shot (m), and the gap that counts as between houses. */
const SPACE_LOOK = 24
const ALLEY_GAP = 12

/**
 * Where a report rings, from the shooter's spot: in a building's room, between two houses (walls close on both sides
 * of one axis: slapback), on a street with houses in earshot, or in the open. Pure: the same town and spot always
 * answer the same.
 */
export function weaponSpace(town: Town, x: number, y: number): WeaponSpace {
  if (indoors(town, x, y)) return "room"
  let px = SPACE_LOOK
  let nx = SPACE_LOOK
  let py = SPACE_LOOK
  let ny = SPACE_LOOK
  for (const b of town.buildings) {
    const [x0, y0, x1, y1] = b.rect
    if (y >= y0 && y <= y1) {
      if (x0 >= x) px = Math.min(px, x0 - x)
      else if (x1 <= x) nx = Math.min(nx, x - x1)
    }
    if (x >= x0 && x <= x1) {
      if (y0 >= y) py = Math.min(py, y0 - y)
      else if (y1 <= y) ny = Math.min(ny, y - y1)
    }
  }
  if (px + nx < ALLEY_GAP || py + ny < ALLEY_GAP) return "alley"
  return Math.min(px, nx, py, ny) < SPACE_LOOK ? "street" : "open"
}

/** The floor brass and magazines answer on, by the surface under them. */
export const BRASS_FLOOR: Readonly<Record<FootSurface, BrassFloor>> = {
  concrete: "hard",
  tile: "hard",
  glass: "hard",
  wood: "wood",
  carpet: "soft",
  grass: "soft",
  dirt: "soft",
  gravel: "gravel",
  metal: "metal",
  puddle: "wet",
  blood: "wet",
}

/** What a round's or a swing's struck material sounds like as a synthesized strike. */
export const STRIKE_OF: Readonly<Record<ImpactMaterial, StrikeSurface>> = {
  flesh: "flesh",
  wood: "wood",
  plaster: "plaster",
  concrete: "concrete",
  metal: "car",
  car: "car",
  glass: "glass",
  dirt: "dirt",
}

/** The library's reload parts and the layered ones they become. */
export const RELOAD_PART: Readonly<Record<string, string>> = {
  "gun.pistol.mag-release": "wpn.pistol.release",
  "gun.pistol.mag-out": "wpn.pistol.out",
  "gun.pistol.mag-in": "wpn.pistol.in",
  "gun.pistol.slide": "wpn.pistol.slide",
}

type Report = "pistol" | "flare" | "blast" | "cracker"
const REPORT: Record<Report, { near: string; far: string | null; size: "small" | "big"; tail: number }> = {
  pistol: { near: "wpn.pistol.report", far: "wpn.pistol.far", size: "small", tail: 1 },
  flare: { near: "wpn.flare.report", far: "wpn.flare.far", size: "small", tail: 0.65 },
  blast: { near: "wpn.blast", far: "wpn.blast.far", size: "big", tail: 1 },
  cracker: { near: "wpn.cracker", far: null, size: "small", tail: 0.32 },
}

const HEAVY_THROW: ReadonlySet<ThrowableItem> = new Set(["brick", "rock"])
const BONK_RATE: Readonly<Record<ThrowableItem, number>> = { baseball: 1, brick: 0.82, rock: 0.9, "tin-can": 1.25, bottle: 1.1 }

/**
 * The layered weapon sounds (AR-102). The director and the inventory sounds hand it the moments they already find in
 * world state (a shot, a swing landing, a reload part, a flare fired, a fuse lit, a throw) and it answers with `wpn.*`
 * sounds: for a report its near layers, its far version and the tail of the space it rang in, crossfaded by the
 * listener's distance, so a teammate's shot down the street sounds like one. Each event carries Today's sound as its
 * `fallback`, which plays while the layered one is still baking. Presentation only; zombie hearing is untouched.
 */
export class WeaponSounds {
  mix: WeaponMix = todayWeaponMix()
  /** Where a report rings (a seam for the offline reel, which stages a shot between two houses). */
  spaceOf: (town: Town, x: number, y: number) => WeaponSpace = weaponSpace
  private rng = mulberry32(97)
  private town: Town | null = null
  private listener = { x: 0, y: 0 }
  /** Floor overlays (broken glass) for brass and dropped magazines, set by `OutbreakAudio` each frame. */
  extra: SurfaceExtras | undefined
  private tosses = new Map<string, { t: number; impact: boolean }>()
  private tossStarted = false

  reset(): void {
    this.rng = mulberry32(97)
    this.tosses.clear()
    this.tossStarted = false
  }

  /** The frame's town and listener. */
  frame(town: Town, listener: { x: number; y: number }): void {
    this.town = town
    this.listener.x = listener.x
    this.listener.y = listener.y
  }

  /** Whether `key` plays its layered sounds. */
  uses(key: WeaponKey): boolean {
    return this.mix.on && this.mix.weapons[key]
  }

  get impacts(): boolean {
    return this.mix.on && this.mix.impacts
  }

  /** A firearm's or a blast's report: the near layers, the far version and the space's tail, by distance. */
  report(kind: Report, x: number, y: number, emit: (e: SoundEvent) => void, o: { source: string; delay?: number; gain?: number; fallback?: SoundEvent["fallback"] }): void {
    const r = REPORT[kind]
    const d = Math.hypot(x - this.listener.x, y - this.listener.y)
    const R = Math.max(4, this.mix.nearRange)
    const near = r.far ? 1 - smooth(R * 0.6, R * 1.7, d) : 1
    const far = r.far ? smooth(R * 0.4, R * 1.3, d) : 0
    const g = o.gain ?? 1
    const base = { x, y, source: o.source, ...(o.delay ? { delay: o.delay } : {}) }
    const nearHeard = near > 0.02
    if (nearHeard) emit({ ...base, id: r.near, gain: g * near, ...(o.fallback ? { fallback: o.fallback } : {}) })
    if (r.far && far > 0.02) emit({ ...base, id: r.far, gain: g * far, ...(!nearHeard && o.fallback ? { fallback: o.fallback } : {}) })
    const space = this.town ? this.spaceOf(this.town, x, y) : "street"
    emit({ ...base, id: `wpn.tail.${space}.${r.size}`, gain: g * r.tail * (1 - 0.5 * far) })
  }

  /** A pistol shot: report, then its brass landing on whatever floor is to the shooter's right. */
  shot(shot: CombatShotEvent, emit: (e: SoundEvent) => void, gunFallback: boolean): void {
    this.report("pistol", shot.fromX, shot.fromY, emit, { source: "shot", ...(gunFallback ? { fallback: { id: "gun.pistol.shot" } } : {}) })
    // The case flies out ~1 m to the right (as `details/leftovers.ts` throws it) and lands about 0.45 s later.
    const rx = -Math.sin(shot.aim)
    const ry = Math.cos(shot.aim)
    const bx = shot.fromX + rx * 1.05
    const by = shot.fromY + ry * 1.05
    const floor = this.town ? BRASS_FLOOR[surfaceAt(this.town, bx, by, this.extra)] : "hard"
    emit({ id: `wpn.brass.${floor}`, x: bx, y: by, delay: 0.4 + this.rng() * 0.1, source: "shot", fallback: { id: "gun.casing" } })
  }

  /** A round arriving: what it struck, as a synthesized impact, with the library's as fallback. */
  bulletImpact(material: ImpactMaterial, x: number, y: number, emit: (e: SoundEvent) => void, o: { delay: number; gain: number; fallback: NonNullable<SoundEvent["fallback"]> }): void {
    emit({ id: `wpn.impact.${STRIKE_OF[material]}`, x, y, delay: o.delay, gain: o.gain, ...(material === "metal" ? { rate: 1.15 } : {}), source: "shot", fallback: o.fallback })
  }

  /** A round into one of the dead: the wet slap, the library's flesh hit kept underneath at half for its body. */
  fleshHit(x: number, y: number, emit: (e: SoundEvent) => void): void {
    emit({ id: "wpn.impact.flesh", x, y, delay: 0.02, source: "shot", fallback: { id: "zombie.hit" } })
    emit({ id: "zombie.hit", x, y, delay: 0.025, gain: 0.45, source: "shot" })
  }

  /** A melee swing through the air, by weapon; heavy swings lower and fuller, combo strokes a touch apart. */
  swing(m: CombatMeleeEvent, wear: number, emit: (e: SoundEvent) => void, fallback: string): void {
    const combo = m.combo === 2 ? 1.04 : m.combo === 3 ? 0.97 : 1
    const rate = (m.heavy ? 0.9 : 1) * combo * (wear > 0.08 ? 1 - wear * 0.1 : 1)
    emit({ id: `wpn.swing.${m.weapon}`, x: m.x, y: m.y, gain: m.heavy ? 1.15 : 1, rate: Number(rate.toFixed(3)), source: m.attackerId, fallback: { id: fallback, ...(wear > 0.08 ? { rate: Number((1 - wear * 0.1).toFixed(3)) } : {}) } })
  }

  /**
   * A melee hit on one of the dead: flesh under every hit (heavier for heavy swings, kills and finishers), the
   * weapon's own layer (slice, chop, clank, knock, spikes), bone on head hits and heavy kills, and for metal tools
   * on heavy, head or finishing hits the library's ringing bell ("you ring their bell"). Later targets of one cleave
   * get flesh and weapon only, so a three-body sweep does not take a dozen voices.
   */
  meleeHit(m: CombatMeleeEvent, h: CombatMeleeHit, first: boolean, rate: number | undefined, emit: (e: SoundEvent) => void): void {
    const w = MELEE_WEAPONS[m.weapon] ?? MELEE_WEAPONS.crowbar
    const at = { x: h.x, y: h.y, source: m.attackerId, ...(rate ? { rate } : {}) }
    const hard = m.heavy || Boolean(h.finisher) || h.killed
    const gain = h.finisher ? 1.3 : m.heavy ? 1.15 : 1
    emit({ ...at, id: hard ? "wpn.hit.flesh-heavy" : "wpn.hit.flesh-light", delay: 0.012, gain, fallback: { id: `melee.hit.${w.material}`, gain, ...(rate ? { rate } : {}) } })
    emit({ ...at, id: `wpn.hit.${MELEE_HIT_LAYER[m.weapon as MeleeWeaponId] ?? "metal"}`, delay: 0.015, gain: 0.9 * gain })
    if (!first) return
    if (h.headshot || (m.heavy && h.killed) || h.finisher) emit({ ...at, id: "wpn.hit.bone", delay: 0.02, gain: h.headshot ? 1.1 : 0.9 })
    if (w.material === "metal" && (m.heavy || h.headshot || h.finisher)) emit({ ...at, id: "melee.hit.metal", delay: 0.016, gain: h.headshot || h.finisher ? 0.95 : 0.78 })
  }

  /** A swing that met a wall, a door, a car or glass: the surface's answer and the weapon's own ring. */
  meleeSurface(m: CombatMeleeEvent, hit: { id: string; material: ImpactMaterial; x: number; y: number; gain: number; rate?: number; cutoffHz?: number }, emit: (e: SoundEvent) => void): void {
    const surface = STRIKE_OF[hit.material]
    const bashSurface = surface === "flesh" ? "dirt" : surface
    const fallback = { id: hit.id, gain: hit.gain, ...(hit.rate !== undefined ? { rate: hit.rate } : {}), ...(hit.cutoffHz !== undefined ? { cutoffHz: hit.cutoffHz } : {}) }
    emit({ id: `wpn.bash.${bashSurface}`, x: hit.x, y: hit.y, delay: 0.035, gain: m.heavy ? 1.1 : 0.95, ...(hit.material === "metal" ? { rate: 1.2 } : {}), source: m.attackerId, fallback })
    if (bashSurface !== "dirt") this.tool(m, hit.x, hit.y, emit, bashSurface === "glass" ? 0.4 : 0.75)
  }

  /** The weapon's ring off something hard (a wall it missed into, a door it battered). */
  tool(m: CombatMeleeEvent, x: number, y: number, emit: (e: SoundEvent) => void, gain = 0.75): void {
    const layer = MELEE_HIT_LAYER[m.weapon as MeleeWeaponId] ?? "metal"
    const mat = layer === "blade" || layer === "chop" ? "blade" : layer === "metal" ? "metal" : "wood"
    emit({ id: `wpn.tool.${mat}`, x, y, delay: 0.036, gain: gain * (m.heavy ? 1.15 : 1), source: m.attackerId })
  }

  /** Taking a weapon in hand. Returns false when the item has no draw sound or its layered sounds are off. */
  draw(item: string, x: number, y: number, emit: (e: SoundEvent) => void, source: string): boolean {
    const id =
      item === "pistol" ? (this.uses("pistol") ? "wpn.pistol.draw" : null)
      : item in MELEE_WEAPONS ? (this.uses(item as WeaponKey) ? `wpn.draw.${meleeDrawKind(item as MeleeWeaponId)}` : null)
      : item === "flamethrower" ? (this.uses("flamethrower") ? "wpn.draw.flamer" : null)
      : item === "flare-gun" ? (this.uses("flare-gun") ? "wpn.draw.flaregun" : null)
      : item === "dynamite" || item === "firecrackers" || item === "molotov" ? (this.uses(item) ? "wpn.draw.explosive" : null)
      : ["baseball", "brick", "rock", "tin-can", "bottle"].includes(item) ? (this.uses("throwables") ? "wpn.draw.throwable" : null)
      : null
    if (!id) return false
    emit({ id, x, y, source })
    return true
  }

  /** A pistol reload part (by the library id `reload.ts` schedules), the spent magazine clattering down after "out". */
  reloadPart(libraryId: string, x: number, y: number, delay: number, emit: (e: SoundEvent) => void, source: string): void {
    const id = RELOAD_PART[libraryId]
    if (!id) return emit({ id: libraryId, x, y, delay, source })
    emit({ id, x, y, delay, source, fallback: { id: libraryId } })
    if (id === "wpn.pistol.out") {
      const floor = this.town ? BRASS_FLOOR[surfaceAt(this.town, x, y, this.extra)] : "hard"
      emit({ id: `wpn.mag.${floor}`, x, y, delay: delay + 0.36, source })
    }
  }

  dryFire(x: number, y: number, emit: (e: SoundEvent) => void, source: string): void {
    emit({ id: "wpn.pistol.dry", x, y, source, fallback: { id: "gun.dry-fire" } })
  }

  /** The flare gun: its report where it was fired, then broken open and reloaded in the shooter's hands. */
  flareGun(x: number, y: number, emit: (e: SoundEvent) => void): void {
    this.report("flare", x, y, emit, { source: "flare-gun", fallback: { id: "gun.pistol.shot", gain: 0.62, rate: 0.82, cutoffHz: 2600 } })
    emit({ id: "wpn.flare.reload", x, y, delay: 0.6, source: "flare-gun" })
  }

  /** Thrown things (AR-96), from the `toss:*` ring: the whoosh as one leaves the hand, then what it hit. */
  observeTosses(stores: ReadonlyMap<string, StoreState>, time: number, emit: (e: SoundEvent) => void): void {
    const on = this.uses("throwables")
    for (const [sid, st] of stores) {
      if (!sid.startsWith("toss:") || !st.at || !st.counts.t) continue
      const t0 = st.counts.t / 10
      const have = this.tosses.get(sid)
      const age = time - t0
      if (!have || have.t !== st.counts.t) {
        this.tosses.set(sid, { t: st.counts.t, impact: age >= (st.counts.fl ?? 5) / 10 })
        if (this.tossStarted && on && age < 0.5) {
          const item = tossItem(st)
          emit({ id: HEAVY_THROW.has(item) ? "wpn.throw.heavy" : "wpn.throw.light", x: st.at.x + (st.counts.sx ?? 0) / 100, y: st.at.y + (st.counts.sy ?? 0) / 100, source: st.owner ?? "throw" })
        }
        continue
      }
      if (have.impact || age < (st.counts.fl ?? 5) / 10) continue
      have.impact = true
      if (!on || age > 0.6 + (st.counts.fl ?? 5) / 10) continue
      const item = tossItem(st)
      const out = st.counts.out ?? 0
      const ix = st.at.x + (st.counts.ix ?? 0) / 100
      const iy = st.at.y + (st.counts.iy ?? 0) / 100
      const src = st.owner ?? "throw"
      // A pane or a smashed bottle is heard by its glass store; a head or a wall gets its own knock.
      if (out & (OUT_WINDOW | OUT_SHATTER)) continue
      if (out & OUT_HIT) {
        emit({ id: "wpn.bonk", x: ix, y: iy, rate: BONK_RATE[item], gain: item === "brick" ? 1.2 : 1, source: src })
        emit({ id: `wpn.land.${item}`, x: st.at.x, y: st.at.y, delay: 0.3, gain: 0.55, source: src })
      } else emit({ id: `wpn.land.${item}`, x: ix, y: iy, gain: out & OUT_WALL ? 1.15 : 1, source: src })
    }
    this.tossStarted = true
  }
}
