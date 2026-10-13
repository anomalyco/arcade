import { Builder } from "./builder"

/** Small shared map fixture for the wizard rules; seed remains on the wire. */
export function castleHall(seed: number) {
  const b = new Builder()
  b.floor("tile", 0, 0, 26, 18)
  b.wall(0, 0, 26, 0.35); b.wall(0, 0, 0.35, 18); b.wall(25.65, 0, 26, 18); b.wall(0, 17.65, 26, 18)
  b.wall(11, 1, 11.5, 5, 2.7, "pillar"); b.wall(17, 13, 17.5, 17, 2.7, "pillar")
  b.prop("bookshelf", 1.5, 0.5, 6.5, 1.2)
  b.prop("bookshelf", 20, 0.5, 24.5, 1.2)
  b.prop("table", 3.3, 7.7, 4.7, 8.4)
  b.prop("table", 6.2, 7.7, 7.6, 8.4)
  b.prop("table", 17, 4, 22, 5.3)
  b.prop("sofa", 17, 5.9, 22, 6.5)
  b.prop("crate", 10.8, 11.4, 11.6, 12.2)
  b.prop("crate", 14.8, 8.5, 15.6, 9.3)
  for (const [x,y] of [[4,4], [1,7], [25,4], [23,14], [1,16], [25,16]]) b.light({ kind: "panel", x: x!, y: y!, h: 2.5, r: 4, color: [1,0.55,0.2], power: 0.5 })
  for (const [x,y] of [[4,10], [12,10], [20,10], [8,14]]) b.spawns.push({ x: x!, y: y! })
  return b.build({ id: "castle-hall", seed, name: "Castle hall", size: [26,18] })
}
