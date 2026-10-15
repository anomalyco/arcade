import { type CharacterDef, DODGE } from "./types"

/** A temperamental chef. The kitchen is the whole arena. */
export const chef: CharacterDef = {
  id: "chef",
  name: "Chef Flambé",
  title: "Celebrity chef",
  tagline: "Yes, chef!",
  color: [1, 0.42, 0.16],
  speed: 4.1,
  accel: 0.95,
  weight: 1.15,
  abilities: [
    { id: "ladle", name: "Ladle Whack", blurb: "A big swing of the ladle.", windup: 0.15, cooldown: 0.55, recover: 0.1, effects: [{ kind: "melee", range: 1.55, arc: 1.6, hit: { damage: 7, knock: 7 } }], botRange: 1.5 },
    {
      id: "pan", name: "Hot Pan", blurb: "A sizzling pan that leaves a grease slick where it lands.", windup: 0.2, cooldown: 4.5,
      effects: [{
        kind: "projectile", look: "pan", speed: 14, radius: 0.38, range: 11, hit: { damage: 9, knock: 10 }, props: 9,
        onEnd: [{ kind: "zone", look: "grease", at: "here", radius: 1.9, life: 7, slick: true, status: [{ kind: "slide", time: 0.35 }] }],
      }],
      botRange: 9,
    },
    {
      id: "flambe", name: "Flambé", blurb: "A burst of fire ahead, and a cloud of smoke that scatters bees.", windup: 0.3, cooldown: 8,
      effects: [
        { kind: "burst", look: "fire", offset: 1.8, radius: 1.9, hit: { damage: 10, knock: 11 }, props: 10 },
        { kind: "zone", look: "smoke", radius: 2.8, life: 4.5, smoke: true, self: true, status: [{ kind: "slow", time: 0.2, amount: 0.15 }] },
      ],
      botRange: 2.8,
    },
    DODGE,
  ],
}
