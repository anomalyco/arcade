import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { bodySites, bodyStoreId } from "../../shared/bodies/bodies"
import { inBuildingFootprint, type Town } from "../../shared/map"
import type { NightRampState } from "../../shared/night-ramp/runtime"
import type { OutbreakSim } from "../../shared/sim-types"
import { supportHeight } from "../../shared/terrain"
import { wayOutOf } from "../../shared/way-out/state"
import { puddleMaskAt } from "../weather/puddles"
import { Breath, type BreathSurvivor } from "./breath"
import { AnimalEyes, placeDens, type AnimalKind } from "./eyeshine"
import { BeamProbe } from "./light-probe"
import type { DetailSite } from "./placement"
import type { OutbreakDetailSettings } from "./settings"
import { dripLevel, placeDrips, writeDrips, type DripPoint } from "./drips"
import { BootPrints, groundKind } from "./prints"
import { placeSprinklers, sprinklerReach, writeSprinklers, type Sprinkler } from "./sprinkler"
import { FLIES_PER_SITE, mothLamps, writeFlies, writeMoths, type FlySite, type MothLamp } from "./swarms"

/** Which night it is: the Way Out's shared count when it runs (it reaches co-op clients), else the night ramp's, else 1. */
export function townNight(sim: Pick<OutbreakSim, "progression" | "getFeatureState">): number {
  const w = wayOutOf(sim.progression.ledger)
  if (w && w.night > 0) return w.night
  return Math.max(1, sim.getFeatureState<NightRampState>("nightRamp")?.night ?? 1)
}

/** What the life touches need from the frame. */
export type TouchFrame = {
  dt: number
  time: number
  town: Town
  /** Clock hour, and the day cycle's darkness 0..1 and sunlight 0..1. */
  hour: number
  darkness: number
  sun: number
  night: number
  view: readonly [number, number, number, number]
  /** The frame's packed light slots; the torches are slots `beamFrom..beamTo`. */
  lights: Float32Array
  beamFrom: number
  beamTo: number
  /** Fixture brightness per town lamp (the frame lighting's `lampPower`). */
  lampPower: Float32Array
  survivors: readonly { id: string; survivor: { x: number; y: number; aim: number; vehicleId?: number | null } }[]
  noises: readonly { x: number; y: number; radius: number; kind: string }[]
  /** The weather now: ground wetness, rainfall and standing water (0..1 each). */
  wetness: number
  rain: number
  puddles: number
  /** The local survivor's sight (`Vision.visible`). */
  vision: { visible(x: number, z: number): boolean }
  /** The shared ledger: a body that rose takes its flies with it. */
  ledger: { store(id: string): { counts: Record<string, number> } | undefined }
}

/**
 * The life touches (Details · Life): moths at lit lamps, flies over bodies and bins, eyes under the trees, breath in
 * the cold. Plans once per town and settings, then each frame steps what moves and writes renderer sprites (alpha for
 * the dark or soft things, additive for what glows), which keeps them in the TAA reactive mask. Owned by
 * `DetailsPresenter`; drawn from `scene/frame-renderer.ts`.
 */
export class LifeTouches {
  readonly probe = new BeamProbe()
  readonly eyes = new AnimalEyes()
  readonly breath = new Breath()
  private mothKey = ""
  private moths: MothLamp[] = []
  private denKey = ""
  private flyKey = ""
  private flies: FlySite[] = []
  private lastNight = 0
  private sprinklerKey = ""
  private sprinklers: Sprinkler[] = []
  private dripKey = ""
  private drips: DripPoint[] = []
  readonly prints = new BootPrints()
  private readonly printWeather = { wetness: 0, puddleAt: (x: number, z: number): number => puddleMaskAt(x, z, this.printWeather.puddles, groundKind(this.frame!.town, x, z) === "hard"), puddles: 0 }
  private readonly breathers: BreathSurvivor[] = []
  private readonly beamFrom = { x: 0, z: 0 }
  private frame: TouchFrame | null = null
  /** Readout for the harness. */
  readonly shown = { moths: 0, flies: 0, eyes: 0, dens: 0, bolts: 0, breath: 0, sprinklers: 0, spray: 0, drips: 0, prints: 0 }
  /** Called when an animal bolts (for the audio layer: rustle, scurry, hooves). */
  set onBolt(fn: ((x: number, z: number, kind: AnimalKind) => void) | null) {
    this.eyes.onBolt = fn
  }

  reset(): void {
    this.eyes.reset()
    this.breath.reset()
    this.mothKey = ""
    this.denKey = ""
    this.flyKey = ""
    this.sprinklerKey = ""
    this.dripKey = ""
    this.prints.reset()
    this.lastNight = 0
  }

