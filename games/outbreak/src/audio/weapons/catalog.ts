import type { MixCategory } from "@arcade/kit/audio"
import { MELEE_WEAPON_IDS, MELEE_WEAPONS, type MeleeWeaponId } from "../../../shared/combat"
import * as dsp from "./dsp"
import { levelTo } from "./level"

export { WEAPON_SAMPLE_RATE } from "./dsp"

/** Every weapon with its own Lab toggle (Backquote › Sound › Weapons); off plays Today's sounds for it. */
export const WEAPON_KEYS = ["pistol", "flare-gun", "flamethrower", "molotov", "dynamite", "firecrackers", "bear-trap", "throwables", ...MELEE_WEAPON_IDS] as const
export type WeaponKey = (typeof WEAPON_KEYS)[number]

/** Which Lab level scales a sound. */
export const WEAPON_GROUPS = ["report", "tail", "far", "handling", "brass", "melee", "impacts", "fire"] as const
export type WeaponGroup = (typeof WEAPON_GROUPS)[number]

export type WeaponSoundDef = {
  id: string
  label: string
  group: WeaponGroup
  bus: MixCategory
  /** Round-robin takes, each baked from its own seed. */
  variants: number
  bake: (sr: number, variant: number) => Float32Array
  /** Loudness every take is baked to: momentary-max LUFS, as the shared library normalises its one-shots. */
  target: number
  /** Linear level at the reference distance. */
  gain: number
  range: { ref: number; max: number }
  wet: number
  maxVoices: number
  priority?: number
  loop?: boolean
  /** ± fraction of playback rate and gain per trigger (scaled by the Lab's Variation). */
  pitchJitter: number
  gainJitter: number
  duck?: { seconds: number; depth: number }
}

/** Sample id of one baked take. */
export const variantId = (id: string, v: number) => `${id}#${v}`

/** How each melee weapon moves the air, from the knife's thin flick to the fire axe's long heavy whoosh. */
export const SWING_SHAPES: Readonly<Record<MeleeWeaponId, dsp.SwingShape>> = {
  knife: { seconds: 0.14, lo: 1400, hi: 4200, q: 1.2, amp: 0.7, tone: 3400, toneQ: 14, toneAmp: 0.5 },
  hammer: { seconds: 0.2, lo: 600, hi: 2000, q: 0.9, amp: 0.9 },
  pipe: { seconds: 0.24, lo: 500, hi: 1600, q: 0.9, amp: 0.9, tone: 880, toneQ: 16, toneAmp: 0.9 },
  crowbar: { seconds: 0.25, lo: 450, hi: 1500, q: 0.9, amp: 1, tone: 1300, toneQ: 10, toneAmp: 0.4 },
  machete: { seconds: 0.22, lo: 900, hi: 3000, q: 1.1, amp: 0.9, tone: 2600, toneQ: 14, toneAmp: 0.7 },
  bat: { seconds: 0.3, lo: 260, hi: 900, q: 0.8, amp: 1, low: 0.5 },
  "spiked-board": { seconds: 0.32, lo: 280, hi: 950, q: 0.8, amp: 1, flutter: 38, low: 0.5 },
  axe: { seconds: 0.33, lo: 300, hi: 1100, q: 0.85, amp: 1, tone: 1900, toneQ: 8, toneAmp: 0.35, low: 0.6 },
  "fire-axe": { seconds: 0.38, lo: 240, hi: 900, q: 0.8, amp: 1, tone: 1600, toneQ: 8, toneAmp: 0.35, low: 0.8 },
}

/** The weapon's own layer in a hit on a body. */
export const MELEE_HIT_LAYER: Readonly<Record<MeleeWeaponId, dsp.MeleeHitLayer>> = {
  knife: "blade",
  machete: "blade",
  axe: "chop",
  "fire-axe": "chop",
  hammer: "metal",
  pipe: "metal",
  crowbar: "metal",
  bat: "wood",
  "spiked-board": "spike",
}

