import { type CharacterDef, DODGE } from "./types"

/** A masked heavyweight wrestler. Picks up anything, throws it at anyone. */
export const slab: CharacterDef = {
  id: "slab",
  name: "Big Slab",
  title: "Masked wrestler",
  tagline: "Ring's too small for both of us.",
  color: [0.95, 0.16, 0.2],
  speed: 5.38,
  accel: 0.97,
  weight: 1.44,
  abilities: [
    { id: "chop", name: "Chop", blurb: "A heavy ring-shaking chop.", windup: 0.1, cooldown: 0.42, recover: 0.06, effects: [{ kind: "melee", range: 1.84, arc: 1.54, hit: { damage: 10.0, knock: 11.4 }, props: 12 }], botRange: 1.74 },
    {
      id: "slam", name: "Body Slam", blurb: "Grabs the nearest fighter, crate or barrel and hurls it.", windup: 0.08, cooldown: 3.45,
      effects: [{ kind: "grab", range: 1.94, arc: 1.9, hold: 0.45, throwSpeed: 20, hit: { damage: 13.2, knock: 18.4 } }],
      botRange: 1.84,
    },
    {
      id: "elbow", name: "Flying Elbow", blurb: "Leaps forward and lands with a shockwave.", windup: 0.11, cooldown: 4.6, moveScale: 1,
      effects: [{ kind: "dash", speed: 14.9, time: 0.34, props: 10, then: [{ kind: "burst", look: "slam", at: "here", radius: 2.88, hit: { damage: 12.2, knock: 15.5 }, props: 15 }] }],
      botRange: 4.75,
    },
    DODGE,
  ],
}
