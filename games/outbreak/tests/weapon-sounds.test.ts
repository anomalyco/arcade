import { describe, expect, test } from "bun:test"
import { SFX_BY_ID } from "@arcade/kit/audio"
import { momentaryMaxLufs } from "@arcade/kit/audio/sfx-analysis"
import { TICK_DT } from "../shared/clock"
import { MELEE_WEAPONS, type CombatMeleeEvent, type MeleeWeaponId } from "../shared/combat"
import type { Town } from "../shared/map"
import { LocalSession } from "../shared/session"
import { SoundDirector, type SoundEvent, type SoundWorld } from "../src/audio/director"
import { audioControls, DEFAULT_AUDIO_SETTINGS, WEAPON_TOGGLE_KEYS } from "../src/audio/settings"
import { weaponCue, weaponMix } from "../src/audio/weapons/bank"
import { WEAPON_KEYS, WEAPON_SAMPLE_RATE, WEAPON_SOUNDS, weaponSound } from "../src/audio/weapons/catalog"
import { to48k } from "../src/audio/weapons/level"
import { weaponSpace } from "../src/audio/weapons/weapons"
import { soundWorld } from "../src/audio/world"

const ids = (events: readonly SoundEvent[]) => events.map((e) => e.id)
const idle = { mx: 0, my: 0, aim: 0, interact: false }
const layered = (director: SoundDirector, patch: Partial<typeof DEFAULT_AUDIO_SETTINGS> = {}) => {
  weaponMix({ ...DEFAULT_AUDIO_SETTINGS, ...patch }, director.weapons.mix)
  return director
}

