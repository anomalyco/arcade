import type * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { Builder, FLOOR_Y, T, glow, paint } from "./kit"
import { windowLight } from "./lighting-state"
import { type Face, SHELL, WINDOWS } from "./plan"

// Lit-window proxies: from outside, beyond the distance at which you'd see into a room, a storey's walls, floors, doors
// and washrooms are hidden and each facade window shows a flat card 0.35 m inside the glass instead, lit in the colour
// and strength the 3 a.m. lighting state (lighting-state.ts) gives that bay, near-black where the room is dark.

const lit = new Map<string, ReturnType<typeof glow>>()
const litMat = (tint: readonly [number, number, number], strength: number) => {
  const k = Math.max(1, Math.round(strength * 3)) / 3
  const key = `${tint.join()}|${k}`
  let m = lit.get(key)
  if (!m) {
    const hex = (v: number) => Math.round(Math.min(1, v / 1.5) * 255)
    lit.set(key, (m = glow(0x101010, (hex(tint[0]) << 16) | (hex(tint[1]) << 8) | hex(tint[2]), 0.7 * k, `window_proxy_${lit.size}`)))
  }
  return m
}
const DARK = paint(0x050605, 0.95)
const INSET = 0.35

/** Builds one proxy group per storey (hidden by default) and returns them. */
export async function buildWindowProxies(ctx: WorldContext, storeys: number, pause: () => Promise<void>): Promise<THREE.Object3D[]> {
  const out: THREE.Object3D[] = []
  for (let i = 0; i < storeys; i++) {
    await pause()
    const b = new Builder(ctx, `window-proxy-${i}`, i)
    b.depthShared = false
    for (const face of ["north", "south", "west", "east"] as Face[]) {
      for (const w of WINDOWS(i, face)) {
        const u = (w.u0 + w.u1) / 2
        const [x, z, rot] =
          face === "north" ? [u, SHELL.z0 + INSET, Math.PI] : face === "south" ? [u, SHELL.z1 - INSET, 0] : face === "west" ? [SHELL.x0 + INSET, u, -Math.PI / 2] : [SHELL.x1 - INSET, u, Math.PI / 2]
        const l = windowLight(i, face, u)
        b.quad(l ? litMat(l.tint, l.strength) : DARK, T(x, FLOOR_Y + (w.sill + w.head) / 2, z, rot), w.u1 - w.u0 + 0.1, w.head - w.sill + 0.1, { cast: false })
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
