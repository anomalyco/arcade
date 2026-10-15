import { type CharacterDef, DODGE } from "./types"

/** A roller-derby jammer. Fast, slippery, impossible to pin down. */
export const roxy: CharacterDef = {
  id: "roxy",
  name: "Roxy Rollers",
  title: "Roller-derby jammer",
  tagline: "Out of my lane!",
  color: [1, 0.3, 0.68],
  speed: 7.1,
  accel: 0.94,
  weight: 0.96,
  abilities: [
    { id: "elbow", name: "Elbow Pad", blurb: "A quick roller-derby elbow.", windup: 0.05, cooldown: 0.29, effects: [{ kind: "melee", range: 1.55, arc: 1.5, hit: { damage: 6.5, knock: 8.8 } }], botRange: 1.5 },
    {
      id: "jam", name: "Jam Dash", blurb: "Skates through everyone in the way and leaves an ice trail.", windup: 0.06, cooldown: 3.5, moveScale: 1,
      effects: [{
        kind: "dash", speed: 20, time: 0.3, hit: { damage: 9.5, knock: 13.8 }, props: 12,
        trail: { look: "ice", radius: 0.85, life: 4.5, every: 0.045, slick: true, status: [{ kind: "slide", time: 0.35 }] },
      }],
      botRange: 5.2,
    },
    {
      id: "rink", name: "Ice Rink", blurb: "Freezes the floor around her, blasts nearby foes back, and skates faster.", windup: 0.12, cooldown: 5.5,
      effects: [
        { kind: "burst", look: "ice", at: "self", radius: 2.7, hit: { damage: 8, knock: 11.8 }, props: 10 },
        { kind: "zone", look: "ice", at: "self", radius: 3.6, life: 5.5, slick: true, status: [{ kind: "slide", time: 0.35 }] },
        { kind: "status", status: [{ kind: "haste", time: 3.8, amount: 0.4 }] },
      ],
      botRange: 2.6,
    },
    DODGE,
  ],
}
