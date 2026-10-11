// Terrain generation worker: builds tile vertex data, tree instances and the shore depth map off
// the main thread. Messages are processed in order; the main thread keeps only a few in flight.
import { generateShoreRows, generateTile, generateTrees } from "./tile-gen"

export type WorkerRequest =
  | { type: "tile"; id: number; tx: number; tz: number; segments: number }
  | { type: "trees"; id: number; tx: number; tz: number; max: number }
  | { type: "shore"; id: number; z0: number; z1: number }

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}
const ctx = self as unknown as WorkerScope

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === "tile") {
    const data = generateTile(msg.tx, msg.tz, msg.segments)
    ctx.postMessage({ type: "tile", id: msg.id, data }, [data.positions.buffer, data.normals.buffer, data.forest.buffer])
  } else if (msg.type === "trees") {
    const data = generateTrees(msg.tx, msg.tz, msg.max)
    ctx.postMessage({ type: "trees", id: msg.id, data }, [...data.matrices.map(m => m.buffer), ...data.colors.map(c => c.buffer)])
  } else if (msg.type === "shore") {
    const rows = generateShoreRows(msg.z0, msg.z1)
    ctx.postMessage({ type: "shore", id: msg.id, z0: msg.z0, z1: msg.z1, rows }, [rows.buffer])
  }
}
