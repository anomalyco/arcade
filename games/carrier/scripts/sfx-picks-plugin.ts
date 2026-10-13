// Dev-server-only store for the SOUNDS tab's picks (src/audio/sounds-lab.ts):
//
//   POST /__sfx/picks    body: the picks JSON ({ [slot]: { take, trim, ratings } }) -> writes public/sfx/picks.json
//
// The shipped game reads public/sfx/picks.json as its defaults (src/audio/sfx-bank.ts), so a SAVE in the dev server
// bakes the user's choices into the next build. Bad input gets a 4xx; nothing throws into the dev server.
import { writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import type { Plugin } from "vite"
import { SLOT_BY_ID } from "../src/audio/sfx-slots"

const ROUTE = "/__sfx/picks"
const MAX_BODY = 256 * 1024

type Pick = { take: number; trim: number; ratings?: number[] }

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0
    const parts: Buffer[] = []
    req.on("data", (c: Buffer) => {
      n += c.length
      if (n > MAX_BODY) reject(new Error("too large"))
      else parts.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")))
    req.on("error", reject)
  })
}

/** Keeps only known slots and sane values. */
function clean(input: unknown): Record<string, Pick> {
  if (!input || typeof input !== "object") throw new Error("expected an object")
  const out: Record<string, Pick> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const slot = SLOT_BY_ID.get(k)
    if (!slot || !v || typeof v !== "object") continue
    const p = v as Record<string, unknown>
    const take = Math.round(Number(p.take))
    if (!(take >= 1 && take <= slot.count)) continue
    const trim = Math.max(-24, Math.min(12, Number(p.trim) || 0))
    const ratings = Array.isArray(p.ratings) ? p.ratings.slice(0, slot.count).map((r) => Math.max(0, Math.min(5, Math.round(Number(r) || 0)))) : []
    out[k] = { take, trim: Math.round(trim * 10) / 10, ratings }
  }
  return out
}

export function sfxPicksPlugin(): Plugin {
  let root = process.cwd()
  return {
    name: "carrier-sfx-picks",
    apply: "serve",
    configResolved(c) {
      root = c.root
    },
    configureServer(server) {
      server.middlewares.use(ROUTE, (req: IncomingMessage, res: ServerResponse) => {
        const send = (status: number, msg: unknown) => {
          res.statusCode = status
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify(msg))
        }
        if (req.method !== "POST") return send(405, { error: "POST only" })
        body(req)
          .then((text) => {
            const picks = clean(JSON.parse(text))
            writeFileSync(join(root, "public/sfx/picks.json"), `${JSON.stringify(picks, null, 1)}\n`)
            send(200, { saved: Object.keys(picks).length })
          })
          .catch((err: Error) => send(400, { error: err.message }))
      })
    },
  }
}
