import {
  LabCommandRegistry,
  type LabCommandDescriptor,
  type LabCommandInvokeResult,
  type LabSceneState,
} from "./lab-commands"
import { formatLabValue, inferControlUnit, type LabControl, type LabPanel, type LabRow, type LabValue } from "./lab-panel"
import type { Stage } from "./lab/stage"

declare global {
  interface ImportMetaEnv {
    DEV: boolean
  }
  interface Window {
    __arcadeDevControl?: PageControlRuntime
    __arcadeSubmitListeners?: Set<() => void>
    __arcadeSubmitHooked?: boolean
  }
}

export type DevPageKind = "hub" | "lab" | "catalogue" | "characters" | "game"

export type DevPageSummary = {
  id: string
  kind: DevPageKind
  url: string
  pathname: string
  hash: string
  title: string
  focused: boolean
  visible: boolean
  mode: "edit" | "play" | "view"
  section?: string
  commands: LabCommandDescriptor[]
  updatedAt: number
  lastActiveAt: number
}

export type DevControlBusyState = {
  busy: boolean
  reason?: string
}

export type DevControlAdapter = {
  kind: DevPageKind
  commands: LabCommandRegistry
  getState: () => Record<string, unknown> | LabSceneState | Promise<Record<string, unknown> | LabSceneState>
  getCanvas?: () => HTMLCanvasElement | null
  captureCanvas?: (target: HTMLCanvasElement) => Promise<void> | void
  isBusy?: () => DevControlBusyState
  getMode?: () => "edit" | "play" | "view"
  getSection?: () => string | undefined
  onIndicator?: (text: string, isError?: boolean) => void
}

export type StageCameraCommandOptions = {
  stage: Stage
  render: () => Promise<unknown> | unknown
  canEdit?: () => boolean
  disabledReason?: () => string
  resolveFrameTarget?: (idOrName?: string) => { x: number; y: number; z: number; dist?: number; label?: string } | null
}

export type PanelLabCommandOptions = {
  getPanels: () => readonly LabPanel[]
  canEdit?: () => boolean
  disabledReason?: () => string
  render?: () => Promise<unknown> | unknown
  extraGet?: (path?: string) => unknown
  extraSet?: (path: string, value: unknown) => { key: string; label: string; before: unknown; value: unknown } | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round4 = (n: number) => Math.round(n * 10000) / 10000

export function isAllowedLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1" || h.endsWith(".localhost")
}

export function parseHostHeader(
  hostHeader: string | undefined,
  protocol: "http:" | "https:" = "http:",
): { host: string; hostname: string; port: string } | null {
  if (!hostHeader) return null
  const trimmed = hostHeader.trim().toLowerCase()
  if (!trimmed || /[\s/?#@\\]/.test(trimmed)) return null
  try {
    const parsed = new URL(`${protocol}//${trimmed}`)
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null
    }
    if (parsed.host.toLowerCase() !== trimmed) {
      return null
    }
    return {
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port,
    }
  } catch {
    return null
  }
}

function normalizeAllowedHostEntry(raw: string): string | null {
  let token = raw.trim().toLowerCase()
  if (!token) return null
  if (
    token === "*" ||
    token === "." ||
    token === "true" ||
    token === "false" ||
    token === "all" ||
    token === "0.0.0.0" ||
    token === "::" ||
    token === "[::]"
  ) {
    return null
  }
  if (token.includes("*")) return null

  const leadingDot = token.startsWith(".")
  if (leadingDot) {
    token = token.slice(1)
  }

  let hostname: string
  if (token.startsWith("http://") || token.startsWith("https://")) {
    if (leadingDot) return null
    try {
      const u = new URL(token)
      if (u.username || u.password) return null
      hostname = u.hostname.toLowerCase()
    } catch {
      return null
    }
  } else {
    const parsed = parseHostHeader(token, "https:") ?? parseHostHeader(token, "http:")
    if (!parsed) return null
    hostname = parsed.hostname
  }

  if (!hostname || hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]") {
    return null
  }

  if (leadingDot) {
    const labels = hostname.split(".").filter(Boolean)
    if (labels.length < 2) return null
    if (labels.length === 2 && (hostname.endsWith(".ts.net") || hostname.endsWith(".co.uk") || hostname.endsWith(".com.au"))) {
      return null
    }
    return `.${hostname}`
  }

  return hostname
}

export function parseAllowedHosts(...sources: (string | readonly string[] | undefined)[]): string[] {
  const out = new Set<string>()
  for (const src of sources) {
    if (!src) continue
    const items = typeof src === "string" ? src.split(/[\s,]+/) : src
    for (const item of items) {
      if (typeof item !== "string") continue
      for (const part of item.split(/[\s,]+/)) {
        const normalized = normalizeAllowedHostEntry(part)
        if (normalized) out.add(normalized)
      }
    }
  }
  return [...out]
}

export function resolveAllowedHosts(
  extraHosts?: readonly string[] | string,
  env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined,
): string[] {
  if (extraHosts !== undefined) {
    return parseAllowedHosts(extraHosts)
  }
  return parseAllowedHosts(env?.ARCADE_DEV_ALLOWED_HOSTS, env?.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS)
}

export function isAllowedExtraHost(
  hostname: string,
  allowedHosts?: readonly string[] | string,
  env?: Record<string, string | undefined>,
): boolean {
  const h = hostname.trim().toLowerCase()
  if (!h) return false
  const list = resolveAllowedHosts(allowedHosts, env)
  for (const entry of list) {
    if (entry.startsWith(".")) {
      if (h.endsWith(entry) && h.length > entry.length) return true
    } else if (h === entry) {
      return true
    }
  }
  return false
}

