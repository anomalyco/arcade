import type { WorldContext, WorldModule } from "./context"
import { Builder } from "./interior/kit"
import { buildCorridor } from "./interior/corridor"
import { buildLobby } from "./interior/lobby"
import { buildCloset, buildLab } from "./interior/rooms"

// Everything inside the main block's shell: lobby, link corridor, main corridor, the lab and the janitor's closet.

export function build(ctx: WorldContext): WorldModule {
  const b = new Builder(ctx)
  buildLobby(b)
  const corridor = buildCorridor(b)
  buildLab(b)
  buildCloset(b)
  b.flush()
  // Automation only: `icam=x,y,z,yawDeg,pitchDeg` pins the camera for captures of rooms with no named viewpoint.
  const icam = ctx.params.get("icam")?.split(",").map(Number)
  return {
    update(_dt, time, camera) {
      corridor.update(time)
      if (icam && icam.length >= 5) {
        camera.position.set(icam[0]!, icam[1]!, icam[2]!)
        camera.rotation.set((icam[4]! * Math.PI) / 180, (icam[3]! * Math.PI) / 180, 0, "YXZ")
      }
    },
  }
}
