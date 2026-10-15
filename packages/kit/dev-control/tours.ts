import type { LabCommandRegistry } from "../lab-commands"
import type {
  DevNotePayload,
  DevNoteResolvedRect,
  DevNoteTarget,
  TourDefinition,
  TourPageImage,
  TourSetupCommand,
  TourStepDefinition,
} from "./types"

export const STUDIO_SESSION_KEY = "arcade.studio.tour.v1"

/** The single Lab app (`/arcade/lab/`); `lab.html` covers standalone fixtures that still serve one. */
export const isLabPath = (pathname: string) => pathname.startsWith("/arcade/lab/") || pathname.endsWith("/lab.html")

export function resolveNavigationPath(target: string): string {
  const raw = target.trim()
  if (!raw) throw new Error("Navigation target cannot be empty.")
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const parsed = new URL(raw)
    return parsed.pathname + parsed.search + parsed.hash
  }
  if (raw.startsWith("/")) return raw
  if (raw.startsWith("#")) return `/arcade/getaway/dev.html${raw}`

  let baseRaw = raw
  let extraSuffix = ""
  const qIdx = raw.indexOf("?")
  const hIdx = raw.indexOf("#")
  const splitIdx = qIdx >= 0 && hIdx >= 0 ? Math.min(qIdx, hIdx) : qIdx >= 0 ? qIdx : hIdx
  if (splitIdx > 0) {
    baseRaw = raw.slice(0, splitIdx)
    extraSuffix = raw.slice(splitIdx)
  }

  const lower = baseRaw.toLowerCase()
  let baseResolved: string | null = null
  if (lower === "hub" || lower === "games" || lower === "studio") baseResolved = "/arcade/getaway/dev.html#games"
  else if (lower.startsWith("tour/")) {
    baseResolved = `/arcade/getaway/dev.html#${raw}`
    extraSuffix = ""
  } else if (lower === "catalogue" || lower === "catalog") baseResolved = "/arcade/getaway/dev.html#catalogue"
  else if (lower.startsWith("catalogue/") || lower.startsWith("catalog/")) {
    const asset = baseRaw.slice(baseRaw.indexOf("/") + 1)
    baseResolved = `/arcade/getaway/dev.html#catalogue/${encodeURIComponent(asset)}`
  } else if (lower === "characters" || lower === "character" || lower === "rig") {
    baseResolved = "/arcade/blackout/characters.html"
  } else if (lower === "anim" || lower === "anim-viewer") {
    baseResolved = "/arcade/blackout/anim.html"
  } else if (lower === "lab" || lower === "sandbox") {
    baseResolved = "/arcade/lab/"
  } else if (lower === "getaway-lab") {
    baseResolved = "/arcade/lab/?game=getaway"
  } else if (lower === "outbreak-lab" || lower === "vignette" || lower === "outbreak-vignette") {
    baseResolved = "/arcade/lab/?game=outbreak&section=outbreak-vignette"
  } else if (lower === "looks" || lower === "looks-lab") {
    baseResolved = "/arcade/lab/#looks"
  } else if (lower === "blackout-lab") {
    baseResolved = "/arcade/lab/?game=blackout"
  } else if (lower === "getaway") baseResolved = "/arcade/getaway/?solo&seed=7"
  else if (lower === "blackout") baseResolved = "/arcade/blackout/?sandbox=1&seed=1"
  else if (lower === "wizards") baseResolved = "/arcade/blackout/?sandbox=1&mode=wizards&seed=1"
  else if (lower === "outbreak") baseResolved = "/arcade/outbreak/?seed=7"
  else if (lower === "carrier") baseResolved = "/arcade/carrier/?seed=7"

  if (!baseResolved) {
    throw new Error(
      `Unknown page target "${target}". Expected one of: hub, games, lab, sandbox, getaway-lab, blackout-lab, outbreak-lab, catalogue, characters, getaway, blackout, outbreak, carrier, or a /arcade/... path.`,
    )
  }
  if (!extraSuffix) return baseResolved
  const baseUrl = new URL(baseResolved, "http://arcade.local")
  const extraUrl = new URL(`http://arcade.local/x${extraSuffix}`)
  for (const [k, v] of extraUrl.searchParams.entries()) {
    baseUrl.searchParams.set(k, v)
  }
  if (extraUrl.hash) baseUrl.hash = extraUrl.hash
  return baseUrl.pathname + baseUrl.search + baseUrl.hash
}

