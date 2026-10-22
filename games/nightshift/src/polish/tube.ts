import { lampFlicker } from "@arcade/kit/gpu/lights/flicker"

export type TubeSignal={level:number;crackle:number}
/** One clock and one seed for the tube, emitted light, electrodes and ballast. */
export function tubeSignal(time:number,amount:number):TubeSignal {
  const level=lampFlicker("fluorescent",87,time,amount).level
  // A short starter transient only at abrupt ignition/extinction edges, independent of frame rate.
  const before=lampFlicker("fluorescent",87,Math.max(0,time-.018),amount).level
  return {level,crackle:Math.max(0,Math.abs(level-before)-.08)}
}