export function isAllowedHost(
  hostOrHostname: string | undefined,
  allowedHosts?: readonly string[] | string,
  env?: Record<string, string | undefined>,
): boolean {
  if (!hostOrHostname) return false
  const parsed = parseHostHeader(hostOrHostname, "https:") ?? parseHostHeader(hostOrHostname, "http:")
  const hostname = parsed ? parsed.hostname : hostOrHostname.trim().toLowerCase()
  if (!hostname || /[\s/?#@\\]/.test(hostname)) return false
  return isAllowedLoopbackHost(hostname) || isAllowedExtraHost(hostname, allowedHosts, env)
}

export function isSameAllowedOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedHosts?: readonly string[] | string,
  env?: Record<string, string | undefined>,
): boolean {
  if (!originHeader || !hostHeader) return false
  const trimmedOrigin = originHeader.trim()
  try {
    const parsed = new URL(trimmedOrigin)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (parsed.origin.toLowerCase() !== trimmedOrigin.toLowerCase()) return false
    const parsedHost = parseHostHeader(hostHeader, parsed.protocol)
    if (!parsedHost) return false
    if (parsed.host.toLowerCase() !== parsedHost.host) return false

    if (isAllowedLoopbackHost(parsed.hostname)) {
      return true
    }
    if (isAllowedExtraHost(parsed.hostname, allowedHosts, env)) {
      return parsed.protocol === "https:"
    }
    return false
  } catch {
    return false
  }
}

export const isSameLoopbackOrigin = isSameAllowedOrigin

export function buildDevControlWsUrl(
  loc: { protocol: string; host: string },
  controlPath: string,
  pageToken: string,
  pageId: string,
): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${loc.host}${controlPath}?token=${encodeURIComponent(pageToken)}&pageId=${encodeURIComponent(pageId)}`
}

export function readStageCameraState(stage: Stage) {
  stage.updateCamera()
  return {
    focus: [round3(stage.focus[0]!), round3(stage.focus[1]!), round3(stage.focus[2]!)] as [number, number, number],
    target: [round3(stage.focus[0]!), round3(stage.focus[1]!), round3(stage.focus[2]!)] as [number, number, number],
    yaw: round4(stage.camYaw),
    pitch: round4(stage.camPitch),
    distance: round3(stage.camDist),
    orbit: round2((stage.camYaw * 180) / Math.PI),
    elevation: round2((stage.camPitch * 180) / Math.PI),
    eye: [round3(stage.eye[0]!), round3(stage.eye[1]!), round3(stage.eye[2]!)] as [number, number, number],
  }
}

export function registerStageCameraCommands(commands: LabCommandRegistry, opts: StageCameraCommandOptions): void {
  const { stage, render, canEdit, disabledReason, resolveFrameTarget } = opts

  commands.registerAll([
    {
      id: "camera.get",
      label: "Get Camera State",
      shortLabel: "Camera Get",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      run: () => readStageCameraState(stage),
    },
    {
      id: "camera.set",
      label: "Set Camera Orientation & Target",
      shortLabel: "Camera Set",
      category: "Scene",
      undoable: true,
      args: {
        orbit: { type: "number", min: -3600, max: 3600, description: "Orbit yaw in degrees" },
        elevation: { type: "number", min: 5, max: 89, description: "Elevation pitch in degrees (10..83)" },
        distance: { type: "number", min: 4, max: 75, description: "Distance in metres (4..75)" },
        targetX: { type: "number", description: "Target X coordinate" },
        targetY: { type: "number", description: "Target Y coordinate" },
        targetZ: { type: "number", description: "Target Z coordinate" },
        frame: { type: "string", description: "Object ID/name to frame, or 'scene'" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode (character is possessed). Run 'arcade release' first.",
      run: (_ctx, args) => {
        const a = args ?? {}
        const hasOrbit = typeof a.orbit === "number"
        const hasElevation = typeof a.elevation === "number"
        const hasDistance = typeof a.distance === "number"
        const hasTarget = typeof a.targetX === "number" || typeof a.targetY === "number" || typeof a.targetZ === "number"
        const hasFrame = typeof a.frame === "string" && a.frame.trim().length > 0

        if (!hasOrbit && !hasElevation && !hasDistance && !hasTarget && !hasFrame) {
          throw new Error("camera.set requires at least one of: orbit, elevation, distance, targetX/Y/Z, frame.")
        }

        if (hasFrame) {
          const query = String(a.frame).trim()
          const framed = resolveFrameTarget
            ? resolveFrameTarget(query)
            : query === "scene" || query === "origin" || query === "default"
              ? { x: 0, y: 0.5, z: 0, dist: 15 }
              : null
          if (!framed) {
            throw new Error(`Unknown frame target "${query}".`)
          }
          stage.frameTarget(framed.x, framed.y, framed.z, hasDistance ? Number(a.distance) : (framed.dist ?? stage.camDist))
        }
        if (hasTarget) {
          if (typeof a.targetX === "number") stage.focus[0] = a.targetX
          if (typeof a.targetY === "number") stage.focus[1] = a.targetY
          if (typeof a.targetZ === "number") stage.focus[2] = a.targetZ
          stage.camCustom = true
        }
        if (hasOrbit) {
          stage.camYaw = (Number(a.orbit) * Math.PI) / 180
          stage.camCustom = true
        }
        if (hasElevation) {
          stage.camPitch = Math.max(0.18, Math.min(1.45, (Number(a.elevation) * Math.PI) / 180))
          stage.camCustom = true
        }
        if (hasDistance) {
          stage.camDist = Math.max(4, Math.min(75, Number(a.distance)))
          stage.camCustom = true
        }
        stage.updateCamera()
        void render()
        return readStageCameraState(stage)
      },
    },
  ])
}

const normalizeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

export function formatControlValue(control: LabControl, val: LabValue): string {
  if ("min" in control) {
    const unit = inferControlUnit(control.key, control.label, control.unit)
    return formatLabValue(val, control.step, unit)
  }
  return String(val)
}

export function findControlRow(
  panels: readonly LabPanel[],
  rawPath: string,
): { panel: LabPanel; row: LabRow; control: LabControl } | null {
  const trimmed = rawPath.trim()
  const dotIdx = trimmed.indexOf(".")
  const prefix = dotIdx > 0 ? trimmed.slice(0, dotIdx).trim().toLowerCase() : null
  const leaf = dotIdx > 0 ? trimmed.slice(dotIdx + 1).trim() : trimmed
  const leafLower = leaf.toLowerCase()
  const leafSlug = normalizeSlug(leaf)

  const allRows: { panel: LabPanel; row: LabRow; control: LabControl }[] = []
  for (const panel of panels) {
    for (const row of panel.navigation.rows) {
      if (row.control) allRows.push({ panel, row, control: row.control })
    }
  }

  for (const entry of allRows) {
    const { row, control } = entry
    if (prefix && normalizeSlug(row.group) !== normalizeSlug(prefix)) continue
    if (control.key === leaf || control.key.toLowerCase() === leafLower) return entry
  }
  for (const entry of allRows) {
    const { row, control } = entry
    if (prefix && !normalizeSlug(row.group).includes(normalizeSlug(prefix))) continue
    if (
      control.label.toLowerCase() === leafLower ||
      normalizeSlug(control.label) === leafSlug ||
      normalizeSlug(control.key) === leafSlug ||
      normalizeSlug(`${row.group}.${control.key}`) === normalizeSlug(trimmed)
    ) {
      return entry
    }
  }
  return null
}

export function coerceControlValue(control: LabControl, rawValue: unknown): LabValue {
  if (control.type === "action") return true
  if ("options" in control) {
    const str = String(rawValue).toLowerCase()
    const match = control.options.find(
      opt =>
        opt.value === rawValue ||
        String(opt.value).toLowerCase() === str ||
        opt.label.toLowerCase() === str ||
        normalizeSlug(opt.label) === normalizeSlug(str),
    )
    if (!match) {
      const choices = control.options.map(o => `${String(o.value)} (${o.label})`).join(", ")
      throw new Error(`Invalid value "${String(rawValue)}" for "${control.label}". Valid options: ${choices}.`)
    }
    return match.value
  }
  if ("min" in control) {
    const num =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim() !== ""
          ? Number(rawValue)
          : Number.NaN
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid numeric value "${String(rawValue)}" for "${control.label}".`)
    }
    if (num < control.min || num > control.max) {
      throw new Error(`Value ${num} for "${control.label}" (${control.key}) is out of range [${control.min}, ${control.max}].`)
    }
    return num
  }
  const onVal = "on" in control && control.on !== undefined ? control.on : true
  const offVal = "off" in control && control.off !== undefined ? control.off : false
  if (rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true" || rawValue === "on") return onVal
  if (rawValue === false || rawValue === 0 || rawValue === "0" || rawValue === "false" || rawValue === "off") return offVal
  throw new Error(`Invalid toggle value "${String(rawValue)}" for "${control.label}". Expected true or false.`)
}

