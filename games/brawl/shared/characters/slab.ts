import { type CharacterDef, DODGE } from "./types"

/** A masked heavyweight wrestler. Picks up anything, throws it at anyone. */
export const slab: CharacterDef = {
  id: "slab",
  name: "Big Slab",
  title: "Masked wrestler",
  tagline: "Ring's too small for both of us.",
  color: [0.95, 0.16, 0.2],
  speed: 5.3,
  accel: 0.95,
  weight: 1.45,
  abilities: [
    { id: "chop", name: "Chop", blurb: "A heavy ring-shaking chop.", windup: 0.13, cooldown: 0.48, recover: 0.07, effects: [{ kind: "melee", range: 1.8, arc: 1.5, hit: { damage: 10, knock: 11 }, props: 12 }], botRange: 1.7 },
    {
      id: "slam", name: "Body Slam", blurb: "Grabs the nearest fighter, crate or barrel and hurls it.", windup: 0.09, cooldown: 3.6,
      effects: [{ kind: "grab", range: 1.9, arc: 1.9, hold: 0.45, throwSpeed: 20, hit: { damage: 13, knock: 18.5 } }],
      botRange: 1.8,
    },
    {
      id: "elbow", name: "Flying Elbow", blurb: "Leaps forward and lands with a shockwave.", windup: 0.12, cooldown: 5.0, moveScale: 1,
      effects: [{ kind: "dash", speed: 14.5, time: 0.34, props: 10, then: [{ kind: "burst", look: "slam", at: "here", radius: 2.8, hit: { damage: 12, knock: 15.5 }, props: 15 }] }],
      botRange: 4.5,
    },
    DODGE,
  ],
}
