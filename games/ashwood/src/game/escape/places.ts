// Where the motor-pool shed and Truck 2 are (no three.js: chapters and checks import this).

/** Shed interior footprint and the slab top (m, world). */
export const SHED = { x0: -52.4, x1: -47.1, z0: -39.4, z1: -31.0, y: 0.06, eaveFront: 3.25, eaveBack: 2.95 }
/** Truck 2 parked: centre on the slab, facing north (model -Z = world -Z). */
export const TRUCK_PARK = { x: (SHED.x0 + SHED.x1) / 2, z: -35.5, yaw: 0 }
