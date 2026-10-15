import { type Crew, type CrewPlayer, type RecoverHow, teamCss, playerOf, shipOf, spawnAt } from "../../shared/crew"
import { fleetSpawn } from "../../shared/spawn"
import type { Archipelago } from "../../shared/islands"
import { hullLimits, settled } from "../../shared/fleet"
import { gunOp, playerBoat, playerVehicle } from "../../shared/ops"
import type { BoatModule } from "../boat/seam"
import type { CombatWorld } from "../../shared/combat"
import type { Target } from "../../shared/weapons"
import { unpackGunBoom, unpackGunFire } from "../../shared/gunnery"
import type { Gunnery } from "../gunnery/gunnery"
import { TurretPass } from "../render/turret-pass"
import type { Sea } from "../../shared/sea"
import type { VehicleKind } from "../../shared/vehicles"
import { collideHulls, hullSolid, makeContact } from "../../shared/ship-collide"
import { KNOT, SHIP, type Ship, type ShipPose, copyShip, extrapolatePose, headingTo, lerpShip, makeShip, shipStep } from "../../shared/ship"
import type { Input } from "../input"
import type { Net } from "../net"
import type { Camera } from "../render/camera"
import { buildCarrier } from "../render/carrier-mesh"
import type { Renderer } from "../render/renderer"
import { ShipPass, type ShipDrawPose } from "../render/ship-pass"
import { shipTeamColor } from "../render/team"
import { CamBlend } from "../flight/blend"
import type { FlightFrame } from "../flight/seam"
import type { Hud } from "../ui/hud"
import { ChaseCam } from "./chase"
import { Helm } from "./helm"
import { Remotes, poseFromShip } from "./remotes"
import { Wake } from "./wake"

/** At most this much sea time is simulated in one frame; a longer gap (a hidden tab) is skipped. */
const MAX_CATCHUP = 4
/** Radar turns per second; its angle is a function of sea time, so every client sees it at the same bearing. */
const RADAR_RPS = 0.25
/** The predicted ship glides onto the room's pose over this lag (s); further apart than SNAP metres, it jumps. */
const CORRECT_LAG = 1.5
const SNAP = 60
/** A refused request shows this long (ms). */
const FLASH_MS = 2500
/** How a refused request reads (shared/crew.ts CrewError); others read "CAN'T: <error>". */
const REFUSED: Record<string, string> = {
  locked: "THAT SHIP IS LOCKED",
  kicked: "KICKED FROM THAT SHIP",
  recharging: "STILL RECHARGING",
  "in-use": "ALL IN USE",
  "helm-taken": "HELM TAKEN",
  "ship-full": "THAT SHIP IS FULL",
  "deck-fire": "DECK ON FIRE",
  sinking: "SHIP IS SINKING",
}

/** A hull as drawn this frame: the ship's state settled by its damage, its crew ship id and team. */
export type DrawnShip = Ship & { id: number; team: number }

/** Where this player is: at a ship's helm, a pilot of one of its jets, or not aboard yet. */
export type Role = "helm" | "pilot" | "gunner" | "none"

/**
 * The flight module's seam. The game calls `start` whenever this player begins a sortie as a pilot (joining as one,
 * launching from the helm, or back on the deck after a flight), then `update` every frame instead of driving the ship
 * camera, and `stop` when the sortie ends (recovered, took the helm, left). The flight side calls `recover` when the
 * flight ends (landed, or crashed: a crash, shot down or lost off the map); there is no manual way out of a flight.
 */
export type FlightSeam = {
  start(ctx: { ship: number; slot: number; vehicle?: VehicleKind; deck: () => Ship | null; recover: (how: RecoverHow) => void; ships?: () => readonly Ship[] }): void
  /** Drives the camera; return false to let the game show the carrier instead. `paused`: a menu has the mouse. */
  update(dt: number, t: number, aspect: number, paused?: boolean): boolean
  stop(): void
  /** Every frame whatever the role, after the camera is placed: every jet in the room. */
  frame?(v: FlightFrame): void
  /** After `frame`: every other jet as the weapons see it now, and the jets' combat world (for the ship guns). */
  targets?(): { jets: readonly Target[]; world: CombatWorld }
}

