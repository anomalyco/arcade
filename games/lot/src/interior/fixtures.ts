import type { RectEmitter } from "@arcade/kit/gpu/lights/rect"
import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"

/** The lit lobby fitting is a 600 × 1200 mm prismatic panel, centred in the source's ceiling grid. */
export function lobbyTroffer(lamp: { position: readonly number[]; kind: string }): RectEmitter | undefined {
  return lamp.kind === "fluorescent" && Math.abs(lamp.position[0]!) < 0.01 && Math.abs(lamp.position[2]! - 15.6) < 0.01
    ? { halfWidth: 0.3, halfLength: 0.6 } : undefined
}

/** Four-point Gaussian quadrature of the same panel for the shared fog integrator; weights preserve total flux. */
export function trofferFog(lamp: FogLamp, rect?: RectEmitter): FogLamp[] {
  if (!rect) return [lamp]
  return [[-1,-1],[-1,1],[1,-1],[1,1]].map(([x,z],i)=>({ ...lamp,
    id: 1000 + (lamp.id ?? 0)*4 + i,
    x: lamp.x + x!*rect.halfWidth/Math.sqrt(3), z: lamp.z + z!*rect.halfLength/Math.sqrt(3),
    intensity: lamp.intensity*0.25, size: Math.min(rect.halfWidth,rect.halfLength)*0.5,
  }))
}