const ALLOWED_TARGET_KEYS = new Set([
  "objectId",
  "object",
  "id",
  "setting",
  "settingKey",
  "key",
  "rect",
  "screenRect",
  "world",
  "worldPoint",
  "point",
  "selector",
  "x",
  "y",
  "z",
  "width",
  "height",
  "w",
  "h",
])

function parseNumberList(raw: string, label: string, expectedCounts: readonly number[]): number[] {
  const nums = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
  if (!expectedCounts.includes(nums.length) || !nums.every(Number.isFinite)) {
    throw new Error(`Invalid ${label} "${raw}". Expected ${expectedCounts.join(" or ")} comma-separated numbers.`)
  }
  return nums
}

export function normalizeNoteTarget(raw: unknown): DevNoteTarget | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith("{")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        throw new Error(`Invalid JSON in note target: ${err instanceof Error ? err.message : String(err)}`)
      }
      return normalizeNoteTarget(parsed)
    }
    const lower = trimmed.toLowerCase()
    if (lower.startsWith("rect:")) {
      const nums = parseNumberList(trimmed.slice(5), "screen rect", [4])
      if (nums[2]! <= 0 || nums[3]! <= 0) throw new Error("Screen rect width and height must be > 0.")
      return { rect: [nums[0]!, nums[1]!, nums[2]!, nums[3]!] }
    }
    if (lower.startsWith("world:") || lower.startsWith("point:")) {
      const slice = trimmed.slice(trimmed.indexOf(":") + 1)
      const nums = parseNumberList(slice, "world point", [2, 3])
      return { world: nums.length === 2 ? [nums[0]!, 0, nums[1]!] : [nums[0]!, nums[1]!, nums[2]!] }
    }
    if (lower.startsWith("setting:") || lower.startsWith("key:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("Setting target key cannot be empty.")
      return { setting: val }
    }
    if (lower.startsWith("object:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("Object target ID cannot be empty.")
      return { objectId: val }
    }
    if (lower.startsWith("selector:")) {
      const val = trimmed.slice(trimmed.indexOf(":") + 1).trim()
      if (!val) throw new Error("DOM selector target cannot be empty.")
      return { selector: val }
    }
    if (trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.startsWith("[")) {
      return { selector: trimmed }
    }
    return { objectId: trimmed, setting: trimmed }
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Note target must be an object ({ objectId, setting, rect, world, selector }) or target string.")
  }

  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TARGET_KEYS.has(k)) {
      throw new Error(`Unknown note target field "${k}". Expected one of: objectId, setting, rect, world, selector.`)
    }
  }

  const out: DevNoteTarget = {}
  const rawObjId = obj.objectId ?? obj.object ?? obj.id
  if (rawObjId !== undefined) {
    if (typeof rawObjId !== "string" || !rawObjId.trim()) {
      throw new Error("Note target 'objectId' must be a non-empty string.")
    }
    out.objectId = rawObjId.trim()
  }

  const rawSetting = obj.setting ?? obj.settingKey ?? obj.key
  if (rawSetting !== undefined) {
    if (typeof rawSetting !== "string" || !rawSetting.trim()) {
      throw new Error("Note target 'setting' must be a non-empty string.")
    }
    out.setting = rawSetting.trim()
  }

  if (obj.selector !== undefined) {
    if (typeof obj.selector !== "string" || !obj.selector.trim()) {
      throw new Error("Note target 'selector' must be a non-empty string.")
    }
    out.selector = obj.selector.trim()
  }

  const rawRect =
    obj.rect ??
    obj.screenRect ??
    (obj.x !== undefined && obj.y !== undefined && (obj.width !== undefined || obj.w !== undefined)
      ? { x: obj.x, y: obj.y, width: obj.width ?? obj.w, height: obj.height ?? obj.h }
      : undefined)
  if (rawRect !== undefined) {
    if (Array.isArray(rawRect)) {
      if (rawRect.length !== 4 || !rawRect.every(n => typeof n === "number" && Number.isFinite(n))) {
        throw new Error("Note target 'rect' array must be [x, y, width, height] with 4 finite numbers.")
      }
      if (Number(rawRect[2]) <= 0 || Number(rawRect[3]) <= 0) {
        throw new Error("Note target 'rect' width and height must be > 0.")
      }
      out.rect = [Number(rawRect[0]), Number(rawRect[1]), Number(rawRect[2]), Number(rawRect[3])]
    } else if (rawRect && typeof rawRect === "object") {
      const r = rawRect as Record<string, unknown>
      const rx = Number(r.x)
      const ry = Number(r.y)
      const rw = Number(r.width ?? r.w)
      const rh = Number(r.height ?? r.h)
      if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) {
        throw new Error("Note target 'rect' object requires finite x, y, width (>0), and height (>0).")
      }
      out.rect = [rx, ry, rw, rh]
    } else {
      throw new Error("Note target 'rect' must be [x, y, width, height] or { x, y, width, height }.")
    }
  }

  const rawWorld =
    obj.world ??
    obj.worldPoint ??
    obj.point ??
    (obj.x !== undefined && obj.z !== undefined && obj.width === undefined && obj.w === undefined
      ? { x: obj.x, y: obj.y ?? 0, z: obj.z }
      : undefined)
  if (rawWorld !== undefined) {
    if (Array.isArray(rawWorld)) {
      if ((rawWorld.length !== 2 && rawWorld.length !== 3) || !rawWorld.every(n => typeof n === "number" && Number.isFinite(n))) {
        throw new Error("Note target 'world' array must be [x, y, z] or [x, z] with finite numbers.")
      }
      out.world =
        rawWorld.length === 2
          ? [Number(rawWorld[0]), 0, Number(rawWorld[1])]
          : [Number(rawWorld[0]), Number(rawWorld[1]), Number(rawWorld[2])]
    } else if (rawWorld && typeof rawWorld === "object") {
      const w = rawWorld as Record<string, unknown>
      const wx = Number(w.x)
      const wy = w.y !== undefined ? Number(w.y) : 0
      const wz = Number(w.z)
      if (![wx, wy, wz].every(Number.isFinite)) {
        throw new Error("Note target 'world' object requires finite x, y, and z coordinates.")
      }
      out.world = [wx, wy, wz]
    } else {
      throw new Error("Note target 'world' must be [x, y, z] or { x, y, z }.")
    }
  }

  if (!out.objectId && !out.setting && !out.rect && !out.world && !out.selector) {
    throw new Error("Note target must specify at least one of: objectId, setting, rect, world, or selector.")
  }

  return out
}

