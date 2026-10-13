// Launchable aircraft types: per-type flight tuning, collision probes and carrier geometry (gear, catapult, hook), as
// data. Pure and DOM-free. The ship operation that launches each one is in shared/ops.ts, its weapons in
// shared/weapons.ts LOADOUTS, its model in src/render/plane-glb.ts (the same keys everywhere).
//
// Body frame for every type: +Z nose, +Y up, +X the pilot's left (the GLBs' frame); positions relative to the jet's
// centre (`flight.centre` above the model origin, the lowest belly point) unless noted.
//
// - F/A-18E (`hornet`): PLANE as tuned, twin engines. Unchanged.
// - F-35C (`f35`): a heavier single-engine strike jet. Similar top speed, a little less thrust (it accelerates and
//   recovers energy more slowly), a lower optimal (blue-zone) speed and turn rate, slightly lower roll rate, a higher
//   stall. Smaller than the Hornet (15.6 m long, 13.1 m span, 3.5 m tall with the gear up), so it sits lower on its
//   gear, its hook is shorter and further forward, and its probes are its own.

import { DECK_Y } from "./carrier-spec"
import type { LandingVehicle } from "./landing"
import { PLANE, type PlaneTuning, PROBES, type Vec3 } from "./plane"

export type VehicleKind = "hornet" | "f35"
/** Wire order: a vehicle's code in a plane tuple is its index here (shared/protocol.ts). */
export const VEHICLE_KINDS: readonly VehicleKind[] = ["hornet", "f35"]

export type VehicleSpec = {
  readonly kind: VehicleKind
  /** Designation, "F/A-18E". */
  readonly name: string
  readonly flight: PlaneTuning
  /** Collision probes (body frame from the centre): nose, tail, wingtips, belly, fin tips. */
  readonly probes: readonly Vec3[]
  /** Engines (afterburner plumes). */
  readonly engines: number
  /** Height of the model origin (lowest belly point) above the deck with the gear down (m). */
  readonly gear: number
  /** Catapult time (s) over the ship's one stroke (shared/launch.ts STROKE): sets its acceleration and launch speed. */
  readonly strokeTime: number
  /** Deck-relative landing approach speed (m/s). */
  readonly approachSpeed: number
  /** Body z of the lowered tailhook's tip (from the centre): where the jet meets the wires (art/*-README.md hook pivot
   *  and length, lowered 0.7 rad as plane-glb.ts draws it). */
  readonly hookZ: number
  /** Missile rails (body frame from the centre), the one that fires next first. */
  readonly rails: readonly Vec3[]
  /** Bomb stations (body frame from the centre) in release order; the first `bay` are inside the weapons bay. */
  readonly bombs: readonly Vec3[]
  readonly bay: number
}

const F35_CENTRE = 1.2
/** Model-space store node pivots (art/f35-README.md) → body frame. */
const f35 = (x: number, y: number, z: number): Vec3 => [x, y - F35_CENTRE, z]

export const VEHICLES: Readonly<Record<VehicleKind, VehicleSpec>> = {
  hornet: {
    kind: "hornet",
    name: "F/A-18E",
    flight: PLANE,
    probes: PROBES,
    engines: 2,
    gear: 1.35,
    strokeTime: 4.2,
    approachSpeed: 70,
    hookZ: -6.35 - 1.9 * Math.cos(0.7),
    rails: [
      [6.78, 0.05, -3.1],
      [-6.78, 0.05, -3.1],
    ],
    bombs: [[0, -1.2, 0.5]],
    bay: 0,
  },
  f35: {
    kind: "f35",
    name: "F-35C",
    flight: {
      ...PLANE,
      centre: F35_CENTRE,
      stallSpeed: 58,
      optimalSpeed: 134,
      topSpeed: 180,
      boostSpeed: 230,
      thrust: 14.5,
      cruise: 134 / 180,
      turnBleed: 7.6,
      pitchRate: 0.86,
      rollRate: 3.0,
      yawRate: 0.54,
      pitchLag: 0.14,
      rollLag: 0.09,
      boostTime: 5.5,
    },
    probes: [
      [0, -0.1, 7.8],
      [0, 0.1, -7.6],
      [6.5, 0.3, -2.9],
      [-6.5, 0.3, -2.9],
      [0, -1.2, 0],
      [1.9, 2.3, -6.4],
      [-1.9, 2.3, -6.4],
    ],
    engines: 1,
    gear: 1.05,
    strokeTime: 4.3,
    approachSpeed: 72,
    hookZ: -4.41 - 1.75 * Math.cos(0.7),
    // AIM-9X on the outboard wing stations.
    rails: [f35(5.3, 1.12, -2.45), f35(-5.3, 1.12, -2.45)],
    // Bay first (left, right), then the wing pylons.
    bombs: [f35(0.36, 0.46, 0.015), f35(-0.36, 0.46, 0.015), f35(3.45, 0.939, -1.826), f35(-3.45, 0.939, -1.826)],
    bay: 2,
  },
}

export const isVehicle = (v: unknown): v is VehicleKind => typeof v === "string" && (VEHICLE_KINDS as readonly string[]).includes(v)

/** A plane tuple's vehicle code → kind (missing or unknown: the Hornet, what old clients fly). */
export const vehicleOfCode = (code: number | undefined): VehicleKind => VEHICLE_KINDS[code ?? 0] ?? "hornet"
export const vehicleCode = (kind: VehicleKind): number => Math.max(0, VEHICLE_KINDS.indexOf(kind))

/** Ship-local height of a jet's centre sitting on the deck on its gear. */
export const deckCentreY = (kind: VehicleKind): number => DECK_Y + VEHICLES[kind].gear + VEHICLES[kind].flight.centre

/** What a type brings to the scripted landing (shared/landing.ts `LandingVehicle`): its centre's height above the deck
 *  on its gear, its stall speed, its approach speed, and its touchdown offset from the Hornet's, so its hook meets the
 *  same wires (the F-35C's hook trails its centre ~2 m less, so it touches down ~2 m further aft). */
export const landingVehicle = (kind: VehicleKind): LandingVehicle => LANDINGS[kind]
const landingOf = (v: VehicleSpec): LandingVehicle => ({
  rest: v.gear + v.flight.centre,
  stallSpeed: v.flight.stallSpeed,
  approachSpeed: v.approachSpeed,
  touch: VEHICLES.hornet.hookZ - v.hookZ,
})
const LANDINGS: Readonly<Record<VehicleKind, LandingVehicle>> = { hornet: landingOf(VEHICLES.hornet), f35: landingOf(VEHICLES.f35) }
