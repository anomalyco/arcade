import { expect, test } from "bun:test"
import { MotionHistory, MotionKeys } from "../src/render/motion"

test("previous transforms follow owner/part identity when batches reorder or a part disappears", () => {
  const keys = new MotionKeys(), history = new MotionHistory()
  const a = {}, b = {}, poses = new Float32Array(24), previous = new Float32Array(24)
  const key = (owner: object, model: number) => {
    keys.begin(owner)
    const array = new Array<number>(12).fill(0)
    keys.record(array, model)
    return keys.of(array)![0]!
  }
  const ka = key(a, 1), kb = key(b, 1)
  poses[0] = 1; poses[12] = 8
  history.begin(false)
  history.write(previous, 0, poses, 0, ka); history.write(previous, 12, poses, 12, kb)
  expect(previous[0]).toBe(1)
  poses[0] = 9; poses[12] = 2
  history.begin(true)
  history.write(previous, 0, poses, 0, key(b, 1)); history.write(previous, 12, poses, 12, key(a, 1))
  expect([previous[0], previous[12]]).toEqual([8, 1])
  history.begin(true)
  history.write(previous, 0, poses, 0, kb)
  history.begin(true)
  history.write(previous, 12, poses, 12, ka)
  expect(previous[12]).toBe(2)
})

test("camera cuts, new parts and teleporting actors reset velocity", () => {
  const history = new MotionHistory(), actor = {}, current = new Float32Array(12), previous = new Float32Array(12)
  history.begin(false); history.write(previous, 0, current, 0, actor)
  current[0] = 100
  history.begin(true); history.write(previous, 0, current, 0, actor)
  expect(previous[0]).toBe(100)
  current[0] = 101
  history.begin(false); history.write(previous, 0, current, 0, actor)
  expect(previous[0]).toBe(101)
  history.begin(true); history.write(previous, 0, current, 0, {})
  expect(previous[0]).toBe(101)
})

test("fast tracers retain flight velocity and begin at their emission point", () => {
  const keys = new MotionKeys(), history = new MotionHistory()
  const current = new Float32Array(12), previous = new Float32Array(12)
  keys.begin({}, [0, 1, 0], 32)
  const tracer = keys.key(4)!
  current[0] = 4; current[1] = 1
  history.begin(true); history.write(previous, 0, current, 0, tracer)
  expect([...previous.slice(0, 3)]).toEqual([0, 1, 0])
  current[0] = 8
  history.begin(true); history.write(previous, 0, current, 0, tracer)
  expect(previous[0]).toBe(4)
  current[0] = 16 // one 30 Hz frame at 240 m/s
  history.begin(true); history.write(previous, 0, current, 0, tracer)
  expect(previous[0]).toBe(8)
  keys.begin({}, [0, 1, 0], 32)
  history.begin(false); history.write(previous, 0, current, 0, keys.key(4))
  expect(previous[0]).toBe(16) // even new emission resets across a camera cut
})
