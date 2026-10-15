import { type CharacterDef, DODGE } from "./types"

/** A retired gardener with very aggressive plants. */
export const fern: CharacterDef = {
  id: "fern",
  name: "Granny Fern",
  title: "Gardener",
  tagline: "Off my lawn.",
  color: [0.38, 0.85, 0.32],
  speed: 5.6,
  accel: 1.05,
  weight: 0.95,
  abilities: [
    { id: "snip", name: "Shears Snip", blurb: "A crisp snip of the garden shears.", windup: 0.06, cooldown: 0.36, effects: [{ kind: "melee", range: 1.55, arc: 1.35, hit: { damage: 7, knock: 7.5 } }], botRange: 1.5 },
    {
      id: "vines", name: "Creeping Vines", blurb: "Vines race along the floor and root everyone they touch.", windup: 0.14, cooldown: 4.5,
      effects: [{ kind: "projectile", look: "vine", speed: 16, radius: 0.58, range: 10.5, pierce: true, hit: { damage: 6, knock: 3, status: [{ kind: "root", time: 1.25 }] } }],
      botRange: 8.5,
    },
    {
      id: "bramble", name: "Bramble Patch", blurb: "Lobs seeds that sprout into a thorny patch that slows and stings.", windup: 0.16, cooldown: 6.0, range: 9.5,
      effects: [{
        kind: "projectile", look: "seed", speed: 14, radius: 0.34, range: 9.5, lob: true,
        onEnd: [{ kind: "zone", look: "vines", at: "here", radius: 2.5, life: 5.5, every: 0.5, tick: { damage: 3, knock: 1.5 }, status: [{ kind: "slow", time: 0.3, amount: 0.55 }] }],
      }],
      botRange: 8,
    },
    DODGE,
  ],
}
