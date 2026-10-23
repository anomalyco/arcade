import { expect, test } from "bun:test"
import { Particles } from "@arcade/kit/fx/particles"
import { CAMERA_FILTER_DEFAULTS } from "@arcade/kit/gpu/post/camcorder"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import { createForestLookSettings } from "@arcade/kit/forest/settings"
import { makeWorld } from "../shared/world"
import { CAMERA_FEEL } from "../src/camera-feel"
import { Juice, type JuiceFrame } from "../src/juice"

const noop = () => {}
Object.assign(globalThis, { window: globalThis.window ?? { addEventListener: noop }, document: globalThis.document ?? { addEventListener: noop, pointerLockElement: null } })
const { CameraLook, bodycamRig } = await import("../src/camera-look")

const flare = (i: number): SceneLight => ({ x: i, y: 0, h: 1, r: 12, color: [1, 0.2, 0.1], power: 4, size: 0.3 })

function juiceFrame(flareLights: readonly SceneLight[], torch: boolean): JuiceFrame {
  return {
    dt: 1 / 60, pool: new Particles(), eye: [0, 1.7, 0], yaw: 0, vx: 0, vz: 0, walkSpeed: 1.4, ground: 0, steps: [], litter: false, flareLights,
    torch: torch ? { pos: [0.3, 1.4, -0.2], dir: [0, -0.1, -1], level: 1 } : null, settings: { ...CAMERA_FEEL }, playing: true,
  }
}

test("particle lights: your torch then every flare's, the same length every frame, the flares' own list untouched", () => {
  const juice = new Juice(), flares = [flare(1), flare(2), flare(3)]
  let lights: readonly SceneLight[] = []
  for (let i = 0; i < 120; i++) lights = juice.frame(juiceFrame(flares, true))
  expect(lights.length).toBe(2 + flares.length)
  expect(lights.slice(2)).toEqual(flares)
  expect(lights[0]!.cone).toBeDefined()
  expect(flares.length).toBe(3)
  // Torch off: just the flares, still not growing.
  for (let i = 0; i < 10; i++) lights = juice.frame(juiceFrame(flares, false))
  expect(lights).toEqual(flares)
  // Flares burn out: nothing left over from earlier frames.
  expect(juice.frame(juiceFrame([], false)).length).toBe(0)
})

test("reduced motion stills the chest rig's sway, torso lag and bob, keeping its lens and mount", () => {
  const fs = { ...CAMERA_FILTER_DEFAULTS, bodyLens: 120, bodyMount: 0.38, bodySway: 1, bodyLag: 0.5, bodyBob: 1 }
  expect(bodycamRig(fs, 1)).toEqual({ lens: 120, mount: 0.38, sway: 1, lag: 0.5, bob: 1 })
  expect(bodycamRig(fs, 0)).toEqual({ lens: 120, mount: 0.38, sway: 0, lag: 0, bob: 0 })
})

function makeLook() {
  const camera = {} as ConstructorParameters<typeof CameraLook>[0]["camera"]
  return new CameraLook({
    renderer: { setFinalPass: noop } as unknown as ConstructorParameters<typeof CameraLook>[0]["renderer"],
    device: {} as GPUDevice, format: "bgra8unorm", camera,
    forest: { settings: createForestLookSettings(), camera: { exposure: 1 } } as unknown as ConstructorParameters<typeof CameraLook>[0]["forest"],
    panel: { addControls: noop, sync: noop } as unknown as ConstructorParameters<typeof CameraLook>[0]["panel"],
    params: new URLSearchParams(), smoke: true, seed: 1,
  })
}

test("switching looks drops the last look's zoom", () => {
  const look = makeLook()
  look.apply("hi8")
  Object.assign(look, { zoomLevel: 1, fovScale: 0.35, zooming: true })
  look.filter.zoom = 1
  look.apply("bodycam")
  expect([look.zoomLevel, look.fovScale, look.zooming, look.filter.zoom]).toEqual([0, 1, false, 0])
})

const world = makeWorld()
type LookFrame = Parameters<InstanceType<typeof CameraLook>["frame"]>[0]
const lookFrame = (o: Partial<LookFrame>): LookFrame => ({
  t: 10, dt: 1 / 60, eye: [0, 1.7, 0], yaw: 0, pitch: 0, torches: [], world, fp: {} as LookFrame["fp"], place: { scene: [], fog: [] } as unknown as LookFrame["place"],
  mapRaise: 0, feelBlur: 1, reduced: false, zoomHeld: false, fovY: 1.2, aspect: 16 / 9, ...o,
})

test("reduced motion turns off the filter's movement and the turn blur", () => {
  const look = makeLook()
  look.apply("phone")
  look.frame(lookFrame({}))
  expect(look.filter.motion).toBe(1)
  look.frame(lookFrame({ reduced: true, yaw: 0.2 }))
  expect(look.filter.motion).toBe(0)
  expect(look.blur.active).toBe(false)
})

test("raising the map fades every pass off, so the sheet stays sharp", () => {
  const look = makeLook()
  look.apply("vhs")
  look.frame(lookFrame({ mapRaise: 0.5 }))
  expect([look.filter.strengthScale, look.lens.strengthScale, look.codec.strengthScale]).toEqual([0.5, 0.5, 0.5])
  look.frame(lookFrame({ mapRaise: 1 }))
  expect([look.filter.strengthScale, look.lens.strengthScale, look.codec.strengthScale, look.blur.scale]).toEqual([0, 0, 0, 0])
})

test("the turn blur only runs while the view is turning fast", () => {
  const look = makeLook()
  look.apply("eyes")
  expect(look.blur.settings.strength).toBe(0)
  look.frame(lookFrame({}))
  expect(look.blur.settings.strength).toBeGreaterThan(0)
  look.frame(lookFrame({ t: 10.02 }))
  expect(look.blur.active).toBe(false)
  // About 4 rad/s: a whip turn.
  look.frame(lookFrame({ t: 10.03, yaw: 4 / 60 }))
  expect(look.blur.active).toBe(true)
})