describe("weapon sound catalog (AR-102)", () => {
  test("every take bakes finite, under -0.9 dBFS, near its loudness target, and differs from its siblings", () => {
    for (const def of WEAPON_SOUNDS) {
      const takes = Array.from({ length: def.variants }, (_, v) => def.bake(WEAPON_SAMPLE_RATE, v))
      for (const pcm of takes) {
        let peak = 0
        for (const x of pcm) {
          expect(Number.isFinite(x)).toBe(true)
          peak = Math.max(peak, Math.abs(x))
        }
        expect(peak, def.id).toBeLessThanOrEqual(0.9)
        const m = momentaryMaxLufs([to48k(pcm, WEAPON_SAMPLE_RATE)])
        // Very short clicks stop a little short when their peaks are held; nothing overshoots.
        expect(m, def.id).toBeLessThanOrEqual(def.target + 0.3)
        expect(m, def.id).toBeGreaterThan(def.target - 7)
      }
      for (let a = 0; a < takes.length; a++) {
        for (let b = a + 1; b < takes.length; b++) {
          const n = Math.min(takes[a]!.length, takes[b]!.length)
          let diff = 0
          for (let i = 0; i < n; i++) diff += Math.abs(takes[a]![i]! - takes[b]![i]!)
          expect(diff / n, `${def.id} takes ${a} and ${b}`).toBeGreaterThan(1e-4)
        }
      }
    }
  })

  test("cues play each sound's takes round-robin with their jitter", () => {
    const def = weaponSound("wpn.pistol.report")!
    const cue = weaponCue(def)
    const layer = cue.layers[0]!
    expect(layer.kind).toBe("sample")
    if (layer.kind === "sample") {
      expect(layer.samples).toHaveLength(def.variants)
      expect(layer.selection).toBe("round-robin")
    }
    expect(cue.pitchVariation).toBeGreaterThan(0)
    expect(cue.gainVariation).toBeGreaterThan(0)
  })

  test("Lab: Sound › Weapons has Today one setting away and a toggle per weapon; layered is the default", () => {
    const weapons = audioControls.filter((c) => c.subsection === "Weapons")
    const set = weapons.find((c) => c.key === "audioWeaponSet")! as { options?: { label: string; value: number }[] }
    expect(set.options?.[0]).toEqual({ label: "Today (shared pistol, 3 melee hits)", value: 0 })
    expect(DEFAULT_AUDIO_SETTINGS.audioWeaponSet).toBe(1)
    for (const k of WEAPON_KEYS) expect(weapons.some((c) => c.key === WEAPON_TOGGLE_KEYS[k] && c.type === "toggle"), k).toBe(true)
  })

  test("every fallback names a library sound", () => {
    const src = [
      Bun.file(new URL("../src/audio/weapons/weapons.ts", import.meta.url).pathname),
      Bun.file(new URL("../src/audio/inventory.ts", import.meta.url).pathname),
      Bun.file(new URL("../src/audio/director.ts", import.meta.url).pathname),
    ]
    return Promise.all(src.map((f) => f.text())).then((texts) => {
      for (const text of texts) {
        for (const m of text.matchAll(/id: "([a-z.-]+)"/g)) {
          const id = m[1]!
          if (id.startsWith("wpn.")) expect(weaponSound(id), id).toBeDefined()
          else expect(SFX_BY_ID.has(id), id).toBe(true)
        }
        for (const m of text.matchAll(/id: `wpn\.([a-z]+)\.\$\{/g)) expect(WEAPON_SOUNDS.some((d) => d.id.startsWith(`wpn.${m[1]}.`)), m[0]).toBe(true)
      }
    })
  })
})

describe("where a report rings", () => {
  const box = (id: string, rect: [number, number, number, number]) => ({ id, kind: "house", rect, color: 0 })
  const town = (buildings: ReturnType<typeof box>[]) => ({ buildings }) as unknown as Town

  test("in a room, between two houses, along a street, in the open", () => {
    const row = town([box("a", [0, 0, 10, 10]), box("b", [16, 0, 26, 10])])
    expect(weaponSpace(row, 5, 5)).toBe("room")
    expect(weaponSpace(row, 13, 5)).toBe("alley")
    expect(weaponSpace(row, 5, 22)).toBe("street")
    expect(weaponSpace(row, 80, 80)).toBe("open")
    expect(weaponSpace(town([box("a", [0, 0, 10, 10]), box("b", [30, 0, 40, 10])]), 20, 5)).toBe("street")
  })
})

describe("layered weapon sounds in the director", () => {
  test("a pistol shot is its report, its space's tail and brass on the floor, each with Today as fallback", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = layered(new SoundDirector())
    const p = session.view.player
    Object.assign(p, { x: 44, y: 57, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
    const hear = () => director.observe(soundWorld(session.sim), p)
    hear()
    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const shot = hear()
    const report = shot.find((e) => e.id === "wpn.pistol.report")!
    expect(report.fallback?.id).toBe("gun.pistol.shot")
    expect(ids(shot)).toContain("wpn.tail.street.small")
    const brass = shot.find((e) => e.id.startsWith("wpn.brass."))!
    expect(brass.fallback?.id).toBe("gun.casing")
    expect(brass.delay).toBeGreaterThan(0.35)
    expect(ids(shot)).not.toContain("gun.pistol.shot")
    expect(ids(shot).some((id) => id.startsWith("wpn.impact.") || id === "wpn.impact.flesh")).toBe(true)
  })

  test("a teammate's shot far down the street is its far version, not the near report", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = layered(new SoundDirector())
    const p = session.view.player
    Object.assign(p, { x: 44, y: 57, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
    const far = { x: p.x + 60, y: p.y }
    const hear = () => director.observe(soundWorld(session.sim), far)
    hear()
    session.update(TICK_DT, { ...idle, fire: true }, 0)
    const heard = hear()
    expect(ids(heard)).toContain("wpn.pistol.far")
    expect(ids(heard)).not.toContain("wpn.pistol.report")
    expect(heard.find((e) => e.id === "wpn.pistol.far")!.fallback?.id).toBe("gun.pistol.shot")
  })

  test("Today and a weapon's own toggle bring back the library's sounds", () => {
    for (const patch of [{ audioWeaponSet: 0 }, { audioWpnPistol: 0 }]) {
      const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
      const director = layered(new SoundDirector(), patch)
      const p = session.view.player
      Object.assign(p, { x: 44, y: 57, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
      director.observe(soundWorld(session.sim), p)
      session.update(TICK_DT, { ...idle, fire: true }, 0)
      const shot = ids(director.observe(soundWorld(session.sim), p))
      expect(shot).toContain("gun.pistol.shot")
      expect(shot).toContain("gun.casing")
      expect(shot.some((id) => id.startsWith("wpn.pistol"))).toBe(false)
    }
  })

  const swing = (weapon: MeleeWeaponId, heavy: boolean, hits: { headshot?: boolean; killed?: boolean }[]): CombatMeleeEvent =>
    ({ id: 1, time: 0, attackerId: "s", attackerIndex: 0, weapon, x: 0, y: 0, aim: 0, arc: 1, reach: MELEE_WEAPONS[weapon].reach, combo: 1, heavy, charge: 0, hits: hits.map((h, i) => ({ zombieId: i + 1, x: 1, y: 0, damage: 20, killed: Boolean(h.killed), knockdown: false, headshot: Boolean(h.headshot), detachBone: null, seed: 1 })), hitDoorId: null, doorBroke: false, weaponBroke: false, durabilityLow: false, seed: 1 }) as CombatMeleeEvent

  const meleeHeard = (m: CombatMeleeEvent) => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = layered(new SoundDirector())
    const base = soundWorld(session.sim)
    const world = (swings: CombatMeleeEvent[]): SoundWorld => ({ ...base, meleeSwings: swings })
    director.observe(world([]), { x: 0, y: 0 })
    return director.observe(world([m]), { x: 0, y: 0 })
  }

  test("melee: the weapon's swing, flesh and its own layer; metal rings their bell on heavy and head hits", () => {
    const light = ids(meleeHeard(swing("crowbar", false, [{}])))
    expect(light).toContain("wpn.swing.crowbar")
    expect(light).toContain("wpn.hit.flesh-light")
    expect(light).toContain("wpn.hit.metal")
    expect(light).not.toContain("melee.hit.metal")
    const head = ids(meleeHeard(swing("pipe", true, [{ headshot: true, killed: true }])))
    expect(head).toContain("melee.hit.metal")
    expect(head).toContain("wpn.hit.bone")
    expect(head).toContain("wpn.hit.flesh-heavy")
    const blade = ids(meleeHeard(swing("machete", false, [{}])))
    expect(blade).toContain("wpn.hit.blade")
    expect(blade).not.toContain("melee.hit.metal")
    // A three-body cleave: bone and the bell only on the first.
    const cleave = ids(meleeHeard(swing("fire-axe", true, [{ headshot: true }, { headshot: true }, {}])))
    expect(cleave.filter((id) => id === "wpn.hit.bone")).toHaveLength(1)
    expect(cleave.filter((id) => id === "wpn.hit.chop")).toHaveLength(3)
  })

  test("every melee weapon has its own swing", () => {
    for (const w of Object.keys(MELEE_WEAPONS) as MeleeWeaponId[]) expect(ids(meleeHeard(swing(w, false, [])))).toContain(`wpn.swing.${w}`)
  })

  test("taking another weapon in hand is heard", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const director = layered(new SoundDirector())
    const p = session.view.player
    const world = () => soundWorld(session.sim)
    director.observe(world(), p)
    const survivor = world().survivors[0]!
    const patched = (item: string): SoundWorld => ({ ...world(), progression: undefined, survivors: [{ id: survivor.id, survivor: { ...survivor.survivor, equippedItem: item as never } }] })
    director.observe(patched("pistol"), p)
    expect(ids(director.observe(patched("machete"), p))).toContain("wpn.draw.blade")
    expect(ids(director.observe(patched("pistol"), p))).toContain("wpn.pistol.draw")
    expect(ids(director.observe(patched("pistol"), p))).not.toContain("wpn.pistol.draw")
  })
})
