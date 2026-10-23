import { describe, expect, test } from "bun:test"
import { createFogSettings } from "@arcade/kit/gpu/fog-scatter"
import { streetProfile } from "@arcade/kit/gpu/lights/street"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { dustShader } from "../src/air/dust"
import { contactVolumeInput, DEFAULT_CONTACT_SHADOW_SETTINGS, resolveContactShadows } from "../src/contact-shadows/settings"
import { outbreakContactVolume } from "../src/contact-shadows/wgsl"
import { FINISH_UNIFORM_FLOATS } from "../src/interiors/finish"
import { OUTBREAK_FINISH_UNIFORM_OFFSET, OUTBREAK_LIGHTING_UNIFORM_FLOATS, OUTBREAK_STREET_LAMP_UNIFORM_OFFSET, OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET, streetLampHead, streetPostArm, STREET_LAMP_POOLS, STREET_LAMP_POSTS } from "../src/lighting"
import { DEFAULT_MIST_SETTINGS, mistFogSettings, resolveMist } from "../src/mist/settings"
import { outbreakFogVolume } from "../src/mist/wgsl"
import { bounceInput } from "../src/bounce-light/settings"
import { OUTBREAK_QUALITY_PROFILES, QUALITY_TIER } from "../src/quality"
import { createOutbreakSettings } from "../src/settings"
import { capsuleSettings } from "../src/soft-shadows/settings"
import { lensStreetFlux, streetArm, streetLensGain, todayStreetFlux } from "../src/street-lamps/lens"
import { DEFAULT_STREET_LAMP_SETTINGS, packStreetLampUniforms } from "../src/street-lamps/settings"
import { packWindowRoomUniforms } from "../src/window-rooms/settings"

describe("the four look ports follow the quality tier by default (D-49 to D-52), Today one setting away", () => {
  const resolved = (tier: "high" | "balanced" | "low", s = createOutbreakSettings()) => {
    const q = OUTBREAK_QUALITY_PROFILES[tier]
    return {
      mist: resolveMist(s.mist, q, { ...s.mist }),
      contact: resolveContactShadows(s.contactShadows, q, { ...s.contactShadows }),
      bounce: bounceInput(s.bounce, q, 0, 0),
      soft: capsuleSettings(s.softShadows, q),
    }
  }

  test("street lamps and lit rooms are on; mist and contact shadows are left to the tier", () => {
    const s = createOutbreakSettings()
    expect(s.streetLamps.streetLampStyle).toBe(1)
    expect(s.windowRooms.windowRoomStyle).toBe(1)
    expect(s.mist.mistStyle).toBe(QUALITY_TIER)
    expect(s.contactShadows.contactShadowStyle).toBe(QUALITY_TIER)
  })

  test("High is Kit's picks as shipped in #401", () => {
    const r = resolved("high")
    expect([r.mist.mistStyle, r.mist.mistDownscale]).toEqual([1, 3])
    expect([r.contact.contactShadowStyle, r.contact.csLights, r.contact.csSteps]).toEqual([1, 2, 12])
    expect(r.bounce?.texel).toBe(0.5)
    expect(r.soft.lights).toBe(3)
  })

  test("Balanced is the measured cut; Low turns mist and contact shadows off", () => {
    const b = resolved("balanced")
    expect([b.mist.mistStyle, b.mist.mistDownscale, b.contact.csLights, b.contact.csSteps]).toEqual([1, 4, 1, 8])
    const l = resolved("low")
    expect([l.mist.mistStyle, l.contact.contactShadowStyle, l.bounce?.texel, l.soft.lights]).toEqual([0, 0, 1, 1])
  })

  test("an explicit Lab value beats the tier", () => {
    const s = createOutbreakSettings()
    s.mist.mistStyle = 1
    s.mist.mistDownscale = 2
    s.contactShadows.csSteps = 16
    const l = resolved("low", s)
    expect([l.mist.mistStyle, l.mist.mistDownscale, l.contact.csSteps]).toEqual([1, 2, 16])
  })

  test("the CI smoke keeps the mist and contact shadows (their own pipelines) at Today on every tier", () => {
    const s = createOutbreakSettings(new URLSearchParams("smoke"))
    const h = resolved("high", s)
    expect([h.mist.mistStyle, h.contact.contactShadowStyle]).toEqual([0, 0])
    expect(s.streetLamps.streetLampStyle).toBe(1)
  })

  test("Today sends no contact-shadow pass", () => {
    const high = resolveContactShadows(DEFAULT_CONTACT_SHADOW_SETTINGS, OUTBREAK_QUALITY_PROFILES.high, { ...DEFAULT_CONTACT_SHADOW_SETTINGS })
    expect(contactVolumeInput({ ...high, contactShadowStyle: 0 }, new Float32Array(8))).toBeNull()
    const on = contactVolumeInput(high, new Float32Array(8))
    expect(on).toMatchObject({ downscale: 2, moving: DEFAULT_CONTACT_SHADOW_SETTINGS.csHistoryMoving })
    expect(Array.from(on!.params!).slice(0, 6)).toEqual([0.7, 0.35, 0.85, 80, 12, 2].map(Math.fround))
  })
})