export type GameDeps = { renderer: Renderer; camera: Camera; input: Input; hud: Hud; net: Net; params: URLSearchParams; flight?: FlightSeam }

export type Game = {
  /** Call once the world is known (again when it changes). */
  setWorld(sea: Sea, arch: Archipelago): void
  /** Swap the connection (menu → room). */
  setNet(net: Net): void
  /** The flight module, once it exists. */
  setFlight(flight: FlightSeam | null): void
  /** The ship guns (src/gunnery/gunnery.ts): a gunner's first-person turret, and everyone's turrets and their fire. */
  setGunnery(gunnery: Gunnery | null): void
  /** The boat (src/boat/seam.ts): a driver's boat, and everyone's boats. */
  setBoat(boat: BoatModule | null): void
  /** True while a menu or the roster has the mouse: no helm keys or look drags reach the game. */
  paused: boolean
  /**
   * Advances the ships to sea time `t` and, unless the free camera is on, drives the camera. Returns false when the
   * caller should run the free orbit camera instead (free mode, or before the world exists).
   */
  update(dt: number, t: number, aspect: number): boolean
  readonly state: { ship: Ship | null; helm: Helm; free: boolean; sea: Sea | null; role: Role; shipId: number; sortie: number }
  /** Remote ships as floated here, for debugging and the multi-page captures. */
  remoteStates(): { id: number; x: number; z: number; heading: number; heave: number; pitch: number; roll: number; t: number }[]
}

/**
 * Every carrier in the room and this player's place on one. The room simulates every ship; the helm's client predicts
 * its own ship on the shared simulation (shared/ship.ts, fixed tick, rendered between the last two ticks) and glides
 * it onto the room's pose, and every other hull is dead-reckoned from its plan pose and floated on the local sea. Your
 * role decides the controls and camera: the helm drives with the chase camera, a pilot hands over to the flight
 * module. Offline (`?seed`), the local ship is simulated here whatever the role. Free orbit camera with `?free` (or
 * `?cam=`), toggled with C.
 */
