import type { RugWorkerRequest, RugWorkerResponse } from "./rug-worker"

export type { RugWorkerRequest, RugWorkerResponse }

/** Starts the rug bake Worker (`rug.ts` generator, interior tile masks and hand-painted resizes, off the main thread). */
export function createRugWorker(): Worker | null {
  return typeof Worker !== "undefined" ? new Worker(new URL("./rug-worker.ts", import.meta.url), { type: "module" }) : null
}
