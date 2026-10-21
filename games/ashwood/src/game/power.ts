import { power } from "../world/power"
import { transmitter } from "../world/interior/storeys/s3/transmitter-state"

// The run's mains (world/power.ts): out from the start of the run (the drive in, the climb to 3-08) until the MAIN POWER
// switch on TX-1 is thrown (the beat's "warming" phase; storeys/s3/transmitter.ts plays the breaker). A run that starts
// past it (a chapter, a checkpoint) has the power on from the first frame.

let bound = false

/** Called as a run starts (the flow enters "intro"). */
export function powerForRun() {
  if (!transmitter.reached("warming")) power.set(false, { instant: true })
  if (bound) return
  bound = true
  transmitter.on((p) => {
    if (power.on || !transmitter.reached("warming")) return
    power.set(true, { instant: p !== "warming" })
  })
}
