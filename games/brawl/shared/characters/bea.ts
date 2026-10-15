import { type CharacterDef, DODGE } from "./types"

/** A daytime talk-show host. Everyone in the audience gets a bee. */
export const bea: CharacterDef = {
  id: "bea",
  name: "Bea Buzzby",
  title: "Talk-show host",
  tagline: "You get a bee! And you get a bee!",
  color: [1, 0.78, 0.18],
  speed: 6.0,
  accel: 1.05,
  weight: 1,
  abilities: [
    { id: "mic", name: "Mic Drop", blurb: "A fast swing of the microphone.", windup: 0.07, cooldown: 0.33, recover: 0.05, effects: [{ kind: "melee", range: 1.66, arc: 1.6, hit: { damage: 7.4, knock: 9.05 } }], botRange: 1.6 },
    {
      id: "bees", name: "You Get a Bee!", blurb: "A swarm that chases the nearest guest. Smoke scatters it.", windup: 0.15, cooldown: 4.8, range: 9,
      effects: [{ kind: "swarm", look: "bees", count: 14, speed: 7.6, turn: 6.2, life: 6, radius: 1.18, seek: 11, every: 0.24, hit: { damage: 3.0, knock: 3.2, status: [{ kind: "slow", time: 0.5, amount: 0.3 }] } }],
      botRange: 8,
    },
    {
      id: "ovation", name: "Standing Ovation", blurb: "Applause that blows everyone back.", windup: 0.17, cooldown: 4.4, moveScale: 0.6,
      effects: [{ kind: "burst", look: "applause", at: "self", radius: 3.4, hit: { damage: 10.5, knock: 14.6 }, props: 13 }],
      botRange: 2.8,
    },
    DODGE,
  ],
}
