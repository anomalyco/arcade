// Generates the Wendigo off the main thread (only when the shipped bake is missing, broken or stale).
import { encodeCreature } from "../kit/format"
import { generateWendigo } from "./build"

self.onmessage = () => {
  try {
    const bytes = encodeCreature(generateWendigo())
    ;(self as unknown as Worker).postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer as ArrayBuffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
