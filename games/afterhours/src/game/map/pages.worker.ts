import { FONT } from "./paper"
import { drawPage, type PageJob } from "./pages"

// Draws the map sheets off the main thread: fonts load once, then each job returns an ImageBitmap (transferred).

export type Request = { type: "init"; fontBase: string } | ({ type: "page"; job: number } & PageJob)
export type Response = { type: "page"; job: number; index: number; bitmap: ImageBitmap; ms: number } | { type: "error"; job: number; message: string }

const scope = self as unknown as { fonts: FontFaceSet; onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(m: Response, transfer?: Transferable[]): void }
let fonts: Promise<unknown> = Promise.resolve()

scope.onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data
  if (m.type === "init") {
    const faces: [string, string, string][] = [
      [FONT.hand, "Caveat-map.woff2", "400 700"],
      [FONT.letter, "LibreFranklin-map.woff2", "100 900"],
      [FONT.title, "Oswald-map.woff2", "200 700"],
      [FONT.stamp, "ArchivoBlack-Regular-map.woff2", "400"],
    ]
    fonts = Promise.all(
      faces.map(async ([family, file, weight]) => {
        const f = new FontFace(family, `url(${m.fontBase}${file})`, { weight })
        await f.load()
        scope.fonts.add(f)
      }),
    ).catch((err) => console.warn(`map fonts: ${err}`))
    return
  }
  try {
    await fonts
    const t0 = performance.now()
    const bitmap = await drawPage(m)
    scope.postMessage({ type: "page", job: m.job, index: m.index, bitmap, ms: performance.now() - t0 } satisfies Response, [bitmap])
  } catch (err) {
    scope.postMessage({ type: "error", job: m.job, message: err instanceof Error ? (err.stack ?? err.message) : String(err) } satisfies Response)
  }
}
