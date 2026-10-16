import * as THREE from "three/webgpu"
import type { WorldContext } from "../world/context"
import type { Player } from "../player"

// Placeholder light rig: turns registered lamps into plain three.js lights. Replaced by the full rig (clustered
// lighting, shadow budget, glows, in-scattering, flicker).

export function createLighting(ctx: WorldContext, player: Player) {
  ctx.scene.add(new THREE.HemisphereLight(0x1c3a36, 0x0a0d0b, 0.35))
  for (const lamp of ctx.lamps.slice(0, 48)) {
    const color = new THREE.Color(...lamp.color)
    const light = lamp.direction
      ? new THREE.SpotLight(color, lamp.intensity, lamp.range, lamp.angle ?? 0.9, lamp.penumbra ?? 0.6, 2)
      : new THREE.PointLight(color, lamp.intensity, lamp.range, 2)
    light.position.set(...lamp.position)
    if (light instanceof THREE.SpotLight && lamp.direction) {
      light.target.position.set(
        lamp.position[0] + lamp.direction[0],
        lamp.position[1] + lamp.direction[1],
        lamp.position[2] + lamp.direction[2],
      )
      ctx.scene.add(light.target)
    }
    ctx.scene.add(light)
  }
  const flash = new THREE.SpotLight(0xfff1dc, 60, 40, 0.42, 0.5, 2)
  ctx.camera.add(flash)
  ctx.camera.add(flash.target)
  flash.position.set(0.2, -0.15, 0)
  flash.target.position.set(0, -0.2, -5)
  ctx.scene.add(ctx.camera)
  return {
    update(_dt: number, _time: number) {
      flash.visible = player.flashlight
    },
  }
}
