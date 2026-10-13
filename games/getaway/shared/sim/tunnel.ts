import { CELL, ROAD_HALF, WORLD_MAX } from "../config"
import type { Body } from "./vehicle"

/** One street wraps through two dark bores; shared by physics, navigation and geometry. */
export const TUNNEL = { z: 2 * CELL, half: 7, west: -ROAD_HALF - 30, east: WORLD_MAX + 30, westMouth: -ROAD_HALF - 6.5, eastMouth: WORLD_MAX + 6.5 }

export function tunnelLink(a: { x: number; z: number }, b: { x: number; z: number }) {
  return a.z === TUNNEL.z && b.z === TUNNEL.z && ((a.x === TUNNEL.west && b.x === TUNNEL.east) || (a.x === TUNNEL.east && b.x === TUNNEL.west))
}

export function inTunnel(b: { x: number; z: number }) {
  return Math.abs(b.z - TUNNEL.z) < TUNNEL.half && (b.x < TUNNEL.westMouth || b.x > TUNNEL.eastMouth)
}

/** Reflect lateral offset, velocity and yaw in the opposite mouth's frame without changing speed. */
export function crossTunnel(b: Body) {
  if (Math.abs(b.z - TUNNEL.z) >= TUNNEL.half) return false
  if (b.x >= TUNNEL.east && b.vx > 0) b.x = TUNNEL.west + (b.x - TUNNEL.east)
  else if (b.x <= TUNNEL.west && b.vx < 0) b.x = TUNNEL.east + (b.x - TUNNEL.west)
  else return false
  b.z = 2 * TUNNEL.z - b.z
  b.h = Math.PI - b.h
  b.vz = -b.vz
  b.yaw = -b.yaw
  b.tunnels++
  return true
}
