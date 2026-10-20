import * as THREE from "three/webgpu"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import type { WorldContext } from "../world/context"
import type { DoorHandle } from "../world/doors"
import { heightAt } from "../world/height"
import type { Player } from "../player"
import { VIEW_LAYER } from "./viewmodel"
import { renderState } from "../render/shared"
import { BODY_LAYER, CHARACTERS, CharacterBody, HEAD_LAYER, saveCharacter, savedCharacter } from "./body"

// The player character in the game: a CharacterBody (any roster character, Lab panel Player → Character) fed the
// controller's PlayerState every frame, on the view camera's body layer (its head layer only in shadows, mirrors and
// the third-person debug camera), in the lamps' shadow maps (not the flashlight's: its beam starts at your hand), with
// E reaching for the button or handle the door system just used. `?body=0` (automation) starts with it hidden;
// `?character=<id>` (automation) picks a character without touching the saved choice.

/** A layer nothing renders: gives the flashlight's shadow camera its own mask (layer 0 alone means "copy the view's"). */
const SPARE_LAYER = 5

export function createGameBody(ctx: WorldContext, player: Player) {
  const s = ctx.settings
  const forced = ctx.params.get("character")
  s["player.character"] ??= forced && CHARACTERS.some((c) => c.id === forced) ? forced : savedCharacter()
  s["body.show"] ??= ctx.params.get("body") !== "0"
  s["body.lampShadows"] ??= true
  s["body.view"] ??= ctx.params.get("bodyView") === "third" ? 1 : 0
  s["body.thirdDist"] ??= 2.6
  s["body.look"] ??= 1
  ctx.controls.push(
    { key: "player.character", label: "Character", group: "Player", type: "select", options: CHARACTERS.map((c) => ({ value: c.id, label: c.name })) },
    { key: "body.show", label: "Show body", group: "Body", type: "toggle" },
    { key: "body.lampShadows", label: "Body in lamp shadows", group: "Body", type: "toggle" },
    { key: "body.look", label: "Head and spine follow the view", group: "Body", unit: "×", min: 0, max: 1, step: 0.05 },
    { key: "body.view", label: "Camera", group: "Body", subsection: "Debug", type: "select", options: [{ value: 0, label: "First person" }, { value: 1, label: "Third person (debug)" }] },
    { key: "body.thirdDist", label: "Third-person distance", group: "Body", subsection: "Debug", unit: "m", min: 1, max: 8, step: 0.1 },
  )
  const ground = (x: number, z: number, maxY: number) => {
    let g = heightAt(x, z)
    for (const f of ctx.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) g = f.y
    }
    return g
  }
  const ladderTop = (x: number, y: number, z: number) => {
    const l = ctx.ladders.find((l) => x >= l.min[0] - 0.05 && x <= l.max[0] + 0.05 && z >= l.min[2] - 0.05 && z <= l.max[2] + 0.05 && y + 0.3 >= l.min[1] && y <= l.max[1] + 0.05)
    return l ? l.max[1] : null
  }
  const camera = ctx.camera
  camera.layers.enable(BODY_LAYER)
  camera.layers.enable(VIEW_LAYER)
  // The viewmodel is the view camera's alone: hidden through every other render the frame does first (mirrors),
  // shown again for the main pass. The hooks are kept first and last in the list.
  let vmWas = false
  const vmHide = () => {
    vmWas = body.viewmodel.root.visible
    body.viewmodel.root.visible = false
  }
  const vmShow = () => {
    body.viewmodel.root.visible = vmWas
  }
  const keepHooks = () => {
    const list = renderState.beforeRender
    if (list[0] !== vmHide) {
      const i = list.indexOf(vmHide)
      if (i >= 0) list.splice(i, 1)
      list.unshift(vmHide)
    }
    if (list[list.length - 1] !== vmShow) {
      const i = list.indexOf(vmShow)
      if (i >= 0) list.splice(i, 1)
      list.push(vmShow)
    }
  }
  const body = new CharacterBody({
    character: String(s["player.character"]),
    ground,
    ladderTop,
    // Compile off the critical path with a camera that also sees the head layer; the view keeps rendering meanwhile.
    compile: (root) => {
      const probe = camera.clone()
      probe.layers.enable(HEAD_LAYER)
      return ctx.renderer.compileAsync(root, probe, ctx.scene)
    },
  })
  body.ready.then(() => ctx.scene.add(body.root)).catch((e: unknown) => console.error("player body:", e))

  // E: the door system picks the target; the body reaches for it (a small control is a button, the rest are handles).
  const doors = ctx.doors
  const use = doors.use.bind(doors)
  let usedAt = -Infinity
  doors.use = (): DoorHandle | null => {
    const d = use()
    if (d && ctx.settings["body.show"] !== false) {
      usedAt = performance.now()
      const t = reachTarget(d)
      body.interact(t.button ? "button" : "door", t.at)
    }
    return d
  }
  // The lift's buttons have their own E handler (world/interior/lift.ts) and show a prompt while one is in reach.
  if (!ctx.params.has("shot")) {
    addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code !== "KeyE" || e.repeat || isEditableEventTarget(e.target) || performance.now() - usedAt < 100) return
      if (liftPrompt()) body.interact("button")
    })
  }

  // Automation (scripts/character/game-shots.ts): the body and the settings it reads.
  ;(globalThis as { __ashwoodBody?: unknown }).__ashwoodBody = {
    body,
    settings: s,
    /** A visible solid test box (collider + mesh); returns a remover. */
    testBox(min: [number, number, number], max: [number, number, number]) {
      const box = { min, max }
      ctx.colliders.push(box)
      const m = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), new THREE.MeshStandardNodeMaterial({ color: 0x6b5a45, roughness: 0.8 }))
      m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
      m.castShadow = m.receiveShadow = true
      ctx.scene.add(m)
      return () => {
        ctx.scene.remove(m)
        ctx.colliders.splice(ctx.colliders.indexOf(box), 1)
      }
    },
  }
  const shadows = shadowHook(ctx, player)
  const third = thirdPerson(camera)
  let picked = String(s["player.character"])
  return {
    body,
    update(dt: number) {
      const id = String(s["player.character"])
      if (id !== picked) {
        picked = id
        if (!forced) saveCharacter(id)
        void body.setCharacter(id).catch((e: unknown) => console.error("player body:", e))
      }
      const thirdOn = Number(s["body.view"]) === 1
      // A seated body (the intro's driver) is shown and updated even with "Show body" off.
      if (s["body.show"] === false && !body.seated) {
        body.root.visible = false
        third.apply(false, player, body, 0, ctx.colliders)
        return
      }
      body.root.visible = true
      body.look = Number(s["body.look"] ?? 1)
      // The third-person debug camera shows the first-person placement (eyes at the controller's eye).
      body.eyeAnchor = true
      body.update(dt, player.state)
      keepHooks()
      // Ladders: the camera at the body's eyes (the controller keeps it on the rung plane, in front of the face).
      const vw = body.view.weight
      if (vw > 1e-3) {
        camera.position.lerp(body.view.eye, vw)
        camera.updateMatrixWorld()
      }
      // Mantle: the eyes go to the hands on the edge while they take the weight.
      if (body.mantleHandsW > 1e-3 && !thirdOn) {
        camera.rotateX(-0.45 * body.mantleHandsW)
        camera.updateMatrixWorld()
      }
      third.apply(thirdOn, player, body, Number(s["body.thirdDist"]), ctx.colliders)
      if (s["body.lampShadows"] !== false) shadows(body.root.position)
    },
  }
}

