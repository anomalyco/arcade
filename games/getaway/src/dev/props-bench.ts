import { Camera } from "../game/camera"
import type { Scene } from "../game/scene"
import type { WorldView } from "../../shared/sim/world"
import type { PropKind } from "../game/props/placement"
import { juice } from "../ui/debug-overlay"

/** Only installed for ?bench. Drives a cloned rendered view, leaving shared simulation untouched. */
export function propsBench(scene: Scene, template: WorldView, canvas: HTMLCanvasElement, device: GPUDevice) {
  let view = structuredClone(template), cam = new Camera(), speed = 20, frame = 0, scaleCheck = false, restCheck = false
  const x = 318.5, z = 400
  const setups: Record<string, PropKind[]> = {
    cones: ["cone", "cone", "barrier", "cone", "sawhorse", "cone"],
    furniture: ["bin", "bench", "newspaper", "mailbox", "dumpster"],
    hydrant: ["hydrant", "cone", "bin"],
    explosion: ["propane", "fuel", "canister", "crate", "pallet", "propane"],
    scale: ["bench", "hydrant", "cone"],
    rest: ["cone", "cone", "cone", "cone"],
  }
  return {
    setup(name: string) {
      scene.resetBench(); cam = new Camera(); frame = 0
      scaleCheck = name === "scale"
      restCheck = name === "rest"
      view = structuredClone(template)
      view.cars = [view.cars.find(c => !c.ghost)!]
      view.heli.active = false; view.phase = "chase"; view.props = []
      speed = name === "cones" ? 25 : name === "furniture" ? 17 : 20
      const car = view.cars[0]!
      Object.assign(car, { x: x + .4, z: z - 13, h: 0, vx: 0, vz: speed, speed, y: 0, impact: 0, drift: 0, ghost: false, engineOff: false, role: "robber", vehicle: "muscle" })
      scene.clutter.fixture(name === "city" ? null : name === "stress" ? Array<PropKind>(320).fill("crate") : setups[name] ?? setups.cones!, x, z)
      if (name === "stress") {
        for (const [i, p] of scene.clutter.props.entries()) {
          p.body.x = x + (i % 20 - 10) * .85; p.body.z = z + Math.floor(i / 20) * .85; p.body.y = 3 + i % 4
          scene.clutter.physics.move(p.body)
          scene.clutter.physics.impulse(p.body, Math.sin(i) * 60, 80, Math.cos(i) * 60)
        }
        scene.clutter.particles.emit(10, x, 4, z + 5, 1800, 1)
        scene.clutter.particles.emit(11, x, 4, z + 5, 400, 1)
        scene.clutter.particles.emit(6, x, 4, z + 5, 200, 1)
      }
      cam.snap(x, z + 4)
      cam.dist = 52
      if (restCheck) {
        Object.assign(car, { x: x + 12, z: z - 10, vx: 0, vz: 0, speed: 0, engineOff: true, ghost: true })
        for (const [i, p] of scene.clutter.props.entries()) {
          const b = p.body
          b.x = x - 1.5 + i % 2 * 2; b.z = z + 2 + Math.floor(i / 2) * 2
          b.y = scene.clutter.ground(b.x, b.z) + 2
          b.roll = [Math.PI, Math.PI - .1, 2.2, .6][i]!; b.pitch = [0, .2, -.4, .2][i]!
          b.wx = i === 0 ? 0 : i - 2; b.wz = i === 0 ? 0 : .5
          scene.clutter.physics.move(b); scene.clutter.physics.wake(b)
        }
        cam.snap(x - .5, z + 3); cam.dist = 15
      }
      if (scaleCheck) {
        Object.assign(car, { x, z: z + 4, y: .16, vx: 0, vz: 0, speed: 0, engineOff: true })
        const positions = [[x - 1.75, z + 5], [x - 1.75, z + 2.5], [x - 1.75, z + 1.4]]
        for (const [i, p] of scene.clutter.props.entries()) {
          const [px, pz] = positions[i]!
          p.home.x = p.body.x = px!; p.home.z = p.body.z = pz!
          p.home.y = .16; p.body.y = .16 + p.body.hy
          scene.clutter.physics.move(p.body)
        }
        cam.snap(x - .5, z + 4)
        cam.dist = 19
      }
      juice.clutter = juice.explosions = true
      juice.physicsDebug = false
      return scene.clutter.props.map(p => ({ kind: p.home.kind, x: p.body.x, z: p.body.z }))
    },
    async step(dt = 1 / 30) {
      const car = view.cars[0]!
      if (dt > 0 && !scaleCheck && !restCheck) {
        frame++
        car.z = z - 13 + Math.min(frame / 30, 1.9) * speed
        car.vz = frame < 57 ? speed : 0; car.speed = car.vz
        cam.update(x, z + 5, 0, 0, dt, -20)
        if (scene.shake > 0) { cam.bump(scene.shake); scene.shake = 0 }
      }
      scene.draw(view, cam, canvas.width, canvas.height, dt, car)
      await device.queue.onSubmittedWorkDone()
      return { ...scene.clutter.stats, bodies: scene.clutter.props.map(p => ({ kind: p.home.kind, x: p.body.x, y: p.body.y, z: p.body.z, roll: p.body.roll, pitch: p.body.pitch, awake: p.body.awake, upY: Math.cos(p.body.roll) * Math.cos(p.body.pitch), broken: p.broken })) }
    },
    enabled(on: boolean) { juice.clutter = on },
  }
}
