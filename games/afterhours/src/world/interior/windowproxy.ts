import type * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { Builder, FLOOR_Y, T, glow, paint } from "./kit"
import { type Face, SHELL, WINDOWS } from "./plan"

// Lit-window proxies: from outside, beyond the distance at which you'd see into a room, a storey's walls, floors, doors
// and washrooms are hidden and each facade window shows a flat card 0.35 m inside the glass instead: a dim fluorescent
// glow where a lamp lights the room behind it, near-black where the room is dark. Two draws per storey.

const LIT = glow(0x1a1c18, 0xb8c4a8, 0.55, "window_proxy_lit")
const DARK = paint(0x050605, 0.95)
const INSET = 0.35

/** Builds one proxy group per storey (hidden by default) and returns them. */
export async function buildWindowProxies(ctx: WorldContext, storeys: number, pause: () => Promise<void>): Promise<THREE.Object3D[]> {
  const out: THREE.Object3D[] = []
  for (let i = 0; i < storeys; i++) {
    await pause()
    const b = new Builder(ctx, `window-proxy-${i}`, i)
    b.depthShared = false
    const lamps = ctx.lamps.filter((l) => l.zone === `interior:${i}` && l.intensity > 0 && l.kind !== "exit" && l.kind !== "warning")
    for (const face of ["north", "south", "west", "east"] as Face[]) {
      for (const w of WINDOWS(i, face)) {
        const u = (w.u0 + w.u1) / 2
        const [x, z, rot] =
          face === "north" ? [u, SHELL.z0 + INSET, Math.PI] : face === "south" ? [u, SHELL.z1 - INSET, 0] : face === "west" ? [SHELL.x0 + INSET, u, -Math.PI / 2] : [SHELL.x1 - INSET, u, Math.PI / 2]
        const lit = lamps.some((l) => Math.hypot(l.position[0] - x, l.position[2] - z) < 5.5)
        b.quad(lit ? LIT : DARK, T(x, FLOOR_Y + (w.sill + w.head) / 2, z, rot), w.u1 - w.u0 + 0.1, w.head - w.sill + 0.1, { cast: false })
      }
    }
    // Flat cards inside the glass: nothing to separate.
    b.separated = true
    b.flush(ctx.scene)
    b.group.visible = false
    out.push(b.group)
  }
  return out
}
