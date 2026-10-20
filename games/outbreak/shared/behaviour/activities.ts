/**
 * What one of the dead is doing beyond its AI state, as one small code that goes on the wire (`net.ts`) and drives
 * its pose on every client. 0 is "nothing special": the crowd's own state says it all.
 *
 * Other features read these as hooks (`zombieActivity` in `mind.ts`): `noticed` (LISTEN), `searching` (SNIFF, PEER,
 * SEEK) and `lost interest` (GIVE_UP).
 */
export const ACT_NONE = 0
/** Heard something: stops, turns to it and listens ("noticed"). */
export const ACT_LISTEN = 1
/** Goes where it last had you, or where you were heading ("searching"). */
export const ACT_SEEK = 2
/** Bent over, sniffing the ground where the trail went cold ("searching"). */
export const ACT_SNIFF = 3
/** At a window or doorway of the house it saw you go into, looking in ("searching"). */
export const ACT_PEER = 4
/** Gives up on you: a slow turn away ("lost interest"). */
export const ACT_GIVE_UP = 5
/** Copies another zombie that noticed something. */
export const ACT_FOLLOW = 6
/** Day rest: sitting on the ground. */
export const ACT_REST_SIT = 7
/** Day rest: slumped against a wall or car. */
export const ACT_REST_SLUMP = 8
/** Day rest: standing still, swaying. */
export const ACT_REST_STAND = 9
/** Getting up from rest. */
export const ACT_ROUSE = 10
/** Crouched over a body, feeding. */
export const ACT_FEED = 11
/** Climbing over a fence. */
export const ACT_CLIMB_FENCE = 12
/** Clambering over a car's bonnet. */
export const ACT_CLIMB_CAR = 13
/** Caught on the fence it was climbing. */
export const ACT_SNAGGED = 14
/** Flinching from a torch beam in its face. */
export const ACT_FLINCH = 15
/** Frozen by a lightning flash, looking up. */
export const ACT_FREEZE = 16
/** A shambler's pause: stands and sways a moment. */
export const ACT_PAUSE = 17
/** Walking in a night herd. */
export const ACT_HERD = 18
/** Drawn to a light at night. */
export const ACT_LIGHT = 19
/** Shouldered off a body by another feeder. */
export const ACT_JOSTLED = 20

export const ACTIVITY_NAMES = [
  "none",
  "listen",
  "seek",
  "sniff",
  "peer",
  "give up",
  "follow",
  "rest (sit)",
  "rest (slump)",
  "rest (stand)",
  "rouse",
  "feed",
  "climb fence",
  "climb car",
  "snagged",
  "flinch",
  "freeze",
  "pause",
  "herd",
  "light",
  "jostled",
] as const

export const ACTIVITY_COUNT = ACTIVITY_NAMES.length

export const isResting = (act: number) => act === ACT_REST_SIT || act === ACT_REST_SLUMP || act === ACT_REST_STAND
export const isClimbing = (act: number) => act === ACT_CLIMB_FENCE || act === ACT_CLIMB_CAR || act === ACT_SNAGGED

/** Activities that keep a zombie where it stands this tick (it can still turn, and still attack if it must). */
export const holdsStill = (act: number) =>
  act === ACT_LISTEN ||
  act === ACT_SNIFF ||
  act === ACT_PEER ||
  act === ACT_GIVE_UP ||
  isResting(act) ||
  act === ACT_ROUSE ||
  act === ACT_FEED ||
  act === ACT_FREEZE ||
  act === ACT_PAUSE

/** The hook names other features use (`zombieAttention`). */
export type ZombieAttention = "none" | "noticed" | "searching" | "lost interest" | "resting" | "feeding" | "following"

export function attentionOf(act: number): ZombieAttention {
  if (act === ACT_LISTEN) return "noticed"
  if (act === ACT_SEEK || act === ACT_SNIFF || act === ACT_PEER) return "searching"
  if (act === ACT_GIVE_UP) return "lost interest"
  if (isResting(act) || act === ACT_ROUSE) return "resting"
  if (act === ACT_FEED || act === ACT_JOSTLED) return "feeding"
  if (act === ACT_FOLLOW || act === ACT_HERD) return "following"
  return "none"
}