export const meleeDrawKind = (w: MeleeWeaponId): dsp.DrawKind => {
  const c = MELEE_WEAPONS[w].weaponClass
  return c === "one-blade" ? "blade" : c === "one-blunt" ? "blunt" : "heavy"
}

const weapon = (d: Omit<WeaponSoundDef, "bus" | "wet" | "maxVoices" | "pitchJitter" | "gainJitter"> & Partial<WeaponSoundDef>): WeaponSoundDef => ({
  bus: "weapon",
  wet: 0.06,
  maxVoices: 3,
  pitchJitter: 0.04,
  gainJitter: 0.08,
  ...d,
  bake: (sr, v) => levelTo(d.bake(sr, v), sr, d.target),
})

const SR_TAILS: WeaponSoundDef[] = dsp.WEAPON_SPACES.flatMap((space) =>
  (["small", "big"] as const).map(
    (size): WeaponSoundDef =>
      weapon({
        id: `wpn.tail.${space}.${size}`,
        label: `${size === "big" ? "Blast" : "Report"} tail (${space})`,
        group: "tail",
        target: (({ room: -23, alley: -23, street: -25, open: -26 } as const)[space]) + (size === "big" ? 5 : 0),
        variants: 2,
        bake: (sr, v) => dsp.tail(sr, v + 1, space, size),
        // Rooms give a lot back, open ground little.
        gain: ({ room: 0.62, alley: 0.66, street: 0.52, open: 0.42 } as const)[space] * (size === "big" ? 1.1 : 1),
        range: { ref: 6, max: size === "big" ? 160 : 110 },
        wet: 0,
        maxVoices: 4,
        priority: 80,
        pitchJitter: 0.03,
        gainJitter: 0.06,
      }),
  ),
)

const BRASS: WeaponSoundDef[] = dsp.BRASS_FLOORS.flatMap((floor) => [
  weapon({ id: `wpn.brass.${floor}`, label: `Brass on ${floor} floor`, group: "brass", target: -24, bus: "foley", variants: 4, bake: (sr, v) => dsp.brass(sr, v + 1, floor), gain: 0.5, range: { ref: 1.5, max: 10 }, wet: 0.05, maxVoices: 4, priority: 40, pitchJitter: 0.07, gainJitter: 0.15 }),
  weapon({ id: `wpn.mag.${floor}`, label: `Magazine dropped on ${floor} floor`, group: "handling", target: -23, bus: "foley", variants: 2, bake: (sr, v) => dsp.magDrop(sr, v + 1, floor), gain: 0.55, range: { ref: 1.5, max: 12 }, wet: 0.06, maxVoices: 2, pitchJitter: 0.05, gainJitter: 0.1 }),
])

