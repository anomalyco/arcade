/**
 * Online proof: the production bundle on a local Worker (`wrangler dev`, real Durable Objects) behind a proxy that
 * delays every WebSocket message like Wi-Fi (40 ms each way ± jitter, order kept), and two headless browsers in one
 * room, each pressing keys like a player. Prints each tab's netcode state (desyncs, lead, round trip) and records
 * both tabs as muted videos. Run `vite build` first.
 *
 *   bun scripts/online-proof.ts --seconds 30 --out captures/online [--delay 40 --jitter 15]
 *   bun scripts/online-proof.ts --url https://anoma.ly/arcade/archers/   (the live room server, real network, no proxy)
 */
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { ServerWebSocket } from "bun"
import { CHROME_ARGS, PACE_60 } from "./headless"
import { chromium, type Page } from "playwright-core"

const { values: o } = parseArgs({
  options: {
    seconds: { type: "string", default: "30" },
    out: { type: "string", default: "captures/online" },
    delay: { type: "string", default: "40" },
    jitter: { type: "string", default: "15" },
    room: { type: "string", default: "prf1" },
    width: { type: "string", default: "960" },
    height: { type: "string", default: "540" },
    url: { type: "string" },
  },
})
const out = resolve(o.out!)
mkdirSync(out, { recursive: true })
const DELAY = Number(o.delay), JITTER = Number(o.jitter)

const local = !o.url
const wport = 8800 + Math.floor(Math.random() * 100)
const wrangler = local ? Bun.spawn(["bunx", "wrangler", "dev", "--port", String(wport), "--ip", "127.0.0.1", "--log-level", "warn"], { stdout: "pipe", stderr: "pipe" }) : null
const upstream = `127.0.0.1:${wport}`
for (let i = 0; local; i++) {
  try {
    if ((await fetch(`http://${upstream}/arcade/archers/api/health`)).ok) break
  } catch {}
  if (i > 120) throw new Error("wrangler dev didn't start")
  await Bun.sleep(500)
}

/** Delivers in order, each message `DELAY ± JITTER` ms after it was sent. */
function delayed(send: (m: string | Buffer) => void) {
  let last = 0
  return (m: string | Buffer) => {
    const at = Math.max(last, performance.now() + DELAY + (Math.random() * 2 - 1) * JITTER)
    last = at
    setTimeout(() => send(m), at - performance.now())
  }
}

/** Plain HTTP passes straight through (fetch has already decoded the body, so its encoding headers go). */
async function proxied(url: string): Promise<Response> {
  const r = await fetch(url, { redirect: "manual" })
  const headers = new Headers(r.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(await r.arrayBuffer(), { status: r.status, headers })
}

type Link = { up: WebSocket; toUp: (m: string | Buffer) => void; queued: (string | Buffer)[]; open: boolean }
const proxy = Bun.serve<{ path: string; link?: Link }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    const url = new URL(req.url)
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(req, { data: { path: url.pathname + url.search } })) return
      return new Response("upgrade failed", { status: 400 })
    }
    return proxied(`http://${upstream}${url.pathname}${url.search}`)
  },
  websocket: {
    open(ws: ServerWebSocket<{ path: string; link?: Link }>) {
      const up = new WebSocket(`ws://${upstream}${ws.data.path}`)
      const toDown = delayed((m) => ws.send(m))
      const link: Link = { up, open: false, queued: [], toUp: delayed((m) => (link.open ? up.send(m) : link.queued.push(m))) }
      up.onopen = () => {
        link.open = true
        for (const m of link.queued.splice(0)) up.send(m)
      }
      up.onmessage = (e) => toDown(e.data as string)
      up.onclose = () => ws.close()
      ws.data.link = link
    },
    message(ws, m) {
      ws.data.link?.toUp(m)
    },
    close(ws) {
      ws.data.link?.up.close()
    },
  },
})

const browser = await chromium.launch({ headless: true, args: CHROME_ARGS })
const size = { width: Number(o.width), height: Number(o.height) }
for (const f of readdirSync(out)) if (f.endsWith(".webm")) unlinkSync(resolve(out, f))

