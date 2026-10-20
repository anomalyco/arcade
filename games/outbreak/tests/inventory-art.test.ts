import { describe, expect, test } from "bun:test"
import sharp from "sharp"
import { ITEMS } from "../shared/progression/catalog"
import { ITEM_SHAPES } from "../shared/progression/shapes"
import { artOnGrid, LID, lidSlots } from "../src/inventory/layout"
import { PORTRAIT_CELL_PX, PORTRAITS } from "../src/portraits"
import { DOCK_THUMB, fitThumb, rotatedBounds } from "../src/portraits/thumb"

// Kit on the Attaché Case (AR-94): "Okay, clearly this doesn't fit, right?" Every portrait is exactly its shape, the
// painted object has its shape's proportions, and every place art is drawn keeps it inside its slot.

const carried = ITEMS.filter((d) => d.tag !== "knowledge").map((d) => d.id)
const dir = new URL("../src/portraits/", import.meta.url).pathname
/** How far a painted object's proportions may stray from its shape's (either way) before it looks mis-scaled. */
const ASPECT_SLACK = 1.38
const EPS = 1e-6

async function objectBox(id: string) {
  const { data, info } = await sharp(`${dir}${id}.webp`).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let x0 = info.width
  let y0 = info.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3]! > 24) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
  return { width: info.width, height: info.height, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

describe("item art fits its shape (AR-94)", () => {
  test("every portrait is exactly its shape at the portrait scale, with the same margin all round", async () => {
    for (const id of carried) {
      const s = ITEM_SHAPES[id]!
      expect(PORTRAITS[id]).toBeDefined()
      const box = await objectBox(id)
      expect([id, box.width, box.height]).toEqual([id, s.w * PORTRAIT_CELL_PX, s.h * PORTRAIT_CELL_PX])
      // Nothing painted touches the edge: the margin keeps art off the slot's border.
      expect([id, box.x0 > 2 && box.y0 > 2 && box.x0 + box.w < box.width - 2 && box.y0 + box.h < box.height - 2]).toEqual([id, true])
    }
  })

  test("the painted object has its shape's proportions", async () => {
    const off: string[] = []
    for (const id of carried) {
      const s = ITEM_SHAPES[id]!
      const box = await objectBox(id)
      const r = box.w / box.h / (s.w / s.h)
      if (r > ASPECT_SLACK || r < 1 / ASPECT_SLACK) off.push(`${id} ${s.w}×${s.h}: painted ${(box.w / box.h).toFixed(2)}:1`)
    }
    expect(off).toEqual([])
  })

  test("the lid's quick slots span exactly the case, never past it", () => {
    for (const cols of [6, 7, 8, 9]) {
      const slots = lidSlots(cols)
      expect(slots).toHaveLength(5)
      const right = slots.at(-1)!.x + slots.at(-1)!.w
      expect(Math.abs(right - cols)).toBeLessThan(EPS)
      for (const [i, r] of slots.entries()) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        if (i) expect(r.x).toBeGreaterThanOrEqual(slots[i - 1]!.x + slots[i - 1]!.w + LID.gap - EPS)
      }
    }
  })

  test("every item's thumbnail stays inside a quick slot and a dock slot, its margin kept", () => {
    const boxes = [...[6, 7, 9].map((cols) => ({ box: lidSlots(cols)[0]!, pad: LID.pad })), { box: DOCK_THUMB, pad: DOCK_THUMB.pad }]
    for (const id of carried) {
      const s = ITEM_SHAPES[id]!
      for (const { box, pad } of boxes) {
        const t = fitThumb(s, box, pad)
        const b = rotatedBounds(t.w, t.h, t.angle)
        expect(b.w).toBeLessThanOrEqual(box.w - pad * 2 + EPS)
        expect(b.h).toBeLessThanOrEqual(box.h - pad * 2 + EPS)
        // Keeps the portrait's proportions, and fills the box one way or the other.
        expect(Math.abs(t.w / t.h - s.w / s.h)).toBeLessThan(1e-6)
        expect(Math.max(b.w / (box.w - pad * 2), b.h / (box.h - pad * 2))).toBeGreaterThan(0.999)
      }
    }
    // A long item in a near-square quick slot lies on the diagonal, bigger than it would lie flat.
    const slot = lidSlots(6)[0]!
    const machete = fitThumb(ITEM_SHAPES.machete!, slot, LID.pad)
    expect(machete.angle).toBeLessThan(0)
    expect(machete.w).toBeGreaterThan((slot.w - LID.pad * 2) * 1.05)
  })

  test("on the grid, art is its footprint, and turned art covers the turned footprint", () => {
    for (const id of carried) {
      const s = ITEM_SHAPES[id]!
      for (const turned of [false, true]) {
        const a = artOnGrid(s, turned)
        const b = rotatedBounds(a.w, a.h, a.angle)
        expect([b.w, b.h].map((n) => Math.round(n * 1e6) / 1e6)).toEqual(turned ? [s.h, s.w] : [s.w, s.h])
      }
    }
  })
})
