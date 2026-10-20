import { expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { makeTown, type Lamp } from "../shared/map"
import type { WeatherSimState } from "../shared/weather/runtime"
import { OutbreakWeatherController } from "../src/weather/controller"
import { DEFAULT_OUTBREAK_WEATHER, setOutbreakWeatherState } from "../src/weather/settings"

const lamp = (x: number, y: number): Lamp => ({ x, y, h: 4, radius: 9, power: 1, kind: "street" })

function strikeAt(lamps: Lamp[]): { x: number; z: number } {
  const town = makeTown(7, 7, 0.22)
  town.lamps = lamps
  town.props = []
  const s = { ...DEFAULT_OUTBREAK_WEATHER }
  setOutbreakWeatherState(s, "storm")
  const ctrl = new OutbreakWeatherController()
  ctrl.flashNow({ near: true, seed: 5, bearing: 0, dist: 0 })
  ctrl.stepAndPrepare({
    dt: 1 / 60,
    town,
    settings: s,
    viewProj: new Float32Array(16),
    eye: [0, 22, 14],
    playerX: 0,
    playerY: 0,
    playerGroundY: 0,
    canvasWidth: 1000,
    canvasHeight: 680,
    zoom: 42,
    lights: new Float32Array(64 * 16),
    lightCount: 0,
    maxLights: 64,
    ambientLum: 0.2,
    simTime: 10,
    hour: 22,
  })
  expect(ctrl.marks.length).toBe(1)
  return { x: ctrl.marks[0]!.x, z: ctrl.marks[0]!.z }
}

test("a near strike lands on the lamp nearest where it fell, whatever the lamp order", () => {
  expect(strikeAt([lamp(10, 0), lamp(19, 0)])).toEqual({ x: 10, z: 0 })
  expect(strikeAt([lamp(19, 0), lamp(10, 0)])).toEqual({ x: 10, z: 0 })
})

test("the client's cycle sample follows the override being cleared within the same sim second", () => {
  const storm = { ...DEFAULT_OUTBREAK_WEATHER, weatherOverride: 3 }
  const cycle = { ...DEFAULT_OUTBREAK_WEATHER, weatherOverride: -1 }
  const ctrl = new OutbreakWeatherController()
  expect(ctrl.sampleCycle(7, 10, 12, storm).state).toBe("storm")
  const fresh = { ...new OutbreakWeatherController().sampleCycle(7, 10, 12, cycle) }
  expect(fresh.state).toBe("clear")
  expect({ ...ctrl.sampleCycle(7, 10, 12, cycle) }).toEqual(fresh)
})

test("the room's weather follows the override being cleared within the same sim second", () => {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: 12 })
  const state = sim.getFeatureState<WeatherSimState>("weather")!
  const tuning = (weatherOverride: number) => ({ weather: { weatherOverride } })
  sim.stepWorld(1 / 60, 1, tuning(3) as never)
  expect(state.sample.state).toBe("storm")
  sim.stepWorld(1 / 60, 1, tuning(-1) as never)
  expect(state.sample.state).toBe("clear")
  expect(sim.ai.weatherSense.hearing).toBe(1)
})
