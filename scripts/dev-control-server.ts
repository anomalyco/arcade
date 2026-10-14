import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DevPageSummary } from "../packages/kit/dev-control"
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

export function isSameLoopbackOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (!originHeader || !hostHeader) return false
  try {
    const parsed = new URL(originHeader)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (!isAllowedLoopbackHost(parsed.hostname)) return false
    return parsed.host.toLowerCase() === hostHeader.toLowerCase()
  } catch {
    return false
  }
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
}) {
  const cliToken = randomBytes(32).toString("hex")
  const pageToken = randomBytes(32).toString("hex")
  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  const origin = `http://${opts.host}:${opts.port}`

  const clients = new Map<string, ConnectedClient>()
  const pendingRpcs = new Map<string, PendingRpc>()
  const navWaiters = new Set<NavigationWaiter>()
  const writtenFiles: string[] = []

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
      if (
        c.id.toLowerCase() === q ||
        c.summary.kind.toLowerCase() === q ||
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

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== CONTROL_PATH && !url.pathname.startsWith(`${CONTROL_PATH}/`)) {
      return false
    }

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
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
      writeJson(res, 200, {
        ok: true,
        server: {
          pid: process.pid,
          origin,
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

    if (!isSameLoopbackOrigin(req.headers.origin, req.headers.host)) {
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
          }
          if (msg.type === "status" && msg.page) {
            if (msg.page.id && msg.page.id !== client.id) {
              clients.delete(client.id)
              client.id = msg.page.id
              clients.set(client.id, client)
            }
            client.summary = { ...msg.page, updatedAt: Date.now() }
            checkNavWaiters(client.summary)
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
