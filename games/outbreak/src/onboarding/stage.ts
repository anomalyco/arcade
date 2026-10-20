import { TRAINING_DRESSER, TRAINING_FRONT_DOOR, TRAINING_ROOM_DOOR, TRAINING_START } from "../../shared/onboarding/training"
import type { LocalSession } from "../../shared/session"
import { BEATS, type BeatId, type TrainingGuide } from "./beats"

/** Where to stand for each beat (x, y, aim), for the Lab station and stills. */
export const BEAT_SPOTS: Readonly<Record<BeatId, readonly [number, number, number]>> = {
  move: [TRAINING_START.x, TRAINING_START.y, TRAINING_START.aim],
  light: [28.4, 27.2, -0.4],
  search: [29.4, 27.6, -Math.PI / 2],
  take: [29.3, 25.95, -Math.PI / 2],
  craft: [30.2, 27.4, -Math.PI / 4],
  "door-open": [27.0, 27.6, Math.PI / 2],
  "door-close": [27.7, 30.35, -Math.PI / 2],
  crouch: [33.6, 30.8, 0],
  board: [35.9, 30.2, 0],
  sprint: [33, 33.4, Math.PI],
  "front-door": [27.7, 33.4, Math.PI / 2],
  melee: [29.0, 37.6, 0.35],
}

/**
 * Jumps the training room to `beat`: every beat before it done (the world as if you had done them) and the survivor at
 * its spot. Offline training sessions only.
 */
export function stageBeat(session: LocalSession, guide: TrainingGuide, beat: BeatId): void {
  const sim = session.sim
  const p = session.view.player
  const ledger = sim.progression.ledger
  const id = session.view.actorId
  const before = BEATS.slice(0, BEATS.indexOf(beat))
  const did = (b: BeatId) => before.includes(b)
  guide.done.clear()
  for (const b of before) guide.done.add(b)
  if (did("light")) p.flashlightOn = true
  const dresser = ledger.store(TRAINING_DRESSER)
  if (dresser && did("search")) dresser.revealed = true
  if (did("take") && dresser) {
    for (let i = 0; i < dresser.slots.length; i++) {
      const s = dresser.slots[i]
      if (s) ledger.apply({ kind: "take", actor: id, from: dresser.id, slot: i })
    }
  }
  if (did("craft") && ledger.count(id, "bandage") <= 0) ledger.apply({ kind: "grant", actor: id, item: "bandage", count: 1 })
  const door = (d: string) => sim.town.doors.find((o) => o.id === d)
  const room = door(TRAINING_ROOM_DOOR)
  if (room) room.open = did("door-open") && !did("door-close")
  if (did("board") && sim.ai.getBarricadePlanks("ash-east") === 0 && ledger.count(id, "plank") > 0) {
    sim.ai.addBarricadePlank("ash-east")
  }
  const front = door(TRAINING_FRONT_DOOR)
  if (front) front.open = did("front-door")
  const [x, y, aim] = BEAT_SPOTS[beat]
  Object.assign(p, { x, y, aim, vx: 0, vy: 0 })
  session.rebuildCollision()
}