export function registerPanelLabCommands(commands: LabCommandRegistry, opts: PanelLabCommandOptions): void {
  const { getPanels, canEdit, disabledReason, render, extraGet, extraSet } = opts

  commands.registerAll([
    {
      id: "lab.get",
      label: "Get Lab Parameter Value(s)",
      shortLabel: "Lab Get",
      category: "Inspector",
      undoable: false,
      args: {
        path: { type: "string", description: "Control key, group.key, or label (omit for all controls)" },
      },
      enabled: () => true,
      run: (_ctx, args) => {
        const rawPath = typeof args?.path === "string" ? args.path.trim() : ""
        const panels = getPanels()
        if (!rawPath || rawPath === "all" || rawPath === "*") {
          const settings: Record<string, LabValue> = {}
          const controls: Record<string, unknown>[] = []
          for (const panel of panels) {
            for (const row of panel.navigation.rows) {
              const c = row.control
              if (!c) continue
              if (c.type === "action") {
                controls.push({ key: c.key, label: c.label, group: row.group, type: "action" })
                continue
              }
              const val = panel.navigation.settings[c.key]!
              settings[c.key] = val
              controls.push({
                key: c.key,
                label: c.label,
                group: row.group,
                value: val,
                formatted: formatControlValue(c, val),
                ...("min" in c ? { min: c.min, max: c.max, step: c.step, unit: inferControlUnit(c.key, c.label, c.unit) } : {}),
                ...("options" in c ? { options: c.options } : {}),
              })
            }
          }
          const extra = extraGet?.()
          if (extra && typeof extra === "object") Object.assign(settings, extra)
          return { settings, controls }
        }

        const found = findControlRow(panels, rawPath)
        if (found) {
          const { panel, row, control: c } = found
          if (c.type === "action") {
            return { key: c.key, label: c.label, group: row.group, type: "action" }
          }
          const val = panel.navigation.settings[c.key]!
          return {
            key: c.key,
            label: c.label,
            group: row.group,
            value: val,
            formatted: formatControlValue(c, val),
            ...("min" in c ? { min: c.min, max: c.max, step: c.step, unit: inferControlUnit(c.key, c.label, c.unit) } : {}),
            ...("options" in c ? { options: c.options } : {}),
          }
        }

        if (extraGet) {
          const extraVal = extraGet(rawPath)
          if (extraVal !== undefined) return extraVal
        }

        const available: string[] = []
        for (const panel of panels) {
          for (const row of panel.navigation.rows) {
            if (row.control) available.push(row.control.key)
          }
        }
        throw new Error(`Unknown lab setting "${rawPath}". Available keys: ${available.slice(0, 30).join(", ") || "none"}.`)
      },
    },
    {
      id: "scene.set-param",
      label: "Set Inspector Parameter",
      shortLabel: "Set Param",
      category: "Inspector",
      undoable: true,
      args: {
        key: { type: "string", required: true, description: "Control key, group.key, or label" },
        value: { type: "value", required: true, description: "New value (number, boolean, or option)" },
      },
      enabled: () => (canEdit ? canEdit() : true),
      disabledReason: () => disabledReason?.() ?? "Unavailable in Play mode",
      run: (_ctx, args) => {
        const rawPath = String(args?.key ?? "").trim()
        const rawValue = args?.value
        if (!rawPath) {
          throw new Error("scene.set-param requires a non-empty key.")
        }
        const panels = getPanels()
        const found = findControlRow(panels, rawPath)
        if (found) {
          const { panel, row, control: c } = found
          if (c.type === "action") {
            void c.run(document.createElement("button"))
            panel.sync()
            void render?.()
            return { key: c.key, label: c.label, group: row.group, action: "triggered" }
          }
          const prev = panel.navigation.settings[c.key]
          const next = coerceControlValue(c, rawValue)
          panel.navigation.set(c, next)
          panel.sync()
          void render?.()
          return {
            key: c.key,
            label: c.label,
            group: row.group,
            before: prev,
            value: panel.navigation.settings[c.key],
            formatted: formatControlValue(c, panel.navigation.settings[c.key]!),
          }
        }

        if (extraSet) {
          const extraRes = extraSet(rawPath, rawValue)
          if (extraRes) {
            void render?.()
            return extraRes
          }
        }

        const available: string[] = []
        for (const panel of panels) {
          for (const row of panel.navigation.rows) {
            if (row.control) available.push(row.control.key)
          }
        }
        throw new Error(`Unknown lab setting "${rawPath}". Available keys: ${available.slice(0, 30).join(", ") || "none"}.`)
      },
    },
  ])
}