/**
 * Where the hand goes on E: a small control's centre (a button), or a leaf's handle (1 m up, near the latch edge).
 * Reads the door's pose fields (world/doors.ts Door); falls back to the crosshair when they aren't there.
 */
function reachTarget(d: DoorHandle) {
  const door = d as DoorHandle & { height?: number; hx?: number; hy?: number; hz?: number; ox?: number; oy?: number; oz?: number; yaw?: number; xa?: number; xb?: number; centre?(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } }
  const button = (door.height ?? 2) < 1.2
  if (door.hx === undefined || door.yaw === undefined || door.xa === undefined || door.xb === undefined || !door.centre) return { button, at: undefined }
  if (button) return { button, at: door.centre({ x: 0, y: 0, z: 0 }) }
  const far = Math.abs(door.xb) > Math.abs(door.xa) ? door.xb : door.xa
  const mx = far - Math.sign(far) * 0.08
  return {
    button,
    at: {
      x: door.hx + (door.ox ?? 0) + mx * Math.cos(door.yaw),
      y: (door.hy ?? 0) + (door.oy ?? 0) + 1.0,
      z: door.hz! + (door.oz ?? 0) - mx * Math.sin(door.yaw),
    },
  }
}

/** True while the lift's "Call lift" / "Next floor" prompt shows (its button is in reach). */
function liftPrompt() {
  for (const el of document.body.children) {
    const h = el as HTMLElement
    if (h.style?.opacity === "1" && /lift|floor/i.test(h.textContent ?? "")) return true
  }
  return false
}

