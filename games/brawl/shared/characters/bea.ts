import { type CharacterDef, DODGE } from "./types"

/** A daytime talk-show host. Everyone in the audience gets a bee. */
export const bea: CharacterDef = {
  id: "bea",
  name: "Bea Buzzby",
  title: "Talk-show host",
  tagline: "You get a bee! And you get a bee!",
  color: [1, 0.78, 0.18],
  speed: 4.4,
  accel: 1,
  weight: 1,
  abilities: [
    { id: "mic", name: "Mic Drop", blurb: "A swing of the microphone.", windup: 0.12, cooldown: 0.45, recover: 0.1, effects: [{ kind: "melee", range: 1.45, arc: 1.5, hit: { damage: 6, knock: 6.5 } }], botRange: 1.4 },
    {
      id: "bees", name: "You Get a Bee!", blurb: "A swarm that chases the nearest guest. Smoke scatters it.", windup: 0.3, cooldown: 7, range: 8,
      effects: [{ kind: "swarm", look: "bees", count: 14, speed: 5.6, turn: 4.5, life: 6.5, radius: 1.1, seek: 10, every: 0.3, hit: { damage: 2.2, knock: 1.6, status: [{ kind: "slow", time: 0.5, amount: 0.3 }] } }],
      botRange: 9,
    },
    {
      id: "ovation", name: "Standing Ovation", blurb: "Applause that blows everyone back.", windup: 0.35, cooldown: 6, moveScale: 0.2,
      effects: [{ kind: "burst", look: "applause", at: "self", radius: 3.2, hit: { damage: 8, knock: 13 }, props: 11 }],
      botRange: 2.6,
    },
    DODGE,
  ],
}
