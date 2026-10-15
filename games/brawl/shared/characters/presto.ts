import { type CharacterDef, DODGE } from "./types"

/** A stage magician who is never quite where you think. */
export const presto: CharacterDef = {
  id: "presto",
  name: "The Great Presto",
  title: "Stage magician",
  tagline: "Is this your card?",
  color: [0.62, 0.32, 1],
  speed: 6.2,
  accel: 1.15,
  weight: 0.9,
  abilities: [
    { id: "cards", name: "Card Fan", blurb: "Three razor playing cards, thrown in a fast fan.", windup: 0.06, cooldown: 0.42, effects: [{ kind: "projectile", look: "card", speed: 24, radius: 0.25, range: 10.5, count: 3, spread: 0.13, hit: { damage: 4, knock: 5.2 }, props: 4 }], botRange: 7.5 },
    {
      id: "switch", name: "Switcheroo", blurb: "A glowing card; whoever it hits trades places with you.", windup: 0.12, cooldown: 4.5,
      effects: [{ kind: "projectile", look: "switch", speed: 21, radius: 0.38, range: 12, hit: { damage: 6, knock: 4, status: [{ kind: "stun", time: 0.5 }] }, onHit: [{ kind: "swap" }] }],
      botRange: 10,
    },
    {
      id: "vanish", name: "Now You See Me", blurb: "Leaves a decoy and vanishes toward the cursor.", windup: 0.03, cooldown: 4.8, range: 6.5,
      effects: [{ kind: "decoy", life: 4 }, { kind: "blink", range: 6.5 }],
      botRange: 3.2,
    },
    DODGE,
  ],
}
