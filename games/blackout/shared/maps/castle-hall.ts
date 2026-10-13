import { Builder } from "./builder"

/** Small shared map fixture for the wizard rules; seed remains on the wire. */
export function castleHall(seed: number) {
  const b = new Builder()
  b.floor("tile", 0, 0, 26, 18)
  b.wall(0, 0, 26, 0.35); b.wall(0, 0, 0.35, 18); b.wall(25.65, 0, 26, 18); b.wall(0, 17.65, 26, 18)
  // A clear central casting lane; four piers and a reading alcove frame it.
  for (const [x,y] of [[3,5],[14,5],[3,14],[18,14]]) b.wall(x!,y!,x!+0.9,y!+0.9,2.7,"pillar")
  b.prop("bookshelf", 1.5, 0.5, 6.5, 1.2)
  b.prop("bookshelf", 20, 0.5, 24.5, 1.2)
  b.prop("table", 4.5, 5, 8.5, 6)
  b.prop("sofa", 4.5, 6.4, 8.5, 6.9)
  b.prop("table", 17, 4, 22, 5.3)
  b.prop("sofa", 17, 5.9, 22, 6.5)
  b.prop("crate", 8.6, 10.4, 9.4, 11.2)
  b.prop("crate", 14.8, 8.5, 15.6, 9.3)
  for (const [x,y,h] of [[3.5,6.1,1.8],[14.5,6.1,1.8],[3.5,13.8,1.8],[18.5,13.8,1.8],[6.5,4,2.5],[21,4,2.5],[1,10,1.8],[25,10,1.8]]) b.light({ kind: "fire", x: x!, y: y!, h: h!, r: 5.5, color: [1,0.57,0.24], power: 0.65 })
  for (const [x,y] of [[6,11], [11,11], [16,11], [10,15]]) b.spawns.push({ x: x!, y: y! })
  return b.build({ id: "castle-hall", seed, name: "Castle hall", size: [26,18] })
}