export function normalizeNoteArgs(
  raw: Record<string, unknown> | undefined,
): { clear: true } | { clear: false; note: DevNotePayload } {
  const input = raw ?? {}
  if (input.clear === true || input.dismiss === true) {
    return { clear: true }
  }
  const rawTitle = typeof input.title === "string" ? input.title.trim() : ""
  if (!rawTitle) {
    throw new Error('ui.note requires a non-empty "title" string (or { clear: true }).')
  }
  if (input.body !== undefined && input.body !== null && typeof input.body !== "string") {
    throw new Error('Argument "body" must be a string.')
  }
  if (input.step !== undefined && input.step !== null && typeof input.step !== "string") {
    throw new Error('Argument "step" must be a string (for example "2/5").')
  }
  if (input.accent !== undefined && input.accent !== null && typeof input.accent !== "string") {
    throw new Error('Argument "accent" must be a string.')
  }
  if (input.dismissible !== undefined && typeof input.dismissible !== "boolean") {
    throw new Error('Argument "dismissible" must be a boolean.')
  }
  const target = normalizeNoteTarget(input.target)
  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : undefined
  const step = typeof input.step === "string" && input.step.trim() ? input.step.trim() : undefined
  const accent = typeof input.accent === "string" && input.accent.trim() ? input.accent.trim() : undefined
  const dismissible = typeof input.dismissible === "boolean" ? input.dismissible : true
  const tourId = typeof input.tourId === "string" && input.tourId.trim() ? input.tourId.trim() : undefined
  const stepIndex = typeof input.stepIndex === "number" && Number.isFinite(input.stepIndex) ? Math.round(input.stepIndex) : undefined
  const stepCount = typeof input.stepCount === "number" && Number.isFinite(input.stepCount) ? Math.round(input.stepCount) : undefined
  const prevUrl = typeof input.prevUrl === "string" && input.prevUrl.trim() ? input.prevUrl.trim() : undefined
  const nextUrl = typeof input.nextUrl === "string" && input.nextUrl.trim() ? input.nextUrl.trim() : undefined
  const singleTab = typeof input.singleTab === "boolean" ? input.singleTab : undefined

  return {
    clear: false,
    note: {
      title: rawTitle,
      ...(body !== undefined ? { body } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(accent !== undefined ? { accent } : {}),
      ...(target !== undefined ? { target } : {}),
      dismissible,
      ...(tourId !== undefined ? { tourId } : {}),
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(stepCount !== undefined ? { stepCount } : {}),
      ...(prevUrl !== undefined ? { prevUrl } : {}),
      ...(nextUrl !== undefined ? { nextUrl } : {}),
      ...(singleTab !== undefined ? { singleTab } : {}),
    },
  }
}

export function resolveTourAssetUrl(tourId: string, rawSrc: string): string {
  const trimmed = rawSrc.trim()
  if (!trimmed) return ""
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("/__arcade/") ||
    trimmed.startsWith("/arcade/")
  ) {
    return trimmed
  }
  const cleanId = tourId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tour"
  const fileName = trimmed.split("/").pop() ?? trimmed
  return `/__arcade/tour-assets/${encodeURIComponent(cleanId)}/${encodeURIComponent(fileName)}`
}

