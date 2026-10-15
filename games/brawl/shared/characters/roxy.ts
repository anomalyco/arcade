import { type CharacterDef, DODGE } from "./types"

/** A roller-derby jammer. Fast, slippery, impossible to pin down. */
export const roxy: CharacterDef = {
  id: "roxy",
  name: "Roxy Rollers",
  title: "Roller-derby jammer",
  tagline: "Out of my lane!",
  color: [1, 0.3, 0.68],
  speed: 7.2,
  accel: 0.9,
  weight: 0.86,
  abilities: [
    { id: "elbow", name: "Elbow Pad", blurb: "A quick roller-derby elbow.", windup: 0.05, cooldown: 0.28, effects: [{ kind: "melee", range: 1.45, arc: 1.4, hit: { damage: 5.5, knock: 7.5 } }], botRange: 1.4 },
    {
      id: "jam", name: "Jam Dash", blurb: "Skates through everyone in the way and leaves an ice trail.", windup: 0.06, cooldown: 3.8, moveScale: 1,
      effects: [{
        kind: "dash", speed: 20, time: 0.32, hit: { damage: 9, knock: 13.5 }, props: 12,
        trail: { look: "ice", radius: 0.85, life: 4.5, every: 0.045, slick: true, status: [{ kind: "slide", time: 0.35 }] },
      }],
      botRange: 5.5,
    },
    {
      id: "rink", name: "Ice Rink", blurb: "Freezes the floor around her and skates faster for a while.", windup: 0.14, cooldown: 6.5,
      effects: [
        { kind: "zone", look: "ice", at: "self", radius: 3.6, life: 5.5, slick: true, status: [{ kind: "slide", time: 0.35 }] },
        { kind: "status", status: [{ kind: "haste", time: 3.8, amount: 0.4 }] },
      ],
      botRange: 3.2,
    },
    DODGE,
  ],
}
