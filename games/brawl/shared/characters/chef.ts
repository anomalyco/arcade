import { type CharacterDef, DODGE } from "./types"

/** A temperamental chef. The kitchen is the whole arena. */
export const chef: CharacterDef = {
  id: "chef",
  name: "Chef Flambé",
  title: "Celebrity chef",
  tagline: "Yes, chef!",
  color: [1, 0.42, 0.16],
  speed: 5.7,
  accel: 1.0,
  weight: 1.15,
  abilities: [
    { id: "ladle", name: "Ladle Whack", blurb: "A heavy swing of the iron ladle.", windup: 0.08, cooldown: 0.38, recover: 0.05, effects: [{ kind: "melee", range: 1.72, arc: 1.65, hit: { damage: 8.5, knock: 9.8 } }], botRange: 1.65 },
    {
      id: "pan", name: "Hot Pan", blurb: "A sizzling pan that leaves a grease slick where it lands.", windup: 0.11, cooldown: 3.3,
      effects: [{
        kind: "projectile", look: "pan", speed: 19, radius: 0.44, range: 11, hit: { damage: 10.5, knock: 12.5 }, props: 11,
        onEnd: [{ kind: "zone", look: "grease", at: "here", radius: 2.0, life: 6.5, slick: true, status: [{ kind: "slide", time: 0.35 }] }],
      }],
      botRange: 8.5,
    },
    {
      id: "flambe", name: "Flambé", blurb: "A burst of fire ahead, and a cloud of smoke that scatters bees.", windup: 0.14, cooldown: 5.0,
      effects: [
        { kind: "burst", look: "fire", offset: 1.8, radius: 2.3, hit: { damage: 12.5, knock: 14.2 }, props: 12 },
        { kind: "zone", look: "smoke", radius: 2.8, life: 4.5, smoke: true, self: true, status: [{ kind: "slow", time: 0.2, amount: 0.15 }] },
      ],
      botRange: 2.8,
    },
    DODGE,
  ],
}
