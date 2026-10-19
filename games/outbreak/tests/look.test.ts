import { describe, expect, test } from "bun:test"
import { createLookSettings } from "@arcade/kit/look"
import { flashlightColor } from "../shared/flashlight"
import { OUTBREAK_BEAN_UNIFORM_OFFSET, OUTBREAK_HERO_UNIFORM_OFFSET, OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET, OUTBREAK_SHROUD_UNIFORM_OFFSET, OUTBREAK_SIGHT_UNIFORM_OFFSET, packOutbreakLightingUniforms } from "../src/lighting"
import {
  beanTint,
  COLOUR_BLOCKS_STYLE,
  DEFAULT_HERO_LOOK,
  heroLookControls,
  heroShape,
  heroTint,
  HERO_STYLE_SURFACES,
  HERO_STYLES,
  SOFT_BEAN_STYLE,
} from "../src/look/hero"
import {
  buildColourBlocksSurvivorMeshes,
  resolveSurvivorVariant,
  SURVIVORS,
  townsfolkZombieMeshes,
  ZOMBIE_ARCHETYPES,
  zombieArchetypeIndex,
  zombiePalette,
} from "../src/look/refined-figure"
import { SURVIVOR_COLOURS } from "../src/seat-colours"
import { applyLookPreset } from "../src/look/index"
import { lookPreset, OUTBREAK_LOOK_PRESETS } from "../src/look/presets"
import { evaluateUnseenFrame } from "../src/unseen"
import { DEFAULT_LOOK_TRIMS, lightRuleWeight, lookTrimControls, trimLighting, trimLook } from "../src/look/world"
import { createOutbreakSettings, createOutbreakSubsystemDefaults } from "../src/settings"
import { Survivor } from "../src/survivor"
import { ZombieCrowdRenderer } from "../src/zombies"
import { LocalSession } from "../shared/session"
import { sightRects } from "../shared/map"
import { supportHeight } from "../shared/terrain"
import { Vision } from "../shared/vision"
import { zombieTuning } from "../src/zombie-profile"

const frame = (settings: ReturnType<typeof createOutbreakSettings>) => ({
  settings,
  playerX: 27.7,
  playerY: 41,
  playerH: 0,
  playerAim: -Math.PI / 2,
  flashlightOutput: 1,
  flashlightSlot: 1,
  inInteriorView: false,
  streetHead: [36.86, 6.18, 47.49] as const,
  zombies: [-999, -999, -999, -999] as const,
})

