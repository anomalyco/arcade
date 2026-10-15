import { type CharacterDef, DODGE } from "./types"

/** A retired gardener with very aggressive plants. */
export const fern: CharacterDef = {
  id: "fern",
  name: "Granny Fern",
  title: "Gardener",
  tagline: "Off my lawn.",
  color: [0.38, 0.85, 0.32],
  speed: 4.0,
  accel: 1,
  weight: 0.95,
  abilities: [
    { id: "snip", name: "Shears Snip", blurb: "A snip of the garden shears.", windup: 0.1, cooldown: 0.5, effects: [{ kind: "melee", range: 1.4, arc: 1.2, hit: { damage: 6, knock: 5.5 } }], botRange: 1.4 },
    {
      id: "vines", name: "Creeping Vines", blurb: "Vines race along the floor and root everyone they touch.", windup: 0.25, cooldown: 6,
      effects: [{ kind: "projectile", look: "vine", speed: 11, radius: 0.55, range: 10, pierce: true, hit: { damage: 4, knock: 1, status: [{ kind: "root", time: 1.3 }] } }],
      botRange: 9,
    },
    {
      id: "bramble", name: "Bramble Patch", blurb: "Lobs seeds that sprout into a thorny patch that slows and stings.", windup: 0.3, cooldown: 9, range: 9,
      effects: [{
        kind: "projectile", look: "seed", speed: 10, radius: 0.3, range: 9, lob: true,
        onEnd: [{ kind: "zone", look: "vines", at: "here", radius: 2.4, life: 6, every: 0.6, tick: { damage: 2, knock: 0.5 }, status: [{ kind: "slow", time: 0.3, amount: 0.55 }] }],
      }],
      botRange: 8,
    },
    DODGE,
  ],
}
