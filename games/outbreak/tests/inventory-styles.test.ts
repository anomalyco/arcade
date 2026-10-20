import { describe, expect, test } from "bun:test"
import { ITEMS } from "../shared/progression/catalog"
import { quadMatrix } from "../src/inventory/bag"
import { footprint, ICON_ITEMS, itemIconSvg } from "../src/inventory/icons"
import { moveFor, parseRef, quickMoveFor, type InvCell, type InvModel } from "../src/inventory/model"
import { packShapes } from "../src/inventory/render"

const cell = (at: InvCell["ref"]["at"], slot: number, item: string | null, count = 1): InvCell => ({
  ref: { at, slot },
  stack: item ? { item, count } : null,
  label: item ?? "",
})

function model(withTarget: boolean): InvModel {
  return {
    hands: [cell("hotbar", 0, "flashlight"), cell("hotbar", 1, "pistol"), cell("hotbar", 2, null), cell("hotbar", 3, "medkit", 2), cell("hotbar", 4, null)],
    pack: [cell("pack", 0, "toolbox"), cell("pack", 1, null), cell("pack", 2, null), cell("pack", 3, null)],
    belt: [cell("belt", 0, "ammo", 12)],
    target: withTarget ? { kind: "container", title: "Search", cells: [cell("target", 0, "machete"), cell("target", 1, "plank", 3)] } : null,
    mates: [{ index: 2, name: "Sam", colour: "#fff", distance: 1, dx: 1, dy: 0 }],
    key: "",
  }
}

describe("inventory styles (AR-94)", () => {
  test("every carried item has a silhouette and a footprint", () => {
    const carried = ITEMS.filter((d) => d.tag !== "knowledge").map((d) => d.id)
    for (const id of carried) expect(ICON_ITEMS).toContain(id)
    for (const id of carried) {
      const fp = footprint(id)
      expect(fp.w).toBeGreaterThan(0)
      expect(itemIconSvg(id)).toContain(`viewBox="0 0 ${fp.w * 24} ${fp.h * 24}"`)
      expect(itemIconSvg(id, { rotate: true })).toContain(`viewBox="0 0 ${fp.h * 24} ${fp.w * 24}"`)
    }
  })

  test("drags become exact moves; areas resolve to a free slot", () => {
    const m = model(true)
    expect(moveFor(m, { at: "hotbar", slot: 1 }, { at: "pack", slot: -1 })).toEqual({ from: { at: "hotbar", slot: 1 }, to: { at: "pack", slot: 1 }, count: 0 })
    expect(moveFor(m, { at: "pack", slot: 0 }, { at: "hotbar", slot: 4 })).toEqual({ from: { at: "pack", slot: 0 }, to: { at: "hotbar", slot: 4 }, count: 0 })
    expect(moveFor(m, { at: "target", slot: 0 }, { at: "hotbar", slot: 2 })).toEqual({ from: { at: "target", slot: 0 }, to: { at: "hotbar", slot: 2 }, count: 0 })
    expect(moveFor(m, { at: "target", slot: 1 }, { at: "pack", slot: -1 })?.to).toEqual({ at: "me", slot: 0 })
    expect(moveFor(m, { at: "belt", slot: 0 }, { at: "mate", slot: 2 }, 6)).toEqual({ from: { at: "belt", slot: 0 }, to: { at: "mate", slot: 2 }, count: 6 })
    expect(moveFor(m, { at: "hotbar", slot: 3 }, { at: "target", slot: 1 })?.to).toEqual({ at: "target", slot: 0 })
    // Meaningless drops do nothing: onto itself, the belt into a hand, from what you face onto the floor, an empty slot.
    expect(moveFor(m, { at: "hotbar", slot: 1 }, { at: "hotbar", slot: 1 })).toBeNull()
    expect(moveFor(m, { at: "belt", slot: 0 }, { at: "hotbar", slot: 2 })).toBeNull()
    expect(moveFor(m, { at: "target", slot: 0 }, { at: "ground", slot: 0 })).toBeNull()
    expect(moveFor(m, { at: "pack", slot: 2 }, { at: "hotbar", slot: 2 })).toBeNull()
    expect(moveFor(model(false), { at: "hotbar", slot: 1 }, { at: "target", slot: 0 })).toBeNull()
  })

  test("a click quick-moves: out of what you face, into it when open, else hands and pack", () => {
    expect(quickMoveFor(model(true), { at: "target", slot: 0 })?.to.at).toBe("me")
    expect(quickMoveFor(model(true), { at: "hotbar", slot: 3 })?.to.at).toBe("target")
    expect(quickMoveFor(model(false), { at: "hotbar", slot: 1 })?.to).toEqual({ at: "pack", slot: 1 })
    expect(quickMoveFor(model(false), { at: "pack", slot: 0 })?.to).toEqual({ at: "hotbar", slot: 2 })
  })

  test("refs parse from data attributes", () => {
    expect(parseRef("pack:2")).toEqual({ at: "pack", slot: 2 })
    expect(parseRef("target:-1")).toEqual({ at: "target", slot: -1 })
    expect(parseRef("nope:1")).toBeNull()
    expect(parseRef(undefined)).toBeNull()
  })

  test("the case packs shapes without overlap, turning what is too long", () => {
    const shapes = packShapes(
      [
        { id: "a", w: 4, h: 2 },
        { id: "b", w: 3, h: 2 },
        { id: "c", w: 1, h: 1 },
        { id: "d", w: 9, h: 1 },
      ],
      8,
    )
    expect(shapes).toHaveLength(4)
    expect(shapes.find((s) => s.id === "d")?.rot).toBe(true)
    const taken = new Set<string>()
    for (const s of shapes) {
      expect(s.x + s.w).toBeLessThanOrEqual(8)
      for (let y = s.y; y < s.y + s.h; y++)
        for (let x = s.x; x < s.x + s.w; x++) {
          expect(taken.has(`${x},${y}`)).toBe(false)
          taken.add(`${x},${y}`)
        }
    }
  })

  test("the mat's matrix maps its corners onto the floor quad", () => {
    const pts = [
      { x: 100, y: 200 },
      { x: 500, y: 210 },
      { x: 520, y: 420 },
      { x: 80, y: 400 },
    ]
    const css = quadMatrix(820, 470, pts)!
    const m = css.slice(9, -1).split(",").map(Number)
    const apply = (x: number, y: number) => {
      const X = m[0]! * x + m[4]! * y + m[12]!
      const Y = m[1]! * x + m[5]! * y + m[13]!
      const W = m[3]! * x + m[7]! * y + m[15]!
      return { x: X / W, y: Y / W }
    }
    const corners = [apply(0, 0), apply(820, 0), apply(820, 470), apply(0, 470)]
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(pts[i]!.x, 3)
      expect(c.y).toBeCloseTo(pts[i]!.y, 3)
    })
  })
})