describe("lens street lamps", () => {
  test("arms point from the pole towards the carriageway", () => {
    expect(streetArm(38.5, 10)).toEqual([1, 0])
    expect(streetArm(49.5, 10)).toEqual([-1, 0])
    expect(streetArm(10, 38.5)).toEqual([0, 1])
    expect(streetArm(96 + 49.5, 10)).toEqual([-1, 0])
    expect(streetArm(10, 10)).toEqual([1, 0])
  })

  test("the origin posts aim their pool where Today lights it", () => {
    const [a, b] = STREET_LAMP_POSTS
    const headA = streetLampHead(a)
    const armA = streetPostArm(headA)
    // Post 0's lens hangs ~6 m from Today's pool: the arm points at the pool.
    const toPool = [STREET_LAMP_POOLS[0][0] - headA[0], STREET_LAMP_POOLS[0][1] - headA[2]]
    expect(armA[0] * toPool[0] + armA[1] * toPool[1]).toBeCloseTo(Math.hypot(toPool[0]!, toPool[1]!), 5)
    // Post 1's pool is under its head: its own yaw, also a block away.
    expect(streetPostArm([b.x + 96, 6.18, b.z])).toEqual([Math.cos(b.yaw), Math.sin(b.yaw)])
  })

  test("the gain puts Today's light on the ground, spread over the designed pool", () => {
    const s = DEFAULT_STREET_LAMP_SETTINGS
    const h = 6.1
    const r = s.slReach * h
    const gain = streetLensGain(s, 5.8, 13, 1, h, r)
    expect(gain).toBeGreaterThan(0.5)
    expect(lensStreetFlux(h, r, s.slLensB, s) * gain).toBeCloseTo(todayStreetFlux(5.8, 13, 1), 3)
  })

  test("no hot spot under the head: the pool is flatter along the road than Today's", () => {
    const s = DEFAULT_STREET_LAMP_SETTINGS
    const p = { along: s.slAlong, street: s.slStreet, house: s.slHouse, cutoff: s.slCutoff, glow: s.slGlow }
    const h = 6
    const lens = (x: number) => {
      const d = Math.hypot(x, h)
      return (streetProfile([0, -h / d, x / d], [1, 0], p) / (d * d + s.slLensB ** 2)) * (h / d)
    }
    const today = (x: number) => (0.025 + 2.25 / (1 + (x * x + h * h) * 0.62)) * (h / Math.hypot(x, h))
    expect(lens(0) / lens(h * 0.5)).toBeLessThan(1.15)
    expect(lens(0) / lens(h)).toBeLessThan(today(0) / today(h))
  })

  test("uniforms: profile, on and the nearest head's lens", () => {
    const out = new Float32Array(12)
    packStreetLampUniforms({ ...DEFAULT_STREET_LAMP_SETTINGS, streetLampStyle: 1 }, [0, 1], out, 0)
    expect(out[4]).toBe(1)
    expect(Array.from(out.slice(8))).toEqual([0, 1, 0.22, 0.13].map(Math.fround))
    packStreetLampUniforms({ ...DEFAULT_STREET_LAMP_SETTINGS, streetLampStyle: 0 }, [1, 0], out, 0)
    expect(out[4]).toBe(0)
  })
})

describe("low mist and lit rooms", () => {
  test("the mist rides a near-clear fog when the lamp fog is at Today", () => {
    const out = createFogSettings()
    mistFogSettings(createFogSettings({ mode: "today" }), false, { ...DEFAULT_MIST_SETTINGS, mistStyle: 1 }, 0, out)
    expect(out).toMatchObject({ mode: "scatter", bank: "drift", bankHeight: DEFAULT_MIST_SETTINGS.mistHeight, bankBrightness: DEFAULT_MIST_SETTINGS.mistNight })
    expect(out.density).toBeLessThan(0.01)
    expect(mistFogSettings(createFogSettings(), false, DEFAULT_MIST_SETTINGS, 1, out).bankBrightness).toBeCloseTo(DEFAULT_MIST_SETTINGS.mistDay)
  })

  test("uniform tail fits and the rooms pack on/off", () => {
    expect(OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET).toBe(OUTBREAK_STREET_LAMP_UNIFORM_OFFSET + 12)
    expect(OUTBREAK_FINISH_UNIFORM_OFFSET).toBe(OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET + 8)
    expect(OUTBREAK_LIGHTING_UNIFORM_FLOATS).toBe(OUTBREAK_FINISH_UNIFORM_OFFSET + FINISH_UNIFORM_FLOATS)
    const out = new Float32Array(8)
    packWindowRoomUniforms({ ...createOutbreakSettings().windowRooms, windowRoomStyle: 0 }, out, 0)
    expect(out[0]).toBe(0)
    packWindowRoomUniforms({ ...createOutbreakSettings().windowRooms, windowRoomStyle: 1 }, out, 0)
    expect(out[0]).toBe(1)
  })
})

describe("look-port WGSL validates with naga", () => {
  test("contact shadows slot", () => validateWgsl(outbreakContactVolume.code))
  test("fog and mist slot", () => validateWgsl(outbreakFogVolume.code))
  test("dust motes (lens lamps light them)", () => validateWgsl(dustShader))
})