/** Holds runs and presses jump, draw and dodge like a person would, for `ms`. */
async function play(page: Page, ms: number, seed: number) {
  let r = seed
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648)
  const end = Date.now() + ms
  let dir: string | null = null
  while (Date.now() < end) {
    const next = ["KeyA", "KeyD", null, "KeyA", "KeyD"][Math.floor(rand() * 5)]!
    if (dir !== next) {
      if (dir) await page.keyboard.up(dir)
      if (next) await page.keyboard.down(next)
      dir = next
    }
    const act = rand()
    if (act < 0.4) await page.keyboard.press("Space", { delay: 60 + rand() * 200 })
    else if (act < 0.7) {
      if (rand() < 0.5) await page.keyboard.down("KeyW")
      await page.keyboard.press("ShiftLeft", { delay: 150 + rand() * 400 })
      await page.keyboard.up("KeyW")
    } else if (act < 0.76) await page.keyboard.press("KeyE", { delay: 40 })
    await page.waitForTimeout(150 + rand() * 500)
  }
  if (dir) await page.keyboard.up(dir)
}

// Both tabs open before either loads, so their videos start together.
const pages: Page[] = []
const errors: string[][] = []
for (let k = 0; k < 2; k++) {
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } })
  const page = await context.newPage()
  await page.addInitScript(PACE_60)
  const errs: string[] = []
  page.on("pageerror", (e) => errs.push(e.message))
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errs.push(m.text()))
  pages.push(page)
  errors.push(errs)
}
const base = o.url ?? `http://127.0.0.1:${proxy.port}/arcade/archers/`
await Promise.all(pages.map((p) => p.goto(`${base}?room=${o.room}`, { waitUntil: "load" })))
for (const page of pages) await page.waitForFunction(() => (globalThis as { archers?: { online?: { ready: boolean } } }).archers?.online?.ready, null, { timeout: 30_000 })
await Promise.all(pages.map((p, k) => play(p, Number(o.seconds) * 1000, 17 + k * 101)))

type Probe = {
  online: { slot: number; desyncs: number; rtt: number; rb: { tick: number; headTick: number }; pacer: { speed: number; snaps: number }; stats: { frames: number; slack: number[]; ahead: number[]; arrivals: number[]; lead: number[]; room: number[]; speed: number[] } }
  world: { s: { tick: number; round: number; archers: { name: string; bot: boolean; wins: number; kills: number }[] } }
  counts: Record<string, number>
}
for (const [k, page] of pages.entries()) {
  const st = await page.evaluate(() => {
    const g = (globalThis as { archers?: Probe }).archers!
    const n = g.online
    const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))]
    return {
      fps: Math.round(n.stats.frames / (performance.now() / 1000)),
      "slack p10/p50": `${q(n.stats.slack, 0.1)}/${q(n.stats.slack, 0.5)}`,
      "ahead p50/p95": `${q(n.stats.ahead, 0.5)}/${q(n.stats.ahead, 0.95)}`,
      "lead p10/50/90": [0.1, 0.5, 0.9].map((p) => q(n.stats.lead, p)?.toFixed(1)).join("/"),
      "room-confirmed p10/50/90": [0.1, 0.5, 0.9].map((p) => q(n.stats.room, p)?.toFixed(1)).join("/"),
      snaps: n.pacer.snaps,
      "room Hz by page clock": ((n.stats.arrivals.length - 1) / ((n.stats.arrivals.at(-1)! - n.stats.arrivals[0]!) / 1000)).toFixed(1),
      "speed p10/50/90": [0.1, 0.5, 0.9].map((p) => q(n.stats.speed, p)?.toFixed(2)).join("/"),
      "frame gaps ms p50/p95/max": ((g) => `${q(g, 0.5)?.toFixed(1)}/${q(g, 0.95)?.toFixed(1)}/${Math.max(...g).toFixed(0)}`)(n.stats.arrivals.slice(1).map((t, i) => t - n.stats.arrivals[i]!)), slot: n.slot, desyncs: n.desyncs, rtt: Math.round(n.rtt), confirmed: n.rb.tick, head: n.rb.headTick, speed: n.pacer.speed, round: g.world.s.round, archers: g.world.s.archers.map((a) => `${a.name}${a.bot ? "(bot)" : ""} w${a.wins} k${a.kills}`), counts: g.counts }
  })
  console.log(`tab ${k + 1}`, JSON.stringify(st))
  if (errors[k]!.length) console.log(`tab ${k + 1} console:`, errors[k]!.slice(0, 5).join(" | "))
}
const videos0 = await Promise.all(pages.map((p) => p.video()?.path()))
for (const page of pages) await page.context().close()
await browser.close()
proxy.stop(true)
wrangler?.kill()
console.log(`videos (tab 1, tab 2):\n${videos0.join("\n")}`)
process.exit(0)
