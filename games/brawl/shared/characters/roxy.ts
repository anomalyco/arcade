import { type CharacterDef, DODGE } from "./types"

/** A roller-derby jammer. Fast, slippery, impossible to pin down. */
export const roxy: CharacterDef = {
  id: "roxy",
  name: "Roxy Rollers",
  title: "Roller-derby jammer",
  tagline: "Out of my lane!",
  color: [1, 0.3, 0.68],
  speed: 5.4,
  accel: 0.55,
  weight: 0.85,
  abilities: [
    { id: "elbow", name: "Elbow Pad", blurb: "A quick elbow.", windup: 0.08, cooldown: 0.35, effects: [{ kind: "melee", range: 1.3, arc: 1.3, hit: { damage: 4.5, knock: 6 } }], botRange: 1.3 },
    {
      id: "jam", name: "Jam Dash", blurb: "Skates through everyone in the way and leaves an ice trail.", windup: 0.1, cooldown: 5, moveScale: 1,
      effects: [{
        kind: "dash", speed: 17, time: 0.36, hit: { damage: 8, knock: 12 }, props: 11,
        trail: { look: "ice", radius: 0.85, life: 5, every: 0.045, slick: true, status: [{ kind: "slide", time: 0.35 }] },
      }],
      botRange: 5,
    },
    {
      id: "rink", name: "Ice Rink", blurb: "Freezes the floor around her and skates faster for a while.", windup: 0.25, cooldown: 10,
      effects: [
        { kind: "zone", look: "ice", at: "self", radius: 3.6, life: 6, slick: true, status: [{ kind: "slide", time: 0.35 }] },
        { kind: "status", status: [{ kind: "haste", time: 3.5, amount: 0.35 }] },
      ],
      botRange: 3,
    },
    DODGE,
  ],
}