export const WEAPON_SOUNDS: readonly WeaponSoundDef[] = [
  // Pistol
  weapon({ id: "wpn.pistol.report", label: "Pistol report (action, crack, punch, thump)", group: "report", target: -16, variants: 4, bake: (sr, v) => dsp.pistolReport(sr, v + 1), gain: 0.95, range: { ref: 3, max: 75 }, wet: 0.05, maxVoices: 4, priority: 92, duck: { seconds: 0.14, depth: 0.72 } }),
  weapon({ id: "wpn.pistol.far", label: "Pistol, far off", group: "far", target: -21, variants: 3, bake: (sr, v) => dsp.pistolFar(sr, v + 1), gain: 0.7, range: { ref: 12, max: 170 }, wet: 0.04, maxVoices: 3, priority: 70, pitchJitter: 0.05 }),
  weapon({ id: "wpn.pistol.dry", label: "Pistol dry-fire", group: "handling", target: -23, variants: 3, bake: (sr, v) => dsp.pistolDry(sr, v + 1), gain: 0.6, range: { ref: 1.5, max: 10 }, wet: 0.04, maxVoices: 2 }),
  weapon({ id: "wpn.pistol.draw", label: "Pistol drawn", group: "handling", target: -25, bus: "foley", variants: 2, bake: (sr, v) => dsp.pistolDraw(sr, v + 1), gain: 0.55, range: { ref: 1.5, max: 10 }, wet: 0.04, maxVoices: 2 }),
  ...(["release", "out", "in", "slide"] as const).map((part) =>
    weapon({ id: `wpn.pistol.${part}`, label: `Pistol reload: ${part}`, group: "handling", target: ({ release: -25, out: -24, in: -21, slide: -20 } as const)[part], variants: 3, bake: (sr, v) => dsp.pistolReloadPart(sr, v + 1, part), gain: part === "in" || part === "slide" ? 0.7 : 0.6, range: { ref: 1.5, max: part === "slide" ? 16 : 12 }, wet: 0.06, maxVoices: 2, pitchJitter: 0.03 }),
  ),
  // Flare gun
  weapon({ id: "wpn.flare.report", label: "Flare gun report", group: "report", target: -18, variants: 3, bake: (sr, v) => dsp.flareReport(sr, v + 1), gain: 1, range: { ref: 3, max: 60 }, wet: 0.08, maxVoices: 2, priority: 88 }),
  weapon({ id: "wpn.flare.far", label: "Flare gun, far off", group: "far", target: -23, variants: 2, bake: (sr, v) => dsp.flareFar(sr, v + 1), gain: 0.55, range: { ref: 10, max: 130 }, wet: 0.04, maxVoices: 2, priority: 65 }),
  weapon({ id: "wpn.flare.reload", label: "Flare gun broken open and reloaded", group: "handling", target: -23, variants: 2, bake: (sr, v) => dsp.flareReload(sr, v + 1), gain: 0.6, range: { ref: 1.5, max: 12 }, wet: 0.06, maxVoices: 2, pitchJitter: 0.03 }),
  ...SR_TAILS,
  ...BRASS,
  // Explosives and fire
  weapon({ id: "wpn.blast", label: "Dynamite blast (crack, body, sub, debris)", group: "fire", target: -12, bus: "impact", variants: 3, bake: (sr, v) => dsp.blast(sr, v + 1), gain: 1.15, range: { ref: 5, max: 140 }, wet: 0.05, maxVoices: 3, priority: 95, duck: { seconds: 0.35, depth: 0.55 } }),
  weapon({ id: "wpn.blast.far", label: "Dynamite, far off", group: "far", target: -17, bus: "impact", variants: 2, bake: (sr, v) => dsp.blastFar(sr, v + 1), gain: 0.85, range: { ref: 20, max: 260 }, wet: 0.03, maxVoices: 2, priority: 75 }),
  weapon({ id: "wpn.cracker", label: "Firecracker pop", group: "fire", target: -19, bus: "impact", variants: 5, bake: (sr, v) => dsp.crackerPop(sr, v + 1), gain: 0.55, range: { ref: 3, max: 60 }, wet: 0.12, maxVoices: 4, priority: 60, pitchJitter: 0.08, gainJitter: 0.15 }),
  weapon({ id: "wpn.fuse.strike", label: "Fuse lit", group: "fire", target: -22, bus: "foley", variants: 2, bake: (sr, v) => dsp.fuseStrike(sr, v + 1), gain: 0.6, range: { ref: 1.5, max: 14 }, wet: 0.05, maxVoices: 3 }),
  weapon({ id: "wpn.fuse.loop", label: "Fuse burning", group: "fire", target: -27, bus: "foley", variants: 1, bake: (sr, v) => dsp.fuseLoop(sr, v + 1), gain: 0.5, range: { ref: 1.5, max: 14 }, wet: 0.05, maxVoices: 6, loop: true, pitchJitter: 0, gainJitter: 0 }),
  weapon({ id: "wpn.flamer.ignite", label: "Flamethrower lights", group: "fire", target: -17, variants: 2, bake: (sr, v) => dsp.flamerIgnite(sr, v + 1), gain: 0.8, range: { ref: 2.5, max: 30 }, wet: 0.08, maxVoices: 2, priority: 80 }),
  weapon({ id: "wpn.flamer.loop", label: "Flamethrower stream", group: "fire", target: -20, variants: 1, bake: (sr, v) => dsp.flamerLoop(sr, v + 1), gain: 0.7, range: { ref: 2.5, max: 34 }, wet: 0.08, maxVoices: 6, loop: true, priority: 80, pitchJitter: 0, gainJitter: 0 }),
  weapon({ id: "wpn.flamer.stop", label: "Flamethrower shuts off", group: "fire", target: -23, variants: 2, bake: (sr, v) => dsp.flamerStop(sr, v + 1), gain: 0.6, range: { ref: 2.5, max: 24 }, wet: 0.08, maxVoices: 2 }),
  weapon({ id: "wpn.molotov.smash", label: "Molotov smashes and catches", group: "fire", target: -15, bus: "impact", variants: 3, bake: (sr, v) => dsp.molotovSmash(sr, v + 1), gain: 0.9, range: { ref: 3, max: 50 }, wet: 0.12, maxVoices: 3, priority: 85 }),
  weapon({ id: "wpn.fire.loop", label: "Fire burning on the ground", group: "fire", target: -25, bus: "foley", variants: 1, bake: (sr, v) => dsp.fireLoop(sr, v + 1), gain: 0.55, range: { ref: 2.5, max: 24 }, wet: 0.1, maxVoices: 8, loop: true, pitchJitter: 0, gainJitter: 0 }),
  weapon({ id: "wpn.trap.set", label: "Bear trap set", group: "fire", target: -22, bus: "foley", variants: 2, bake: (sr, v) => dsp.trapSet(sr, v + 1), gain: 0.6, range: { ref: 1.5, max: 14 }, wet: 0.05, maxVoices: 2 }),
  weapon({ id: "wpn.trap.snap", label: "Bear trap snaps", group: "fire", target: -16, bus: "impact", variants: 2, bake: (sr, v) => dsp.trapSnap(sr, v + 1), gain: 0.9, range: { ref: 2.5, max: 30 }, wet: 0.08, maxVoices: 2, priority: 80 }),
  // Melee
  ...MELEE_WEAPON_IDS.map((w) =>
    weapon({ id: `wpn.swing.${w}`, label: `${MELEE_WEAPONS[w].label} swing`, group: "melee", target: -23 + (3 * (SWING_SHAPES[w].seconds - 0.14)) / 0.24, variants: 3, bake: (sr, v) => dsp.swing(sr, v + 1, SWING_SHAPES[w]), gain: 0.55 + 0.25 * (SWING_SHAPES[w].seconds - 0.14) / 0.24, range: { ref: 2, max: 16 }, wet: 0.05, maxVoices: 3, pitchJitter: 0.06, gainJitter: 0.1 }),
  ),
  ...(["flesh-light", "flesh-heavy", "bone", "blade", "chop", "metal", "wood", "spike"] as const).map((layer) =>
    weapon({ id: `wpn.hit.${layer}`, label: `Melee hit: ${layer}`, group: "melee", target: layer.startsWith("flesh") ? -18 : layer === "bone" ? -20 : -19, bus: "impact", variants: 3, bake: (sr, v) => dsp.meleeHit(sr, v + 1, layer), gain: layer.startsWith("flesh") ? 0.7 : layer === "bone" ? 0.55 : 0.58, range: { ref: 2.5, max: 26 }, wet: 0.08, maxVoices: 4, priority: 75, pitchJitter: 0.06, gainJitter: 0.1 }),
  ),
  ...(["blade", "metal", "wood"] as const).map((m) =>
    weapon({ id: `wpn.tool.${m}`, label: `Weapon on a hard surface: ${m}`, group: "melee", target: -20, bus: "impact", variants: 2, bake: (sr, v) => dsp.toolHit(sr, v + 1, m), gain: 0.5, range: { ref: 2.5, max: 24 }, wet: 0.1, maxVoices: 2, pitchJitter: 0.05 }),
  ),
  ...(["wood", "plaster", "concrete", "car", "glass", "dirt"] as const).map((s) =>
    weapon({ id: `wpn.bash.${s}`, label: `Melee blow on ${s}`, group: "melee", target: -18, bus: "impact", variants: 3, bake: (sr, v) => dsp.bash(sr, v + 1, s), gain: 0.75, range: { ref: 2.5, max: 28 }, wet: 0.12, maxVoices: 3, priority: 70, pitchJitter: 0.05 }),
  ),
  // Bullet impacts
  ...dsp.STRIKE_SURFACES.map((s) =>
    weapon({ id: `wpn.impact.${s}`, label: `Round hits ${s}`, group: "impacts", target: s === "flesh" ? -19 : -20, bus: "impact", variants: s === "concrete" ? 6 : 4, bake: (sr, v) => dsp.bulletImpact(sr, v + 1, s), gain: s === "flesh" ? 0.7 : 0.6, range: { ref: 2, max: 32 }, wet: 0.12, maxVoices: 3, priority: 65, pitchJitter: 0.07, gainJitter: 0.1 }),
  ),
  // Handling and throwables
  ...(["blade", "blunt", "heavy", "flamer", "flaregun", "throwable", "explosive"] as const).map((k) =>
    weapon({ id: `wpn.draw.${k}`, label: `Weapon drawn: ${k}`, group: "handling", target: -25, bus: "foley", variants: 2, bake: (sr, v) => dsp.draw(sr, v + 1, k), gain: 0.5, range: { ref: 1.5, max: 10 }, wet: 0.04, maxVoices: 2 }),
  ),
  weapon({ id: "wpn.throw.light", label: "Throw (light)", group: "fire", target: -24, bus: "foley", variants: 3, bake: (sr, v) => dsp.throwWhoosh(sr, v + 1, false), gain: 0.5, range: { ref: 2, max: 12 }, wet: 0.04, maxVoices: 2, pitchJitter: 0.06 }),
  weapon({ id: "wpn.throw.heavy", label: "Throw (heavy)", group: "fire", target: -23, bus: "foley", variants: 3, bake: (sr, v) => dsp.throwWhoosh(sr, v + 1, true), gain: 0.55, range: { ref: 2, max: 12 }, wet: 0.04, maxVoices: 2, pitchJitter: 0.06 }),
  ...(["baseball", "brick", "rock", "tin-can", "bottle"] as const).map((item) =>
    weapon({ id: `wpn.land.${item}`, label: `Thrown ${item} lands`, group: "fire", target: -17, bus: "impact", variants: 3, bake: (sr, v) => dsp.land(sr, v + 1, item), gain: item === "tin-can" ? 0.85 : 0.95, range: { ref: 4, max: item === "tin-can" ? 34 : 26 }, wet: 0.1, maxVoices: 3, pitchJitter: 0.06, gainJitter: 0.12 }),
  ),
  weapon({ id: "wpn.bonk", label: "Thrown thing bonks a head", group: "fire", target: -18, bus: "impact", variants: 3, bake: (sr, v) => dsp.bonk(sr, v + 1), gain: 0.9, range: { ref: 4, max: 24 }, wet: 0.08, maxVoices: 2, pitchJitter: 0.08 }),
]

const BY_ID = new Map(WEAPON_SOUNDS.map((d) => [d.id, d]))

export const weaponSound = (id: string): WeaponSoundDef | undefined => BY_ID.get(id)
