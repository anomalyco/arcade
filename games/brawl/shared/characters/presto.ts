import { type CharacterDef, DODGE } from "./types"

/** A stage magician who is never quite where you think. */
export const presto: CharacterDef = {
  id: "presto",
  name: "The Great Presto",
  title: "Stage magician",
  tagline: "Is this your card?",
  color: [0.62, 0.32, 1],
  speed: 6.1,
  accel: 1.12,
  weight: 0.94,
  abilities: [
    { id: "cards", name: "Card Fan", blurb: "Three razor playing cards, thrown in a fast fan.", windup: 0.07, cooldown: 0.45, effects: [{ kind: "projectile", look: "card", speed: 22.5, radius: 0.24, range: 9.0, count: 3, spread: 0.19, hit: { damage: 3.4, knock: 4.92 }, props: 4 }], botRange: 6.2 },
    {
      id: "switch", name: "Switcheroo", blurb: "A glowing card; whoever it hits trades places with you.", windup: 0.12, cooldown: 4.8,
      effects: [{ kind: "projectile", look: "switch", speed: 20.5, radius: 0.36, range: 11, hit: { damage: 6, knock: 4.8, status: [{ kind: "stun", time: 0.45 }] }, onHit: [{ kind: "swap" }] }],
      botRange: 9.0,
    },
    {
      id: "vanish", name: "Now You See Me", blurb: "Leaves a decoy with a stage-flash blast and vanishes toward the cursor.", windup: 0.04, cooldown: 4.8, range: 6.2,
      effects: [
        { kind: "decoy", life: 3.8 },
        { kind: "burst", look: "smoke", at: "self", radius: 2.4, hit: { damage: 8, knock: 12.0 }, props: 8 },
        { kind: "blink", range: 6.2 },
      ],
      botRange: 3.0,
    },
    DODGE,
  ],
}
