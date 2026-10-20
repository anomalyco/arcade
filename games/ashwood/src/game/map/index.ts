import * as THREE from "three/webgpu"
import type { WorldContext } from "../../world/context"
import { BUILDING, ROOF_Y } from "../../world/layout"
import { renderState } from "../../render/shared"
import { paperSound } from "../../audio/hooks"
import { Clipboard, PAGE_H, PAGE_W } from "./clipboard"
import { pulseObjective } from "../objective"
import { BRIEFING } from "../objectives"
import { collectPlan, planKey } from "./data"
import { INVENTORY_PAGE, PAGE_COUNT, PAGE_TITLES, pageOfStorey, type SiteFacts } from "./pages"
import { carriedItems, mapMarks, onInventory, readNotes } from "../inventory"
/** Sheets on the clipboard: the plans (PAGE_COUNT) and the inventory sheet last. */
const SHEETS = PAGE_COUNT + 1
import type { Request, Response } from "./pages.worker"

// The player's clipboard map. M raises it into view (first person, held in front of the camera), M or Esc lowers it.
// While it's up: A/D, Q/E, ←/→ or the mouse wheel flip pages, the right mouse button brings it closer, and the player
// can still walk, slowly. Pages are drawn in a worker from the world's own data (see pages.ts) once the world has
// streamed in, and redrawn if the interior's registries change.
//
// Light: the page is lit by the scene. With the flashlight on, the torch is turned onto the sheet (the beam's spill,
// not its hot centre, falls on the page); otherwise the sheet keeps a faint fill as dark-adapted eyes would see it.

export type MapHost = {
  ctx: WorldContext
  camera: THREE.PerspectiveCamera
  player: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; flashlight: boolean }
  /** Present on the boot's World: the map then updates itself before every frame. */
  render?: (dt: number, time: number) => void
  readonly streaming?: boolean
}

export type MapHandle = {
  /** Per frame before rendering (called automatically when the host has `render`). */
  update(dt: number): void
  raise(page?: number): void
  lower(): void
  flip(dir: -1 | 1): void
  readonly raised: boolean
  readonly page: number
}

const SHEET_PX = 2048
/** Walking speed cap while reading (m/s). */
const READ_SPEED = 0.85
const FLIP_S = 0.42
const RAISE_S = 0.38

const CONTROLS = [
  { key: "map.fill", label: "Dark-adapted fill on the page", group: "Map", unit: "", min: 0, max: 0.2, step: 0.005, value: 0.035 },
  { key: "map.torchAim", label: "Torch aim below the page", group: "Map", unit: "m", min: 0, max: 0.6, step: 0.01, value: 0.3 },
  { key: "map.fill.height", label: "Sheet height on screen", group: "Map", unit: "×", min: 0.6, max: 0.95, step: 0.01, value: 0.87 },
  { key: "map.zoom", label: "Zoom (right mouse)", group: "Map", unit: "×", min: 1.3, max: 2.6, step: 0.05, value: 1.95 },
] as const

/**
 * Held 20 cm from the eye (clear of the camera's 15 cm near plane, tilt and zoom included). How big the clipboard looks
 * is set by the camera's FOV: at the reading distance its scale is chosen so the sheet fills `map.fill.height` of the
 * screen height (never wider than the screen); the angular size, not the metres, is what reads.
 */
const HOLD_D = 0.2
const DOWN = new THREE.Vector3(0.16, -0.46, -0.22)
/** Board-local y of the middle of the clip-to-page-bottom span (centred on screen). */
const HOLD_CENTRE = 0.0065

export type MapOptions = {
  /**
   * Whether the map takes input now (default always). The play shell passes `() => flow.playerActive`, so a paused
   * game, the menu and cutscenes leave M, the flip keys, the wheel and the right mouse button alone.
   */
  active?: () => boolean
}

