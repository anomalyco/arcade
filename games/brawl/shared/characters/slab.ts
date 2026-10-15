import { type CharacterDef, DODGE } from "./types"

/** A masked heavyweight wrestler. Picks up anything, throws it at anyone. */
export const slab: CharacterDef = {
  id: "slab",
  name: "Big Slab",
  title: "Masked wrestler",
  tagline: "Ring's too small for both of us.",
  color: [0.95, 0.16, 0.2],
  speed: 3.8,
  accel: 0.85,
  weight: 1.55,
  abilities: [
    { id: "chop", name: "Chop", blurb: "A heavy chop.", windup: 0.22, cooldown: 0.7, recover: 0.12, effects: [{ kind: "melee", range: 1.65, arc: 1.4, hit: { damage: 9, knock: 9 }, props: 10 }], botRange: 1.6 },
    {
      id: "slam", name: "Body Slam", blurb: "Grabs the nearest fighter, crate or barrel and throws it.", windup: 0.15, cooldown: 4.5,
      effects: [{ kind: "grab", range: 1.7, arc: 1.8, hold: 0.65, throwSpeed: 17, hit: { damage: 12, knock: 17 } }],
      botRange: 1.6,
    },
    {
      id: "elbow", name: "Flying Elbow", blurb: "Leaps forward and lands with a shockwave.", windup: 0.2, cooldown: 7, moveScale: 1,
      effects: [{ kind: "dash", speed: 11, time: 0.38, props: 8, then: [{ kind: "burst", look: "slam", at: "here", radius: 2.6, hit: { damage: 11, knock: 14 }, props: 14 }] }],
      botRange: 4,
    },
    DODGE,
  ],
}
