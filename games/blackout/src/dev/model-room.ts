import { Builder } from "../../shared/maps/builder"

/** Bounded furniture fixture for comparing office and castle presentation in envlab. */
export function modelRoom() {
  const b = new Builder()
  b.floor("tile", 0, 0, 16, 12)
  b.wall(0, 0, 16, 0.35)
  b.wall(0, 0, 0.35, 12)
  b.wall(15.65, 0, 16, 12)
  b.wall(0, 11.65, 16, 12, 0.45)
  b.wall(5, 0, 5.5, 3, 2.7, "pillar")
  b.prop("bookshelf", 1, 0.4, 4.4, 1.1)
  b.prop("bookshelf", 11.5, 0.4, 15, 1.1)
  b.prop("table", 7, 3.5, 11.7, 5.2)
  b.prop("sofa", 7, 2.6, 11.7, 3.15)
  b.prop("sofa", 7, 5.65, 11.7, 6.2)
  b.prop("table", 1.5, 4, 4.5, 5.4)
  b.prop("crate", 13.3, 2.8, 14.4, 3.9)
  for (const [x, y] of [[9, 3.8], [1.4, 2], [14, 2], [4, 8], [1, 9], [15, 9]]) b.light({ kind: "panel", x: x!, y: y!, h: 2.5, r: 5, color: [0.8, 0.88, 1], power: 0.6 })
  b.spawns.push({ x: 8, y: 8 })
  return b.build({ id: "model-room", seed: 990002, name: "Model room", size: [16, 12] })
}
