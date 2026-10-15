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
    { id: "ladle", name: "Ladle Whack", blurb: "A heavy swing of the iron ladle.", windup: 0.09, cooldown: 0.4, recover: 0.06, effects: [{ kind: "melee", range: 1.7, arc: 1.65, hit: { damage: 8, knock: 9.0 } }], botRange: 1.6 },
    {
      id: "pan", name: "Hot Pan", blurb: "A sizzling pan that leaves a grease slick where it lands.", windup: 0.12, cooldown: 3.5,
      effects: [{
        kind: "projectile", look: "pan", speed: 18.5, radius: 0.42, range: 11, hit: { damage: 10, knock: 12 }, props: 11,
        onEnd: [{ kind: "zone", look: "grease", at: "here", radius: 2.0, life: 6.5, slick: true, status: [{ kind: "slide", time: 0.35 }] }],
      }],
      botRange: 8.5,
    },
    {
      id: "flambe", name: "Flambé", blurb: "A burst of fire ahead, and a cloud of smoke that scatters bees.", windup: 0.16, cooldown: 5.5,
      effects: [
        { kind: "burst", look: "fire", offset: 1.8, radius: 2.2, hit: { damage: 12, knock: 13.5 }, props: 12 },
        { kind: "zone", look: "smoke", radius: 2.8, life: 4.5, smoke: true, self: true, status: [{ kind: "slow", time: 0.2, amount: 0.15 }] },
      ],
      botRange: 2.8,
    },
    DODGE,
  ],
}