export function validateTourDefinition(raw: unknown, defaultId = "tour"): TourDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error("Tour definition must be a JSON object or non-empty array of steps.")
  }
  const isArray = Array.isArray(raw)
  const container = isArray ? { steps: raw } : (raw as Record<string, unknown>)
  const rawSteps = container.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error("Tour definition requires a non-empty 'steps' array.")
  }

  const rawId = typeof container.id === "string" && container.id.trim() ? container.id.trim() : defaultId
  const id = rawId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tour"
  const title = typeof container.title === "string" && container.title.trim() ? container.title.trim() : undefined
  const baseUrl = typeof container.baseUrl === "string" && container.baseUrl.trim() ? container.baseUrl.trim().replace(/\/$/, "") : undefined
  const singleTab = typeof container.singleTab === "boolean" ? container.singleTab : true

  const steps: TourStepDefinition[] = rawSteps.map((item, idx) => {
    const stepNum = idx + 1
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Tour step ${stepNum} must be an object.`)
    }
    const s = item as Record<string, unknown>
    const stepTitle = typeof s.title === "string" ? s.title.trim() : ""
    if (!stepTitle) {
      throw new Error(`Tour step ${stepNum} is missing a non-empty "title".`)
    }

    const rawKind = typeof s.kind === "string" ? s.kind.trim().toLowerCase() : ""
    if (rawKind && rawKind !== "scene" && rawKind !== "page" && rawKind !== "grid") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): invalid kind "${String(s.kind)}". Expected "scene", "page", or "grid".`)
    }

    if (s.markdown !== undefined && s.markdown !== null && typeof s.markdown !== "string") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "markdown" must be a string.`)
    }
    const markdown = typeof s.markdown === "string" && s.markdown.trim() ? s.markdown.trim() : undefined

    let images: TourPageImage[] | undefined
    if (s.images !== undefined) {
      if (!Array.isArray(s.images)) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "images" must be an array.`)
      }
      images = s.images.map((imgItem, imgIdx) => {
        if (typeof imgItem === "string" && imgItem.trim()) {
          return { src: imgItem.trim() }
        }
        if (!imgItem || typeof imgItem !== "object" || Array.isArray(imgItem)) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") images[${imgIdx}] must be a string or { src, label?, caption?, tag? }.`)
        }
        const imgObj = imgItem as Record<string, unknown>
        const rawSrc =
          typeof imgObj.src === "string"
            ? imgObj.src.trim()
            : typeof imgObj.url === "string"
              ? imgObj.url.trim()
              : typeof imgObj.path === "string"
                ? imgObj.path.trim()
                : ""
        if (!rawSrc) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") images[${imgIdx}] is missing "src".`)
        }
        const label =
          typeof imgObj.label === "string" && imgObj.label.trim()
            ? imgObj.label.trim()
            : typeof imgObj.title === "string" && imgObj.title.trim()
              ? imgObj.title.trim()
              : undefined
        const caption = typeof imgObj.caption === "string" && imgObj.caption.trim() ? imgObj.caption.trim() : undefined
        const tag = typeof imgObj.tag === "string" && imgObj.tag.trim() ? imgObj.tag.trim() : undefined
        return {
          src: rawSrc,
          ...(label !== undefined ? { label } : {}),
          ...(caption !== undefined ? { caption } : {}),
          ...(tag !== undefined ? { tag } : {}),
        }
      })
    }

    const isPage = rawKind === "page" || Boolean(markdown || (images && images.length > 0))
    const isGrid = rawKind === "grid" || Array.isArray(s.tiles)
    const rawUrl = typeof s.url === "string" ? s.url.trim() : typeof s.page === "string" ? s.page.trim() : typeof s.path === "string" ? s.path.trim() : ""
    if (!rawUrl && !isPage && !isGrid) {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}") is missing a non-empty "url".`)
    }
    let resolvedUrl: string
    if (!rawUrl && isPage) {
      resolvedUrl = `/arcade/getaway/dev.html#tour/${encodeURIComponent(id)}/${stepNum}`
    } else if (!rawUrl && isGrid) {
      resolvedUrl = "/arcade/lab/"
    } else {
      try {
        resolvedUrl = resolveNavigationPath(rawUrl)
      } catch (err) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const rawBody = s.body ?? s.description
    if (rawBody !== undefined && rawBody !== null && typeof rawBody !== "string") {
      throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "body" must be a string.`)
    }
    const body = typeof rawBody === "string" && rawBody.trim() ? rawBody.trim() : undefined

    const setup: TourSetupCommand[] = []
    if (s.setup !== undefined) {
      if (!Array.isArray(s.setup)) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): "setup" must be an array of commands.`)
      }
      for (let cIdx = 0; cIdx < s.setup.length; cIdx++) {
        const entry = s.setup[cIdx]
        if (typeof entry === "string" && entry.trim()) {
          setup.push({ command: entry.trim() })
          continue
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] must be a command object.`)
        }
        const cmdObj = entry as Record<string, unknown>
        const cmdName =
          typeof cmdObj.command === "string"
            ? cmdObj.command.trim()
            : typeof cmdObj.cmd === "string"
              ? cmdObj.cmd.trim()
              : typeof cmdObj.id === "string"
                ? cmdObj.id.trim()
                : ""
        if (!cmdName) {
          throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] is missing "command".`)
        }
        let cmdArgs: Record<string, unknown> | undefined
        if (cmdObj.args !== undefined) {
          if (!cmdObj.args || typeof cmdObj.args !== "object" || Array.isArray(cmdObj.args)) {
            throw new Error(`Tour step ${stepNum} ("${stepTitle}") setup[${cIdx}] "args" must be a JSON object.`)
          }
          cmdArgs = { ...(cmdObj.args as Record<string, unknown>) }
        } else {
          const inline: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(cmdObj)) {
            if (k !== "command" && k !== "cmd" && k !== "id") inline[k] = v
          }
          if (Object.keys(inline).length > 0) cmdArgs = inline
        }
        setup.push(cmdArgs ? { command: cmdName, args: cmdArgs } : { command: cmdName })
      }
    }

    const gridPreset = typeof s.preset === "string" && s.preset.trim() ? s.preset.trim() : undefined
    const gridSection = typeof s.section === "string" && s.section.trim() ? s.section.trim() : undefined
    const gridCols = typeof s.cols === "number" && Number.isFinite(s.cols) ? Math.round(s.cols) : undefined
    const gridTiles = Array.isArray(s.tiles) ? (s.tiles as Record<string, unknown>[]) : undefined

    if (isGrid && !setup.some(c => c.command === "grid.open" || c.command === "grid")) {
      const gridArgs: Record<string, unknown> = { title: stepTitle }
      if (gridPreset) gridArgs.preset = gridPreset
      if (gridSection) gridArgs.section = gridSection
      if (gridCols !== undefined) gridArgs.cols = gridCols
      if (gridTiles) gridArgs.tiles = gridTiles
      setup.push({ command: "grid.open", args: gridArgs })
    }

    let target: DevNoteTarget | undefined
    const rawTarget = s.target ?? s.noteTarget
    if (rawTarget !== undefined) {
      try {
        target = normalizeNoteTarget(rawTarget)
      } catch (err) {
        throw new Error(`Tour step ${stepNum} ("${stepTitle}"): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const accent = typeof s.accent === "string" && s.accent.trim() ? s.accent.trim() : undefined
    const dismissible = typeof s.dismissible === "boolean" ? s.dismissible : undefined

    return {
      ...(isPage
        ? { kind: "page" as const }
        : isGrid
          ? { kind: "grid" as const }
          : rawKind === "scene"
            ? { kind: "scene" as const }
            : {}),
      title: stepTitle,
      ...(body !== undefined ? { body } : {}),
      url: resolvedUrl,
      setup,
      ...(target !== undefined ? { target } : {}),
      ...(accent !== undefined ? { accent } : {}),
      ...(dismissible !== undefined ? { dismissible } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(gridPreset !== undefined ? { preset: gridPreset } : {}),
      ...(gridSection !== undefined ? { section: gridSection } : {}),
      ...(gridCols !== undefined ? { cols: gridCols } : {}),
      ...(gridTiles !== undefined ? { tiles: gridTiles } : {}),
    }
  })

  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    singleTab,
    steps,
  }
}

export function buildTourStepUrl(
  origin: string,
  stepUrl: string,
  tourId: string,
  stepNumber: number,
  singleTab = true,
): string {
  const resolved = resolveNavigationPath(stepUrl)
  const u = new URL(resolved, origin.endsWith("/") ? origin : `${origin}/`)
  u.searchParams.set("tour", tourId)
  u.searchParams.set("step", String(stepNumber))
  if (singleTab) u.searchParams.set("singleTab", "1")
  return u.href
}

export const ACCENT_PALETTE: Record<string, { border: string; text: string; glow: string; badgeBg: string }> = {
  cyan: {
    border: "rgba(124, 197, 214, 0.55)",
    text: "#7cc5d6",
    glow: "rgba(124, 197, 214, 0.28)",
    badgeBg: "rgba(124, 197, 214, 0.16)",
  },
  amber: {
    border: "rgba(245, 185, 66, 0.6)",
    text: "#f5b942",
    glow: "rgba(245, 185, 66, 0.28)",
    badgeBg: "rgba(245, 185, 66, 0.18)",
  },
  emerald: {
    border: "rgba(92, 214, 154, 0.58)",
    text: "#5cd69a",
    glow: "rgba(92, 214, 154, 0.28)",
    badgeBg: "rgba(92, 214, 154, 0.16)",
  },
  rose: {
    border: "rgba(255, 122, 144, 0.58)",
    text: "#ff7a90",
    glow: "rgba(255, 122, 144, 0.28)",
    badgeBg: "rgba(255, 122, 144, 0.16)",
  },
  violet: {
    border: "rgba(180, 142, 247, 0.58)",
    text: "#b48ef7",
    glow: "rgba(180, 142, 247, 0.28)",
    badgeBg: "rgba(180, 142, 247, 0.16)",
  },
}

export function resolveAccentColors(accent?: string) {
  if (!accent) return ACCENT_PALETTE.cyan!
  const key = accent.trim().toLowerCase()
  if (ACCENT_PALETTE[key]) return ACCENT_PALETTE[key]!
  return {
    border: accent,
    text: accent,
    glow: "rgba(124, 197, 214, 0.28)",
    badgeBg: "rgba(124, 197, 214, 0.16)",
  }
}

export function registerUiNoteCommand(
  commands: LabCommandRegistry,
  handlers?: {
    onShow?: (note: DevNotePayload) => DevNoteResolvedRect | null
    onClear?: () => void
    getDocumentTitle?: () => string
  },
): void {
  let fallbackTitle = handlers?.getDocumentTitle?.() ?? (typeof document !== "undefined" ? document.title : "Arcade")
  let activeNoteState: DevNotePayload | null = null

  commands.register({
    id: "ui.note",
    aliases: ["note", "show-me"],
    label: "Show Pinned Page Note & Highlight Target",
    shortLabel: "Note",
    category: "Navigation",
    undoable: false,
    readOnly: true,
    args: {
      title: { type: "string", description: "Short pinned tab/card title (sets document.title to '▸ <title>')" },
      body: { type: "string", description: "One-line description of what to look at" },
      step: { type: "string", description: "Optional tour step counter such as '2/5'" },
      accent: { type: "string", description: "Optional accent colour (cyan, amber, emerald, rose, violet, or CSS colour)" },
      target: { type: "object", description: "Optional highlight target ({ objectId, setting, rect, world, selector } or string)" },
      dismissible: { type: "boolean", description: "Whether Esc and × dismiss the note (default true)" },
      clear: { type: "boolean", description: "Dismiss any active note and restore document.title" },
      tourId: { type: "string", description: "Optional tour identifier" },
      stepIndex: { type: "number", min: 1, max: 999, description: "Optional 1-based step index" },
      stepCount: { type: "number", min: 1, max: 999, description: "Optional total steps in tour" },
      prevUrl: { type: "string", description: "Optional previous step URL" },
      nextUrl: { type: "string", description: "Optional next step URL" },
      singleTab: { type: "boolean", description: "Navigate within the same tab on Next/Prev" },
    },
    enabled: () => true,
    run: (_ctx, rawArgs) => {
      const normalized = normalizeNoteArgs(rawArgs as Record<string, unknown> | undefined)
      if (normalized.clear) {
        activeNoteState = null
        handlers?.onClear?.()
        return {
          active: false,
          documentTitle: handlers?.getDocumentTitle?.() ?? fallbackTitle,
        }
      }
      const { note } = normalized
      activeNoteState = note
      const formattedDocTitle = note.title.startsWith("▸ ") ? note.title : `▸ ${note.title}`
      fallbackTitle = formattedDocTitle
      const resolvedRect = handlers?.onShow ? handlers.onShow(note) : null
      return {
        active: true,
        title: note.title,
        documentTitle: handlers?.getDocumentTitle?.() ?? formattedDocTitle,
        body: note.body ?? null,
        step: note.step ?? null,
        accent: note.accent ?? "cyan",
        target: note.target ?? null,
        targetResolved: Boolean(resolvedRect),
        targetRect: resolvedRect ?? null,
        dismissible: note.dismissible,
        tourId: note.tourId ?? null,
        stepIndex: note.stepIndex ?? null,
        stepCount: note.stepCount ?? null,
      }
    },
  })

  if (!commands.get("ui.note.clear")) {
    commands.register({
      id: "ui.note.clear",
      aliases: ["note.clear"],
      label: "Dismiss Pinned Page Note",
      shortLabel: "Dismiss Note",
      category: "Navigation",
      undoable: false,
      readOnly: true,
      enabled: () => true,
      run: () => {
        activeNoteState = null
        handlers?.onClear?.()
        return {
          active: false,
          documentTitle: handlers?.getDocumentTitle?.() ?? fallbackTitle,
        }
      },
    })
  }
  void activeNoteState
}

export function renderMarkdownFragment(markdown: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  let listEl: HTMLUListElement | null = null

  const appendInline = (parent: HTMLElement, text: string) => {
    const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g
    let lastIdx = 0
    let match: RegExpExecArray | null
    while ((match = tokenRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parent.append(document.createTextNode(text.slice(lastIdx, match.index)))
      }
      const raw = match[0]
      if (raw.startsWith("**") && raw.endsWith("**")) {
        const strong = document.createElement("strong")
        strong.style.color = "#f0f5f8"
        strong.textContent = raw.slice(2, -2)
        parent.append(strong)
      } else if (raw.startsWith("`") && raw.endsWith("`")) {
        const code = document.createElement("code")
        code.style.cssText =
          "font:11.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border-radius:4px;background:#0e0f11;border:1px solid #23252a;color:#7cc5d6;"
        code.textContent = raw.slice(1, -1)
        parent.append(code)
      }
      lastIdx = match.index + raw.length
    }
    if (lastIdx < text.length) {
      parent.append(document.createTextNode(text.slice(lastIdx)))
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      listEl = null
      continue
    }
    if (line.startsWith("### ")) {
      listEl = null
      const h3 = document.createElement("h3")
      h3.style.cssText = "margin:10px 0 4px;font:600 13px/1.35 system-ui,-apple-system,sans-serif;color:#e6eef4;"
      appendInline(h3, line.slice(4))
      frag.append(h3)
    } else if (line.startsWith("## ")) {
      listEl = null
      const h2 = document.createElement("h2")
      h2.style.cssText = "margin:12px 0 6px;font:600 15px/1.35 system-ui,-apple-system,sans-serif;color:#f0f5f8;"
      appendInline(h2, line.slice(3))
      frag.append(h2)
    } else if (line.startsWith("# ")) {
      listEl = null
      const h1 = document.createElement("h1")
      h1.style.cssText = "margin:12px 0 6px;font:700 17px/1.3 system-ui,-apple-system,sans-serif;color:#f0f5f8;"
      appendInline(h1, line.slice(2))
      frag.append(h1)
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!listEl) {
        listEl = document.createElement("ul")
        listEl.style.cssText = "margin:4px 0 8px;padding-left:18px;display:flex;flex-direction:column;gap:4px;color:#b8c4ce;font-size:12.5px;line-height:1.45;"
        frag.append(listEl)
      }
      const li = document.createElement("li")
      appendInline(li, line.slice(2))
      listEl.append(li)
    } else {
      listEl = null
      const p = document.createElement("p")
      p.style.cssText = "margin:4px 0 8px;color:#b8c4ce;font-size:12.5px;line-height:1.5;"
      appendInline(p, line)
      frag.append(p)
    }
  }
  return frag
}