  private plan(town: Town, s: OutbreakDetailSettings, sites: readonly DetailSite[]): void {
    const o = town.windowOrigin ?? [0, 0]
    const mk = `${town.seed}:${o[0]},${o[1]}:${town.lamps.length}:${s.lfMoths}`
    if (mk !== this.mothKey) {
      this.mothKey = mk
      this.moths = mothLamps(town.lamps, town.seed, s.lfMoths)
    }
    const dk = `${town.seed}:${o[0]},${o[1]}:${town.props.length}:${s.lfEyeshine}:${s.lfWatcher}:${s.dtSeed}`
    if (dk !== this.denKey) {
      this.denKey = dk
      this.eyes.setDens(dk, placeDens(town, s))
    }
    const sk = `${town.seed}:${o[0]},${o[1]}:${town.buildings.length}:${s.lfSprinkler}:${s.dtSeed}`
    if (sk !== this.sprinklerKey) {
      this.sprinklerKey = sk
      this.sprinklers = placeSprinklers(town, s)
      this.shown.sprinklers = this.sprinklers.length
    }
    const rk = `${town.seed}:${o[0]},${o[1]}:${town.buildings.length}:${town.props.length}:${s.lfDrips}`
    if (rk !== this.dripKey) {
      this.dripKey = rk
      this.drips = placeDrips(town, s.lfDrips)
    }
    const fk = `${town.seed}:${o[0]},${o[1]}:${town.buildings.length}:${sites.length}:${s.lfFlies}`
    if (fk !== this.flyKey) {
      this.flyKey = fk
      this.flies = []
      if (s.lfFlies > 0) {
        const count = (seed: number, base: number) => Math.min(FLIES_PER_SITE, Math.round((base + (seed % 4)) * s.lfFlies))
        for (const b of bodySites(town)) {
          const seed = hashKey(`${town.seed}:fly:${b.key}`)
          this.flies.push({ key: b.key, store: bodyStoreId(b.key), x: b.x, y: 0, z: b.y, n: count(seed, 4), seed, spread: 0.45 })
        }
        for (const d of sites) {
          if (d.model !== "bins" && d.model !== "binsBags" && d.model !== "dumpster") continue
          const seed = hashKey(`${town.seed}:fly:${d.model}:${d.x.toFixed(1)},${d.z.toFixed(1)}`)
          // Not every bin: the bagged ones and dumpsters mostly, a plain bin now and then.
          if (d.model === "bins" && seed % 3 !== 0) continue
          this.flies.push({ key: `bin:${d.x.toFixed(1)},${d.z.toFixed(1)}`, store: "", x: d.x, y: d.y + (d.model === "dumpster" ? 1.25 : 1.0), z: d.z, n: count(seed, 2), seed, spread: d.model === "dumpster" ? 0.6 : 0.3 })
        }
      }
    }
  }

  private readonly flyLight = (site: FlySite): number => {
    const f = this.frame!
    if (site.store && (f.ledger.store(site.store)?.counts.rise ?? 0) > 0) return 0
    if (!f.vision.visible(site.x, site.z)) return 0
    if (site.y === 0) site.y = supportHeight(f.town, site.x, site.z)
    return Math.max(f.sun * 0.9, this.probe.at(site.x, site.y + 0.4, site.z) * 1.3)
  }

  private readonly sprinklerLight = (x: number, z: number): number => {
    const f = this.frame!
    return Math.max(Math.min(1, f.sun * 2.2), this.probe.at(x, 0.5, z))
  }

  /** Light on a ground point for the eye: daylight, a torch, or a lit fixture close by (porch, street lamp, window). */
  private readonly groundLight = (x: number, z: number): number => {
    const f = this.frame!
    let lamp = 0
    for (const m of this.moths) {
      const d = Math.hypot(m.x - x, m.z - z)
      if (d > 4.5) continue
      lamp = Math.max(lamp, Math.min(1, f.lampPower[m.lamp] ?? 0) * (1 - d / 4.5) ** 2)
    }
    return Math.min(1, Math.max(f.sun * 0.8, this.probe.at(x, 0, z) * 1.2, lamp))
  }

  private readonly beamAt = (x: number, y: number, z: number): number => this.probe.at(x, y, z)

