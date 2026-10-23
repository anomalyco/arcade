import { runJob, type PrintReply, type PrintRequest } from "./print-jobs"

/** The held map's print worker: one job per message (`print-jobs.ts`), bitmaps transferred back. */

const scope = self as unknown as { onmessage: ((e: MessageEvent<PrintRequest>) => void) | null; postMessage(m: PrintReply, transfer?: Transferable[]): void }

scope.onmessage = (e: MessageEvent<PrintRequest>) => {
  runJob(e.data).then(
    (r) => scope.postMessage(r, r.bitmap ? [r.bitmap] : []),
    (err: unknown) => scope.postMessage({ id: e.data.id, ms: 0, error: String((err as Error)?.stack ?? err) }),
  )
}
