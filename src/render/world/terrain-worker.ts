// Terrain generation worker: builds cluster meshes, tree instances and the shore depth map off
// the main thread. Messages are processed in order; the main thread keeps only a few in flight.
import { generateCluster, generateShoreRows, generateTrees } from "./tile-gen"

export type WorkerRequest =
  | { type: "cluster"; id: number; cx: number; cz: number; lod: number }
  | { type: "trees"; id: number; cx: number; cz: number; max: number }
  | { type: "shore"; id: number; z0: number; z1: number }

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}
const ctx = self as unknown as WorkerScope

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === "cluster") {
    const data = generateCluster(msg.cx, msg.cz, msg.lod)
    // Copy out of the oversized scratch buffers so only the used bytes are transferred.
    data.positions = data.positions.slice()
    data.colors = data.colors.slice()
    ctx.postMessage({ type: "cluster", id: msg.id, data }, [data.positions.buffer, data.colors.buffer])
  } else if (msg.type === "trees") {
    const data = generateTrees(msg.cx, msg.cz, msg.max)
    ctx.postMessage({ type: "trees", id: msg.id, data }, [...data.matrices.map(m => m.buffer), ...data.colors.map(c => c.buffer)])
  } else if (msg.type === "shore") {
    const rows = generateShoreRows(msg.z0, msg.z1)
    ctx.postMessage({ type: "shore", id: msg.id, z0: msg.z0, z1: msg.z1, rows }, [rows.buffer])
  }
}
