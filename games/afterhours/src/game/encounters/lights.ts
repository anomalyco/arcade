import * as THREE from "three/webgpu"

// Every light the encounters and death scenes use, created ONCE at boot before the warm-up (src/boot/world.ts calls
// `createEncounterLights`), dark and parked far below the world. three's lighting cache key covers every non-clustered
// light in the scene, so adding or removing one at runtime rebuilds every lit material (seconds of frozen frames);
// these only ever change intensity, position, distance and target. Never `add`/`remove` them, never toggle `visible`.

export type EncounterLights = {
  /** Death scenes: cold point light on the face at the climax. */
  face: THREE.PointLight
  /** Death scenes: wide cold spot from beside the eye onto the torso and limbs. */
  body: THREE.SpotLight
  /** Lift pounce / hunter catch: cold key from just above the eye. */
  kill: THREE.PointLight
  /** Road ambush: faint cold fill at the windscreen. */
  fill: THREE.PointLight
  /** Road ambush: the narrow headlight beam that catches it. */
  beam: THREE.SpotLight
  /** The `ending` chapter's stand-in truck headlights (until the real truck lands). */
  heads: [THREE.SpotLight, THREE.SpotLight]
}

const PARK = new THREE.Vector3(0, -200, 0)
let lights: EncounterLights | null = null

/** Boot (before the warm-up): adds the encounter lights to `scene`, dark. Idempotent. */
export function createEncounterLights(scene: THREE.Scene): EncounterLights {
  if (lights) return lights
  const point = (color: number, distance: number) => {
    const l = new THREE.PointLight(color, 0, distance, 2)
    l.castShadow = false
    l.position.copy(PARK)
    scene.add(l)
    return l
  }
  const spot = (color: number, distance: number, angle: number, penumbra: number, decay: number) => {
    const l = new THREE.SpotLight(color, 0, distance, angle, penumbra, decay)
    l.castShadow = false
    l.position.copy(PARK)
    l.target.position.copy(PARK).y -= 1
    scene.add(l, l.target)
    return l
  }
  lights = {
    face: point(0xc6d4de, 3.2),
    body: spot(0xb9c8d4, 22, 0.62, 0.7, 1.2),
    kill: point(0xc8d4dc, 6),
    fill: point(0xb8c4cc, 3),
    beam: spot(0xfff0d6, 30, 0.16, 0.5, 1.4),
    heads: [spot(0xfff1d6, 60, 0.42, 0.55, 1.6), spot(0xfff1d6, 60, 0.42, 0.55, 1.6)],
  }
  return lights
}

/** The boot-created lights. If boot didn't create them (a page without the hook), they are created now, with a warning. */
export function encounterLights(scene: THREE.Scene): EncounterLights {
  if (!lights) console.warn("encounter lights: created at runtime (boot hook missing): lit materials will rebuild")
  return createEncounterLights(scene)
}

/** Dark and parked again (restarts, the end of a scene). */
export function parkEncounterLight(l: THREE.Light) {
  l.intensity = 0
  l.position.copy(PARK)
}
