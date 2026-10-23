// Gunnery test harness (gunnery.html, dev only, not built): the sea, islands, our sailing carrier and an enemy carrier
// off the starboard bow, AI target drones, offline, with this player manning one of the ship's guns in first person.
// URL: ?seed=N (world, default 7) ?gunner=ciws|ciws-stbd|sam|sam-port|gun (or a mount index 0-4; default ciws)
// ?drone=N (target drones, default 3) ?flares (drones flare at inbound SAMs) ?ship=0.5 (our throttle) ?enemy=M (enemy
// carrier distance, default 4200) ?chase (start in the orbit view round the turret).
// Mouse aims (click for Pointer Lock), LMB/Space fires, RMB zooms. Digits 1-5 switch mounts (harness only).
// `globalThis.carrier` exposes everything for scripts/gunnery-shot.ts: gunnery, drones, weapons, ship, enemy, track(kind,
// id), incoming(kind), lob(x, z), inspect, hits (enemy ship hits), man(mount).
import "../style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { WEAPON_MOUNTS } from "../../shared/carrier-spec"
import type { CombatWorld } from "../../shared/combat"
import { teamCss } from "../../shared/crew"
import { GUNNERY, type GunWeapon, type GunneryEvent, leadPoint, muzzleWorld, predictImpact, shipPointVel } from "../../shared/gunnery"
import { makeArchipelago, type Archipelago } from "../../shared/islands"
import { type Vec3, shipToWorld, worldToShip } from "../../shared/plane"
import { makeSea, type Sea } from "../../shared/sea"
import { bakeSeabed } from "../../shared/seabed"
import { SHIP, type Ship, copyShip, headingTo, lerpShip, makeShip, shipStep } from "../../shared/ship"
import type { WeaponKind } from "../../shared/weapons"
import { WeaponAudio } from "../audio/weapon-audio"
import { FlightView } from "../flight/camera"
import { Wake } from "../game/wake"
import { ATMOSPHERE, fillAtmosphere } from "../render/atmosphere"
import { buildCarrier } from "../render/carrier-mesh"
import { Clouds } from "../render/clouds"
import { FRAME, FRAME_FLOATS, TIME_WRAP } from "../render/frame"
import { buildIslandMesh } from "../render/island-mesh"
import { Ocean } from "../render/ocean"
import { PlaneFx } from "../render/plane-fx"
import { loadPlaneModels } from "../render/plane-glb"
import { PlanePass } from "../render/plane-pass"
import { DEFAULT_GRADE } from "../render/post"
import { Renderer } from "../render/renderer"
import type { ShipDrawPose } from "../render/ship-pass"
import { Sky } from "../render/sky"
import { teamColor } from "../render/team"
import { TurretPass } from "../render/turret-pass"
import { WeaponFx } from "../render/weapon-fx"
import { Drones } from "../weapons/drones"
import { WeaponHud } from "../weapons/hud"
import { WeaponInput } from "../weapons/input"
import { Weapons } from "../weapons/weapons"
import { TurretCam } from "./camera"
import { Gunnery, type GunShip } from "./gunnery"

