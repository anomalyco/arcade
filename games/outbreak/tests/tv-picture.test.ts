import { describe, expect, test } from "bun:test"
import { DEFAULT_DETAIL_SETTINGS } from "../src/details/settings"
import { tvGlass } from "../src/details/tv-picture"

describe("Televisions show a picture", () => {
  test("is off by default (Today's flat glow and noise flicker)", () => {
    expect(DEFAULT_DETAIL_SETTINGS.dtTvPicture).toBe(false)
  })

  test("the glass sits on the set's screen, facing the way the set faces", () => {
    for (const yaw of [0, Math.PI / 2, 2.3]) {
      const site = { x: 4, y: 0.2, z: -7, yaw, scale: 1 }
      const g = tvGlass(site)
      // The screen faces model +Z, which instances turn to (−sin yaw, cos yaw), as the room light's offset does.
      expect(Math.cos(g.yaw)).toBeCloseTo(-Math.sin(yaw), 6)
      expect(Math.sin(g.yaw)).toBeCloseTo(Math.cos(yaw), 6)
      const ahead = (g.center[0] - site.x) * -Math.sin(yaw) + (g.center[2] - site.z) * Math.cos(yaw)
      expect(ahead).toBeCloseTo(0.222, 6)
      expect(g.center[1]).toBeCloseTo(0.9, 6)
      expect(g.width / g.height).toBeCloseTo(0.42 / 0.34, 6)
    }
  })
})
