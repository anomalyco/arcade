import type { Avatar } from "./anim"
import { animation } from "./anim-settings"
import * as human from "@arcade/kit/human-locomotion"
export { newMotion, angleSpring, stiffness, plantedFoot, pelvisPoint } from "@arcade/kit/human-locomotion"

export const gaitAt = (speed: number, back = false, strafe = 0) => human.gaitAt(speed, back, strafe, animation)
export const locomotion = (a: Avatar, dt: number, distance: number, teleport: boolean) => human.locomotion(a, dt, distance, teleport, a.profile ?? animation)