export function resolveNavigationPath(target: string): string {
  const raw = target.trim()
  if (!raw) throw new Error("Navigation target cannot be empty.")
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const parsed = new URL(raw)
    return parsed.pathname + parsed.search + parsed.hash
  }
  if (raw.startsWith("/")) return raw
  if (raw.startsWith("#")) return `/arcade/getaway/dev.html${raw}`

  const lower = raw.toLowerCase()
  if (lower === "hub" || lower === "games") return "/arcade/getaway/dev.html#games"
  if (lower === "catalogue" || lower === "catalog") return "/arcade/getaway/dev.html#catalogue"
  if (lower.startsWith("catalogue/") || lower.startsWith("catalog/")) {
    const asset = raw.slice(raw.indexOf("/") + 1)
    return `/arcade/getaway/dev.html#catalogue/${encodeURIComponent(asset)}`
  }
  if (lower === "characters" || lower === "character" || lower === "rig") {
    return "/arcade/blackout/characters.html"
  }
  if (lower === "anim" || lower === "anim-viewer") {
    return "/arcade/blackout/anim.html"
  }
  if (lower === "lab" || lower === "sandbox" || lower === "getaway-lab") {
    return "/arcade/getaway/lab.html"
  }
  if (lower === "blackout-lab") {
    return "/arcade/blackout/lab.html"
  }
  if (lower === "getaway") return "/arcade/getaway/?solo&seed=7"
  if (lower === "blackout") return "/arcade/blackout/?sandbox=1&seed=1"
  if (lower === "wizards") return "/arcade/blackout/?sandbox=1&mode=wizards&seed=1"
  if (lower === "outbreak") return "/arcade/outbreak/?seed=7"
  if (lower === "carrier") return "/arcade/carrier/?seed=7"

  throw new Error(
    `Unknown page target "${target}". Expected one of: hub, games, lab, sandbox, blackout-lab, catalogue, characters, getaway, blackout, outbreak, carrier, or a /arcade/... path.`,
  )
}

function detectGameName(pathname: string): string {
  const m = pathname.match(/^\/arcade\/([a-z0-9-]+)/)
  return m?.[1] ?? "unknown"
}

function getSubmitListeners(): Set<() => void> {
  if (typeof window === "undefined") return new Set()
  window.__arcadeSubmitListeners ??= new Set<() => void>()
  if (import.meta.env?.DEV && !window.__arcadeSubmitHooked && typeof GPUQueue !== "undefined") {
    window.__arcadeSubmitHooked = true
    const origSubmit = GPUQueue.prototype.submit
    GPUQueue.prototype.submit = function (commandBuffers) {
      const res = origSubmit.call(this, commandBuffers)
      const listeners = window.__arcadeSubmitListeners
      if (listeners && listeners.size > 0) {
        for (const fn of [...listeners]) fn()
      }
      return res
    }
  }
  return window.__arcadeSubmitListeners
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  getSubmitListeners()
}

