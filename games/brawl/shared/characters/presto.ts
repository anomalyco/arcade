import { type CharacterDef, DODGE } from "./types"

/** A stage magician who is never quite where you think. */
export const presto: CharacterDef = {
  id: "presto",
  name: "The Great Presto",
  title: "Stage magician",
  tagline: "Is this your card?",
  color: [0.62, 0.32, 1],
  speed: 4.5,
  accel: 1.1,
  weight: 0.9,
  abilities: [
    { id: "cards", name: "Card Fan", blurb: "Three playing cards, thrown in a fan.", windup: 0.1, cooldown: 0.6, effects: [{ kind: "projectile", look: "card", speed: 19, radius: 0.22, range: 10, count: 3, spread: 0.13, hit: { damage: 3, knock: 3.5 }, props: 2 }], botRange: 8 },
    {
      id: "switch", name: "Switcheroo", blurb: "A glowing card; whoever it hits trades places with you.", windup: 0.2, cooldown: 6,
      effects: [{ kind: "projectile", look: "switch", speed: 16, radius: 0.35, range: 12, hit: { damage: 4, knock: 2, status: [{ kind: "stun", time: 0.45 }] }, onHit: [{ kind: "swap" }] }],
      botRange: 11,
    },
    {
      id: "vanish", name: "Now You See Me", blurb: "Leaves a decoy and vanishes a few steps toward the cursor.", windup: 0.05, cooldown: 7, range: 6,
      effects: [{ kind: "decoy", life: 4 }, { kind: "blink", range: 6 }],
      botRange: 3,
    },
    DODGE,
  ],
}
