import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildTourStepUrl,
  validateTourDefinition,
  type DevPageSummary,
  type TourDefinition,
} from "../packages/kit/dev-control"
import type { LabCommandInvokeResult } from "../packages/kit/lab-commands"

export const CONTROL_PATH = "/__arcade/control"
export const DEFAULT_CONTROL_FILENAME = ".arcade-control.json"
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export type ControlFilePayload = {
  version: 1
  pid: number
  origin: string
  host: string
  port: number
  controlPath: string
  token: string
  cwd: string
  startedAt: string
}

type ConnectedClient = {
  id: string
  socket: Socket
  summary: DevPageSummary
  connectedAt: number
  appliedTourKey?: string
  applyingTour?: boolean
}

type PendingRpc = {
  pageId: string
  command: string
  resolve: (value: { outcome: LabCommandInvokeResult; page: DevPageSummary }) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type NavigationWaiter = {
  pageId: string
  expectedPath?: string
  minUpdatedAt: number
  resolve: (page: DevPageSummary) => void
  timer: ReturnType<typeof setTimeout>
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

export function isAllowedLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1" || h.endsWith(".localhost")
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  try {
    return isAllowedLoopbackHost(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return false
  }
}

/** Extra page hostnames (e.g. a Tailscale Serve name) from ARCADE_DEV_ALLOWED_HOSTS or Vite's allowed-hosts env. */
export function extraPageHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = [env.ARCADE_DEV_ALLOWED_HOSTS, env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS].filter(Boolean).join(",")
  return raw
    .split(",")
    .map(h => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(h => h && !h.startsWith(".") && !h.includes("*"))
}

/** Page origins must match the Host header; extra hosts are accepted over HTTPS only. */
export function isAllowedPageOrigin(originHeader: string | undefined, hostHeader: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!originHeader || !hostHeader) return false
  try {
    const parsed = new URL(originHeader)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (parsed.host.toLowerCase() !== hostHeader.toLowerCase()) return false
    if (isAllowedLoopbackHost(parsed.hostname)) return true
    return parsed.protocol === "https:" && extraHosts.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isSameLoopbackOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  return isAllowedPageOrigin(originHeader, hostHeader)
}

function safeTokenEquals(expected: string, actual: string | undefined): boolean {
  if (!actual) return false
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(actual, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8")
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function encodeWsFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from([0x80 | (opcode & 0x0f), payload.length & 0x7f])
  return Buffer.concat([header, payload])
}

function attachWsReader(socket: Socket, onMessage: (text: string) => void, onClose: () => void) {
  let buf = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let closed = false

  const finishClose = () => {
    if (closed) return
    closed = true
    onClose()
  }

  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const b0 = buf[0]!
      const b1 = buf[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2
      if (payloadLen === 126) {
        if (buf.length < 4) return
        payloadLen = buf.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buf.length < 10) return
        payloadLen = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (buf.length < offset + maskLen + payloadLen) return
      const mask = masked ? buf.subarray(offset, offset + 4) : null
      offset += maskLen
      const data = Buffer.from(buf.subarray(offset, offset + payloadLen))
      if (mask) {
        for (let i = 0; i < data.length; i++) {
          data[i]! ^= mask[i & 3]!
        }
      }
      buf = buf.subarray(offset + payloadLen)

      if (opcode === 0x8) {
        try {
          socket.end(encodeWsFrame(0x8))
        } catch {}
        finishClose()
        return
      }
      if (opcode === 0x9) {
        try {
          socket.write(encodeWsFrame(0xa, data.subarray(0, Math.min(125, data.length))))
        } catch {}
        continue
      }
      if (opcode === 0xa) continue

      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(data)
        if (fin) {
          const full = Buffer.concat(fragments).toString("utf8")
          fragments = []
          onMessage(full)
        }
      }
    }
  })

  socket.on("close", finishClose)
  socket.on("end", finishClose)
  socket.on("error", finishClose)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new Error("Invalid JSON request body"))
      }
    })
    req.on("error", reject)
  })
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(payload))
}