async function captureWebGPUOr2DCanvas(
  canvas: HTMLCanvasElement,
  customCapture: ((target: HTMLCanvasElement) => Promise<void> | void) | undefined,
  maxSize = 1280,
): Promise<{ dataUrl: string; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  const scratch = document.createElement("canvas")
  const srcW = Math.max(1, canvas.width || canvas.clientWidth || 320)
  const srcH = Math.max(1, canvas.height || canvas.clientHeight || 200)
  scratch.width = srcW
  scratch.height = srcH

  if (customCapture) {
    await customCapture(scratch)
  } else {
    const ctx2d = scratch.getContext("2d")!
    let capturedViaSubmit = false
    if (typeof GPUQueue !== "undefined") {
      const listeners = getSubmitListeners()
      await new Promise<void>(resolve => {
        let settled = false
        let rafAfter = 0
        const onSubmit = () => {
          try {
            ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            capturedViaSubmit = true
          } catch {}
          if (!rafAfter) {
            rafAfter = requestAnimationFrame(() => {
              window.clearTimeout(timer)
              finish()
            })
          }
        }
        const finish = () => {
          if (settled) return
          settled = true
          listeners.delete(onSubmit)
          if (rafAfter) cancelAnimationFrame(rafAfter)
          resolve()
        }
        const timer = window.setTimeout(() => {
          if (!capturedViaSubmit) {
            try {
              ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            } catch {}
          }
          finish()
        }, 250)
        listeners.add(onSubmit)
      })
    } else {
      ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
    }
  }

  const limit = maxSize > 0 ? maxSize : Math.max(scratch.width, scratch.height)
  const longest = Math.max(scratch.width, scratch.height)
  let outCanvas = scratch
  if (longest > limit) {
    const scale = limit / longest
    const outW = Math.max(1, Math.round(scratch.width * scale))
    const outH = Math.max(1, Math.round(scratch.height * scale))
    const scaled = document.createElement("canvas")
    scaled.width = outW
    scaled.height = outH
    const sctx = scaled.getContext("2d")!
    sctx.drawImage(scratch, 0, 0, outW, outH)
    outCanvas = scaled
  }

  return {
    dataUrl: outCanvas.toDataURL("image/png"),
    width: outCanvas.width,
    height: outCanvas.height,
    sourceWidth: scratch.width,
    sourceHeight: scratch.height,
  }
}

function synthesizeHubCanvas(): HTMLCanvasElement {
  const out = document.createElement("canvas")
  out.width = Math.max(640, Math.min(1280, window.innerWidth || 960))
  out.height = Math.max(400, Math.min(800, window.innerHeight || 600))
  const ctx = out.getContext("2d")!
  ctx.fillStyle = "#0e1318"
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.fillStyle = "#171f27"
  ctx.fillRect(0, 0, out.width, 44)
  ctx.fillStyle = "#e4e9ed"
  ctx.font = "600 15px system-ui, -apple-system, sans-serif"
  ctx.fillText(`Arcade Dev Hub (${document.title || location.pathname + location.hash})`, 20, 27)
  const cards = [...document.querySelectorAll<HTMLElement>("a.game")]
  let y = 76
  for (const card of cards) {
    ctx.fillStyle = "#19222b"
    ctx.fillRect(24, y, 260, 54)
    ctx.strokeStyle = "#2d3c4a"
    ctx.strokeRect(24, y, 260, 54)
    ctx.fillStyle = "#e4e9ed"
    ctx.font = "600 14px system-ui, -apple-system, sans-serif"
    ctx.fillText(card.querySelector("span")?.textContent ?? card.dataset.game ?? "Game", 38, y + 24)
    ctx.fillStyle = "#8fa0ad"
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillText(card.querySelector("small")?.textContent ?? card.getAttribute("href") ?? "", 38, y + 42)
    y += 66
  }
  return out
}

