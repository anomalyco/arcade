import type { LabContext } from "@arcade/kit/lab/types"
import type { CharacterSpawnable, ItemWorld, PlaygroundEnvironmentInfo, SpawnPoint } from "@arcade/kit/lab/spawn-types"
import type { LabLight } from "@arcade/kit/lab/stage"
import { GameSprites } from "@arcade/kit/lab/game-sprites"
import { yardGround, yardRamps, yardWalls } from "@arcade/kit/lab/yard"
import { VEHICLES } from "../../shared/config"
import { newBody, stepAndCollide, lateralSpeed, type Input } from "../../shared/sim/vehicle"
import type { CarView } from "../../shared/sim/world"
import type { Box, City } from "../../shared/sim/city"
import { buildCar } from "../render/car-mesh"
import { splitChassis } from "../render/chassis-mesh"
import { Chassis, chassisSettings, wheelRotation } from "../game/chassis"
import { VehicleEmissions, EmissionState } from "../game/vehicle-emissions"
import { Fx } from "../game/fx"
import { StreetProps } from "../game/props"
import { PROP_KINDS } from "../game/props/placement"
import type { SpriteWriter } from "../game/props/particles"
import { getawayEnvironment, getawayRooms } from "./environment"
import { bodyPoint, type BodyPose } from "@arcade/kit/vehicle/body-pose"
import { HEADLIGHT, lampMounts } from "@arcade/kit/vehicle/lights"

function makeYardBoxes(): Box[] {
  return yardWalls.map(([x0, z0, x1, z1]) => ({
    x0,
    z0,
    x1,
    z1,
    h: 2.2,
    color: [0.3, 0.34, 0.38],
    neon: null,
    kind: "wall",
    label: null,
  }))
}

function findValidatedSpawn(boxes: readonly Box[], preferred: SpawnPoint): SpawnPoint {
  const clearAt = (x: number, z: number, margin = 2.3) =>
    !boxes.some(b => x > b.x0 - margin && x < b.x1 + margin && z > b.z0 - margin && z < b.z1 + margin)
  let sx = preferred.x
  let sz = preferred.z
  if (!clearAt(sx, sz)) {
    outer: for (let r = 2; r <= 20; r += 2) {
      for (const [dx, dz] of [[0, -r], [0, r], [-r, 0], [r, 0], [-r, -r], [r, -r], [-r, r], [r, r]] as const) {
        if (clearAt(preferred.x + dx, preferred.z + dz)) {
          sx = preferred.x + dx
          sz = preferred.z + dz
          break outer
        }
      }
    }
  }
  // Pick the heading with the longest clear run ahead so the car faces along the open street/alley
  let bestYaw = preferred.yaw
  let bestDist = -1
  for (const yaw of [preferred.yaw, Math.PI, 0, Math.PI / 2, -Math.PI / 2]) {
    let d = 0
    while (d < 24 && clearAt(sx + Math.sin(yaw) * (d + 2), sz + Math.cos(yaw) * (d + 2), 1.6)) d += 2
    if (d > bestDist) {
      bestDist = d
      bestYaw = yaw
    }
  }
  return { x: sx, y: 0, z: sz, yaw: bestYaw }
}

