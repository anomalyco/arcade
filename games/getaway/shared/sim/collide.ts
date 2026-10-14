import {
  CARS,
  STATIC,
  WALL,
  boxMass,
  collideShapesXZ as collideShapes,
  resolveXZ as resolve,
  separateXZ as separate,
  shapeGapXZ as shapeGap,
  type ContactXZ as Contact,
  type HitXZ as Hit,
  type Mass,
  type PointXZ as Point,
  type Response,
  type RigidXZ as Rigid,
  type ShapeXZ as Shape,
} from "@arcade/kit/sim/obb"
import type { Vehicle } from "../config"
import type { Box } from "./city"

export {
  CARS,
  STATIC,
  WALL,
  collideShapes,
  resolve,
  separate,
  shapeGap,
  type Contact,
  type Hit,
  type Mass,
  type Point,
  type Response,
  type Rigid,
  type Shape,
}

/** Collision box as a fraction of the drawn length and width (the bodywork has rounded corners). */
const INSET = 0.48

export function carHalf(v: Vehicle): [number, number] {
  return [v.length * INSET, v.width * INSET]
}

export function carShape(b: { x: number; z: number; h: number }, v: Vehicle): Shape {
  const [hl, hw] = carHalf(v)
  return { x: b.x, z: b.z, ax: Math.sin(b.h), az: Math.cos(b.h), ea: hl, eb: hw }
}

export function boxShape(box: Box): Shape {
  return { x: (box.x0 + box.x1) / 2, z: (box.z0 + box.z1) / 2, ax: 0, az: 1, ea: (box.z1 - box.z0) / 2, eb: (box.x1 - box.x0) / 2 }
}

export function carMass(v: Vehicle): Mass {
  return boxMass(v.mass, v.length, v.width)
}