export function createMap(host: MapHost, options: MapOptions = {}): MapHandle {
  const active = options.active ?? (() => true)
  const { ctx, camera, player } = host
  for (const { value, ...c } of CONTROLS) {
    if (!(c.key in ctx.settings)) ctx.settings[c.key] = value
    const q = ctx.params.get(c.key)
    if (q !== null) ctx.settings[c.key] = Number(q)
    ctx.controls.push(c)
  }
  const num = (k: string) => Number(ctx.settings[k])
  const board = new Clipboard()
  const rig = new THREE.Group()
  rig.name = "map:rig"
  rig.add(board.root)
  rig.visible = false
  camera.add(rig)
  // The clipboard rides on the camera, so the camera must be in the scene graph (module contexts may carry a group).
  let root: THREE.Object3D = ctx.scene
  while (root.parent) root = root.parent
  if (camera.parent !== root) root.add(camera)

  // ----------------------------------------------------------------------------------------------- pages
  const textures: (THREE.Texture | null)[] = Array(SHEETS).fill(null)
  const bitmaps: (ImageBitmap | null)[] = Array(SHEETS).fill(null)
  let worker: Worker | null = null
  let facts: SiteFacts | null = null
  let jobSeq = 0
  let drawnKey = ""
  const pending = new Set<number>()
  const queue: number[] = []
  let busy = false

  const startWorker = async () => {
    if (worker) return
    worker = new Worker(new URL("./pages.worker.ts", import.meta.url), { type: "module", name: "map" })
    const fontBase = new URL(`${import.meta.env.BASE_URL}fonts/`, location.href).href
    worker.postMessage({ type: "init", fontBase } satisfies Request)
    worker.onmessage = (e: MessageEvent<Response>) => {
      const m = e.data
      busy = false
      if (m.type === "error") console.error(`map page: ${m.message}`)
      else {
        bitmaps[m.index]?.close()
        bitmaps[m.index] = m.bitmap
        textures[m.index]?.dispose()
        textures[m.index] = null
        pending.delete(m.index)
        stats.pages[m.index] = Math.round(m.ms)
        refreshTextures()
      }
      pump()
    }
    const [core, lot] = await Promise.all([import("../../world/interior/core"), import("../../world/compound/lot")])
    facts = { stair: { ...core.ST }, lotRows: lot.ROWS.map((r) => ({ ...r })), aisleX: lot.AISLE_X }
  }
  let plan: ReturnType<typeof collectPlan> | null = null
  const pump = () => {
    if (busy || !worker || !facts || !queue.length) return
    const index = queue.shift()!
    plan ??= collectPlan(ctx)
    busy = true
    worker.postMessage({
      type: "page",
      job: ++jobSeq,
      index,
      plan,
      facts,
      width: SHEET_PX,
      briefing: BRIEFING,
      marks: mapMarks(),
      inventory: { items: carriedItems().map((i) => ({ name: i.name, desc: i.desc, key: i.key })), notes: readNotes().map((n) => ({ title: n.title, text: n.text })) },
    } satisfies Request)
  }
  /** Queues pages (nearest the given page first). */
  const request = (pages: number[], refresh = false) => {
    if (refresh) plan = null
    for (const p of pages) {
      if (!refresh && (bitmaps[p] || pending.has(p))) continue
      pending.add(p)
      if (!queue.includes(p)) queue.push(p)
    }
    void startWorker().then(pump)
  }
  const allNear = (p: number) => [...Array(SHEETS).keys()].sort((a, b) => Math.abs(a - p) - Math.abs(b - p))

  const texFor = (p: number): THREE.Texture | null => {
    if (p < 0 || p >= SHEETS) return null
    if (textures[p]) return textures[p]
    const bm = bitmaps[p]
    if (!bm) return null
    const t = new THREE.Texture(bm as unknown as HTMLImageElement)
    t.colorSpace = THREE.SRGBColorSpace
    t.flipY = false
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.magFilter = THREE.LinearFilter
    t.anisotropy = 16
    t.needsUpdate = true
    textures[p] = t
    return t
  }
  /** GPU copies only for the page in view and its neighbours. */
  const refreshTextures = () => {
    for (let p = 0; p < SHEETS; p++) {
      const near = Math.abs(p - page) <= 1 || p === flipPage
      if (!near && textures[p]) {
        textures[p]!.dispose()
        textures[p] = null
      }
    }
    if (flipPage < 0) board.setTop(texFor(page))
  }

  // ----------------------------------------------------------------------------------------------- state
  let raised = false
  let study = false
  let lift = 0 // 0 lowered … 1 raised
  let page = 0
  let lastLocation = -1
  let flipPage = -1
  let flipDir: -1 | 1 = 1
  let flipT = 0
  let time = 0
  const stats = { pages: {} as Record<number, number> }

  const locationPage = () => {
    const p = camera.getWorldPosition(tmp)
    const [x0, z0] = BUILDING.main.min
    const [x1, z1] = BUILDING.main.max
    const inside = p.x > x0 - 0.5 && p.x < x1 + 0.5 && p.z > z0 - 0.5 && p.z < z1 + 3.6
    if (!inside) return 0
    if (p.y > ROOF_Y + 0.5) return PAGE_COUNT - 1
    const s = Math.max(0, Math.min(BUILDING.main.storeys - 1, Math.floor((p.y - 1.0 - BUILDING.floorY) / BUILDING.main.storeyHeight + 0.15)))
    return pageOfStorey(s)
  }

  const raise = (at?: number) => {
    if (!raised) {
      const loc = locationPage()
      if (at !== undefined) page = Math.max(0, Math.min(SHEETS - 1, at))
      else if (loc !== lastLocation) page = loc
      lastLocation = loc
      raised = true
      pulseObjective()
      request(allNear(page))
      refreshTextures()
    } else if (at !== undefined) {
      page = Math.max(0, Math.min(SHEETS - 1, at))
      refreshTextures()
    }
  }
  const lower = () => {
    raised = false
    study = false
  }
  const flip = (dir: -1 | 1) => {
    if (!raised) return
    const next = page + dir
    if (next < 0 || next >= SHEETS) return
    // A flip still in the air lands at once.
    if (flipPage >= 0) endFlip()
    flipDir = dir
    flipT = 0
    if (dir > 0) {
      // Forward: the current sheet goes up over the clip, the next one is underneath.
      flipPage = page
      page = next
      board.setTop(texFor(page))
    } else {
      // Back: the previous sheet comes down over the current one.
      flipPage = next
    }
    board.setFlip(texFor(flipPage), dir > 0 ? 0 : 1)
    request([page + dir].filter((p) => p >= 0 && p < SHEETS))
    refreshTextures()
    paperSound()
  }
  const endFlip = () => {
    if (flipDir < 0) page = flipPage
    flipPage = -1
    board.setFlip(undefined)
    refreshTextures()
  }

  // ----------------------------------------------------------------------------------------------- input
  const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  const PREV = new Set(["KeyA", "KeyQ", "ArrowLeft"])
  const NEXT = new Set(["KeyD", "KeyE", "ArrowRight"])
  // Capture phase on window: runs before the player's own key handler, so flip keys don't also strafe or open doors.
  window.addEventListener(
    "keydown",
    (e) => {
      if (editable(e.target) || !active()) return
      if (e.code === "KeyM") {
        if (!e.repeat) raised ? lower() : raise()
        e.stopImmediatePropagation()
        return
      }
      if (!raised) return
      if (e.code === "Escape") lower()
      else if (PREV.has(e.code) || NEXT.has(e.code)) {
        e.stopImmediatePropagation()
        e.preventDefault()
        if (!e.repeat) flip(PREV.has(e.code) ? -1 : 1)
      }
    },
    { capture: true },
  )
  let wheel = 0
  window.addEventListener(
    "wheel",
    (e) => {
      if (!raised || !active()) return
      e.preventDefault()
      wheel += e.deltaY
      if (Math.abs(wheel) >= 60) {
        flip(wheel > 0 ? 1 : -1)
        wheel = 0
      }
    },
    { passive: false },
  )
  // Right mouse: a click toggles the zoom, holding it zooms while held.
  let zoomDownAt = -1
  window.addEventListener("mousedown", (e) => {
    if (!raised || e.button !== 2 || !active()) return
    if (study) {
      study = false
      zoomDownAt = -1
    } else {
      study = true
      zoomDownAt = time
    }
  })
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2 || zoomDownAt < 0) return
    if (time - zoomDownAt > 0.3) study = false
    zoomDownAt = -1
  })
  window.addEventListener("contextmenu", (e) => raised && e.preventDefault())
  let locked = false
  document.addEventListener("pointerlockchange", () => {
    const now = document.pointerLockElement !== null
    // Esc releases the pointer lock before the page sees the key: treat losing the lock as Esc.
    if (locked && !now) lower()
    locked = now
  })

  // ----------------------------------------------------------------------------------------------- torch
  // While reading with the flashlight on, the torch is turned onto the sheet: its beam aims a little below the page so
  // the sheet sits in the soft spill (the hot centre at 20 cm would bleach it). Body hook pending (see report).
  const lensPos = new THREE.Vector3()
  const pageWorld = new THREE.Vector3()
  const pageDown = new THREE.Vector3()
  let installed = false
  const installTorch = () => {
    if (installed) return
    installed = true
    const inner = renderState.torchLens
    renderState.torchLens = (pos, dir) => {
      const ok = inner?.(pos, dir) === true
      if (lift < 0.5 || !player.flashlight) return ok
      if (!ok) pos.copy(lensPos.set(0.2, -0.3, -0.08).applyQuaternion(camera.quaternion).add(camera.position))
      board.root.getWorldPosition(pageWorld)
      pageDown.set(0, -1, 0).applyQuaternion(board.root.getWorldQuaternion(tmpQ))
      const target = pageWorld.addScaledVector(pageDown, num("map.torchAim"))
      dir.copy(target).sub(pos).normalize()
      return true
    }
  }

  // ----------------------------------------------------------------------------------------------- frame
  const tmp = new THREE.Vector3()
  const tmpQ = new THREE.Quaternion()
  const pose = new THREE.Vector3()
  const eye = new THREE.Vector3()
  const look = new THREE.Object3D()
  let prevYaw = 0
  let prevPitch = 0
  const sway = { x: 0, y: 0 }
  const pan = { x: 0, y: 0 }
  const euler = new THREE.Euler(0, 0, 0, "YXZ")

  const update = (dt: number) => {
    time += dt
    installTorch()
    const target = raised ? 1 : 0
    lift += Math.sign(target - lift) * Math.min(Math.abs(target - lift), dt / RAISE_S)
    rig.visible = lift > 0.001 || warming
    if (raised || lift > 0) {
      // Reading is a slow walk.
      const v = Math.hypot(player.vel.x, player.vel.z)
      if (v > READ_SPEED) {
        player.vel.x *= READ_SPEED / v
        player.vel.z *= READ_SPEED / v
      }
    }
    if (lift <= 0.001) {
      if (flipPage >= 0 && !warming) endFlip()
      return
    }
    // Hold pose: eased between lowered and reading (or zoomed), facing the eye with a slight tilt, a little lag on
    // turns, a walk bob and breathing. Zoomed, turning the head pans across the sheet instead.
    const e = lift * lift * (3 - 2 * lift)
    const k = 1 - Math.exp(-dt * 8)
    studyBlend += ((study ? 1 : 0) - studyBlend) * k
    const t = Math.tan(((camera.fov || 68) * Math.PI) / 360)
    const visH = 2 * HOLD_D * t
    const visW = visH * (camera.aspect || 16 / 9)
    const fit = Math.min((num("map.fill.height") * visH) / PAGE_H, (0.95 * visW) / PAGE_W)
    const scale = fit * (1 + (num("map.zoom") - 1) * studyBlend)
    if (!warming) board.root.scale.setScalar(scale)
    euler.setFromQuaternion(camera.quaternion)
    let dy = euler.y - prevYaw
    if (dy > Math.PI) dy -= Math.PI * 2
    if (dy < -Math.PI) dy += Math.PI * 2
    const dp = euler.x - prevPitch
    prevYaw = euler.y
    prevPitch = euler.x
    const panX = Math.max(0, (PAGE_W * scale - visW * 0.96) / 2)
    const panY = Math.max(0, (PAGE_H * scale - visH * 0.94) / 2)
    if (study) {
      pan.x = Math.max(-panX, Math.min(panX, pan.x + (dy / 0.5) * panX))
      pan.y = Math.max(-panY, Math.min(panY, pan.y - (dp / 0.4) * panY))
    } else {
      pan.x *= 1 - k
      pan.y *= 1 - k
    }
    sway.x = (sway.x + dy * 0.25 * (1 - studyBlend)) * Math.exp(-dt * 9)
    sway.y = (sway.y + dp * 0.25 * (1 - studyBlend)) * Math.exp(-dt * 9)
    const speed = Math.hypot(player.vel.x, player.vel.z)
    const bob = Math.min(1, speed / READ_SPEED)
    pose.set(pan.x, -HOLD_CENTRE * scale + pan.y, -HOLD_D)
    pose.lerpVectors(DOWN, pose, e)
    pose.x += sway.x * 0.25 + Math.sin(time * 5.6) * 0.003 * bob
    pose.y += sway.y * 0.25 + Math.abs(Math.cos(time * 5.6)) * 0.0035 * bob + Math.sin(time * 1.3) * 0.0004
    look.position.copy(pose)
    eye.set(pan.x, pose.y, 0)
    look.lookAt(eye)
    // A slight tilt back (none when zoomed), steeper while lowering, and a slight natural roll.
    look.rotateX(-0.06 * (1 - studyBlend) + (1 - e) * -0.9)
    look.rotateZ(-0.02 * (1 - studyBlend) + sway.x * 0.5)
    board.root.position.copy(look.position)
    board.root.quaternion.copy(look.quaternion)
    // Flip animation.
    if (flipPage >= 0) {
      flipT += dt / FLIP_S
      const a = Math.min(1, flipT)
      const s = a * a * (3 - 2 * a)
      board.setFlip(texFor(flipPage), flipDir > 0 ? s : 1 - s)
      if (a >= 1) endFlip()
    }
    // Dark-adapted fill: a target brightness on screen, divided by the camera's exposure (post.ts) so it stays faint.
    const p = camera.getWorldPosition(tmp)
    const [x0, z0] = BUILDING.main.min
    const [x1, z1] = BUILDING.main.max
    const indoor = p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1 + 3.2 && p.y < ROOF_Y ? 1 : 0
    const ev = num("post.exposure") + indoor * num("post.interiorExposure")
    const exposure = 2 ** (Number.isFinite(ev) ? ev : -2.2)
    board.ambient.value = num("map.fill") / exposure
  }
  let studyBlend = 0

  // Pages are drawn once the world has streamed in and the interior's registries have settled; redrawn on change.
  let lastKey = ""
  let stable = 0
  const watch = setInterval(() => {
    if (host.streaming) return
    const key = collectKey()
    if (key === lastKey) stable++
    else {
      stable = 0
      lastKey = key
    }
    if (stable === 1 && key !== drawnKey) {
      if (!drawnKey) void prewarm()
      drawnKey = key
      request(allNear(raised ? page : locationPage()), true)
    }
  }, 1500)
  const collectKey = () => planKey(ctx)
  /** Compiles the clipboard's materials once the world is in, so the first M doesn't hitch on pipeline builds. */
  const prewarm = async () => {
    const r = ctx.renderer as THREE.WebGPURenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s: THREE.Object3D) => Promise<void> }
    if (!r.compileAsync || rig.visible) return
    // Drawn for a moment at a pinpoint size, never seen.
    warming = true
    board.root.scale.setScalar(1e-5)
    board.setFlip(null, 0.5)
    try {
      await r.compileAsync(rig, camera, root)
    } catch (e) {
      console.warn(`map prewarm: ${e}`)
    }
    warming = false
    board.setFlip(undefined)
    board.root.scale.setScalar(1)
  }
  let warming = false
  void watch

  if (host.render) {
    const render = host.render
    host.render = (dt, t) => {
      update(dt)
      render(dt, t)
    }
  }

  // The inventory sheet and the plans with the player's marks redraw when what they carry or have read changes (the
  // plan data is kept; only these sheets are queued again).
  onInventory(() => {
    const pages = [INVENTORY_PAGE, ...mapMarks().flatMap((m) => (m.site ? [0, pageOfStorey(m.storey)] : [pageOfStorey(m.storey)]))]
    for (const p of new Set(pages)) {
      pending.add(p)
      if (!queue.includes(p)) queue.push(p)
    }
    if (bitmaps.some(Boolean)) void startWorker().then(pump)
  })

  // Automation only: `?map=<page>` raises the clipboard at that page (0 site … 6 roof), `map.study=1` holds it close.
  const qp = ctx.params.get("map")
  if (qp !== null) raise(Number(qp))
  if (ctx.params.get("map.study") === "1") study = true

  const handle: MapHandle = {
    update,
    raise,
    lower,
    flip,
    get raised() {
      return raised
    },
    get page() {
      return page
    },
  }
  ;(globalThis as { __ashwoodMap?: unknown }).__ashwoodMap = {
    ...handle,
    get page() {
      return page
    },
    get raised() {
      return raised
    },
    set study(on: boolean) {
      study = on
    },
    titles: PAGE_TITLES,
    stats,
    ready: () => bitmaps.every(Boolean),
    /** The drawn sheet as a PNG data URL (automation: page review without the 3D view). */
    dump: (p: number) => {
      const bm = bitmaps[p]
      if (!bm) return null
      const c = document.createElement("canvas")
      c.width = bm.width
      c.height = bm.height
      c.getContext("2d")!.drawImage(bm, 0, 0)
      return c.toDataURL("image/png")
    },
    request: () => request(allNear(page), true),
  }
  return handle
}