/**
 * Debug: moves the view camera behind and above the player after the controller placed it (the frame's updates run
 * after the controller), with the head layer on. The controller puts it back at the eye every frame.
 */
function thirdPerson(camera: THREE.PerspectiveCamera) {
  const target = new THREE.Vector3()
  const back = new THREE.Vector3()
  let on = false
  return {
    apply(want: boolean, player: Player, body: CharacterBody, dist: number, colliders: WorldContext["colliders"]) {
      if (want !== on) {
        on = want
        if (on) {
          camera.layers.enable(HEAD_LAYER)
          camera.layers.disable(VIEW_LAYER)
        } else {
          camera.layers.disable(HEAD_LAYER)
          camera.layers.enable(VIEW_LAYER)
        }
      }
      if (!on) return
      const st = player.state
      target.set(body.root.position.x, body.root.position.y + 1.2, body.root.position.z)
      // Behind the view direction, raised by the pitch; pulled in in front of walls (a lift car, a corridor).
      back.set(Math.sin(st.yaw) * Math.cos(st.pitch), -Math.sin(st.pitch) + 0.25, Math.cos(st.yaw) * Math.cos(st.pitch)).normalize()
      const hit = rayBoxes(target, back, dist, colliders)
      camera.position.copy(target).addScaledVector(back, Math.max(0.4, hit - 0.2))
      camera.lookAt(target)
      camera.updateMatrixWorld()
    },
  }
}

/** Nearest hit (≤ max) of a ray against the colliders' boxes, ignoring boxes the origin is inside. */
function rayBoxes(o: THREE.Vector3, d: THREE.Vector3, max: number, boxes: WorldContext["colliders"]) {
  let best = max
  const O = [o.x, o.y, o.z]
  const D = [d.x, d.y, d.z]
  for (const b of boxes) {
    let t0 = 0
    let t1 = best
    let inside = true
    for (let i = 0; i < 3 && t0 <= t1; i++) {
      const lo = b.min[i]!
      const hi = b.max[i]!
      if (O[i]! < lo || O[i]! > hi) inside = false
      if (Math.abs(D[i]!) < 1e-9) {
        if (O[i]! < lo || O[i]! > hi) t0 = Infinity
        continue
      }
      let a = (lo - O[i]!) / D[i]!
      let c = (hi - O[i]!) / D[i]!
      if (a > c) [a, c] = [c, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, c)
    }
    if (!inside && t0 <= t1 && t0 < best) best = t0
  }
  return best
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