describe("Outbreak look", () => {
  test("today's look is the identity apart from the light-colour rule, which holds at night and not by day", () => {
    const base = createLookSettings("noir")
    const trims = { ...DEFAULT_LOOK_TRIMS, dayVignette: 0, dayGrain: 0, lookContrast: 1 }
    expect(trimLook(base, { ...trims, lightColour: 0 }, createLookSettings("current"))).toEqual(base)
    expect(trimLook(base, trims, createLookSettings("current"), 0)).toEqual(base)
    const night = trimLook(base, trims, createLookSettings("current"), 1)
    expect(night).toEqual({
      ...base,
      saturation: DEFAULT_LOOK_TRIMS.worldSaturation,
      selectiveColor: DEFAULT_LOOK_TRIMS.litColour,
      practicalWarmth: 0,
      vignette: DEFAULT_LOOK_TRIMS.nightVignette,
      grain: base.grain + DEFAULT_LOOK_TRIMS.nightGrain,
    })
    expect(lightRuleWeight(DEFAULT_LOOK_TRIMS, 0.5)).toBeCloseTo(0.5)
    const settings = createOutbreakSettings()
    expect(trimLighting(settings.lighting, settings.look)).toMatchObject({
      skyFill: settings.lighting.skyFill * DEFAULT_LOOK_TRIMS.skyAmbient,
      roomPower: settings.lighting.roomPower,
      practicalWarmth: settings.lighting.practicalWarmth,
    })
    // v8 dims the sky fill and moonlight; with those at 1 the trims leave the lighting uniforms untouched.
    const packed = packOutbreakLightingUniforms(frame({ ...settings, look: { ...settings.look, skyAmbient: 1, moonlight: 1 } }), flashlightColor(0.92))
    const untrimmed = packOutbreakLightingUniforms(frame({ ...settings, look: undefined } as never), flashlightColor(0.92))
    expect([...packed]).toEqual([...untrimmed])
    expect(settings.survivor.heroStyle).toBe(COLOUR_BLOCKS_STYLE)
    expect(settings.zombies.zombieLook).toBe(1)
  })

  test("every preset sets every knob, so presets never leak into each other, and today restores the defaults", () => {
    const keys = [...lookTrimControls, ...heroLookControls].map(c => c.key).sort()
    for (const preset of OUTBREAK_LOOK_PRESETS) {
      expect(Object.keys(preset.knobs).sort()).toEqual(keys)
      expect(preset.version).toBeGreaterThanOrEqual(1)
      for (const c of [...lookTrimControls, ...heroLookControls]) {
        const v = preset.knobs[c.key as keyof typeof preset.knobs]
        if ("min" in c) expect({ preset: preset.id, key: c.key, ok: v >= c.min && v <= c.max }).toEqual({ preset: preset.id, key: c.key, ok: true })
      }
    }
    const settings = createOutbreakSettings()
    applyLookPreset(settings, "big-walk")
    expect(settings.look.lookIdea).toBe("big-walk")
    expect(settings.survivor.heroStyle).toBe(2)
    expect(settings.look.lookSaturation).toBeGreaterThan(1)
    settings.zombies.zombieLook = 0
    applyLookPreset(settings, "today")
    const defaults = createOutbreakSubsystemDefaults()
    expect(settings.look).toEqual(defaults.look)
    expect(settings.survivor).toEqual(defaults.survivor)
    applyLookPreset(settings, "today-v7")
    expect(settings.flashlight.beamPoolDistance).toBe(5.5)
    applyLookPreset(settings, "today")
    expect(settings.flashlight).toEqual(defaults.flashlight)
    expect(settings.zombies.zombieLook).toBe(1)
    expect(applyLookPreset(settings, "nope")).toBe(false)
  })

  test("trims scale the hour's grade and lights and pack the hero surface", () => {
    const settings = createOutbreakSettings()
    applyLookPreset(settings, "warm-practicals")
    const base = createLookSettings("noir")
    const graded = trimLook(base, settings.look, createLookSettings("noir"), 0)
    expect(graded.practicalWarmth).toBeCloseTo(base.practicalWarmth + 0.9)
    expect(graded.saturation).toBeCloseTo(base.saturation * 1.3)
    const lit = trimLighting(settings.lighting, settings.look)
    expect(lit.roomPower).toBeCloseTo(settings.lighting.roomPower * 1.5 * 1.6)
    applyLookPreset(settings, "big-walk")
    const packed = packOutbreakLightingUniforms(frame(settings), flashlightColor(0.92))
    const s = HERO_STYLE_SURFACES[2]!
    expect([...packed.slice(OUTBREAK_HERO_UNIFORM_OFFSET, OUTBREAK_HERO_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([
      s.heroRim, s.heroRimTight, s.heroFlat, +s.heroSaturation.toFixed(4),
    ])
  })

  test("survivor styles: today keeps its boxes; simple styles draw their own tinted figure with the same rig", () => {
    expect(HERO_STYLES.map(s => heroShape(HERO_STYLES.indexOf(s)))).toEqual([0, 1, 1, 2, 3, 4])
    let next = 0
    const s = new Survivor({ addModel: () => next++ })
    const pose = { x: 27.7, y: 41, vx: 1.4, vy: 0, aim: 0 }
    const ids = (style: number) => {
      const batches = s.draw(pose, 1 / 60, 0, () => 0, { heroStyle: style })
      return { models: batches.map(b => b.model), tint: [...batches[0]!.data.slice(4, 7)] }
    }
    const today = ids(0)
    const mannequin = ids(1)
    const capsule = ids(3)
    const colourBlocks = ids(COLOUR_BLOCKS_STYLE)
    expect(today.tint).toEqual([1, 1, 1])
    expect(colourBlocks.tint).toEqual([1, 1, 1])
    expect(colourBlocks.models).not.toEqual(today.models)
    expect(mannequin.models).not.toEqual(today.models)
    expect(capsule.models).not.toEqual(mannequin.models)
    expect(ids(2).models).toEqual(mannequin.models)
    const tint = heroTint(DEFAULT_HERO_LOOK, null)
    expect(mannequin.tint.map(v => +v.toFixed(4))).toEqual(tint.map(v => +Math.fround(v).toFixed(4)))
    // Same rig: two survivors walking the same path put every part in the same place whatever their style.
    const a = new Survivor({ addModel: () => 0 })
    const b = new Survivor({ addModel: () => 0 })
    const c = new Survivor({ addModel: () => 0 })
    for (let n = 0; n < 90; n++) {
      const p = { ...pose, x: 27.7 + n * 1.4 / 60 }
      const fa = a.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: 0 }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      const fb = b.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: 3 }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      const fc = c.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: COLOUR_BLOCKS_STYLE }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      expect(fb).toEqual(fa)
      expect(fc).toEqual(fa)
    }
  })

  test("Soft Bean: its own figure on the same rig, one colour per seat, rebuilt in place when its shape changes", () => {
    expect(HERO_STYLES[SOFT_BEAN_STYLE]!.id).toBe("bean")
    let next = 0
    const set: number[] = []
    const renderer = { addModel: () => next++, setModel: (i: number) => void set.push(i) }
    const pose = { x: 27.7, y: 41, vx: 1.4, vy: 0, aim: 0 }
    const solo = new Survivor(renderer)
    const capsule = solo.draw(pose, 1 / 60, 0, () => 0, { heroStyle: 3 }).map(b => b.model)
    const bean = solo.draw(pose, 1 / 60, 0, () => 0, { heroStyle: SOFT_BEAN_STYLE })
    expect(bean.map(b => b.model)).not.toEqual(capsule)
    expect([...bean[0]!.data.slice(4, 7)].map(v => +v.toFixed(4))).toEqual(beanTint(DEFAULT_HERO_LOOK, 0).map(v => +Math.fround(v).toFixed(4)))
    const before = next
    solo.draw(pose, 1 / 60, 0, () => 0, { heroStyle: SOFT_BEAN_STYLE, beanHead: 1.3 })
    expect(next).toBe(before)
    expect(set.length).toBe(9)
    // Four seats, four clearly different colours (hue families of the name tags).
    const tints = SURVIVOR_COLOURS.map(c => new Survivor({ addModel: () => 0 }, c).draw(pose, 1 / 60, 0, () => 0, { heroStyle: SOFT_BEAN_STYLE })[0]!.data.slice(4, 7))
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(tints[i]![0]! - tints[j]![0]!, tints[i]![1]! - tints[j]![1]!, tints[i]![2]! - tints[j]![2]!)
      expect(d).toBeGreaterThan(0.2)
    }
    // A skin, not a rig change: every part lands where today's figure puts it.
    const a = new Survivor({ addModel: () => 0 })
    const b = new Survivor({ addModel: () => 0 })
    for (let n = 0; n < 90; n++) {
      const p = { ...pose, x: 27.7 + n * 1.4 / 60 }
      const fa = a.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: 0 }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      const fb = b.draw(p, 1 / 60, n / 60, () => 0, { heroStyle: SOFT_BEAN_STYLE }).map(x => [...x.data.slice(0, 4), ...x.data.slice(8, 10)])
      expect(fb).toEqual(fa)
    }
  })

  test("Soft Bean packs its wrap, sheen and own colour", () => {
    const settings = createOutbreakSettings()
    Object.assign(settings.survivor, { heroStyle: SOFT_BEAN_STYLE, beanWrap: 0.7, beanSheen: 1.1, beanSheenTight: 4, beanOwnColour: 0.3 })
    const packed = packOutbreakLightingUniforms(frame(settings), flashlightColor(0.92))
    expect([...packed.slice(OUTBREAK_BEAN_UNIFORM_OFFSET, OUTBREAK_BEAN_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([0.7, 1.1, 4, 0.3])
  })

  test("presets: today ships the Darkwood look and today-v7 restores v7 through the sight and beam knobs alone", () => {
    const settings = createOutbreakSettings()
    applyLookPreset(settings, "today-v7")
    expect(settings.look.beamWarmth).toBe(0.28)
    expect(settings.look.beamTightness).toBe(1)
    expect(settings.look.nightGrain).toBe(0.05)
    expect(settings.look.nightVignette).toBe(0.35)
    expect(settings.look.coneSharpness).toBe(0)
    expect(settings.look.dayShroud).toBe(0)
    expect(settings.look.shroudCharcoal).toBe(0)
    expect(settings.look.shroudGrain).toBe(0)
    expect(settings.look.shroudLampKeep).toBe(1)
    expect(settings.look.dayMuted).toBe(0)
    expect(settings.look.dayVignette).toBe(0)
    expect(settings.look.dayGrain).toBe(0)
    applyLookPreset(settings, "today")
    expect(settings.look.shroudDarkness).toBe(1)
    expect(settings.look.outOfLightDesat).toBe(1)
    expect(settings.look.outOfSightDarkening).toBe(1)
    expect(settings.look.worldSaturation).toBe(0.03)
    expect(settings.look.visionLift).toBe(0.03)
    expect(settings.look.zombieRimSpec).toBe(1.0)
    const packed = packOutbreakLightingUniforms(frame(settings), flashlightColor(0.92))
    const L = DEFAULT_LOOK_TRIMS
    expect([...packed.slice(OUTBREAK_SHROUD_UNIFORM_OFFSET, OUTBREAK_SHROUD_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([1, 1, 1, 0.03])
    expect([...packed.slice(OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET, OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([L.beamWarmth, L.beamTightness, 1, L.nightGrain])
    expect([...packed.slice(OUTBREAK_SIGHT_UNIFORM_OFFSET, OUTBREAK_SIGHT_UNIFORM_OFFSET + 4)].map(v => +v.toFixed(4))).toEqual([L.coneSharpness, L.dayShroud, L.dayMuted, L.shroudLampKeep])
  })

  test("only today, the v7 Before preset and knob-only look ideas remain", () => {
    expect(OUTBREAK_LOOK_PRESETS.map(p => p.id)).toEqual(["today", "today-v8", "today-v7", "deeper-noir", "warm-practicals", "vivid-world", "big-walk"])
  })

  test("Darkwood v8: the sight shroud holds by day and packs its charcoal and grain weights for the post pass", () => {
    const settings = createOutbreakSettings()
    const v8Day = evaluateUnseenFrame(settings.unseen, 0, 100, 100, settings.look)
    const v7Day = evaluateUnseenFrame(settings.unseen, 0, 100, 100, lookPreset("today-v7")!.knobs)
    expect(v8Day.nightFactor).toBe(1)
    expect(v7Day.nightFactor).toBeLessThan(0.5)
    expect(v7Day.postExtra).toBe(0)
    const extra = v8Day.postExtra
    expect(extra & 4095).toBe(Math.round(DEFAULT_LOOK_TRIMS.shroudCharcoal * 1024))
    expect((extra >>> 12) & 4095).toBe(Math.round(DEFAULT_LOOK_TRIMS.shroudGrain * 1024))
    expect(Number.isInteger(extra) && extra < 2 ** 24).toBe(true)
    const day = trimLook(createLookSettings("current"), DEFAULT_LOOK_TRIMS, createLookSettings("current"), 0)
    expect(day.vignette).toBeGreaterThanOrEqual(DEFAULT_LOOK_TRIMS.dayVignette)
    expect(day.grain).toBeGreaterThanOrEqual(DEFAULT_LOOK_TRIMS.dayGrain)
  })

  test("co-op seats tint the simple figure a little toward their jacket", () => {
    const own = heroTint(DEFAULT_HERO_LOOK, null)
    const seat = heroTint(DEFAULT_HERO_LOOK, [0.8, 0.1, 0.1])
    expect(seat[0]).toBeGreaterThan(own[0])
    expect(seat[2]).toBeLessThan(own[2])
  })

  test("Colour Blocks survivors: 4 distinct co-op people with distinct headgear, builds, skin tones and outfits", () => {
    expect(SURVIVORS.length).toBeGreaterThanOrEqual(4)
    const ids = new Set(SURVIVORS.map(s => s.id))
    const hats = new Set(SURVIVORS.map(s => s.headgear))
    const jackets = new Set(SURVIVORS.map(s => s.palette.jacket))
    const skins = new Set(SURVIVORS.map(s => s.palette.skin))
    const widths = new Set(SURVIVORS.map(s => s.build.torsoWidth))
    expect(ids.size).toBe(SURVIVORS.length)
    expect(hats.size).toBeGreaterThanOrEqual(4)
    expect(jackets.size).toBe(SURVIVORS.length)
    expect(skins.size).toBeGreaterThanOrEqual(3)
    expect(widths.size).toBeGreaterThanOrEqual(3)

    // Solo defaults to variant 0; co-op seats 0..3 map to distinct variants and wrap cleanly.
    const solo = new Survivor({ addModel: () => 0 })
    expect(solo.variantIndex).toBe(0)
    expect(solo.variant.id).toBe(SURVIVORS[0]!.id)

    for (let seat = 0; seat < 4; seat++) {
      const byPalette = new Survivor({ addModel: () => 0 }, SURVIVOR_COLOURS[seat]!)
      const bySeat = new Survivor({ addModel: () => 0 }, seat)
      expect(byPalette.variantIndex).toBe(seat)
      expect(bySeat.variantIndex).toBe(seat)
      expect(bySeat.variant.id).toBe(SURVIVORS[seat]!.id)
    }
    expect(resolveSurvivorVariant(4).id).toBe(SURVIVORS[0]!.id)
    expect(resolveSurvivorVariant(-1).id).toBe(SURVIVORS[SURVIVORS.length - 1]!.id)

    // Explicit variant override & setVariant rebuilds meshes in place.
    const updated: number[] = []
    let next = 0
    const custom = new Survivor({ addModel: () => next++, setModel: (id) => void updated.push(id) }, SURVIVOR_COLOURS[0]!, 2)
    expect(custom.variant.id).toBe("hank")
    custom.setVariant(3)
    expect(custom.variant.id).toBe("tess")
    expect(updated.length).toBe(9)

    // Each variant builds non-empty meshes with distinct vertex data.
    const meshes = SURVIVORS.map((_, i) => buildColourBlocksSurvivorMeshes(i))
    for (let i = 0; i < meshes.length; i++) {
      expect(meshes[i]!.torso.v.length).toBeGreaterThan(0)
      expect(meshes[i]!.head.v.length).toBeGreaterThan(0)
      if (i > 0) expect([...meshes[i]!.head.v]).not.toEqual([...meshes[0]!.head.v])
    }
  })

  test("Former Townsfolk zombies: deterministic archetype and decayed palette per id/seed, instanced in ZombieCrowdRenderer", () => {
    expect(ZOMBIE_ARCHETYPES.length).toBeGreaterThanOrEqual(6)
    const { archetypes, shared } = townsfolkZombieMeshes()
    const v1 = townsfolkZombieMeshes(0.35, false)
    expect(archetypes.length).toBe(ZOMBIE_ARCHETYPES.length)
    expect(shared.length).toBe(6)
    for (let i = 0; i < archetypes.length; i++) {
      expect(archetypes[i]!.torso.v.length).toBeGreaterThan(v1.archetypes[i]!.torso.v.length)
      expect(archetypes[i]!.head.v.length).toBeGreaterThan(v1.archetypes[i]!.head.v.length)
    }
    expect(shared[0]!.v.length).toBeGreaterThan(v1.shared[0]!.v.length)
    expect(shared[1]!.v.length).toBeGreaterThan(v1.shared[1]!.v.length)

    // Deterministic for same (seed, id), varied across a crowd.
    const archSet = new Set<number>()
    const tintSet = new Set<string>()
    const bufA = new Float32Array(27)
    const bufB = new Float32Array(27)
    for (let id = 1; id <= 48; id++) {
      const seed = (id * 2654435761) >>> 0
      const a1 = zombieArchetypeIndex(seed, id)
      const a2 = zombieArchetypeIndex(seed, id)
      expect(a1).toBe(a2)
      archSet.add(a1)
      zombiePalette(seed, bufA, id)
      zombiePalette(seed, bufB, id)
      expect([...bufA]).toEqual([...bufB])
      tintSet.add([...bufA.slice(0, 9)].map(v => v.toFixed(3)).join(","))
    }
    expect(archSet.size).toBe(ZOMBIE_ARCHETYPES.length)
    expect(tintSet.size).toBeGreaterThan(16)

    // ZombieCrowdRenderer buckets pelvis/torso/head by archetype and shares limb/foot instancing for zombieLook = 1,
    // while keeping total partCounts identical to zombieLook = 0.
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const town = session.view.town
    for (let i = 0; i < 60; i++) {
      session.ai.spawnZombie(town, 20 + (i * 5) % 40, 20 + (i * 7) % 40, "chase")
    }
    const vision = new Vision()
    vision.update(40, 40, 0, sightRects(town), { range: 96, cone: 360, awareness: 96 })
    let modelId = 0
    const crowd = new ZombieCrowdRenderer({ addModel: () => modelId++ })
    const townsfolkBatches = crowd.draw(
      session.view.zombies,
      1 / 60,
      (x, z) => supportHeight(town, x, z),
      vision,
      [0, 0, 96, 96],
      { ...zombieTuning, zombieLook: 1 },
      true,
    )
    expect([...crowd.partCounts]).toEqual([60, 60, 60, 120, 120, 120, 120, 120, 120])
    expect(townsfolkBatches.length).toBeGreaterThan(9)
    expect(townsfolkBatches.reduce((sum, b) => sum + b.count, 0)).toBe(60 * 3 + 120 * 6)

    const v1Batches = crowd.draw(
      session.view.zombies,
      1 / 60,
      (x, z) => supportHeight(town, x, z),
      vision,
      [0, 0, 96, 96],
      { ...zombieTuning, zombieLook: 2 },
      true,
    )
    expect(v1Batches.reduce((sum, b) => sum + b.count, 0)).toBe(60 * 3 + 120 * 6)

    const todayBatches = crowd.draw(
      session.view.zombies,
      1 / 60,
      (x, z) => supportHeight(town, x, z),
      vision,
      [0, 0, 96, 96],
      { ...zombieTuning, zombieLook: 0 },
      true,
    )
    expect(todayBatches.map(b => b.count)).toEqual([60, 60, 60, 120, 120, 120, 120, 120, 120])
  })
})
