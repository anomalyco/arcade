// Tasks: a room with a start line at x = 0 and a goal on the far side, plus what stands in between.

import { mulberry32 } from "@arcade/kit/sim/rng"

export type TaskId = "room" | "wall" | "steps" | "rough"

export type TaskDef = {
  id: TaskId
  label: string
  blurb: string
  /** Goal line (m from the start). */
  goal: number
  /** Ground polyline, x non-decreasing; the room's back and front walls are the ends. */
  points: [number, number][]
}

const ROOM_LEFT = -3
const GOAL = 16
const ROOM_RIGHT = GOAL + 4
const WALL_H = 3

function room(middle: [number, number][] = []): [number, number][] {
  return [
    [ROOM_LEFT - 0.5, WALL_H],
    [ROOM_LEFT, WALL_H],
    [ROOM_LEFT, 0],
    ...middle,
    [ROOM_RIGHT, 0],
    [ROOM_RIGHT, WALL_H],
    [ROOM_RIGHT + 0.5, WALL_H],
  ]
}

function block(x: number, w: number, h: number): [number, number][] {
  return [[x, 0], [x, h], [x + w, h], [x + w, 0]]
}

function wall(): [number, number][] {
  return [...block(3, 0.3, 0.14), ...block(7, 0.3, 0.22), ...block(11.5, 0.3, 0.3)]
}

function steps(): [number, number][] {
  const out: [number, number][] = []
  let h = 0
  for (let i = 0; i < 8; i++) {
    const x = 2.5 + i * 0.9
    out.push([x, h])
    h += 0.07
    out.push([x, h])
  }
  out.push([2.5 + 8 * 0.9 + 1.2, h])
  for (let i = 0; i < 8; i++) {
    const x = 2.5 + 8 * 0.9 + 1.2 + i * 0.9
    out.push([x, h])
    h -= 0.07
    out.push([x, h])
  }
  return out
}

function rough(): [number, number][] {
  const rand = mulberry32(7)
  const out: [number, number][] = [[1.5, 0]]
  let h = 0
  for (let x = 2; x < GOAL + 1.5; x += 0.5) {
    h = Math.max(0, Math.min(0.35, h + (rand() - 0.5) * 0.16))
    out.push([x, Math.round(h * 1000) / 1000])
  }
  out.push([GOAL + 2, 0])
  return out
}

export const TASKS: Record<TaskId, TaskDef> = {
  room: { id: "room", label: "Cross the room", blurb: "Flat floor, get to the far side.", goal: GOAL, points: room() },
  wall: { id: "wall", label: "Low walls", blurb: "Three walls, 14, 22 and 30 cm tall.", goal: GOAL, points: room(wall()) },
  steps: { id: "steps", label: "Steps", blurb: "Up eight 7 cm steps and back down.", goal: GOAL, points: room(steps()) },
  rough: { id: "rough", label: "Rough ground", blurb: "Bumpy floor, up to 35 cm high.", goal: GOAL, points: room(rough()) },
}
export const TASK_IDS = Object.keys(TASKS) as TaskId[]
export const ROOM = { left: ROOM_LEFT, right: ROOM_RIGHT, height: WALL_H }
