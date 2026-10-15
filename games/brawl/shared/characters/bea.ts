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
    { id: "mic", name: "Mic Drop", blurb: "A fast swing of the microphone.", windup: 0.07, cooldown: 0.34, recover: 0.06, effects: [{ kind: "melee", range: 1.65, arc: 1.6, hit: { damage: 7, knock: 8.5 } }], botRange: 1.6 },
    {
      id: "bees", name: "You Get a Bee!", blurb: "A swarm that chases the nearest guest. Smoke scatters it.", windup: 0.16, cooldown: 5, range: 9,
      effects: [{ kind: "swarm", look: "bees", count: 14, speed: 7.4, turn: 6.0, life: 6, radius: 1.15, seek: 11, every: 0.25, hit: { damage: 2.6, knock: 2.4, status: [{ kind: "slow", time: 0.5, amount: 0.3 }] } }],
      botRange: 8,
    },
    {
      id: "ovation", name: "Standing Ovation", blurb: "Applause that blows everyone back.", windup: 0.18, cooldown: 4.5, moveScale: 0.55,
      effects: [{ kind: "burst", look: "applause", at: "self", radius: 3.4, hit: { damage: 10, knock: 14.5 }, props: 13 }],
      botRange: 2.8,
    },
    DODGE,
  ],
}
