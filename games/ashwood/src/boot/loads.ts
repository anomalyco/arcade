import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { touch } from "./schedule"

// Counts GLB loads in flight (world props, vehicles, the player character and its animations all go through
// GLTFLoader), so the boot can keep the loading screen up until every model that the builders asked for has arrived
// and been warmed, instead of letting them pop in during play.

let pending = 0
const inFlight = new Set<string>()
const load = GLTFLoader.prototype.load
GLTFLoader.prototype.load = function (this: GLTFLoader, url, onLoad, onProgress, onError) {
  pending++
  inFlight.add(url)
  let done = false
  const settle = () => {
    if (done) return
    done = true
    pending--
    inFlight.delete(url)
    touch()
  }
  return load.call(
    this,
    url,
    (gltf) => {
      try {
        onLoad(gltf)
      } finally {
        settle()
      }
    },
    onProgress,
    (e) => {
      settle()
      onError?.(e)
    },
  )
}

/** GLB loads currently in flight. */
export const modelLoadsPending = () => pending
/** Their URLs (for the log when the boot stops waiting for them). */
export const modelLoadsInFlight = () => [...inFlight]
