import type { Avatar } from "./anim"
import { animation } from "./anim-settings"
import * as human from "../human-locomotion"
import type { HumanProfile } from "../human-profile"
export { newMotion, angleSpring, stiffness, plantedFoot, pelvisPoint, stepGait } from "../human-locomotion"

export const gaitAt = (speed: number, back = false, strafe = 0) => human.gaitAt(speed, back, strafe, animation)
export const locomotion = (a: Avatar, dt: number, distance: number, teleport: boolean, profile: HumanProfile = a.profile ?? animation) => human.locomotion(a, dt, distance, teleport, profile)
