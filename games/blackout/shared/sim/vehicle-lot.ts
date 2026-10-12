import { Builder } from "../maps/builder"
import type { MapDef } from "../maps/types"

/**
 * A practice-only test map for vehicles (?practice&map=lot): a walled 90 x 64 m yard with a loop of lanes around a block
 * of crates and pillars, a few warm work lights, and every kind of vehicle parked along the edge.
 */
export function lotMap(): MapDef {
  const W = 90
  const H = 64
  const b = new Builder()
  b.floor("concrete", 0, 0, W, H)
  b.wall(0, 0, W, 0.4, 3)
  b.wall(0, H - 0.4, W, H, 3)
  b.wall(0, 0, 0.4, H, 3)
  b.wall(W - 0.4, 0, W, H, 3)
  // The middle block: a long wall with pillars and crates to drive around and hide behind.
  b.wall(30, 26, 60, 26.4, 2.7)
  b.wall(30, 37.6, 60, 38, 2.7)
  b.wall(30, 26, 30.4, 31, 2.7)
  b.wall(59.6, 33, 60, 38, 2.7)
  for (const [x, y] of [
    [38, 31],
    [45, 33],
    [52, 30],
  ] as const)
    b.prop("crate", x - 0.6, y - 0.6, x + 0.6, y + 0.6, 0, true)
  for (const [x, y] of [
    [15, 15],
    [75, 15],
    [15, 49],
    [75, 49],
  ] as const)
    b.wall(x - 0.4, y - 0.4, x + 0.4, y + 0.4, 2.7, "pillar")
  for (const [x, y] of [
    [10, 32],
    [45, 8],
    [80, 32],
    [45, 56],
    [22, 20],
    [68, 44],
    [68, 20],
    [22, 44],
  ] as const)
    b.light({ kind: "bulb", x, y, h: 2.6, r: 11, power: 1.3, color: [1, 0.68, 0.36] })
  b.spawns.push({ x: 6, y: 6 }, { x: 84, y: 6 }, { x: 6, y: 58 }, { x: 84, y: 58 }, { x: 45, y: 20 }, { x: 45, y: 44 }, { x: 20, y: 32 }, { x: 70, y: 32 })
  return {
    ...b.build({ id: "lot", seed: -1, name: "Vehicle lot", size: [W, H] }),
    vehicles: [
      { kind: "jeep", x: 12, y: 6, heading: 0 },
      { kind: "jeep", x: 78, y: 58, heading: Math.PI },
      { kind: "van", x: 45, y: 14, heading: 0 },
      { kind: "scooter", x: 8, y: 12, heading: Math.PI / 2 },
      { kind: "scooter", x: 82, y: 52, heading: -Math.PI / 2 },
      { kind: "van", x: 45, y: 50, heading: Math.PI },
    ],
  }
}
