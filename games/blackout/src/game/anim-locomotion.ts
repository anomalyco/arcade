import type { Avatar } from "./anim"
import { animation } from "./anim-settings"
import * as human from "@arcade/kit/human-locomotion"
import type { HumanProfile } from "@arcade/kit/human-profile"
export { newMotion, angleSpring, stiffness, plantedFoot, pelvisPoint } from "@arcade/kit/human-locomotion"

export const gaitAt = (speed: number, back = false, strafe = 0) => human.gaitAt(speed, back, strafe, animation)
export const locomotion = (a: Avatar, dt: number, distance: number, teleport: boolean, profile: HumanProfile = a.profile ?? animation) => human.locomotion(a, dt, distance, teleport, profile)