export function createGame({ renderer, camera, input, hud, net: firstNet, params, flight: firstFlight }: GameDeps): Game {
  const pass = new ShipPass(renderer, buildCarrier())
  renderer.addPass("opaque", pass)
  // The weapons' turrets and barrels, trained to their gunners' aim (the pedestals are baked into the hull).
  const turrets = new TurretPass(renderer)
  renderer.addPass("opaque", turrets)
  let gunnery: Gunnery | null = null
  let lastMount = -1
  let boat: BoatModule | null = null
  let lastBoatSortie = -1
  const wake = new Wake(renderer)
  renderer.addPass("alpha", wake)
  let net = firstNet
  let flight = firstFlight ?? null
  const helm = new Helm()
  const chase = new ChaseCam()
  const blend = new CamBlend()
  const remotes = new Remotes()
  /** Every hull as drawn this frame by ship id, settled by its damage (shared/fleet.ts), with its id and team: remote
   *  jets on the catapult are placed on them, rounds and jets hit them. */
  const drawn = new Map<number, DrawnShip>()
  const drawnList: DrawnShip[] = []
  const state: Game["state"] = { ship: null, helm, free: params.has("free") || params.has("cam"), sea: null, role: "none", shipId: -1, sortie: -1 }
  const frozen = params.has("t")
  let sea: Sea | null = null
  let arch: Archipelago | null = null
  /** Where ships face at the start: toward the centrepiece island. */
  let heading0 = 0
  // The predicted ship (this client's own while at its helm, or always offline): its id, and its last two ticks.
  let predicted = -1
  const cur = makeShip(0, 0, 0)
  const prev = makeShip(0, 0, 0)
  const draw = makeShip(0, 0, 0)
  const bumpOut = makeContact()
  /** My ship as drawn this frame (predicted or remote), for the cameras and the HUD. */
  const mine = makeShip(0, 0, 0)
  let hasMine = false
  const drawPose: ShipDrawPose = { x: 0, heave: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0 }
  const target = { x: 0, z: 0, heading: 0 }
  let simT = 0
  let lastRole: Role = "none"
  let lastShip = -1
  let lastSortie = -1
  const controls = { throttle: 0, rudder: 0 }

  function setWorld(s: Sea, a: Archipelago): void {
    sea = s
    arch = a
    state.sea = s
    const goal = a.islands[0]
    heading0 = goal ? headingTo(0, 0, goal.x, goal.z) : 0
    predicted = -1
    remotes.ships.clear()
    chase.reset()
    wake.reset()
  }

  /** Ship `id`'s draw pose, wearing its team's colour. */
  function toPose(s: Ship, t: number, id: number): ShipDrawPose {
    drawPose.accent = shipTeamColor(net.crew, id)
    drawPose.x = s.x
    drawPose.z = s.z
    drawPose.heave = s.heave
    drawPose.heading = s.heading
    drawPose.pitch = s.pitch
    drawPose.roll = s.roll
    drawPose.radar = (t * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    return drawPose
  }

  /** Starts predicting ship `id`: from its floated remote hull if we have one, else its room pose, else (offline) its spawn. */
  function beginPredict(id: number, crew: Crew, t: number): void {
    predicted = id
    const r = remotes.ships.get(id)
    const tuple = net.ships.get(id)
    if (r) copyShip(r.ship, cur)
    else if (tuple) {
      const p = poseFromShip(tuple)
      Object.assign(cur, makeShip(p.x, p.z, p.heading, t), { u: p.u, v: p.v, r: p.r, order: p.order, rudder: p.rudder, power: tuple[10] })
    } else {
      const s = shipOf(crew, id)!
      const at = arch ? fleetSpawn(arch, s.team) : spawnAt(s.team, heading0)
      Object.assign(cur, makeShip(at.x, at.z, at.heading, t))
    }
    cur.t = t
    copyShip(cur, prev)
    // Take over the throttle where it was; the rudder centres.
    helm.order = cur.order
    remotes.ships.delete(id)
  }

  /** Glides the predicted ship onto the room's pose for it, dead-reckoned to our sea time. */
  function reconcile(pose: ShipPose, dt: number): void {
    extrapolatePose(pose, cur.t, target)
    const dx = target.x - cur.x
    const dz = target.z - cur.z
    const dh = Math.atan2(Math.sin(target.heading - cur.heading), Math.cos(target.heading - cur.heading))
    const k = Math.hypot(dx, dz) > SNAP ? 1 : 1 - Math.exp(-dt / CORRECT_LAG)
    for (const s of [cur, prev]) {
      s.x += dx * k
      s.z += dz * k
      s.heading += dh * k
    }
    if (k === 1) {
      cur.u = pose.u
      cur.v = pose.v
      cur.r = pose.r
    }
  }

  function roleOf(me: CrewPlayer | undefined): Role {
    return me ? me.role : "none"
  }

  /**
   * Starts and stops the flight module with each sortie: a pilot holding an aircraft slot flies (a new ship or sortie
   * count is a fresh jet on the catapult); a pilot on deck waiting for a slot watches the ship.
   */
  function flightChange(role: Role, me: CrewPlayer | undefined): void {
    // A boat slot is the boat module's sortie, not a jet's.
    const inBoat = !!me && me.role === "pilot" && me.plane >= 0 && playerBoat(net.crew, me.id)
    const boatSortie = inBoat ? me!.sortie : -1
    if (lastBoatSortie >= 0 && boatSortie !== lastBoatSortie) {
      boat?.stop()
      chase.reset()
      blend.begin(camera, 1.1)
    }
    if (boatSortie >= 0 && boatSortie !== lastBoatSortie && me) {
      boat?.start({ ship: me.ship, slot: me.plane, home: () => drawn.get(state.shipId) ?? null, recover: (how) => net.recover(how) }, simT)
      blend.begin(camera, 1.3)
    }
    lastBoatSortie = boatSortie
    const sortie = me && me.role === "pilot" && me.plane >= 0 && !inBoat ? me.sortie : -1
    // A new sortie is a fresh jet. A ship change with the same sortie is a jet rescued from a sunk carrier: it flies on.
    const fresh = sortie >= 0 && sortie !== lastSortie
    if (lastSortie >= 0 && (sortie < 0 || fresh)) flight?.stop()
    if (fresh && me) flight?.start({ ship: me.ship, slot: me.plane, vehicle: playerVehicle(net.crew, me.id), deck: () => (hasMine ? mine : null), recover: (how) => net.recover(how), ships: () => drawnList })
    if (role !== lastRole || me?.ship !== lastShip) {
      // Helm ↔ jet: ease the view across instead of cutting.
      if ((role === "pilot") !== (lastRole === "pilot") && lastRole !== "none") blend.begin(camera, role === "pilot" ? 1.3 : 1.1)
      if (role === "helm" || me?.ship !== lastShip) chase.reset()
    }
    // A gun seat: the first-person turret on that mount; leaving it (another operation, the ship sank) hands back.
    const mount = role === "gunner" && me ? me.mount : -1
    if (mount !== lastMount || (mount >= 0 && me?.ship !== lastShip)) {
      if (mount >= 0 && me) {
        gunnery?.man(me.ship, mount)
        if (lastRole !== "gunner") blend.begin(camera, 0.9)
      } else {
        gunnery?.unman()
        if (lastRole === "gunner") {
          chase.reset()
          blend.begin(camera, 0.9)
        }
      }
      lastMount = mount
    }
    lastRole = role
    lastShip = me?.ship ?? -1
    lastSortie = sortie
  }

  function update(dt: number, t: number, aspect: number): boolean {
    // C is the free camera aboard; in the air it belongs to the jet (chase / cockpit).
    if (!game.paused && state.role !== "pilot" && input.pressed("KeyC")) {
      state.free = !state.free
      // The free camera keeps its drag-to-orbit: let go of the mouse.
      if (state.free) input.unlock()
      else chase.reset()
    }
    if (!sea) {
      simT = frozen ? simT + dt : t
      return false
    }
    const crew = net.crew
    const me = crew ? playerOf(crew, net.id) : undefined
    const role = roleOf(me)
    // Aboard (helm, on deck or flying) and not in the free camera: a click on the canvas takes Pointer Lock.
    input.lockable = role !== "none" && !state.free && !game.paused
    const shipId = me?.ship ?? -1
    flightChange(role, me)
    state.role = role
    state.shipId = shipId
    state.sortie = me?.sortie ?? -1
    const offline = net.state === "offline"
    const predict = !!crew && !!me && (role === "helm" || offline)
    if (predict && predicted !== shipId) beginPredict(shipId, crew!, simT)
    if (!predict && predicted !== -1) {
      remotes.adopt(predicted, cur, net.ships)
      predicted = -1
    }
    state.ship = predicted >= 0 ? cur : null

    const driving = role === "helm" && !state.free && !game.paused
    if (driving) helm.update(input, dt)
    controls.throttle = role === "helm" ? helm.order : cur.order
    controls.rudder = driving ? helm.rudder : 0
    // The room limits a damaged ship the same way (a wrecked bridge, a sinking hull): predict with the same limits.
    const lim = hullLimits(net.hulls.get(shipId))
    controls.throttle *= lim.speed
    controls.rudder *= lim.turn

    // The simulation runs on sea time (with ?t the sea is frozen, so the ships keep their own clock).
    const base = predicted >= 0 ? cur.t : simT
    const goal = frozen ? base + dt : t
    let now = base
    if (goal - now > MAX_CATCHUP || goal < now - 1) {
      now = goal - SHIP.tick
      if (predicted >= 0) cur.t = now
      remotes.step(sea, now, 0)
    }
    remotes.sync(net.ships, predicted)
    while (now + SHIP.tick <= goal) {
      if (predicted >= 0) {
        copyShip(cur, prev)
        shipStep(cur, controls, sea, arch, SHIP.tick)
      }
      now += SHIP.tick
      remotes.step(sea, now, SHIP.tick)
      // Our hull stops against the others where the room's does (the room moves them and decides the damage).
      if (predicted >= 0) for (const [id, r] of remotes.ships) if (hullSolid(net.hulls.get(id), now)) collideHulls(cur, r.ship, bumpOut, true)
    }
    simT = now
    // The room's collisions: a shake on both hulls and one hull-slam sound (ship-audio.ts plays a new `slams`).
    if (net.bumps?.length) {
      for (const m of net.bumps.splice(0)) {
        let sound = m.k >= 0.05
        for (const id of [m.a, m.b]) {
          const s = id === predicted ? cur : remotes.ships.get(id)?.ship
          if (!s) continue
          s.slam = Math.max(s.slam, m.k)
          if (sound) s.slams++
          sound = false
        }
      }
    }
    const k = Math.max(0, Math.min(1, (goal - now) / SHIP.tick))
    if (predicted >= 0) {
      const tuple = net.ships.get(predicted)
      if (tuple && !offline) reconcile(poseFromShip(tuple), dt)
      lerpShip(prev, cur, k, draw)
    }
    if (role === "helm") net.sendHelm(controls.throttle, controls.rudder)
    // Taking the helm and launching happen only in the DEPLOY menu (src/ui/ops-menu.ts).

    pass.begin()
    turrets.begin(camera.eye)
    wake.begin(sea, simT, camera.eye)
    hasMine = false
    // Each hull settled by its damage: lower and listing, down by the bow while sinking (the same offset the room hits).
    const keep = (id: number, s: Ship): DrawnShip => {
      let d = drawn.get(id)
      if (!d) drawn.set(id, (d = Object.assign(makeShip(0, 0, 0), { id, team: 0 })))
      settled(s, net.hulls.get(id), t, d)
      d.id = id
      d.team = crew ? (shipOf(crew, id)?.team ?? 0) : 0
      drawnList.push(d)
      return d
    }
    drawnList.length = 0
    if (predicted >= 0) {
      const d = keep(predicted, draw)
      const pose = toPose(d, t, predicted)
      pass.add(pose)
      turrets.add(pose, gunnery?.anglesFor(predicted) ?? null)
      wake.ship(predicted, d)
      copyShip(d, mine)
      hasMine = true
    }
    for (const [id, r] of remotes.interpolated(k)) {
      const d = keep(id, r)
      const pose = toPose(d, t, id)
      pass.add(pose)
      turrets.add(pose, gunnery?.anglesFor(id) ?? null)
      wake.ship(id, d)
      if (id === shipId) {
        copyShip(d, mine)
        hasMine = true
      }
    }
    for (const id of drawn.keys()) if (!drawnList.includes(drawn.get(id)!)) drawn.delete(id)
    pass.upload()
    turrets.upload()
    wake.upload()

    const ship = crew && me ? shipOf(crew, me.ship) : undefined
    const refused = net.refused && performance.now() - net.refused.at < FLASH_MS ? (REFUSED[net.refused.error] ?? `CAN'T: ${net.refused.error.replace(/-/g, " ")}`) : ""
    hud.seat(
      me && ship
        ? {
            role: role === "helm" ? "HELM" : role === "gunner" ? "GUNNER" : "PILOT",
            ship: ship.name,
            state: role === "pilot" && me.plane < 0 ? "ON DECK" : role === "gunner" ? (gunOp(me.mount)?.label ?? "") : lastBoatSortie >= 0 ? "BOAT" : "",
            captain: ship.captain === me.id,
            color: me ? teamCss(me.team) : "",
            flash: refused,
          }
        : null,
    )
    hud.ship(hasMine && role === "helm" ? { order: mine.order, power: mine.power, knots: Math.abs(mine.u) / KNOT, heading: mine.heading, rudder: mine.rudder } : null)
    const drove = drive(dt, t, aspect, role)
    if (drove) blend.apply(camera, dt, aspect)
    flight?.frame?.({
      t,
      dt,
      paused: game.paused,
      crew,
      planes: net.planes,
      ship: (id) => drawn.get(id) ?? null,
      ships: drawnList,
      hulls: net.hulls,
      eye: camera.eye,
    })
    // Every boat, after the jets' effects began (their lights share a pass); boats become everyone's targets.
    boat?.frame({ t, dt, paused: game.paused, crew, ship: (id) => drawn.get(id) ?? null, ships: drawnList, jets: flight?.targets?.().jets ?? [], eye: camera.eye, fov: camera.fov })
    if (gunnery) {
      // The room's turrets, launches and bursts, then everyone's guns this frame.
      for (const m of net.gunnery) {
        if (m.type === "turrets") gunnery.remoteTurrets(m.t)
        else if (m.type === "gfire") gunnery.remoteFire(unpackGunFire(m.id, m.g))
        else gunnery.apply(unpackGunBoom(m.b))
      }
      net.gunnery.length = 0
      const tg = flight?.targets?.()
      const g = gunnery
      gunnery.frame({
        t,
        dt,
        paused: game.paused,
        ships: drawnList,
        jets: boat ? [...(tg?.jets ?? []), ...boat.targets()] : (tg?.jets ?? []),
        combat: tg?.world ?? null,
        eye: camera.eye,
        fov: camera.fov,
        project: role === "gunner" && drove && !state.free ? (x, y, z) => g.cam.project(x, y, z, innerWidth, innerHeight) : null,
      })
    }
    return drove
  }

  /** Places the camera for this player's role. False: the caller runs the free orbit camera. */
  function drive(dt: number, t: number, aspect: number, role: Role): boolean {
    if (role === "pilot" && boat?.active && boat.update(dt, t, camera, aspect, { ships: drawnList, jets: flight?.targets?.().jets ?? [] }, game.paused)) return true
    if (role === "pilot" && flight?.update(dt, t, aspect, game.paused)) return true
    if (role === "gunner" && gunnery) {
      // The turret keeps reporting in the free camera; only the first-person view gives way.
      const g = gunnery
      if (g.update(dt, t, aspect, drawn.get(state.shipId) ?? null, game.paused || state.free) && !state.free) {
        camera.lookAlong(g.cam.eye, g.cam.forward, g.cam.up, g.cam.fov, aspect)
        return true
      }
    }
    if (state.free) return false
    const look = { dx: game.paused ? 0 : input.dragX, dy: game.paused ? 0 : input.dragY, wheel: game.paused ? 0 : input.wheel, dragging: !game.paused && input.dragging }
    if (!hasMine) return false
    chase.update(camera, { x: mine.x, z: mine.z, heave: mine.heave, heading: mine.heading, speed: mine.u, topSpeed: SHIP.topSpeed, trauma: Math.max(mine.ground, mine.slam * 0.85) }, dt, aspect, look)
    return true
  }

  const remoteStates = () => [...remotes.ships].map(([id, r]) => ({ id, x: r.ship.x, z: r.ship.z, heading: r.ship.heading, heave: r.ship.heave, pitch: r.ship.pitch, roll: r.ship.roll, t: r.ship.t }))

  const game: Game = {
    setWorld,
    setNet(n: Net) {
      net = n
      predicted = -1
      remotes.ships.clear()
    },
    setFlight(f: FlightSeam | null) {
      flight = f
    },
    setGunnery(g: Gunnery | null) {
      gunnery = g
    },
    setBoat(b: BoatModule | null) {
      boat = b
    },
    paused: false,
    update,
    state,
    remoteStates,
  }
  return game
}
