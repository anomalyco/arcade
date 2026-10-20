// Tasks and the environment settings that pick a level. A saved policy keeps its Env so its replay rebuilds the room.

import { courseLevel, heistLevel, humanHeistLevel, roomLevel, roughLevel, stepsLevel, wallLevel, type Level } from "./level"

export type TaskId = "room" | "wall" | "steps" | "rough" | "course" | "heist"

export type Env = {
  human?: boolean
  task: TaskId
  /** Obstacle-course seed. */
  seed: number
  /** Heist curriculum stage (0 = no lasers … 4 = full heist). */
  stage: number
  /** Heist laser speed multiplier. */
  laserSpeed: number
  /** Heist: extra pulsing beams on the way out (0 in training; a knob for trying a policy on a harder vault). */
  extra: number
}

export type TaskDef = { id: TaskId; label: string; blurb: string }

export const TASKS: Record<TaskId, TaskDef> = {
  room: { id: "room", label: "Cross the room", blurb: "Flat floor, get to the far side." },
  wall: { id: "wall", label: "Low walls", blurb: "Three walls, 14, 22 and 30 cm tall." },
  steps: { id: "steps", label: "Steps", blurb: "Up eight 7 cm steps and back down." },
  rough: { id: "rough", label: "Rough ground", blurb: "Bumpy floor, up to 35 cm high." },
  course: { id: "course", label: "Obstacle course", blurb: "Seeded run of steps, ramps, gaps, hurdles, low ceilings, crates, seesaws and moving platforms." },
  heist: { id: "heist", label: "Heist", blurb: "Through the vent, past the lasers, grab the gem, out the door." },
}
export const TASK_IDS = Object.keys(TASKS) as TaskId[]

export const envFor = (task: TaskId, over: Partial<Env> = {}): Env => ({ task, seed: 1, stage: 0, laserSpeed: 1, extra: 0, ...over })
export const envKey = (e: Env): string => `${e.human ? "human:" : ""}${e.task}:${e.task === "course" ? e.seed : 0}:${e.task === "heist" ? `${e.stage}:${e.laserSpeed}:${e.extra}` : ""}`

const cache = new Map<string, Level>()
export function levelFor(e: Env): Level {
  const key = envKey(e)
  let lv = cache.get(key)
  if (!lv) {
    lv =
      e.task === "room" ? roomLevel()
      : e.task === "wall" ? wallLevel()
      : e.task === "steps" ? stepsLevel()
      : e.task === "rough" ? roughLevel()
      : e.task === "course" ? courseLevel(e.seed)
       : (e.human ? humanHeistLevel : heistLevel)({ stage: e.stage, laserSpeed: e.laserSpeed, extra: e.extra })
    cache.set(key, lv)
  }
  return lv
}

/** The biped is too tall for the course's low ceilings and the heist vent. */
export const fits = (creature: string, task: TaskId): boolean => !(creature === "biped" && (task === "heist" || task === "course"))
