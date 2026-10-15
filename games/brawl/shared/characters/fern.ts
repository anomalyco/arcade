import { type CharacterDef, DODGE } from "./types"

/** A retired gardener with very aggressive plants. */
export const fern: CharacterDef = {
  id: "fern",
  name: "Granny Fern",
  title: "Gardener",
  tagline: "Off my lawn.",
  color: [0.38, 0.85, 0.32],
  speed: 5.75,
  accel: 1.07,
  weight: 1.0,
  abilities: [
    { id: "snip", name: "Shears Snip", blurb: "A crisp snip of the garden shears.", windup: 0.06, cooldown: 0.35, effects: [{ kind: "melee", range: 1.7, arc: 1.52, hit: { damage: 7.8, knock: 9.6 } }], botRange: 1.62 },
    {
      id: "vines", name: "Creeping Vines", blurb: "Vines race along the floor and root everyone they touch.", windup: 0.13, cooldown: 4.0,
      effects: [{ kind: "projectile", look: "vine", speed: 17.5, radius: 0.6, range: 10.5, pierce: true, hit: { damage: 7.5, knock: 7.5, status: [{ kind: "root", time: 1.25 }] } }],
      botRange: 8.5,
    },
    {
      id: "bramble", name: "Bramble Patch", blurb: "Lobs seeds that sprout into a thorny patch that slows and stings.", windup: 0.14, cooldown: 5.2, range: 9.5,
      effects: [{
        kind: "projectile", look: "seed", speed: 15.5, radius: 0.35, range: 9.5, lob: true,
        onEnd: [
          { kind: "burst", look: "vines", at: "here", radius: 2.4, hit: { damage: 7.0, knock: 9.8 }, props: 8 },
          { kind: "zone", look: "vines", at: "here", radius: 2.5, life: 5.0, every: 0.45, tick: { damage: 3.4, knock: 4.0 }, status: [{ kind: "slow", time: 0.35, amount: 0.5 }] },
        ],
      }],
      botRange: 8,
    },
    DODGE,
  ],
}