export function createDevControlServer(opts: {
  root: string
  host: string
  port: number
  games: readonly string[]
  workers: boolean
  pageHosts?: readonly string[]
}) {
  const cliToken = randomBytes(32).toString("hex")
  const pageToken = randomBytes(32).toString("hex")
  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  const origin = `http://${opts.host}:${opts.port}`
  const pageHosts = opts.pageHosts ?? extraPageHosts()

  const clients = new Map<string, ConnectedClient>()
  const pendingRpcs = new Map<string, PendingRpc>()
  const navWaiters = new Set<NavigationWaiter>()
  const tours = new Map<string, TourDefinition>()
  const writtenFiles: string[] = []
  const toursDir = join(opts.root, ".arcade-tours")

  function loadTourById(tourId: string): TourDefinition | null {
    const cleanId = tourId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
    if (!cleanId) return null
    const mem = tours.get(cleanId) ?? tours.get(tourId)
    if (mem) return mem
    const diskPath = join(toursDir, `${cleanId}.json`)
    if (existsSync(diskPath)) {
      try {
        const parsed = JSON.parse(readFileSync(diskPath, "utf8"))
        const validated = validateTourDefinition(parsed, cleanId)
        tours.set(validated.id, validated)
        return validated
      } catch {}
    }
    return null
  }

  function saveTour(tour: TourDefinition): string {
    tours.set(tour.id, tour)
    const file = join(toursDir, `${tour.id}.json`)
    try {
      mkdirSync(toursDir, { recursive: true })
      writeFileSync(file, JSON.stringify(tour, null, 2) + "\n", "utf8")
    } catch {}
    return file
  }

  function writeStateFiles() {
    const payload: ControlFilePayload = {
      version: 1,
      pid: process.pid,
      origin,
      host: opts.host,
      port: opts.port,
      controlPath: CONTROL_PATH,
      token: cliToken,
      cwd: opts.root,
      startedAt: startedIso,
    }
    const content = JSON.stringify(payload, null, 2)
    const primaryFile = process.env.ARCADE_CONTROL_FILE || join(opts.root, DEFAULT_CONTROL_FILENAME)
    mkdirSync(dirname(primaryFile), { recursive: true })
    writeFileSync(primaryFile, content, { mode: 0o600 })
    chmodSync(primaryFile, 0o600)
    writtenFiles.push(primaryFile)

    if (process.env.ARCADE_NO_GLOBAL_STATE !== "1" && !process.env.ARCADE_CONTROL_FILE) {
      try {
        const globalFile = join(homedir(), ".cache", "arcade", "dev-control.json")
        mkdirSync(dirname(globalFile), { recursive: true })
        writeFileSync(globalFile, content, { mode: 0o600 })
        chmodSync(globalFile, 0o600)
        writtenFiles.push(globalFile)
      } catch {}
    }
  }

  function cleanupStateFiles() {
    for (const file of writtenFiles) {
      try {
        if (!existsSync(file)) continue
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number }
        if (parsed.pid === process.pid) unlinkSync(file)
      } catch {}
    }
  }

  function sortedPages(): DevPageSummary[] {
    return [...clients.values()]
      .map(c => c.summary)
      .sort((a, b) => {
        if (a.focused !== b.focused) return a.focused ? -1 : 1
        if (a.visible !== b.visible) return a.visible ? -1 : 1
        return (b.lastActiveAt || b.updatedAt) - (a.lastActiveAt || a.updatedAt)
      })
  }

  function resolveClient(targetPage?: string): { client?: ConnectedClient; error?: string; code?: string } {
    if (clients.size === 0) {
      return {
        code: "no_page_connected",
        error: `No browser page is connected to ${origin}. Open ${origin}/arcade/getaway/dev.html in your browser or run 'arcade open hub --new'.`,
      }
    }
    if (!targetPage) {
      const top = sortedPages()[0]!
      return { client: clients.get(top.id) }
    }
    const q = targetPage.trim().toLowerCase()
    const direct = clients.get(targetPage)
    if (direct) return { client: direct }
    for (const c of clients.values()) {
      const tourStepTag = c.summary.tour ? `${c.summary.tour.id}:${c.summary.tour.step}`.toLowerCase() : ""
      const stepOnlyTag = c.summary.tour ? `step=${c.summary.tour.step}` : ""
      if (
        c.id.toLowerCase() === q ||
        c.summary.kind.toLowerCase() === q ||
        tourStepTag === q ||
        stepOnlyTag === q ||
        c.summary.title.toLowerCase().includes(q) ||
        c.summary.pathname.toLowerCase().includes(q) ||
        c.summary.url.toLowerCase().includes(q)
      ) {
        return { client: c }
      }
    }
    return {
      code: "page_not_found",
      error: `No connected page matches "${targetPage}". Connected pages: ${sortedPages().map(p => `${p.id} (${p.kind} ${p.pathname}${p.hash})`).join(", ")}`,
    }
  }

  function checkNavWaiters(summary: DevPageSummary) {
    for (const w of [...navWaiters]) {
      if (w.pageId && summary.id !== w.pageId && clients.has(w.pageId)) continue
      if (summary.updatedAt < w.minUpdatedAt) continue
      if (w.expectedPath) {
        const currentFull = summary.pathname + summary.hash
        const matchesPath =
          summary.url.endsWith(w.expectedPath) ||
          currentFull === w.expectedPath ||
          summary.pathname === w.expectedPath.split("?")[0]?.split("#")[0]
        if (!matchesPath) continue
      }
      clearTimeout(w.timer)
      navWaiters.delete(w)
      w.resolve(summary)
    }
  }

  function waitForNavigation(pageId: string, expectedPath?: string, timeoutMs = 8000): Promise<DevPageSummary> {
    const minUpdatedAt = Date.now()
    return new Promise((resolve, reject) => {
      const waiter: NavigationWaiter = {
        pageId,
        expectedPath,
        minUpdatedAt,
        resolve,
        timer: setTimeout(() => {
          navWaiters.delete(waiter)
          const fallback = clients.get(pageId)?.summary ?? sortedPages()[0]
          if (fallback) resolve(fallback)
          else reject(new Error(`Timed out waiting for page navigation to ${expectedPath ?? "target"}`))
        }, timeoutMs),
      }
      navWaiters.add(waiter)
    })
  }

  function invokeOnClient(
    client: ConnectedClient,
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = 10000,
  ): Promise<{ outcome: LabCommandInvokeResult; page: DevPageSummary }> {
    const requestId = `req_${randomBytes(6).toString("hex")}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(requestId)
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms on page ${client.id}`))
      }, timeoutMs)
      pendingRpcs.set(requestId, { pageId: client.id, command, resolve, reject, timer })
      try {
        client.socket.write(encodeWsTextFrame(JSON.stringify({ type: "invoke", requestId, command, args })))
      } catch (err) {
        clearTimeout(timer)
        pendingRpcs.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async function applyTourStepToClient(
    client: ConnectedClient,
    tour: TourDefinition,
    stepNum: number,
    singleTabOverride?: boolean,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const step = tour.steps[stepNum - 1]
    if (!step) return { ok: false, errors: [`Step ${stepNum} out of range (1..${tour.steps.length}).`] }
    const errors: string[] = []
    let clientOrigin = tour.baseUrl || origin
    try {
      if (client.summary.url) {
        clientOrigin = new URL(client.summary.url).origin
      }
    } catch {}
    const singleTab = Boolean(singleTabOverride ?? tour.singleTab)
    const prevUrl =
      stepNum > 1 ? buildTourStepUrl(clientOrigin, tour.steps[stepNum - 2]!.url, tour.id, stepNum - 1, singleTab) : undefined
    const nextUrl =
      stepNum < tour.steps.length
        ? buildTourStepUrl(clientOrigin, tour.steps[stepNum]!.url, tour.id, stepNum + 1, singleTab)
        : undefined

    await new Promise(r => setTimeout(r, 90))

    for (const cmd of step.setup) {
      if (!clients.has(client.id)) return { ok: false, errors: ["Client disconnected during tour setup."] }
      let res = await invokeOnClient(client, cmd.command, cmd.args, 10000).catch(err => ({
        outcome: { ok: false as const, id: cmd.command, error: err instanceof Error ? err.message : String(err) },
      }))
      if (!res.outcome.ok) {
        await new Promise(r => setTimeout(r, 200))
        res = await invokeOnClient(client, cmd.command, cmd.args, 10000).catch(err => ({
          outcome: { ok: false as const, id: cmd.command, error: err instanceof Error ? err.message : String(err) },
        }))
      }
      if (!res.outcome.ok) {
        errors.push(`${cmd.command}: ${res.outcome.error}`)
      }
    }

    if (!clients.has(client.id)) return { ok: false, errors }
    const noteRes = await invokeOnClient(
      client,
      "ui.note",
      {
        title: step.title,
        ...(step.body ? { body: step.body } : {}),
        step: `${stepNum}/${tour.steps.length}`,
        ...(step.accent ? { accent: step.accent } : {}),
        ...(step.target ? { target: step.target } : {}),
        dismissible: step.dismissible ?? true,
        tourId: tour.id,
        stepIndex: stepNum,
        stepCount: tour.steps.length,
        ...(prevUrl ? { prevUrl } : {}),
        ...(nextUrl ? { nextUrl } : {}),
        singleTab,
      },
      8000,
    ).catch(err => ({
      outcome: { ok: false as const, id: "ui.note", error: err instanceof Error ? err.message : String(err) },
    }))
    if (!noteRes.outcome.ok) {
      errors.push(`ui.note: ${noteRes.outcome.error}`)
    }
    return { ok: errors.length === 0, errors }
  }

  function extractTourParams(summary: DevPageSummary): { id: string; step: number; singleTab?: boolean; applied?: boolean } | null {
    if (summary.tour && summary.tour.id && summary.tour.step >= 1) return summary.tour
    try {
      if (!summary.url) return null
      const u = new URL(summary.url)
      const id = u.searchParams.get("tour")?.trim()
      const step = Number(u.searchParams.get("step"))
      const multiTab = u.searchParams.get("multiTab") === "1" || u.searchParams.get("singleTab") === "0"
      if (id && Number.isFinite(step) && step >= 1) {
        return {
          id,
          step: Math.round(step),
          singleTab: !multiTab,
        }
      }
      const hashMatch = (u.hash || summary.hash || "").match(/^#tour\/([a-zA-Z0-9_-]+)(?:\/(\d+))?/)
      if (hashMatch) {
        return {
          id: hashMatch[1]!,
          step: hashMatch[2] ? Math.max(1, Number(hashMatch[2])) : 1,
          singleTab: true,
        }
      }
    } catch {}
    return null
  }

  function sendTourState(client: ConnectedClient, tour: TourDefinition, step: number) {
    try {
      client.socket.write(encodeWsTextFrame(JSON.stringify({ type: "tour.state", tour, step })))
    } catch {}
  }

  function maybeApplyTourOnStatus(client: ConnectedClient) {
    const meta = extractTourParams(client.summary)
    if (!meta) return
    const tour = loadTourById(meta.id)
    if (!tour || !tour.steps[meta.step - 1]) return
    const key = `${meta.id}:${meta.step}:${client.summary.pathname}${client.summary.hash}`
    if (client.appliedTourKey === key || client.applyingTour) return
    sendTourState(client, tour, meta.step)
    client.appliedTourKey = key
    if (meta.applied === true) {
      return
    }
    client.applyingTour = true
    void applyTourStepToClient(client, tour, meta.step, meta.singleTab ?? tour.singleTab ?? true).finally(() => {
      client.applyingTour = false
    })
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    const assetMatch = url.pathname.match(/^(?:\/arcade\/[a-z0-9-]+)?\/__arcade\/tour-assets\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/)
    if (req.method === "GET" && assetMatch) {
      const tourId = assetMatch[1]!
      const fileName = assetMatch[2]!
      if (!fileName.includes("..")) {
        const candidates = [
          join(toursDir, "assets", tourId, fileName),
          join(homedir(), ".cache", "arcade", "tour-assets", tourId, fileName),
          join(homedir(), "code", "home", "artifacts", "2026-10-14-outbreak-review", fileName),
        ]
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
            const mime =
              ext === ".png"
                ? "image/png"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : ext === ".webp"
                    ? "image/webp"
                    : ext === ".gif"
                      ? "image/gif"
                      : ext === ".svg"
                        ? "image/svg+xml"
                        : ext === ".json"
                          ? "application/json; charset=utf-8"
                          : "text/plain; charset=utf-8"
            const data = readFileSync(candidate)
            res.writeHead(200, {
              "content-type": mime,
              "content-length": data.byteLength,
              "cache-control": "no-cache",
            })
            res.end(data)
            return true
          }
        }
      }
      writeJson(res, 404, { ok: false, code: "not_found", error: `Tour asset not found: ${tourId}/${fileName}` })
      return true
    }

    if (url.pathname !== CONTROL_PATH && !url.pathname.startsWith(`${CONTROL_PATH}/`)) {
      return false
    }

    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHostHeader(req.headers.host)) {
      writeJson(res, 403, { ok: false, code: "forbidden_host", error: "Control endpoint is loopback-only." })
      return true
    }

    if (req.headers.origin) {
      writeJson(res, 403, { ok: false, code: "forbidden_origin", error: "Cross-origin browser requests to HTTP control endpoint are forbidden." })
      return true
    }

    const authHeader = req.headers.authorization ?? ""
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : String(req.headers["x-arcade-token"] ?? "")
    if (!safeTokenEquals(cliToken, bearer)) {
      writeJson(res, 403, { ok: false, code: "unauthorized", error: "Invalid or missing Arcade control token." })
      return true
    }

    const sub = url.pathname.slice(CONTROL_PATH.length) || "/status"
    if (req.method === "GET" && (sub === "/status" || sub === "" || sub === "/pages")) {
      const pages = sortedPages()
      const publicOrigin = pageHosts.length > 0 ? `https://${pageHosts[0]}:${opts.port}` : origin
      writeJson(res, 200, {
        ok: true,
        server: {
          pid: process.pid,
          origin,
          publicOrigin,
          pageHosts,
          host: opts.host,
          port: opts.port,
          games: opts.games,
          workers: opts.workers,
          uptimeMs: Date.now() - startedAt,
        },
        connectedPages: pages.length,
        activePageId: pages[0]?.id ?? null,
        pages,
      })
      return true
    }

    if (req.method === "GET" && sub === "/tour") {
      const id = url.searchParams.get("id")?.trim()
      if (id) {
        const tour = loadTourById(id)
        if (!tour) {
          writeJson(res, 404, { ok: false, code: "not_found", error: `Unknown tour "${id}".` })
          return true
        }
        writeJson(res, 200, { ok: true, tour })
        return true
      }
      writeJson(res, 200, { ok: true, tours: [...tours.values()] })
      return true
    }

    if (req.method === "POST" && sub === "/tour") {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        writeJson(res, 400, { ok: false, code: "invalid_args", error: err instanceof Error ? err.message : String(err) })
        return true
      }

      let validated: TourDefinition
      try {
        const defaultId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "tour"
        validated = validateTourDefinition(body.tour ?? body, defaultId)
      } catch (err) {
        writeJson(res, 400, { ok: false, code: "invalid_args", error: err instanceof Error ? err.message : String(err) })
        return true
      }

      const savedFile = saveTour(validated)
      const runtimeSingleTab = typeof body.singleTab === "boolean" ? body.singleTab : validated.singleTab !== false
      const runtimeBaseUrl =
        typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim().replace(/\/$/, "") : validated.baseUrl
      const storedTour: TourDefinition = {
        ...validated,
        singleTab: runtimeSingleTab,
        ...(runtimeBaseUrl ? { baseUrl: runtimeBaseUrl } : {}),
      }
      tours.set(validated.id, storedTour)
      const baseOrigin = runtimeBaseUrl || (pageHosts.length > 0 ? `https://${pageHosts[0]}:${opts.port}` : origin)
      const singleTab = runtimeSingleTab
      const stepUrls = validated.steps.map((s, idx) => ({
        step: idx + 1,
        title: s.title,
        body: s.body ?? null,
        kind: s.kind ?? "scene",
        url: buildTourStepUrl(baseOrigin, s.url, validated.id, idx + 1, singleTab),
        localUrl: buildTourStepUrl(origin, s.url, validated.id, idx + 1, singleTab),
      }))

      // Re-apply on any connected pages already displaying a step of this tour
      const appliedPages: string[] = []
      for (const c of clients.values()) {
        const meta = extractTourParams(c.summary)
        if (meta && meta.id === validated.id && validated.steps[meta.step - 1]) {
          sendTourState(c, storedTour, meta.step)
          c.appliedTourKey = `${meta.id}:${meta.step}:${c.summary.pathname}${c.summary.hash}`
          c.applyingTour = true
          appliedPages.push(c.id)
          void applyTourStepToClient(c, storedTour, meta.step, singleTab).finally(() => {
            c.applyingTour = false
          })
        }
      }

      writeJson(res, 200, {
        ok: true,
        tour: validated,
        savedFile,
        stepUrls,
        appliedPages,
      })
      return true
    }

    if (req.method === "POST" && sub === "/invoke") {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        writeJson(res, 400, { ok: false, code: "invalid_args", error: err instanceof Error ? err.message : String(err) })
        return true
      }

      const command = typeof body.command === "string" ? body.command.trim() : ""
      const pageQuery = typeof body.pageId === "string" && body.pageId.trim() ? body.pageId.trim() : undefined
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : undefined
      const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 10000

      if (!command) {
        writeJson(res, 400, { ok: false, code: "invalid_args", error: "Missing 'command' in invoke request." })
        return true
      }

      const resolved = resolveClient(pageQuery)
      if (!resolved.client) {
        const status = resolved.code === "no_page_connected" ? 409 : 404
        writeJson(res, status, { ok: false, code: resolved.code, error: resolved.error })
        return true
      }

      try {
        const { outcome, page } = await invokeOnClient(resolved.client, command, args, timeoutMs)
        if (!outcome.ok) {
          const code = outcome.code ?? (/Unknown command/i.test(outcome.error) ? "unknown_command" : /unavailable|play mode/i.test(outcome.error) ? "unavailable" : "invalid_args")
          const status =
            code === "unknown_command"
              ? 404
              : code === "invalid_args"
                ? 400
                : code === "unavailable" || code === "busy"
                  ? 409
                  : 500
          writeJson(res, status, {
            ok: false,
            id: outcome.id,
            command: outcome.id,
            code,
            error: outcome.error,
            page: { id: page.id, kind: page.kind, url: page.url, mode: page.mode },
          })
          return true
        }

        const resObj = outcome.result as { navigating?: boolean; navigated?: string } | undefined
        let finalPage = page
        if (resObj && typeof resObj === "object" && resObj.navigating === true) {
          finalPage = await waitForNavigation(page.id, resObj.navigated, Math.min(timeoutMs, 8000))
        }

        writeJson(res, 200, {
          ok: true,
          id: outcome.id,
          command: outcome.id,
          label: outcome.label,
          undoable: outcome.undoable,
          state: outcome.state,
          result: outcome.result ?? outcome.state ?? { ok: true },
          page: {
            id: finalPage.id,
            kind: finalPage.kind,
            url: finalPage.url,
            pathname: finalPage.pathname,
            hash: finalPage.hash,
            title: finalPage.title,
            mode: finalPage.mode,
            section: finalPage.section,
          },
        })
      } catch (err) {
        writeJson(res, 504, {
          ok: false,
          command,
          code: "error",
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return true
    }

    writeJson(res, 404, { ok: false, code: "not_found", error: `Unknown control endpoint: ${req.method} ${url.pathname}` })
    return true
  }

  function handleUpgrade(req: IncomingMessage, socket: Socket): boolean {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== CONTROL_PATH) return false

    const rejectUpgrade = (status: number, code: string, message: string) => {
      const body = JSON.stringify({ ok: false, code, error: message })
      socket.end(
        `HTTP/1.1 ${status} Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
    }

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      rejectUpgrade(403, "forbidden_host", "WebSocket control endpoint is loopback-only.")
      return true
    }

    if (!isAllowedPageOrigin(req.headers.origin, req.headers.host, pageHosts)) {
      rejectUpgrade(403, "forbidden_origin", "Cross-origin or missing Origin header on WebSocket upgrade.")
      return true
    }

    const qToken = url.searchParams.get("token") ?? ""
    if (!safeTokenEquals(pageToken, qToken)) {
      rejectUpgrade(403, "unauthorized", "Invalid page token on WebSocket upgrade.")
      return true
    }

    const wsKey = req.headers["sec-websocket-key"]
    if (!wsKey || typeof wsKey !== "string") {
      rejectUpgrade(400, "bad_request", "Missing Sec-WebSocket-Key.")
      return true
    }

    const accept = createHash("sha1").update(wsKey + WS_GUID).digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    const initialId = url.searchParams.get("pageId") || `page_${randomBytes(4).toString("hex")}`
    const now = Date.now()
    const client: ConnectedClient = {
      id: initialId,
      socket,
      connectedAt: now,
      summary: {
        id: initialId,
        kind: "hub",
        url: "",
        pathname: "",
        hash: "",
        title: "",
        focused: false,
        visible: true,
        mode: "view",
        commands: [],
        updatedAt: now,
        lastActiveAt: now,
      },
    }
    clients.set(initialId, client)

    attachWsReader(
      socket,
      rawText => {
        try {
          const msg = JSON.parse(rawText) as {
            type?: string
            page?: DevPageSummary
            requestId?: string
            outcome?: LabCommandInvokeResult
            tourId?: string
            step?: number
            url?: string
            singleTab?: boolean
          }
          if (msg.type === "status" && msg.page) {
            if (msg.page.id && msg.page.id !== client.id) {
              clients.delete(client.id)
              client.id = msg.page.id
              clients.set(client.id, client)
            }
            client.summary = { ...msg.page, updatedAt: Date.now() }
            checkNavWaiters(client.summary)
            maybeApplyTourOnStatus(client)
          } else if (msg.type === "tour.get" && typeof msg.tourId === "string") {
            const tour = loadTourById(msg.tourId)
            if (tour) {
              sendTourState(client, tour, typeof msg.step === "number" && msg.step >= 1 ? msg.step : 1)
            }
          } else if (msg.type === "tour.focus" && typeof msg.tourId === "string" && typeof msg.step === "number") {
            let targetClient: ConnectedClient | undefined
            for (const c of clients.values()) {
              const meta = extractTourParams(c.summary)
              if (meta && meta.id === msg.tourId && meta.step === msg.step) {
                targetClient = c
                break
              }
            }
            if (targetClient) {
              targetClient.summary.lastActiveAt = Date.now()
              try {
                targetClient.socket.write(encodeWsTextFrame(JSON.stringify({ type: "tour.activate" })))
              } catch {}
            } else if (typeof msg.url === "string" && msg.url) {
              try {
                client.socket.write(encodeWsTextFrame(JSON.stringify({ type: "tour.navigate", url: msg.url })))
              } catch {}
            }
          } else if (msg.type === "result" && msg.requestId && msg.outcome) {
            if (msg.page) {
              client.summary = { ...msg.page, updatedAt: Date.now() }
              checkNavWaiters(client.summary)
            }
            const pending = pendingRpcs.get(msg.requestId)
            if (pending) {
              clearTimeout(pending.timer)
              pendingRpcs.delete(msg.requestId)
              pending.resolve({ outcome: msg.outcome, page: client.summary })
            }
          }
        } catch {}
      },
      () => {
        if (clients.get(client.id) === client) {
          clients.delete(client.id)
        }
        for (const [reqId, pending] of pendingRpcs) {
          if (pending.pageId === client.id) {
            if (pending.command === "nav.open" || pending.command === "open") {
              clearTimeout(pending.timer)
              pendingRpcs.delete(reqId)
              pending.resolve({
                outcome: {
                  ok: true,
                  id: "nav.open",
                  label: "Navigate Page",
                  undoable: false,
                  state: null,
                  result: { navigating: true },
                },
                page: client.summary,
              })
            } else {
              clearTimeout(pending.timer)
              pendingRpcs.delete(reqId)
              pending.reject(new Error(`Page ${client.id} disconnected while executing "${pending.command}".`))
            }
          }
        }
      },
    )

    return true
  }

  return {
    cliToken,
    pageToken,
    controlPath: CONTROL_PATH,
    writeStateFiles,
    cleanupStateFiles,
    handleHttp,
    handleUpgrade,
    waitForNavigation,
    sortedPages,
  }
}