  /** Steps and draws every touch; returns the new alpha and additive sprite counts in `out`. */
  write(f: TouchFrame, s: OutbreakDetailSettings, sites: readonly DetailSite[], alpha: Float32Array, alphaCount: number, add: Float32Array, addCount: number, out: { alpha: number; add: number }): void {
    out.alpha = alphaCount
    out.add = addCount
    this.shown.moths = this.shown.flies = this.shown.eyes = this.shown.breath = this.shown.spray = this.shown.drips = this.shown.prints = 0
    if (!s.worldDetails || !s.lifeTouches) {
      if (this.mothKey) this.reset()
      return
    }
    this.frame = f
    this.plan(f.town, s, sites)
    this.probe.set(f.lights, f.beamFrom, f.beamTo)
    this.beamOrigin(f)
    if (f.night > this.lastNight) {
      if (this.lastNight > 0) this.eyes.newNight()
      this.lastNight = f.night
    }

    if (s.lfMoths > 0) {
      const before = out.add
      out.add = writeMoths(this.moths, f.lampPower, f.time, f.view, add, out.add, 1)
      this.shown.moths = out.add - before
    }
    if (s.lfFlies > 0) {
      const before = out.alpha
      out.alpha = writeFlies(this.flies, this.flyLight, f.time, f.view, alpha, out.alpha)
      this.shown.flies = out.alpha - before
    }
    if (s.lfSprinkler) {
      const before = out.alpha
      // The dawn after night n: the reach that morning.
      out.alpha = writeSprinklers(this.sprinklers, f.time, f.hour, sprinklerReach(f.night, s.lfDecay), this.sprinklerLight, f.view, alpha, out.alpha)
      this.shown.spray = out.alpha - before
    }
    if (s.lfDrips > 0) {
      const before = out.alpha
      out.alpha = writeDrips(this.drips, dripLevel(f.wetness, f.rain), f.time, this.groundLight, f.view, alpha, out.alpha, 48)
      this.shown.drips = out.alpha - before
    }
    if (s.lfPrints) {
      this.printWeather.wetness = f.wetness
      this.printWeather.puddles = f.puddles
      this.prints.step(f.time, f.town, this.printWeather, f.survivors)
      const before = out.alpha
      out.alpha = this.prints.write(f.time, f.view, alpha, out.alpha)
      this.shown.prints = out.alpha - before
    } else if (this.prints.count) this.prints.reset()
    const eyeFrame = this.eyeFrame
    eyeFrame.dt = f.dt
    eyeFrame.time = f.time
    eyeFrame.darkness = f.darkness
    eyeFrame.night = f.night
    eyeFrame.noises = f.noises
    eyeFrame.survivors = this.positions(f)
    this.eyes.step(eyeFrame)
    out.add = this.eyes.write(eyeFrame, f.town, f.view, add, out.add, 1)
    this.shown.eyes = this.eyes.shown.eyes
    this.shown.dens = this.eyes.shown.dens
    this.shown.bolts = this.eyes.shown.bolts

    const cold = s.lfBreath * smooth01((f.darkness - 0.62) / 0.3)
    this.breathers.length = 0
    for (const slot of f.survivors) {
      const v = slot.survivor
      this.breathers.push({ id: slot.id, x: v.x, y: v.y, aim: v.aim, inside: indoors(f.town, v.x, v.y), driving: v.vehicleId != null, ground: supportHeight(f.town, v.x, v.y) })
    }
    this.breath.step(f.dt, f.time, cold, this.breathers)
    if (s.lfBreath > 0) {
      const before = out.alpha
      out.alpha = this.breath.write(this.probe, alpha, out.alpha, Math.min(2, s.lfBreath))
      this.shown.breath = out.alpha - before
    }
    this.frame = null
  }

  private readonly eyeFrame = {
    dt: 0,
    time: 0,
    darkness: 0,
    night: 1,
    survivors: [] as { x: number; y: number }[],
    noises: [] as readonly { x: number; y: number; radius: number; kind: string }[],
    beam: this.beamAt,
    beamFrom: this.beamFrom,
  }

  private readonly pos: { x: number; y: number }[] = []

  private positions(f: TouchFrame): { x: number; y: number }[] {
    const p = this.pos
    p.length = f.survivors.length
    for (let i = 0; i < f.survivors.length; i++) {
      const v = f.survivors[i]!.survivor
      const o = (p[i] ??= { x: 0, y: 0 })
      o.x = v.x
      o.y = v.y
    }
    return p
  }

  /** Where the strongest torch shines from (the local beam's lens when it is on), for turning eyes toward it. */
  private beamOrigin(f: TouchFrame): void {
    const k = f.beamFrom * LIGHT_FLOATS
    if (f.beamTo > f.beamFrom) {
      this.beamFrom.x = f.lights[k]!
      this.beamFrom.z = f.lights[k + 2]!
    } else if (f.survivors[0]) {
      this.beamFrom.x = f.survivors[0].survivor.x
      this.beamFrom.z = f.survivors[0].survivor.y
    }
  }
}

function indoors(town: Town, x: number, z: number): boolean {
  for (const b of town.buildings) if (inBuildingFootprint(b, x, z)) return true
  return false
}

const smooth01 = (v: number) => {
  const t = Math.max(0, Math.min(1, v))
  return t * t * (3 - 2 * t)
}

function hashKey(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 13
  return Math.imul(h, 0x5bd1e995) >>> 0
}