export function buildDevControlWsUrl(
  loc: { protocol: string; host: string },
  controlPath: string,
  pageToken: string,
  pageId: string,
): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${loc.host}${controlPath}?token=${encodeURIComponent(pageToken)}&pageId=${encodeURIComponent(pageId)}`
}

const COMMAND_ALIASES: Record<string, string> = {
  select: "object.select",
  spawn: "ground.spawn-here",
  "lab.set": "scene.set-param",
  env: "scene.set-env",
  "env.set": "scene.set-env",
  possess: "object.possess",
  release: "mode.play",
  "preset.save": "preset.export",
  "preset.load": "preset.import",
  undo: "edit.undo",
  redo: "edit.redo",
  reroll: "ground.reroll",
  frame: "object.frame",
}

// Singleton per-page DevControl runtime (only active in DEV when served by the Arcade dev router)
class PageControlRuntime {
  readonly panels = new Set<LabPanel>()
  private adapter: DevControlAdapter | null = null
  private defaultAdapter: DevControlAdapter | null = null
  private ws: WebSocket | null = null
  private reconnectTimer = 0
  private indicatorEl: HTMLElement | null = null
  private indicatorTimer = 0
  private lastActiveAt = Date.now()
  private fallbackReady = false
  readonly pageId: string
  private routerConfig: { controlPath: string; pageToken: string } | null = null

  constructor() {
    this.pageId = this.resolvePageId()
    if (!import.meta.env?.DEV) return
    if (typeof window === "undefined" || typeof document === "undefined") return
    this.routerConfig = this.readRouterConfig()
    if (!this.routerConfig) return

    const bumpActivity = () => {
      this.lastActiveAt = Date.now()
      this.sendStatus()
    }
    window.addEventListener("focus", bumpActivity)
    window.addEventListener("blur", () => this.sendStatus())
    document.addEventListener("visibilitychange", () => this.sendStatus())
    window.addEventListener("hashchange", () => {
      this.lastActiveAt = Date.now()
      this.sendStatus()
    })
    window.addEventListener("popstate", () => this.sendStatus())
    this.connect()
    this.pollUntilReady()
  }

  private isPageReady(): boolean {
    if (this.adapter !== null) return true
    if (location.pathname.endsWith("/lab.html") || location.pathname.endsWith("/dev.html")) {
      return this.fallbackReady
    }
    if (this.panels.size > 0) return true
    if ((globalThis as { carrier?: unknown }).carrier !== undefined) return true
    return this.fallbackReady
  }

  private pollUntilReady() {
    const started = Date.now()
    const isStructuredPage = location.pathname.endsWith("/lab.html") || location.pathname.endsWith("/dev.html")
    const maxWait = isStructuredPage ? 6000 : 1200
    const timer = window.setInterval(() => {
      if (this.isPageReady()) {
        window.clearInterval(timer)
        this.sendStatus()
        return
      }
      if (Date.now() - started > maxWait) {
        this.fallbackReady = true
        window.clearInterval(timer)
        this.sendStatus()
      }
    }, 40)
  }

  private async waitForReady(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.isPageReady() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 40))
    }
  }

  private resolvePageId(): string {
    try {
      const key = "arcade.control.pageId"
      const existing = sessionStorage.getItem(key)
      if (existing) return existing
      const id = `page_${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(key, id)
      return id
    } catch {
      return `page_${Math.random().toString(36).slice(2, 10)}`
    }
  }

  private readRouterConfig(): { controlPath: string; pageToken: string } | null {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="arcade-dev-router"]')?.content
    if (!meta) return null
    try {
      const parsed = JSON.parse(meta) as { controlPath?: string; pageToken?: string }
      if (typeof parsed.controlPath === "string" && typeof parsed.pageToken === "string") {
        return { controlPath: parsed.controlPath, pageToken: parsed.pageToken }
      }
    } catch {}
    return null
  }

  setAdapter(adapter: DevControlAdapter | null) {
    this.adapter = adapter
    if (adapter) {
      this.ensureStandardCommands(adapter)
    }
    this.sendStatus()
  }

  addPanel(panel: LabPanel) {
    this.panels.add(panel)
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    this.sendStatus()
  }

  removePanel(panel: LabPanel) {
    this.panels.delete(panel)
    this.sendStatus()
  }

  private activeAdapter(): DevControlAdapter {
    if (this.adapter) return this.adapter
    if (!this.defaultAdapter) {
      this.defaultAdapter = this.createDefaultGameAdapter()
      this.ensureStandardCommands(this.defaultAdapter)
    }
    return this.defaultAdapter
  }

  private createDefaultGameAdapter(): DevControlAdapter {
    const commands = new LabCommandRegistry()
    const getCarrier = () => (globalThis as { carrier?: Record<string, any> }).carrier
    const classifyCarrierWeather = (c: Record<string, any>): string => {
      const w = c.lab?.mode === "manual" ? c.lab.target : c.weather?.current
      const rain = Number(w?.rain ?? 0)
      return rain < 0.05 ? "clear" : rain < 0.35 ? "light" : rain < 0.7 ? "medium" : "heavy"
    }
    registerPanelLabCommands(commands, {
      getPanels: () => [...this.panels],
      extraGet: path => {
        const c = getCarrier()
        if (!c) return undefined
        if (!path) {
          return {
            weather: classifyCarrierWeather(c),
            hour: round2(c.daynight?.state?.hour ?? 12),
            exposure: round2(c.grade?.exposure ?? 0),
            overcast: round2(c.atmosphere?.overcast ?? 0),
          }
        }
        const key = path.toLowerCase()
        if (key === "weather") return { key: "weather", label: "Weather", value: classifyCarrierWeather(c) }
        if (key === "hour" || key === "tod") return { key: "hour", label: "Time of day", value: round2(c.daynight?.state?.hour ?? 12) }
        if (c.grade && key in c.grade) return { key, label: key, group: "Grade", value: c.grade[key] }
        if (c.atmosphere && key in c.atmosphere) return { key, label: key, group: "Atmosphere", value: c.atmosphere[key] }
        return undefined
      },
      extraSet: (path, value) => {
        const c = getCarrier()
        if (!c) return null
        const key = path.toLowerCase()
        if (key === "weather" && c.lab?.force) {
          const valid = ["clear", "light", "medium", "heavy"]
          const str = String(value).toLowerCase()
          if (!valid.includes(str)) {
            throw new Error(`Invalid Carrier weather "${String(value)}". Expected: ${valid.join(", ")}.`)
          }
          const before = classifyCarrierWeather(c)
          c.lab.force(str, 0)
          c.lab.frame?.(0, 0)
          return { key: "weather", label: "Weather", before, value: classifyCarrierWeather(c) }
        }
        if ((key === "hour" || key === "tod") && c.daynight?.setManual) {
          const num = Number(value)
          if (!Number.isFinite(num) || num < 0 || num > 24) {
            throw new Error(`Invalid hour "${String(value)}". Expected 0..24.`)
          }
          const before = round2(c.daynight?.state?.hour ?? 12)
          c.daynight.setManual(num, 0)
          return { key: "hour", label: "Time of day", before, value: num }
        }
        if (c.grade && key in c.grade && typeof c.grade[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.grade[key]
          c.grade[key] = num
          return { key, label: key, before, value: num }
        }
        if (c.atmosphere && key in c.atmosphere && typeof c.atmosphere[key] === "number") {
          const num = Number(value)
          if (!Number.isFinite(num)) throw new Error(`Invalid number "${String(value)}".`)
          const before = c.atmosphere[key]
          c.atmosphere[key] = num
          return { key, label: key, before, value: num }
        }
        return null
      },
    })
    return {
      kind: "game",
      commands,
      getCanvas: () => document.querySelector<HTMLCanvasElement>("canvas"),
      isBusy: () => {
        for (const p of this.panels) {
          if (p.isInteracting()) return { busy: true, reason: "User is scrubbing a Lab control" }
        }
        return { busy: false }
      },
      getState: () => {
        const labAll = commands.get("lab.get")?.run({ pickedObject: null, groundHit: null, args: {} }) as
          | { settings?: Record<string, unknown> }
          | undefined
        const canvas = document.querySelector<HTMLCanvasElement>("canvas")
        const c = getCarrier()
        return {
          game: detectGameName(location.pathname),
          settings: labAll?.settings ?? {},
          ...(c?.camera
            ? {
                camera: {
                  orbit: round2(((c.camera.yaw ?? 0) * 180) / Math.PI),
                  elevation: round2(((c.camera.pitch ?? 0) * 180) / Math.PI),
                  distance: round2(c.camera.dist ?? 0),
                  target: [round2(c.camera.x ?? 0), 0, round2(c.camera.z ?? 0)],
                },
              }
            : {}),
          canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        }
      },
    }
  }

  private ensureStandardCommands(adapter: DevControlAdapter) {
    const { commands } = adapter
    if (!commands.get("nav.open")) {
      commands.register({
        id: "nav.open",
        label: "Navigate Page",
        shortLabel: "Open",
        category: "Scene",
        undoable: false,
        args: {
          target: { type: "string", required: true, description: "Page shorthand or /arcade/... path" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const target = String(args?.target ?? "")
          const resolved = resolveNavigationPath(target)
          const targetUrl = new URL(resolved, location.origin)
          const sameDoc = targetUrl.pathname === location.pathname && targetUrl.search === location.search && Boolean(targetUrl.hash)
          if (sameDoc) {
            location.hash = targetUrl.hash
            if (targetUrl.hash.startsWith("#catalogue")) {
              const deadline = Date.now() + 5000
              while (this.adapter?.kind !== "catalogue" && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 40))
              }
            } else {
              await new Promise(r => setTimeout(r, 60))
            }
            this.sendStatus()
            return { navigated: resolved, inPage: true, url: location.href }
          }
          setTimeout(() => {
            location.assign(targetUrl.href)
          }, 15)
          return { navigating: true, navigated: resolved, inPage: false, url: targetUrl.href }
        },
      })
    }

    if (!commands.get("state")) {
      commands.register({
        id: "state",
        label: "Get Scene & Page State",
        shortLabel: "State",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: async () => {
          const regState = commands.state()
          const pageState = regState ?? (await adapter.getState())
          return {
            page: this.buildSummary(),
            ...pageState,
          }
        },
      })
    }

    if (!commands.get("screenshot")) {
      commands.register({
        id: "screenshot",
        label: "Capture Canvas Screenshot",
        shortLabel: "Screenshot",
        category: "Scene",
        undoable: false,
        args: {
          maxSize: { type: "number", min: 0, max: 4096, description: "Max long-edge pixel dimension (default 1280, 0 for native)" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const maxSize = typeof args?.maxSize === "number" ? args.maxSize : 1280
          const canvas = adapter.getCanvas?.() ?? document.querySelector<HTMLCanvasElement>("canvas")
          if (!canvas || (canvas.closest("[hidden]") && adapter.kind === "hub")) {
            const synth = synthesizeHubCanvas()
            return await captureWebGPUOr2DCanvas(synth, undefined, maxSize)
          }
          return await captureWebGPUOr2DCanvas(canvas, adapter.captureCanvas, maxSize)
        },
      })
    }
  }

  showIndicator(text: string, isError = false) {
    const adapter = this.activeAdapter()
    adapter.onIndicator?.(text, isError)
    if (!this.indicatorEl || !document.body.contains(this.indicatorEl)) {
      const el = document.createElement("div")
      el.dataset.arcadeCliIndicator = ""
      el.setAttribute("role", "status")
      el.setAttribute("aria-live", "polite")
      el.style.cssText =
        "position:fixed;top:44px;right:14px;z-index:9999;pointer-events:none;font:600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 10px;border-radius:999px;background:rgba(14,19,24,0.92);color:#7cc5d6;border:1px solid rgba(124,197,214,0.42);box-shadow:0 4px 14px rgba(0,0,0,0.35);transition:opacity 0.15s ease"
      document.body.append(el)
      this.indicatorEl = el
    }
    this.indicatorEl.textContent = text
    this.indicatorEl.style.color = isError ? "#ff8a8a" : "#7cc5d6"
    this.indicatorEl.style.borderColor = isError ? "rgba(255,138,138,0.45)" : "rgba(124,197,214,0.42)"
    this.indicatorEl.hidden = false
    if (this.indicatorTimer) window.clearTimeout(this.indicatorTimer)
    this.indicatorTimer = window.setTimeout(() => {
      if (this.indicatorEl) this.indicatorEl.hidden = true
    }, 2200)
  }

  buildSummary(): DevPageSummary {
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    return {
      id: this.pageId,
      kind: adapter.kind,
      url: location.href,
      pathname: location.pathname,
      hash: location.hash,
      title: document.title || adapter.kind,
      focused: document.hasFocus(),
      visible: !document.hidden,
      mode: adapter.getMode?.() ?? "view",
      section: adapter.getSection?.(),
      commands: adapter.commands.describe(),
      updatedAt: Date.now(),
      lastActiveAt: this.lastActiveAt,
    }
  }

  sendStatus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.isPageReady()) return
    try {
      this.ws.send(JSON.stringify({ type: "status", page: this.buildSummary() }))
    } catch {}
  }

  private async waitIfBusy(adapter: DevControlAdapter, waitMs = 600): Promise<DevControlBusyState> {
    for (const panel of this.panels) {
      if (panel.isInteracting()) {
        return { busy: true, reason: "User is actively scrubbing or editing a Lab control." }
      }
    }
    if (!adapter.isBusy) return { busy: false }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const state = adapter.isBusy()
      if (!state.busy) return state
      await new Promise(r => setTimeout(r, 50))
    }
    return adapter.isBusy()
  }

  private formatIndicatorText(command: string, args?: Record<string, unknown>): string {
    const short = command.replace(/\./g, " ")
    if ((command === "scene.set-param" || command === "lab.set") && (args?.key ?? args?.path) !== undefined) {
      return `CLI: lab set ${String(args?.key ?? args?.path)} = ${String(args?.value)}`
    }
    if ((command === "object.select" || command === "select") && (args?.id ?? args?.target) !== undefined) {
      return `CLI: select ${String(args?.id ?? args?.target)}`
    }
    if ((command === "ground.spawn-here" || command === "spawn") && args?.asset !== undefined) {
      return `CLI: spawn ${String(args.asset)}`
    }
    if ((command === "scene.set-env" || command === "env") && args?.name !== undefined) {
      return `CLI: env ${String(args.name)}`
    }
    if (command === "nav.open" && args?.target !== undefined) {
      return `CLI: open ${String(args.target)}`
    }
    return `CLI: ${short}`
  }

  private resolveCommandId(commands: LabCommandRegistry, requested: string): string {
    if (commands.get(requested)) return requested
    const mapped = COMMAND_ALIASES[requested]
    if (mapped && commands.get(mapped)) return mapped
    return requested
  }

  private isReadOnlyCommand(id: string): boolean {
    return id === "state" || id === "screenshot" || id === "camera.get" || id === "lab.get" || id === "preset.export"
  }

  private async handleRpc(msg: { requestId: string; command: string; args?: Record<string, unknown> }) {
    await this.waitForReady()
    const adapter = this.activeAdapter()
    this.ensureStandardCommands(adapter)
    const cmdId = this.resolveCommandId(adapter.commands, msg.command)
    const cmd = adapter.commands.get(cmdId)

    if (cmd && !this.isReadOnlyCommand(cmd.id)) {
      const busy = await this.waitIfBusy(adapter)
      if (busy.busy) {
        const reason = busy.reason ?? "User is actively interacting with the viewport."
        this.showIndicator(`CLI blocked: ${reason}`, true)
        const outcome: LabCommandInvokeResult = {
          ok: false,
          id: cmd.id,
          code: "busy",
          error: `Blocked by live user input: ${reason}`,
        }
        this.ws?.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
        return
      }
    }

    const rawOutcome = adapter.commands.invoke(cmdId, msg.args, {
      pickedObject: null,
      groundHit: null,
      source: "cli",
    })

    let outcome: LabCommandInvokeResult = rawOutcome
    if (rawOutcome.ok && rawOutcome.result instanceof Promise) {
      try {
        const awaited = await rawOutcome.result
        outcome = { ...rawOutcome, state: adapter.commands.state(), result: awaited }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        outcome = {
          ok: false,
          id: rawOutcome.id,
          code: /unavailable|play mode/i.test(message) ? "unavailable" : "invalid_args",
          error: message,
        }
      }
    }

    if (outcome.ok && !this.isReadOnlyCommand(outcome.id)) {
      this.showIndicator(this.formatIndicatorText(outcome.id, msg.args), false)
    } else if (!outcome.ok) {
      this.showIndicator(`CLI: ${msg.command} (${outcome.code ?? "error"})`, true)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, outcome, page: this.buildSummary() }))
    }
  }

  private connect() {
    if (!this.routerConfig) return
    const wsUrl = buildDevControlWsUrl(location, this.routerConfig.controlPath, this.routerConfig.pageToken, this.pageId)
    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.onopen = () => {
        this.sendStatus()
      }
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string; requestId?: string; command?: string; args?: Record<string, unknown> }
          if (msg.type === "invoke" && msg.requestId && msg.command) {
            void this.handleRpc({ requestId: msg.requestId, command: msg.command, args: msg.args })
          } else if (msg.type === "ping") {
            this.sendStatus()
          }
        } catch {}
      }
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null
        if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
        this.reconnectTimer = window.setTimeout(() => this.connect(), 600)
      }
      ws.onerror = () => {
        ws.close()
      }
    } catch {}
  }
}

function getRuntime(): PageControlRuntime | null {
  if (!import.meta.env?.DEV) return null
  if (typeof window === "undefined" || typeof document === "undefined") return null
  window.__arcadeDevControl ??= new PageControlRuntime()
  return window.__arcadeDevControl
}

if (import.meta.env?.DEV) {
  getRuntime()
}

export function registerDevControl(adapter: DevControlAdapter): { notifyUpdate: () => void; dispose: () => void } {
  const rt = getRuntime()
  rt?.setAdapter(adapter)
  return {
    notifyUpdate: () => rt?.sendStatus(),
    dispose: () => rt?.setAdapter(null),
  }
}

export function attachLabPanelControl(panel: LabPanel): () => void {
  const rt = getRuntime()
  rt?.addPanel(panel)
  return () => rt?.removePanel(panel)
}

export function ensureDevControlConnected(): void {
  getRuntime()
}