export function getawaySpawn(context: LabContext) {
  const meshes = context.stage.meshes
  const sprites = new GameSprites(context)
  const fx = new Fx()
  const emissions = new VehicleEmissions(context.trail)
  emissions.skids = fx

  let skidsEnabled = true
  let smokeEnabled = true
  let activeEnv = "yard"
  let activeGround: (x: number, z: number) => number = yardGround
  let activeWalls: readonly (readonly [number, number, number, number])[] = yardWalls
  let envModel = -1
  let envLights: LabLight[] = []

  const city: City = {
    seed: 7,
    boxes: makeYardBoxes(),
    ramps: yardRamps.map(r => ({ ...r, kind: "plate" as const })),
    parks: [],
    trees: [],
    alleys: [],
    parked: [],
    lamps: [],
    nodes: [],
    adj: [],
    sites: [],
    extraction: [],
    precinct: { x: 0, y: 0, z: 0, h: 0, spawnNode: 0 } as any,
    helipad: { x: 0, y: 0, z: 0 },
    waterZ: 100,
    max: 100,
    yards: [],
    sidewalk: 0,
    shops: [],
  }
  emissions.city = city

  const cars: CarView[] = []
  const lights: LabLight[] = []
  const alpha = new Float32Array(4096 * 12)
  const add = new Float32Array(4096 * 12)
  const pendingAdd: number[][] = []
  let activeCarShadow: { x: number; y: number; z: number; h: number; width: number; length: number } | null = null

  const addModel = (mesh: { v: number[] }) => meshes.add(mesh.v, 12, code => ([2, 5, 8, 9].includes(code) ? 1.5 : 0))
  const props = new StreetProps({ boxes: city.boxes, placements: [] }, { addModel }, (x, z) => activeGround(x, z))

  function rebuildPropWallHash(boxes: readonly Box[]) {
    const wallMap = (props.physics as unknown as { walls: Map<number, Box[]> }).walls
    wallMap.clear()
    for (const b of boxes) {
      for (let x = Math.floor(b.x0 / 6); x <= Math.floor(b.x1 / 6); x++) {
        for (let z = Math.floor(b.z0 / 6); z <= Math.floor(b.z1 / 6); z++) {
          const k = props.physics.hash.key(x * 6, z * 6)
          const cell = wallMap.get(k) ?? []
          cell.push(b)
          wallMap.set(k, cell)
        }
      }
    }
  }

  const sprite: SpriteWriter = (list, x, y, z, size, r, g, b, a, kind, rot = 0, stretch = 1) => {
    if (list === "a") {
      const shape = kind === 2 ? 2 : kind === 3 || kind === 4 || kind === 9 ? 1 : kind === 20 ? 4 : 0
      sprites.push(x, y, z, size, r, g, b, a, shape, rot, stretch)
    } else {
      pendingAdd.push([x, y, z, size, r, g, b, a, kind === 2 ? 2 : 0, rot, stretch])
    }
  }

  const environmentOptions = [
    { value: "yard", label: "Proving Yard" },
    ...getawayRooms.map(r => ({ value: r.value, label: `Getaway · ${r.label}` })),
  ]

  function setEnvironment(kind: string, seed: number): PlaygroundEnvironmentInfo {
    activeEnv = kind
    fx.clearSkids()
    fx.add.length = 0
    emissions.reset()
    context.trail.seedWind(seed)
    if (kind === "yard") {
      city.boxes = makeYardBoxes()
      city.ramps = yardRamps.map(r => ({ ...r, kind: "plate" as const }))
      city.parks = []
      activeGround = yardGround
      activeWalls = yardWalls
      envLights = []
      rebuildPropWallHash(city.boxes)
      return {
        kind,
        seed,
        spawn: { x: 0, y: 0, z: 8, yaw: Math.PI },
        walls: activeWalls,
        ground: activeGround,
        lights: envLights,
      }
    }
    const env = getawayEnvironment(kind, seed)
    if (envModel < 0) envModel = meshes.add(env.vertices, 12, c => ([2, 5, 8, 9].includes(c) ? 1.5 : 0))
    else meshes.replace(envModel, env.vertices, 12, c => ([2, 5, 8, 9].includes(c) ? 1.5 : 0))
    const ox = env.origin.x
    const oz = env.origin.z
    city.boxes = env.city.boxes.map(b => ({
      ...b,
      x0: b.x0 - ox,
      x1: b.x1 - ox,
      z0: b.z0 - oz,
      z1: b.z1 - oz,
    }))
    city.parks = env.city.parks.map(p => ({
      ...p,
      x0: p.x0 - ox,
      x1: p.x1 - ox,
      z0: p.z0 - oz,
      z1: p.z1 - oz,
    }))
    city.ramps = []
    activeGround = () => 0
    activeWalls = city.boxes.map(b => [b.x0, b.z0, b.x1, b.z1] as const)
    envLights = env.lights
    rebuildPropWallHash(city.boxes)
    const spawn = findValidatedSpawn(city.boxes, { x: 0, y: 0, z: 0, yaw: Math.PI })
    return {
      kind,
      seed,
      spawn,
      walls: activeWalls,
      ground: activeGround,
      lights: envLights,
    }
  }

  const items: ItemWorld = {
    items: PROP_KINDS.map(id => ({ id, label: id === "propane" ? "Propane tank" : id[0]!.toUpperCase() + id.slice(1) })),
    environments: environmentOptions,
    setEnvironment,
    clearSkids: () => {
      fx.clearSkids()
      fx.add.length = 0
    },
    setSkidsEnabled: (enabled: boolean) => {
      skidsEnabled = enabled
      emissions.skids = enabled ? fx : null
    },
    setSmokeEnabled: (enabled: boolean) => {
      smokeEnabled = enabled
    },
    skidStats: () => ({
      skids: fx.skidCount,
      budget: 1600,
      sparks: fx.add.length,
      tyreSmoke: context.trail.count,
    }),
    get bodies() {
      return [...props.props.map(p => p.body), ...props.chunks.map(c => c.body)]
    },
    lights,
    spawn(id, at) {
      const kind = PROP_KINDS.find(k => k === id)
      if (!kind) return
      props.spawn({ kind, x: at.x, y: activeGround(at.x, at.z), z: at.z, yaw: at.yaw })
      const added = props.props.at(-1)
      return added ? `prop:${added.body.id}` : undefined
    },
    entries: () =>
      props.props
        .filter(p => p.body.enabled)
        .map(p => ({
          id: `prop:${p.body.id}`,
          kind: p.home.kind,
          label: `${p.home.kind === "propane" ? "Propane tank" : p.home.kind[0]!.toUpperCase() + p.home.kind.slice(1)} #${p.body.id + 1}`,
          x: p.body.x,
          y: p.body.y - p.body.hy,
          z: p.body.z,
          yaw: p.body.yaw,
          radius: Math.max(0.65, Math.hypot(p.body.hx, p.body.hz)),
          broken: p.broken,
        })),
    move(id, at) {
      const p = props.props.find(item => `prop:${item.body.id}` === id)
      if (!p) return false
      const gy = activeGround(at.x, at.z)
      p.home.x = at.x
      p.home.y = gy
      p.home.z = at.z
      p.home.yaw = at.yaw
      props.physics.remove(p.body)
      Object.assign(p.body, {
        x: at.x,
        y: gy + p.body.hy,
        z: at.z,
        yaw: at.yaw,
        roll: 0,
        pitch: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        sleep: 0,
        awake: false,
        enabled: true,
      })
      p.broken = false
      p.touched = p.hitAt = p.fuse = -1
      props.physics.add(p.body)
      return true
    },
    remove(id) {
      const idx = props.props.findIndex(item => `prop:${item.body.id}` === id)
      if (idx < 0) return false
      const [removed] = props.props.splice(idx, 1)
      if (removed) props.physics.remove(removed.body)
      return true
    },
    drawGhost(kind, at) {
      const found = PROP_KINDS.find(k => k === kind)
      if (!found) return
      const model = props.models.get(found)
      if (model !== undefined) meshes.instance(model, at.x, activeGround(at.x, at.z), at.z, at.yaw, 0, 0, 1.02, [0.45, 0.95, 0.8])
    },
    snapshot: () =>
      props.props
        .filter(p => p.body.enabled && !p.broken)
        .map(p => ({ kind: p.home.kind, x: p.body.x, y: activeGround(p.body.x, p.body.z), z: p.body.z, yaw: p.body.yaw })),
    restore(placements) {
      props.clear()
      for (const p of placements) {
        const kind = PROP_KINDS.find(k => k === p.kind)
        if (kind) props.spawn({ kind, x: p.x, y: activeGround(p.x, p.z), z: p.z, yaw: p.yaw })
      }
    },
    clear: () => {
      props.clear()
      fx.clearSkids()
      fx.add.length = 0
    },
    reset: () => {
      props.reset()
      fx.clearSkids()
      fx.add.length = 0
    },
    wakeAll: () => {
      for (const p of props.props) props.physics.wake(p.body)
      for (const c of props.chunks) props.physics.wake(c.body)
    },
    update: dt => {
      fx.update(dt)
      emissions.update(dt)
      props.update(cars, dt, { x: context.stage.focus[0], z: context.stage.focus[2] }, true, () => true)
    },
    prepare() {
      if (activeEnv !== "yard" && envModel >= 0) {
        meshes.instance(envModel, 0, 0.001, 0)
      }
      lights.length = 0
      for (const l of envLights) lights.push(l)
      sprites.reset()
      pendingAdd.length = 0
      props.draw(
        (...args) => meshes.instance(...args),
        sprite,
        (x, y, z, radius, r, g, b, power) => lights.push({ x, y, z, radius, r, g, b, power }),
        { x: context.stage.focus[0], z: context.stage.focus[2] },
        false,
      )
      if (activeCarShadow) {
        const s = activeCarShadow
        sprites.push(s.x, s.y + 0.014, s.z, s.width * 0.72, 0.01, 0.01, 0.015, 0.58, 5, s.h, (s.length * 0.62) / (s.width * 0.72))
      }
      const counts = fx.emit(alpha, 0, add, 0, 4096, skidsEnabled)
      emissions.emit(alpha, counts.alpha, add, counts.add, 4096, true)
      sprites.batch(alpha, emissions.alphaCount, "getaway")
      sprites.additive()
      sprites.batch(add, emissions.addCount, "getaway")
      for (const p of pendingAdd) {
        sprites.push(p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!, p[9]!, p[10]!)
      }
      sprites.upload()
    },
    draw: sprites.draw,
    inspect: () => ({
      stats: { ...props.stats },
      props: props.props.map(p => ({ kind: p.home.kind, x: p.body.x, y: p.body.y, z: p.body.z, awake: p.body.awake, broken: p.broken })),
      chunks: props.chunks.length,
      skids: fx.skidCount,
      skidBudget: 1600,
    }),
  }

  const characters: CharacterSpawnable[] = VEHICLES.map(spec => {
    let model: ReturnType<typeof splitChassis> | undefined
    let bodyModel = 0
    let wheelModels: number[] = []
    return {
      id: `getaway:${spec.id}`,
      label: `Getaway · ${spec.name}`,
      create(_context, at) {
        if (!model) {
          model = splitChassis(buildCar(spec, undefined, 4))
          bodyModel = addModel(model.body)
          wheelModels = model.wheels.map(w => addModel(w.mesh))
        }
        let body = newBody(at.x, at.z, at.yaw)
        body.y = activeGround(at.x, at.z)
        const point: SpawnPoint = { ...at, y: body.y }
        const input: Input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }
        const car: CarView = {
          ...body,
          id: 1,
          ownerId: "lab",
          name: "Lab",
          role: spec.role,
          vehicle: spec.id,
          speed: 0,
          drift: 0,
          boost: 1,
          human: true,
          impact: 0,
          ghost: false,
        }
        let chassis = new Chassis(car, model.wheels)
        const settings = chassisSettings()
        let emission = new EmissionState()
        let scrapeAcc = 0
        let lastLandings = 0
        emissions.skids = skidsEnabled ? fx : null
        cars.splice(0, cars.length, car)
        const mount = lampMounts(spec)
        const half = spec.length / 2
        const frontZ = mount.frontZ ?? half
        const rearZ = mount.rearZ ?? -half
        const sides = spec.id === "bike" ? [0] : [-1, 1]
        const headlights: LabLight[] = sides.map(() => ({
          x: 0,
          y: 0,
          z: 0,
          radius: 17,
          r: HEADLIGHT[0] * 1.15,
          g: HEADLIGHT[1] * 1.15,
          b: HEADLIGHT[2] * 1.15,
          power: 4.2,
          cone: 0.79,
        }))
        const tailLights: LabLight[] = sides.map(() => ({
          x: 0,
          y: 0,
          z: 0,
          radius: 4.2,
          r: 1,
          g: 0.04,
          b: 0.015,
          power: 0.35,
        }))

        const currentPose = (): BodyPose => ({
          height: (car.y ?? 0) + chassis.lift.x,
          roll: chassis.roll.x,
          pitch: chassis.pitch.x,
        })

        return {
          point,
          updatesTrail: true,
          setPoint(nextAt: SpawnPoint) {
            body = newBody(nextAt.x, nextAt.z, nextAt.yaw)
            body.y = activeGround(nextAt.x, nextAt.z)
            Object.assign(car, body, { speed: 0, drift: 0, boost: 1, impact: 0 })
            Object.assign(point, { x: body.x, y: body.y, z: body.z, yaw: body.h })
            Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false })
            chassis = new Chassis(car, model!.wheels)
            emission = new EmissionState()
            scrapeAcc = 0
            lastLandings = 0
          },
          update(dt, keys) {
            const vf = body.vx * Math.sin(body.h) + body.vz * Math.cos(body.h)
            input.throttle = keys.up ? 1 : keys.down ? -1 : 0
            input.brake = (keys.up && keys.down) || (keys.down && vf > 3.5) ? 1 : 0
            input.handbrake = keys.space || (keys.down && vf > 8)
            input.boost = keys.shift
            const target = Number(keys.left) - Number(keys.right)
            const rate = target === 0 ? 10 : Math.sign(target) !== Math.sign(input.steer) ? 12 : 6
            input.steer += Math.max(-rate * dt, Math.min(rate * dt, target - input.steer))
            const impact = stepAndCollide(body, input, spec, dt, city.boxes, undefined, city.ramps)
            Object.assign(car, body, {
              speed: Math.hypot(body.vx, body.vz),
              drift: Math.abs(lateralSpeed(body)),
              boost: body.boostFuel,
              impact,
            })
            if ((body.landings ?? 0) > lastLandings) {
              const landImpact = Math.max(body.landing ?? 0, Math.abs(body.vy))
              if (landImpact > 8) fx.sparks(car.x, car.z, -car.vx, -car.vz, Math.min(10, Math.floor(landImpact * 0.6)), (car.y ?? 0) + 0.08)
              lastLandings = body.landings ?? 0
            }
            if (impact > 0.35 && car.speed > 4) {
              scrapeAcc += dt * (12 + Math.min(car.speed, 40))
              const n = Math.floor(scrapeAcc)
              scrapeAcc -= n
              if (n > 0) fx.sparks(car.x + Math.sin(car.h) * spec.length * 0.4, car.z + Math.cos(car.h) * spec.length * 0.4, -car.vx, -car.vz, n, (car.y ?? 0) + 0.18)
            } else {
              scrapeAcc = 0
            }
            chassis.update(car, spec, city, dt, settings, input)
            emissions.skids = skidsEnabled ? fx : null
            // Note: emissions.car uses c.y < 0.15 for flat road; subtract ramp ground height so driving on ramps remains grounded unless car.airborne is true.
            const groundY = activeGround(car.x, car.z)
            const relCar: CarView = { ...car, y: car.airborne ? Math.max(0.5, (car.y ?? 0) - groundY) : Math.max(0, (car.y ?? 0) - groundY) }
            emissions.car(relCar, spec, emission, input, dt, groundY, smokeEnabled, true)
            Object.assign(point, { x: body.x, y: body.y, z: body.z, yaw: body.h })
          },
          prepare() {
            const pose = currentPose()
            meshes.instance(bodyModel, car.x, pose.height ?? 0, car.z, car.h, pose.roll ?? 0, pose.pitch ?? 0)
            model!.wheels.forEach((p, i) => {
              const w = chassis.contacts[i]!
              wheelRotation(w, car.h, car.airborne ? (pose.roll ?? 0) : 0, car.airborne ? (pose.pitch ?? 0) : 0, p.z > 0 ? chassis.steer : 0, w.spin)
              meshes.instance(wheelModels[i]!, w.x, w.y, w.z, w.yaw, w.roll, w.pitch)
            })
            const isBraking = Boolean(input.brake || input.throttle < 0 || input.handbrake)
            const grounded = Math.max(0, 1 - Math.max(0, (car.y ?? 0) - activeGround(car.x, car.z)) / 1.2)
            for (const s of sides) {
              const head = bodyPoint(car, pose, [mount.frontX * s, mount.frontY + 0.01, frontZ + 0.048])
              const aim = bodyPoint(car, pose, [mount.frontX * s, mount.frontY - 0.25, frontZ + 1.048])
              const beamYaw = Math.atan2(aim[0] - head[0], aim[2] - head[2])
              const tail = bodyPoint(car, pose, [mount.rearX * s, mount.rearY + 0.01, rearZ - 0.052])
              pendingAdd.push([head[0], head[1], head[2], 0.24, HEADLIGHT[0], HEADLIGHT[1], HEADLIGHT[2], 0.26, 0, 0, 1])
              if (grounded > 0.05) {
                pendingAdd.push([head[0], activeGround(head[0], head[2]) + 0.032, head[2], 1.35, HEADLIGHT[0], HEADLIGHT[1], HEADLIGHT[2], 0.085 * grounded, 6, beamYaw, 5.5 / 1.35])
              }
              pendingAdd.push([tail[0], tail[1], tail[2], isBraking ? 0.32 : 0.2, 1, 0.06, 0.025, isBraking ? 0.45 : 0.18, 0, 0, 1])
            }
            activeCarShadow = car.airborne
              ? null
              : { x: car.x, y: activeGround(car.x, car.z), z: car.z, h: car.h, width: spec.width, length: spec.length }
          },
          lights() {
            const pose = currentPose()
            const isBraking = Boolean(input.brake || input.throttle < 0 || input.handbrake)
            sides.forEach((s, i) => {
              const head = bodyPoint(car, pose, [mount.frontX * s, mount.frontY + 0.01, frontZ + 0.05])
              const aim = bodyPoint(car, pose, [mount.frontX * s, mount.frontY - 0.25, frontZ + 1.05])
              const rawDx = aim[0] - head[0]
              // Bound vertical pitch aim so brake dive brings pools closer without throttle squat flinging them to the horizon
              const rawDy = Math.max(-0.42, Math.min(-0.18, aim[1] - head[1]))
              const rawDz = aim[2] - head[2]
              const len = Math.hypot(rawDx, rawDy, rawDz) || 1
              Object.assign(headlights[i]!, {
                x: head[0],
                y: head[1],
                z: head[2],
                dx: rawDx / len,
                dy: rawDy / len,
                dz: rawDz / len,
              })
              const tail = bodyPoint(car, pose, [mount.rearX * s, mount.rearY + 0.01, rearZ - 0.08])
              Object.assign(tailLights[i]!, {
                x: tail[0],
                y: tail[1],
                z: tail[2],
                power: isBraking ? 1.8 : 0.35,
              })
            })
            return [...headlights, ...tailLights]
          },
          inspect: () => {
            const pose = currentPose()
            const s = sides[0]!
            const headL = bodyPoint(car, pose, [mount.frontX * s, mount.frontY + 0.01, frontZ + 0.05])
            const tailL = bodyPoint(car, pose, [mount.rearX * s, mount.rearY + 0.01, rearZ - 0.08])
            return {
              vehicle: spec.id,
              ...point,
              speed: car.speed,
              drift: car.drift,
              lift: chassis.lift.x,
              roll: chassis.roll.x,
              pitch: chassis.pitch.x,
              headlampWorld: headL,
              taillampWorld: tailL,
              tyreParticles: context.trail.count,
              skids: fx.skidCount,
              skidBudget: 1600,
              sparks: fx.add.length,
              emittingWheels: emission.emittingWheels,
              airborne: car.airborne,
              input: { ...input },
            }
          },
          leave: () => {
            cars.length = 0
            activeCarShadow = null
            emissions.reset()
          },
        }
      },
    }
  })

  return { items, characters }
}
