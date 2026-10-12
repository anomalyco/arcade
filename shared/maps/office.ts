import { Builder, WALL_H } from "./builder"

const COLD = [0.82, 0.9, 1] as const
const WARM = [1, 0.88, 0.72] as const
const MOON = [0.42, 0.56, 1] as const

/**
 * Office Tower FL 12, after concept/iso-spooky-2.png. Open-plan cubicles in the middle; a glass meeting room, a
 * kitchen and a pitch-black storage room on the west; a server room, a moonlit lounge along the windows and the
 * manager's office on the east. Corridor panels are on one breaker in the server room.
 */
function build() {
  const b = new Builder()
  const W = 48
  const H = 32

  b.floor("carpet", 0, 0, W, H)
  b.floor("wood", 0.3, 0.3, 10.85, 9.85)
  b.floor("tile", 0.3, 10.15, 10.85, 19.85)
  b.floor("concrete", 0.3, 20.15, 10.85, 31.7)
  b.floor("tile", 11.15, 0.3, 36.85, 4.4)
  b.floor("grate", 37.15, 0.3, 47.7, 6.85)
  b.floor("wood", 37.15, 25.15, 47.7, 31.7)
  b.floor("tile", 27.15, 27.65, 33.85, 31.7)

  // Shell. The east side is glass from the server room down; mullions throw the moonlight in stripes.
  b.wall(0, 0, W, 0.3)
  b.wall(0, H - 0.3, W, H)
  b.wall(0, 0.3, 0.3, H - 0.3)
  b.wall(W - 0.3, 0.3, W, 7.15)
  b.windows.push([W - 0.3, 7.15, W, H - 0.3])
  for (let y = 9; y < H - 1; y += 2) b.wall(W - 0.3, y, W, y + 0.18, WALL_H, "mullion")

  // West rooms behind x = 11: meeting room (glass front), kitchen, storage.
  b.pane(10.9, 0.3, 11.1, 2.8)
  b.pane(10.9, 2.8, 11.1, 5.3)
  b.pane(10.9, 5.3, 11.1, 7.8)
  b.door([10.85, 7.8, 11.15, 9.0])
  b.vwall(11, 9.0, H - 0.3, [
    [14, 15.2],
    [25, 26.2],
  ])
  b.openDoors.push(1)
  b.hwall(10, 0.3, 10.85)
  b.hwall(20, 0.3, 10.85)

  b.prop("table", 3, 3.3, 8, 6.1)
  for (const x of [3.8, 5.5, 7.2]) {
    b.prop("chair", x - 0.25, 2.55, x + 0.25, 3.05, 0, false)
    b.prop("chair", x - 0.25, 6.35, x + 0.25, 6.85, 2, false)
  }
  b.prop("plant", 0.6, 0.6, 1.3, 1.3)
  b.prop("plant", 9.4, 0.6, 10.1, 1.3)
  b.light({ kind: "pendant", x: 5.5, y: 4.7, h: 2.2, r: 6.5, power: 1.1, color: WARM, shootable: true })

  b.prop("counter", 0.3, 10.15, 1.0, 16.8, 1)
  b.prop("fridge", 0.3, 17.1, 1.15, 18.1, 1)
  b.prop("table", 4.6, 13.4, 6.2, 15.0)
  b.prop("chair", 4.15, 13.95, 4.6, 14.45, 1, false)
  b.prop("chair", 6.2, 13.95, 6.65, 14.45, 3, false)
  b.prop("cooler", 9.9, 10.4, 10.6, 11.0)
  b.light({ kind: "panel", x: 5, y: 13, h: 2.6, r: 6.5, power: 0.95, color: COLD, shootable: true, flicker: 2 })
  b.noisy.push({ rect: [1.4, 16.4, 3.6, 18.8], kind: "puddle" })

  for (const x of [2.2, 5.2, 8.2]) b.wall(x, 22, x + 0.6, x === 8.2 ? 29 : 30, 2.0, "shelf")
  b.prop("crate", 3.4, 30.6, 4.3, 31.5)
  b.prop("crate", 0.6, 20.6, 1.5, 21.4)

  // North corridor with the exit.
  b.prop("exitdoor", 24, 0.3, 25.6, 0.5, 0, false)
  b.light({ kind: "exit", x: 24.8, y: 0.6, h: 2.35, r: 4.5, power: 0.55, color: [0.3, 1, 0.5], cone: [0, 1, 0.15], shootable: false })
  b.prop("plant", 11.5, 0.6, 12.2, 1.3)
  b.prop("cooler", 35.9, 0.6, 36.6, 1.2)

  // Open office.
  b.cluster(18, 8, ["ne"])
  b.cluster(24.5, 8)
  b.cluster(31, 8, ["sw"])
  b.cluster(18, 14.5)
  b.cluster(24.5, 14.5, ["nw"])
  b.cluster(31, 14.5)
  b.cluster(18, 21, ["se"])
  b.cluster(24.5, 21, ["sw"])
  b.cluster(31, 21, ["ne"])
  for (const [x, y, f] of [
    [19.5, 2.4, 0],
    [30, 2.4, 0],
    [21.25, 11.25, 0],
    [27.75, 17.75, 2],
    [24.5, 24.6, 1],
  ] as const) {
    b.light({ kind: "panel", x, y, h: 2.6, r: 7.5, power: 1, color: COLD, shootable: true, group: "main", flicker: f })
  }
  b.prop("plant", 14.3, 4.8, 15, 5.5)
  b.prop("plant", 34.2, 4.8, 34.9, 5.5)
  b.prop("plant", 14.3, 24.8, 15, 25.5)

  // Server room: grated floor, two rack rows, a cold light and the breaker for the corridor panels.
  b.vwall(37, 0.3, 7.15, [[3.8, 5.0]])
  b.hwall(7, 37.15, W - 0.3)
  b.wall(39, 1.6, 46.4, 2.3, 2.1, "rack")
  b.wall(39, 4.2, 46.4, 4.9, 2.1, "rack")
  b.noisy.push({ rect: [37.15, 0.3, 47.7, 6.85], kind: "grate" })
  b.light({ kind: "server", x: 42.6, y: 3.25, h: 2.4, r: 5.5, power: 0.8, color: [0.35, 0.55, 1], shootable: true, flicker: 1 })
  b.breakers.push({ x: 37.55, y: 6.4, group: "main" })

  // Lounge along the windows.
  const vend = b.light({ kind: "vending", x: 45.4, y: 8.45, h: 1.2, r: 4.5, power: 0.9, color: [0.3, 0.85, 1], cone: [0, 1, -0.2], shootable: true })
  b.prop("vending", 44.6, 7.15, 46.2, 8.05, 0, true, vend)
  b.prop("sofa", 40, 10.9, 42.4, 11.8, 0)
  b.prop("table", 40.5, 12.5, 41.9, 13.5)
  b.prop("sofa", 40, 14.2, 42.4, 15.1, 2)
  b.prop("sofa", 45, 16.8, 45.9, 19.6, 1)
  b.prop("table", 43.4, 17.5, 44.4, 18.9)
  b.prop("plant", 46.8, 9.4, 47.5, 10.1)
  b.prop("plant", 46.8, 22.1, 47.5, 22.8)
  b.prop("plant", 37.4, 23.9, 38.1, 24.6)
  b.prop("copier", 35, 22.4, 36.2, 23.4)
  b.prop("bench", 38.2, 19.4, 40.6, 20)

  // Manager's office.
  b.hwall(25, 37.15, W - 0.3, [[39, 40.2]])
  b.vwall(37, 24.85, H - 0.3)
  b.prop("desk", 42, 28, 44.6, 29.1, 2)
  b.prop("chair", 43, 29.2, 43.6, 29.8, 2, false)
  b.prop("bookshelf", 37.15, 26.6, 37.75, 30.2, 1)
  b.prop("plant", 46.8, 30.8, 47.5, 31.5)
  b.deskLamp(44.25, 28.3, 2)

  // Copy room off the south corridor.
  b.hwall(27.5, 27, 34, [[29, 30.2]], { openDoor: true })
  b.vwall(27, 27.65, H - 0.3)
  b.vwall(34, 27.65, H - 0.3)
  b.prop("copier", 31.6, 30.5, 33.6, 31.55)
  b.prop("cabinet", 27.2, 30.9, 29.2, 31.6)

  for (let x = 15; x < 25; x += 1.25) b.prop("cabinet", x, 31.1, x + 1.2, 31.7)
  b.prop("cooler", 13.2, 31, 13.9, 31.6)

  b.spawns.push({ x: 12.5, y: 1.6 }, { x: 12.6, y: 30.4 }, { x: 35.6, y: 2.2 }, { x: 35.5, y: 26.4 }, { x: 7, y: 30.8 }, { x: 2.2, y: 12.4 }, { x: 42, y: 30.6 }, { x: 39, y: 9 })

  return b.build({ id: "office", name: "Office Tower FL 12", blurb: "Cubicles, glass and moonlight", size: [W, H], ambient: [0.006, 0.008, 0.014] })
}

export const office = build()
