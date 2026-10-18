import * as THREE from "three/webgpu"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import type { WorldContext } from "../world/context"
import { heightAt } from "../world/height"
import type { Player } from "../player"
import { BODY_CONTROLS, BODY_LAYER, HEAD_LAYER, PlayerBody } from "./body"

// The body in the game: a PlayerBody fed the controller's PlayerState every frame, on the view camera's layers, in the
// lamps' shadow maps (not the flashlight's: its beam starts at your face), with E reaching for the handle.
// `?body=0` (automation) starts with it hidden; the Lab panel's Body group has every tunable.

/** A layer nothing renders: gives the flashlight's shadow camera its own mask (layer 0 alone means "copy the view's"). */
const SPARE_LAYER = 5

export function createGameBody(ctx: WorldContext, player: Player) {
  ctx.settings["body.show"] ??= ctx.params.get("body") !== "0"
  ctx.settings["body.lampShadows"] ??= true
  ctx.controls.push(
    { key: "body.show", label: "Show body", group: "Body", type: "toggle" },
    { key: "body.lampShadows", label: "Body in lamp shadows", group: "Body", type: "toggle" },
    ...BODY_CONTROLS,
  )
  const ground = (x: number, z: number, maxY: number) => {
    let g = heightAt(x, z)
    for (const f of ctx.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
    }
    return g
  }
  const camera = ctx.camera
  camera.layers.enable(BODY_LAYER)
  const body = new PlayerBody({
    url: `${import.meta.env.BASE_URL}models/player/janitor.glb`,
    settings: ctx.settings,
    ground,
    // Compile off the critical path with a camera that also sees the head layer; the view keeps rendering meanwhile.
    compile: (root) => {
      const probe = camera.clone()
      probe.layers.enable(HEAD_LAYER)
      return ctx.renderer.compileAsync(root, probe, ctx.scene)
    },
  })
  body.ready.then(() => ctx.scene.add(body.root)).catch((e: unknown) => console.error("player body:", e))
  if (!ctx.params.has("shot")) {
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyE" && !e.repeat && !isEditableEventTarget(e.target)) body.reach()
    })
  }
  const shadows = shadowHook(ctx, player)
  return {
    body,
    update(dt: number) {
      if (ctx.settings["body.show"] === false) {
        body.root.visible = false
        return
      }
      body.update(dt, player.state)
      if (body.root.visible && ctx.settings["body.lampShadows"] !== false) shadows(body.root.position)
    },
  }
}

/**
 * Lamp shadow maps add the body/head layers and re-render while the body stands in their cone (they are static
 * otherwise); the flashlight's map gets a mask without the body.
 */
function shadowHook(ctx: WorldContext, player: Player) {
  let lights: THREE.SpotLight[] = []
  let frame = 0
  const p = new THREE.Vector3()
  const d = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const at = new THREE.Vector3()
  return (feet: THREE.Vector3) => {
    if (frame++ % 30 === 0) {
      lights = []
      const eye = player.state.eye
      for (const o of ctx.scene.children) {
        const l = o as THREE.SpotLight
        if (!l.isSpotLight || !l.castShadow) continue
        const flash = Math.hypot(l.position.x - eye.x, l.position.y - eye.y, l.position.z - eye.z) < 1
        l.shadow.camera.layers.mask = flash ? (1 << 0) | (1 << SPARE_LAYER) : (1 << 0) | (1 << BODY_LAYER) | (1 << HEAD_LAYER)
        if (!flash) lights.push(l)
      }
    }
    at.copy(feet).setY(feet.y + 1)
    for (const l of lights) {
      if (l.intensity <= 0) continue
      l.getWorldPosition(p)
      if (p.distanceTo(at) > l.distance) continue
      d.copy(at).sub(p).normalize()
      l.target.getWorldPosition(dir).sub(p).normalize()
      if (d.dot(dir) < Math.cos(l.angle + 0.15)) continue
      l.shadow.needsUpdate = true
    }
  }
}
