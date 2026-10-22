import { describe, expect, test } from "bun:test"
import { createFogSettings } from "@arcade/kit/gpu/fog-scatter"
import { streetProfile } from "@arcade/kit/gpu/lights/street"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { dustShader } from "../src/air/dust"
import { contactVolumeInput, DEFAULT_CONTACT_SHADOW_SETTINGS } from "../src/contact-shadows/settings"
import { outbreakContactVolume } from "../src/contact-shadows/wgsl"
import { OUTBREAK_LIGHTING_UNIFORM_FLOATS, OUTBREAK_STREET_LAMP_UNIFORM_OFFSET, OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET, streetLampHead, streetPostArm, STREET_LAMP_POOLS, STREET_LAMP_POSTS } from "../src/lighting"
import { DEFAULT_MIST_SETTINGS, mistFogSettings } from "../src/mist/settings"
import { outbreakFogVolume } from "../src/mist/wgsl"
import { createOutbreakSettings } from "../src/settings"
import { lensStreetFlux, streetArm, streetLensGain, todayStreetFlux } from "../src/street-lamps/lens"
import { DEFAULT_STREET_LAMP_SETTINGS, packStreetLampUniforms } from "../src/street-lamps/settings"
import { packWindowRoomUniforms } from "../src/window-rooms/settings"

describe("the four look ports are on by default (D-49 to D-52), Today one setting away", () => {
  test("street lamps, mist, contact shadows and lit rooms are on", () => {
    const s = createOutbreakSettings()
    expect(s.streetLamps.streetLampStyle).toBe(1)
    expect(s.mist.mistStyle).toBe(1)
    expect(s.contactShadows.contactShadowStyle).toBe(1)
    expect(s.windowRooms.windowRoomStyle).toBe(1)
  })

  test("the CI smoke keeps the mist and contact shadows (their own pipelines) at Today", () => {
    const s = createOutbreakSettings(new URLSearchParams("smoke"))
    expect(s.mist.mistStyle).toBe(0)
    expect(s.contactShadows.contactShadowStyle).toBe(0)
    expect(s.streetLamps.streetLampStyle).toBe(1)
    expect(s.windowRooms.windowRoomStyle).toBe(1)
  })

  test("Today sends no contact-shadow pass", () => {
    expect(contactVolumeInput({ ...DEFAULT_CONTACT_SHADOW_SETTINGS, contactShadowStyle: 0 }, new Float32Array(8))).toBeNull()
    const on = contactVolumeInput({ ...DEFAULT_CONTACT_SHADOW_SETTINGS, contactShadowStyle: 1 }, new Float32Array(8))
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
    expect(OUTBREAK_LIGHTING_UNIFORM_FLOATS).toBe(OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET + 8)
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
