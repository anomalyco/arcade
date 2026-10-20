import { mix32 } from "../specials/kinds"

/**
 * Who one of the dead is, read from its seed alone (so every client agrees and nothing goes on the wire). A seed that
 * is re-picked (a special's kind, a habit's calling) is a new person. Traits are 0..1 unless noted.
 *
 * The sim reads the first block (they change what a zombie does); the client reads the gait block for its walk.
 */
export type ZombiePersonality = {
  /** Stops and turns to faint sounds; goes to look at windows and light. */
  curiosity: number
  /** Searches longer and further before it gives up on you. */
  persistence: number
  /** Follows other dead that noticed something; drifts in herds at night. */
  sociability: number
  /** Drawn to bodies and slow to leave them. */
  hunger: number
  /** How readily it goes still by day. */
  torpor: number
  /** 0 long dead (hunched, slow, dragging), 1 freshly turned (upright, longer stride). */
  freshness: number
  /** Where it rests by day: 0 sits, 1 slumps against something, 2 stands swaying. */
  restPose: 0 | 1 | 2
  /** Leads a herd rather than following (top quarter). */
  leader: boolean
  /** Seconds it takes to react to another zombie or a sound (0.25..1.2). */
  reaction: number
  // Gait (presentation)
  /** Steps per minute at a walk (the 100STYLE zombie walks ~86; 72..102 here). */
  cadence: number
  /** Stride length multiplier (0.82..1.14). */
  stride: number
  /** Arms held out in front, 0 hanging .. 1 reaching level (100STYLE zombie holds them out). */
  armsOut: number
  /** Forward hunch, radians (0.05..0.42). */
  hunch: number
  /** Sideways lean, radians (−0.14..0.14). */
  lean: number
  /** −1 limps on the left, 1 on the right, 0 walks even. */
  limpSide: -1 | 0 | 1
  /** Head bob and loll, 0..1. */
  headLoll: number
  /** 0 picks its feet up, 1 shuffles them along the ground. */
  shuffle: number
}

const u = (seed: number, salt: number) => mix32((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0) / 4294967296

export function zombiePersonality(seed: number, out?: ZombiePersonality): ZombiePersonality {
  const s = seed >>> 0
  const freshness = u(s, 11)
  const decay = 1 - freshness
  const limpRoll = u(s, 19)
  const p = out ?? ({} as ZombiePersonality)
  p.curiosity = u(s, 1)
  p.persistence = u(s, 2)
  p.sociability = u(s, 3)
  p.hunger = u(s, 4)
  p.torpor = u(s, 5)
  p.freshness = freshness
  const rest = u(s, 6)
  p.restPose = rest < 0.38 ? 0 : rest < 0.7 ? 1 : 2
  p.leader = u(s, 7) < 0.25
  p.reaction = 0.25 + 0.95 * u(s, 8)
  p.cadence = 72 + 30 * (0.55 * freshness + 0.45 * u(s, 12))
  p.stride = 0.82 + 0.32 * (0.6 * freshness + 0.4 * u(s, 13))
  p.armsOut = Math.min(1, 0.25 + 0.85 * u(s, 14))
  p.hunch = 0.05 + 0.37 * (0.6 * decay + 0.4 * u(s, 15))
  p.lean = (u(s, 16) - 0.5) * 0.28
  p.limpSide = limpRoll < 0.18 ? -1 : limpRoll > 0.82 ? 1 : 0
  p.headLoll = u(s, 17) * (0.4 + 0.6 * decay)
  p.shuffle = Math.min(1, 0.7 * decay + 0.3 * u(s, 18))
  return p
}