const MAX_DPR = 1.5
const RADAR_RPS = 0.25
const ME = 1
const MOUNTS: Record<string, number> = { gun: 0, sam: 1, "sam-stbd": 1, ciws: 2, "ciws-port": 2, "sam-port": 3, "ciws-stbd": 4 }
/** Kill feed weapon kinds until the jets' world knows the gunnery ones. */
const AS_JET: Record<GunWeapon, WeaponKind> = { ciws: "gun", sam: "missile", shell: "bomb" }

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | string> {
  if (!navigator.gpu) return "Carrier needs WebGPU."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter."
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")
  if (!context) return "WebGPU could not start on this canvas."
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

/** Applies gunnery damage to a jet in the jets' world as its own weapons would (health, credit, hp and kill events). */
function hurtJet(world: CombatWorld, id: number, dmg: number, by: number, w: WeaponKind): void {
  const f = world.fighters.get(id)
  if (!f || !f.alive || dmg <= 0) return
  f.hp = Math.max(0, f.hp - dmg)
  f.sent = f.hp
  f.hitAt = world.t
  f.by = by
  f.w = w
  world.events.push({ k: "hp", on: id, hp: Math.round(f.hp * 10) / 10, by, w })
  if (f.hp <= 0) {
    f.alive = false
    world.events.push({ k: "kill", on: id, by, w })
  }
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") {
    hudEl.innerHTML = `<div class="notice"><div class="brand">CARRIER</div><div>${renderer}</div></div>`
    return
  }
  hudEl.innerHTML = `<div id="tl" class="brand">CARRIER</div>`
  const params = new URLSearchParams(location.search)
  const num = (k: string, d: number) => (params.get(k) !== null && params.get(k) !== "" && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d)
  const seed = num("seed", 7) >>> 0
  const g = params.get("gunner") ?? "ciws"
  const startMount = MOUNTS[g] ?? Math.max(0, Math.min(WEAPON_MOUNTS.length - 1, Number(g) || 2))

  const grade = { ...DEFAULT_GRADE }
  const atmosphere = { ...ATMOSPHERE }
  const frame = new Float32Array(FRAME_FLOATS)
  const view = new FlightView()
  const sky = new Sky(renderer)
  const ocean = new Ocean(renderer)
  const clouds = new Clouds(renderer)
  const turrets = new TurretPass(renderer, { hull: buildCarrier() })
  const wake = new Wake(renderer)
  const models = await loadPlaneModels()
  const planePass = new PlanePass(renderer, models)
  const pfx = new PlaneFx(renderer, models)
  const wfx = new WeaponFx(renderer)
  renderer.addPass("sky", sky)
  renderer.addPass("opaque", turrets)
  renderer.addPass("opaque", planePass)
  renderer.addPass("opaque", ocean)
  renderer.addPass("opaque", clouds)
  renderer.addPass("alpha", wake)
  renderer.addPass("alpha", pfx)
  renderer.addPass("alpha", wfx)

  const arch: Archipelago = makeArchipelago(seed)
  renderer.setStatic(buildIslandMesh(arch))
  const sea: Sea = makeSea(seed)
  ocean.setSea(sea)
  clouds.setWorld(seed, sea.wind)
  ocean.setClouds(seed, (t, out) => clouds.drift(t, out))
  ocean.setSeabed(bakeSeabed(arch, 2048))

  const start = performance.now()
  const seaTime = () => (performance.now() - start) / 1000
  const goal = arch.islands[0]
  const heading = goal ? headingTo(0, 0, goal.x, goal.z) : 0
  type Sim = { ship: Ship; prev: Ship; draw: Ship & GunShip; controls: { throttle: number; rudder: number } }
  const sim = (id: number, team: number, x: number, z: number, h: number, throttle: number): Sim => {
    const ship = makeShip(x, z, h, 0)
    const s: Sim = { ship, prev: makeShip(0, 0, 0), draw: Object.assign(makeShip(0, 0, 0), { id, team }), controls: { throttle, rudder: 0 } }
    for (let i = 0; i < 40 / SHIP.tick; i++) shipStep(ship, s.controls, sea, arch, SHIP.tick)
    ship.t = seaTime()
    copyShip(ship, s.prev)
    return s
  }
  const own = sim(1, 0, 0, 0, heading, num("ship", 0.5))
  // The enemy carrier off our starboard bow (gun range), sailing slowly on a parallel course.
  const ed = num("enemy", 4200)
  const at = shipToWorld(own.ship, Math.sin(-0.55) * ed, 0, Math.cos(-0.55) * ed)
  const enemy = sim(2, 1, at[0], at[2], own.ship.heading, 0.25)
  const sims = [own, enemy]
  const ships: (Ship & GunShip)[] = [own.draw, enemy.draw]
  const ground = { sea, arch, ships }

  const weapons = new Weapons(wfx, new WeaponHud(), new WeaponAudio(), new WeaponInput(canvas), null, ground)
  weapons.setPilot(ME, 0, "YOU", teamCss(0))
  const drones = new Drones(num("drone", 3), { centre: [own.ship.x, own.ship.z], hostile: false, flares: params.has("flares"), team: 1 })
  drones.enlist(weapons.world)

  const gunnery = new Gunnery(renderer, canvas, ground)
  gunnery.input.grab = true
  gunnery.setPlayer(ME, 0)
  gunnery.man(own.draw.id, startMount)
  /** Damage to the enemy carrier as the fleet would take it (harness tally). */
  const hits = { direct: 0, near: 0, sam: 0, log: [] as string[] }
  gunnery.onEvent = (e: GunneryEvent) => {
    if (e.k === "hurt") hurtJet(weapons.world, e.on, e.dmg, e.by, AS_JET[e.w])
    else if (e.k === "ship") {
      if (e.w === "sam") hits.sam++
      else if (e.near > 0) hits.near++
      else hits.direct++
      hits.log.push(`${e.w} ship ${e.ship} near ${e.near.toFixed(1)} at ${e.x.toFixed(0)},${e.y.toFixed(0)},${e.z.toFixed(0)}`)
    } else if (e.k === "intercept" && e.store === 0) weapons.world.snap(e.owner, e.seq)
  }
  addEventListener("keydown", (e) => {
    const n = Number(e.key)
    if (n >= 1 && n <= WEAPON_MOUNTS.length) {
      gunnery.unman()
      gunnery.man(own.draw.id, n - 1)
    }
  })

  const shipPose: ShipDrawPose = { x: 0, heave: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0 }
  const lv: Vec3 = [0, 0, 0]
  const lm: Vec3 = [0, 0, 0]
  const sv: Vec3 = [0, 0, 0]

  /** Aim the gunner (scripts): track a drone or a store with lead, every frame. */
  const debug = {
    track: null as null | { kind: "drone" | "store"; id: number },
    inspect: null as null | { yaw: number; pitch: number; dist: number; mount?: number },
    renderer,
    frame,
    grade,
    atmosphere,
    sea,
    arch,
    gunnery,
    weapons,
    drones,
    own,
    enemy,
    hits,
    man(mount: number) {
      gunnery.unman()
      gunnery.man(own.draw.id, mount)
    },
    /** A dumbfire missile (kind "missile") or a bomb (kind "bomb") from drone 100's side, aimed at our carrier. */
    incoming(kind: "missile" | "bomb" = "missile", dist = 2400, side = 0.6) {
      const f = weapons.world.fighters.get(100)
      if (!f) return
      f.missiles = 2
      f.bombs = 4
      f.alive = true
      const s = own.ship
      const target = shipToWorld(s, 0, 20, 60)
      const dir = shipToWorld(s, Math.sin(side) * 1000, 0, Math.cos(side) * 1000)
      const dx = dir[0] - s.x
      const dz = dir[2] - s.z
      const l = Math.hypot(dx, dz)
      if (kind === "missile") {
        const x = target[0] + (dx / l) * dist
        const z = target[2] + (dz / l) * dist
        const y = 160
        const sp = 320
        const tx = target[0] - x
        const ty = target[1] - y + 120
        const tz = target[2] - z
        const tl = Math.hypot(tx, ty, tz)
        weapons.world.fire({ owner: 100, seq: 5000 + Math.floor(Math.random() * 1e6), t: weapons.world.t, x, y, z, vx: (tx / tl) * sp, vy: (ty / tl) * sp, vz: (tz / tl) * sp, target: -1 })
      } else {
        // A bomb released high, falling onto the deck: lead the ship by the fall time.
        const h = 900
        const tf = Math.sqrt((2 * h) / 9.81)
        const vh = 120
        shipPointVel(s, sv)
        const x = target[0] + sv[0] * tf - (-dx / l) * vh * tf
        const z = target[2] + sv[2] * tf - (-dz / l) * vh * tf
        weapons.world.fire({ owner: 100, seq: 7000 + Math.floor(Math.random() * 1e6), t: weapons.world.t, x, y: h, z, vx: (-dx / l) * vh, vy: 0, vz: (-dz / l) * vh, target: -1, kind: "bomb" })
      }
    },
    /** Live drones within `range` m of the manned mount and inside its training arc, nearest first. */
    candidates(range: number): number[] {
      const seat = gunnery.seat
      if (!seat) return []
      const m = WEAPON_MOUNTS[seat.mount]!
      const at = shipToWorld(own.draw, m.pos[0], m.pos[1], m.pos[2])
      return drones.list
        .filter((d) => d.dead < 0)
        .map((d) => {
          const p = d.plane
          const l = worldToShip(own.draw, p.x, p.y, p.z)
          const yaw = Math.atan2(l[0] - m.pos[0], l[2] - m.pos[2])
          return { id: d.id, d: Math.hypot(p.x - at[0], p.y - at[1], p.z - at[2]), ok: yaw > m.yawArc[0] + 0.15 && yaw < m.yawArc[1] - 0.15 }
        })
        .filter((x) => x.ok && x.d < range)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.id)
    },
    /** Lob the gun at a world point: picks the elevation whose predicted impact lands at that range. */
    lob(x: number, z: number) {
      const st = gunnery.status
      if (st.kind !== "gun") return
      const s = own.draw
      muzzleWorld(s, gunnery.seat!.mount, gunnery.turret.yaw, gunnery.turret.pitch, lm, lv)
      const want = Math.hypot(x - lm[0], z - lm[2])
      const h = Math.atan2(x - lm[0], -(z - lm[2]))
      let lo = -0.05
      let hi = 0.6
      for (let i = 0; i < 24; i++) {
        const e = (lo + hi) / 2
        const v = GUNNERY.gun.muzzle
        const ce = Math.cos(e)
        shipPointVel(s, sv)
        const p = predictImpact(lm[0], lm[1], lm[2], sv[0] + Math.sin(h) * ce * v, sv[1] + Math.sin(e) * v, sv[2] - Math.cos(h) * ce * v, s.t, { sea, arch }, undefined)
        const r = Math.hypot(p.x - lm[0], p.z - lm[2])
        if (p.kind === "air" || r > want) hi = e
        else lo = e
      }
      gunnery.aimHeading = h
      gunnery.aimElevation = (lo + hi) / 2
    },
    paused: false,
  }
  const cam = gunnery.cam
  Object.assign(globalThis, { carrier: Object.assign(debug, { camera: cam }) })

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  const orbit = new TurretCam()
  if (params.has("chase")) debug.inspect = { yaw: 2.4, pitch: 0.25, dist: 40 }
  const matrix = new Float32Array(16)
  const enemyAccent = teamColor(1)
  const enemyCss = teamCss(1)
  let last = performance.now()
  let simT = own.ship.t
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = debug.paused ? simT : seaTime()
    for (const s of sims) if (target - s.ship.t > 4) s.ship.t = target - SHIP.tick
    while (own.ship.t + SHIP.tick <= target) {
      for (const s of sims) {
        copyShip(s.ship, s.prev)
        shipStep(s.ship, s.controls, sea, arch, SHIP.tick)
      }
      drones.tick(weapons.world, { sea, arch }, null, () => {})
    }
    simT = own.ship.t
    const k = Math.max(0, Math.min(1, (target - own.ship.t) / SHIP.tick))
    for (const s of sims) lerpShip(s.prev, s.ship, k, s.draw)
    const aspect = canvas.width / canvas.height

    // Scripted tracking: aim at a drone or a store with lead from our muzzle.
    if (debug.track && gunnery.seat) {
      let p: { x: number; y: number; z: number; vx: number; vy: number; vz: number } | null = null
      if (debug.track.kind === "drone") p = drones.list.find((d) => d.id === debug.track!.id && d.dead < 0)?.plane ?? null
      else p = weapons.world.missiles.find((m) => m.alive) ?? null
      if (p) {
        muzzleWorld(own.draw, gunnery.seat.mount, gunnery.turret.yaw, gunnery.turret.pitch, lm, lv)
        shipPointVel(own.draw, sv)
        const kind = WEAPON_MOUNTS[gunnery.seat.mount]!.kind
        const speed = kind === "ciws" ? GUNNERY.ciws.muzzle : kind === "gun" ? GUNNERY.gun.muzzle : 1e6
        leadPoint(lm[0], lm[1], lm[2], sv[0], sv[1], sv[2], speed, p.x, p.y, p.z, p.vx, p.vy, p.vz, kind === "sam" ? 0 : 1, lv)
        const dx = lv[0] - lm[0]
        const dy = lv[1] - lm[1]
        const dz = lv[2] - lm[2]
        gunnery.aimHeading = Math.atan2(dx, -dz)
        gunnery.aimElevation = Math.atan2(dy, Math.hypot(dx, dz))
      }
    }
    const manned = gunnery.update(dt, target, aspect, own.draw, debug.paused)
    if (debug.inspect || !manned) {
      // Screenshot orbit round the manned turret (or the ship's middle): yaw from the bow, pitch up, distance.
      const d = debug.inspect ?? { yaw: 2.4, pitch: 0.3, dist: 420 }
      const m = gunnery.seat ? WEAPON_MOUNTS[d.mount ?? gunnery.seat.mount]!.pos : [0, 30, 0]
      const c = shipToWorld(own.draw, m[0]!, m[1]! + 6, m[2]!)
      const e = shipToWorld(own.draw, m[0]! + Math.sin(d.yaw) * Math.cos(d.pitch) * d.dist, m[1]! + 6 + Math.sin(d.pitch) * d.dist, m[2]! + Math.cos(d.yaw) * Math.cos(d.pitch) * d.dist)
      const f: Vec3 = [c[0] - e[0], c[1] - e[1], c[2] - e[2]]
      const l = Math.hypot(...f)
      orbit.place(dt, e, [f[0] / l, f[1] / l, f[2] / l], [0, 1, 0], (45 * Math.PI) / 180, aspect)
    }
    const view3 = debug.inspect || !manned ? orbit : cam

    planePass.begin()
    pfx.begin(view3.eye, target)
    weapons.beginJets()
    for (const [d, dp] of drones.poses(k)) {
      dp.accent = enemyAccent
      planePass.add(dp)
      const m = planePass.modelMatrix(dp, matrix)
      pfx.plane(d.id, m, dp.throttle, dp.burner, 0)
      const p = d.plane
      weapons.jet(d.id, 1, dp, p.vx, p.vy, p.vz, true, `DRONE ${d.id - 99}`, enemyCss, "hornet", m)
    }
    for (const [id, w] of weapons.wreckPoses()) {
      w.accent = id === ME ? teamColor(0) : enemyAccent
      planePass.add(w)
    }
    const project = (x: number, y: number, z: number) => view3.project(x, y, z, innerWidth, innerHeight)
    weapons.frame(dt, target, view3.eye, view3.fov, innerHeight, project)
    gunnery.frame({ t: target, dt, paused: debug.paused, ships, jets: [...weapons.jets.values()], combat: weapons.world, eye: view3.eye, fov: view3.fov, project: debug.inspect ? null : project })
    planePass.upload()
    pfx.upload()

    turrets.begin(view3.eye)
    wake.begin(sea, own.draw.t, view3.eye)
    for (const s of ships) {
      shipPose.x = s.x
      shipPose.z = s.z
      shipPose.heave = s.heave
      shipPose.heading = s.heading
      shipPose.pitch = s.pitch
      shipPose.roll = s.roll
      shipPose.radar = (target * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
      shipPose.accent = teamColor(s.team)
      turrets.add(shipPose, gunnery.anglesFor(s.id))
      wake.ship(s.id, s)
    }
    turrets.upload()
    wake.upload()

    frame.set(view3.viewProj, FRAME.viewProj)
    frame.set(view3.eye, FRAME.eye)
    frame[FRAME.eye + 3] = ((target % TIME_WRAP) + TIME_WRAP) % TIME_WRAP
    fillAtmosphere(frame, atmosphere)
    frame[FRAME.viewport] = canvas.width
    frame[FRAME.viewport + 1] = canvas.height
    frame[FRAME.viewport + 2] = 1 / canvas.width
    frame[FRAME.viewport + 3] = 1 / canvas.height
    frame.set(view3.forward, FRAME.forward)
    view.set(view3.eye, view3.forward, view3.up, view3.fov, aspect)
    const sunView = atmosphere.sunView ?? atmosphere.sunDir
    sky.update(view, sunView)
    ocean.update(target, view, sunView)
    clouds.update(target, view)
    renderer.render(frame, grade)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
