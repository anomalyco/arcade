import type { LabControl } from "@arcade/kit/lab-panel"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import { type Crew, type CrewPlayer, teamCss } from "../../shared/crew"
import type { Missile } from "../../shared/combat"
import type { Hull } from "../../shared/fleet"
import { type Archipelago, terrainHeight } from "../../shared/islands"
import { PLANE, type ShipPoseLike } from "../../shared/plane"
import { type Target, canHurt } from "../../shared/weapons"

/**
 * The pilot's map, typed settings bound to the Lab panel (debug menu, RADAR tab), read live every frame: the radar in
 * the bottom-left corner while flying, the full map on a held key, and the target markers on screen
 * (src/flight/target-markers.ts).
 */
export type RadarSettings = {
  /** The heading-up radar while flying. */
  radar: boolean
  /** Its diameter (CSS px, before the HUD scale). */
  radarSize: number
  /** Its range: 0 picks one from the nearest enemy, else fixed (km). */
  radarRange: number
  /** Darkness of its disc, so it reads over sea and sky (0..1). */
  radarBack: number
  /** How strongly islands show (0..1). */
  islands: number
  /** The full map while G is held (tap to pin). */
  map: boolean
  /** Its size as a share of the screen's short side. */
  mapSize: number
  /** Brackets on enemy carriers and diamonds on enemy jets and boats in view, with their distance. */
  markers: boolean
  /** Enemy jets get a diamond within this distance (km). */
  markerJets: number
  /** An arrow at the screen edge toward the nearest enemy carrier when it is out of view. */
  markerArrow: boolean
}
export const RADAR_DEFAULTS: Readonly<RadarSettings> = {
  radar: true,
  radarSize: 196,
  radarRange: 0,
  radarBack: 0.5,
  islands: 0.8,
  map: true,
  mapSize: 0.8,
  markers: true,
  markerJets: 8,
  markerArrow: true,
}
export const RADAR: RadarSettings = { ...RADAR_DEFAULTS }
export const RADAR_CONTROLS: LabControl[] = [
  { key: "radar", label: "Radar while flying", group: "Radar", type: "toggle" },
  { key: "radarSize", label: "Diameter", group: "Radar", min: 120, max: 320, step: 4, unit: "px" },
  {
    key: "radarRange",
    label: "Range",
    group: "Radar",
    type: "select",
    options: [
      { value: 0, label: "Auto" },
      { value: 2, label: "2 km" },
      { value: 5, label: "5 km" },
      { value: 10, label: "10 km" },
      { value: 20, label: "20 km" },
    ],
  },
  { key: "radarBack", label: "Backing", group: "Radar", min: 0, max: 0.9, step: 0.02, unit: "" },
  { key: "islands", label: "Islands", group: "Radar", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "map", label: "Full map on G", group: "Full map", type: "toggle" },
  { key: "mapSize", label: "Size", group: "Full map", min: 0.4, max: 0.95, step: 0.01, unit: "×" },
  { key: "markers", label: "Target markers", group: "Markers", type: "toggle" },
  { key: "markerJets", label: "Jet markers within", group: "Markers", min: 1, max: 20, step: 0.5, unit: "km" },
  { key: "markerArrow", label: "Edge arrow to nearest enemy carrier", group: "Markers", type: "toggle" },
]

/** Another jet as the weapons see it (src/weapons/weapons.ts `Jet`): position, attitude, team, alive in the air. */
export type RadarJet = Target & { qx: number; qy: number; qz: number; qw: number }
export type RadarShip = ShipPoseLike & { id: number; team: number }

/** Everything the radar, the map and the markers show this frame, from what the client already draws. */
export type RadarScene = {
  /** This player (null: not in the crew yet). */
  me: CrewPlayer | null
  crew: Crew | null
  /** Our own jet while it flies, else null. */
  jet: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number } | null
  ships: readonly RadarShip[]
  hulls: ReadonlyMap<number, Hull> | null
  jets: ReadonlyMap<number, RadarJet>
  boats: readonly Target[]
  missiles: readonly Missile[]
}

/** Whether team `team` (player or boat `id`, -1 for a carrier) is an enemy of this player: the weapons' own rule. */
export const hostile = (me: CrewPlayer | null, team: number, id = -1): boolean => !!me && canHurt(me.team, me.id, team, id)

/** Compass heading (rad, 0 north, clockwise) of a body's nose (+Z body axis). */
export function noseHeading(q: { qx: number; qy: number; qz: number; qw: number }): number {
  const nx = 2 * (q.qx * q.qz + q.qw * q.qy)
  const nz = 1 - 2 * (q.qx * q.qx + q.qy * q.qy)
  return Math.atan2(nx, -nz)
}

export const sinking = (hulls: ReadonlyMap<number, Hull> | null, id: number): boolean => (hulls?.get(id)?.sinkAt ?? -1) >= 0

const RANGES = [2000, 5000, 10000, 20000] as const
/** The island mask covers ±MAP_HALF m, a little past the world edge. */
const MAP_HALF = 9600
const MASK = 640
const MASK_ROWS = 24
const INK = "#f4f7fb"
const RED = "#ff5a3a"
const FONT = `300 9px "IBM Plex Mono", ui-monospace, Menlo, monospace`
const FONT_MAP = `300 10px "IBM Plex Mono", ui-monospace, Menlo, monospace`

const CSS = `
#rd { position: fixed; inset: 0; pointer-events: none; }
#rd[hidden], #rd [hidden] { display: none !important; }
#rd canvas { position: absolute; }
#rd .mini { left: calc(22px * var(--hud, 1)); bottom: calc(84px * var(--hud, 1)); }
#rd .map { left: 50%; top: 50%; transform: translate(-50%, -50%); backdrop-filter: blur(6px); }
body.mn-open #rd { display: none; }
`

/**
 * The pilot's map. While flying, a compact heading-up radar sits in the bottom-left corner, centred on our jet: range
 * rings, a north mark, islands as faint shapes, enemy carriers as filled hulls in their colour (pinned to the rim when
 * out of range), our carrier as an outline, jets as arrows (filled enemies, outlined friends, a tick above or below
 * for a big height difference), boats as small diamonds, and missiles homing on us as blinking red dots. The range
 * follows the nearest enemy (2/5/10/20 km) unless fixed in the settings. Holding G (physical KeyG; a tap pins it, a
 * second tap or Esc closes) shows the whole battle area north-up with every carrier named, from any role.
 */
export class Radar {
  readonly root: HTMLElement
  private mini: HTMLCanvasElement
  private map: HTMLCanvasElement
  private mask = document.createElement("canvas")
  private maskData: ImageData | null = null
  private maskLand: Uint8Array | null = null
  private maskRow = MASK
  private arch: Archipelago | null = null
  /** Range picked (m) and the range drawn, easing toward it. */
  private range: number = RANGES[1]
  private shown: number = RANGES[1]
  private downFor = 0
  private zoomAt = 0
  private clock = 0
  private held = false
  private pinned = false
  private heldAt = 0
  private tapClose = false
  /** The radar's corner on screen while it shows (CSS px: its right edge and top), for markers to keep clear of. */
  box: { right: number; top: number } | null = null

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("rd-css")) {
      const style = document.createElement("style")
      style.id = "rd-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "rd"
    root.innerHTML = `<canvas class="mini" hidden></canvas><canvas class="map" hidden></canvas>`
    parent.append(root)
    this.root = root
    this.mini = root.querySelector<HTMLCanvasElement>(".mini")!
    this.map = root.querySelector<HTMLCanvasElement>(".map")!
    this.mask.width = this.mask.height = MASK
    addEventListener("keydown", (e) => {
      if (e.code === "Escape" && (this.pinned || this.held)) {
        e.preventDefault()
        this.pinned = this.held = false
      }
      if (e.code !== "KeyG" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditableEventTarget(e.composedPath()[0])) return
      if (this.pinned) {
        this.pinned = false
        this.tapClose = true
        return
      }
      this.held = true
      this.heldAt = performance.now()
    })
    addEventListener("keyup", (e) => {
      if (e.code !== "KeyG") return
      if (this.tapClose) this.tapClose = false
      else if (this.held && performance.now() - this.heldAt < 250) this.pinned = true
      this.held = false
    })
    addEventListener("blur", () => (this.held = false))
  }

  /** The full map is up (held or pinned). */
  get mapOpen(): boolean {
    return RADAR.map && (this.held || this.pinned)
  }

  /** A new world: the island mask is baked again over the next frames. */
  setWorld(arch: Archipelago): void {
    this.arch = arch
    this.maskRow = 0
    this.maskData = new ImageData(MASK, MASK)
    this.maskLand = new Uint8Array(MASK * MASK)
  }

  /** Bakes a few rows of the island mask (land, reef shelf) per frame, then the coastlines. */
  private bake(): void {
    const arch = this.arch
    const land = this.maskLand
    const img = this.maskData
    if (!arch || !land || !img || this.maskRow >= MASK) return
    const px = (2 * MAP_HALF) / MASK
    const end = Math.min(MASK, this.maskRow + MASK_ROWS)
    for (let j = this.maskRow; j < end; j++) {
      const z = -MAP_HALF + (j + 0.5) * px
      for (let i = 0; i < MASK; i++) {
        const x = -MAP_HALF + (i + 0.5) * px
        // Open sea far from every island: skip the terrain.
        let near = false
        for (const isl of arch.islands) {
          const r = isl.radius + 900
          if (Math.abs(x - isl.x) < r && Math.abs(z - isl.z) < r) {
            near = true
            break
          }
        }
        if (!near) continue
        const h = terrainHeight(arch, x, z)
        land[j * MASK + i] = h > 0 ? 2 : h > -5 ? 1 : 0
      }
    }
    this.maskRow = end
    if (end < MASK) return
    const d = img.data
    for (let j = 0; j < MASK; j++)
      for (let i = 0; i < MASK; i++) {
        const k = j * MASK + i
        const v = land[k]!
        if (!v) continue
        const o = k * 4
        if (v === 1) {
          d[o] = 150
          d[o + 1] = 215
          d[o + 2] = 230
          d[o + 3] = 34
          continue
        }
        const coast = (i > 0 && land[k - 1]! < 2) || (i < MASK - 1 && land[k + 1]! < 2) || (j > 0 && land[k - MASK]! < 2) || (j < MASK - 1 && land[k + MASK]! < 2)
        d[o] = 244
        d[o + 1] = 247
        d[o + 2] = 251
        d[o + 3] = coast ? 200 : 80
      }
    this.mask.getContext("2d")!.putImageData(img, 0, 0)
  }

  /** Per frame. `flying`: our jet is in the air (the radar shows); `paused`: a menu is open (the map stays shut). */
  update(dt: number, s: RadarScene, flying: boolean, paused: boolean): void {
    this.clock += dt
    this.bake()
    const showMini = RADAR.radar && flying && !!s.jet
    this.mini.hidden = !showMini
    this.box = null
    if (showMini) this.drawMini(dt, s)
    const showMap = this.mapOpen && !paused && !!s.me
    this.map.hidden = !showMap
    if (showMap) this.drawMap(s)
  }

  /** Sizes a canvas to `css` px square at the device pixel ratio; returns its 2D context scaled to CSS px. */
  private fit(c: HTMLCanvasElement, css: number): CanvasRenderingContext2D {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const px = Math.round(css * dpr)
    if (c.width !== px) {
      c.width = c.height = px
      c.style.width = c.style.height = `${css}px`
    }
    const ctx = c.getContext("2d")!
    ctx.setTransform(px / css, 0, 0, px / css, 0, 0)
    ctx.clearRect(0, 0, css, css)
    return ctx
  }

  /** The radar range: the nearest enemy jet or boat, else the nearest enemy carrier; up at once, down after a pause. */
  private pickRange(dt: number, s: RadarScene, ox: number, oz: number): number {
    if (RADAR.radarRange > 0) return RADAR.radarRange * 1000
    let air = Infinity
    for (const j of s.jets.values()) if (j.alive && hostile(s.me, j.team, j.id)) air = Math.min(air, Math.hypot(j.x - ox, j.z - oz))
    for (const b of s.boats) if (b.alive && hostile(s.me, b.team, b.id)) air = Math.min(air, Math.hypot(b.x - ox, b.z - oz))
    let want = air
    if (want > RANGES[2]) {
      let sea = Infinity
      for (const sh of s.ships) if (hostile(s.me, sh.team) && !sinking(s.hulls, sh.id)) sea = Math.min(sea, Math.hypot(sh.x - ox, sh.z - oz))
      want = Math.min(want, sea)
    }
    if (!Number.isFinite(want)) want = RANGES[1] * 0.8
    const need = RANGES.find((r) => want <= r * 0.92) ?? RANGES[RANGES.length - 1]
    if (need > this.range) {
      this.range = need
      this.downFor = 0
    } else if (need < this.range) {
      this.downFor += dt
      if (this.downFor > 1.5) {
        this.range = need
        this.downFor = 0
      }
    } else this.downFor = 0
    return this.range
  }

  private drawMini(dt: number, s: RadarScene): void {
    const jet = s.jet!
    const hud = Number.parseFloat(document.documentElement.style.getPropertyValue("--hud")) || 1
    const size = Math.round(RADAR.radarSize * hud)
    const ctx = this.fit(this.mini, size)
    this.box = { right: 22 * hud + size, top: innerHeight - 84 * hud - size }
    const ox = jet.x
    const oz = jet.z
    const h = noseHeading(jet)
    const target = this.pickRange(dt, s, ox, oz)
    // Zooms on the wall clock, so a slow frame (the game caps dt) never leaves the scale behind its label.
    const now = performance.now()
    const wall = Math.min(1, (now - this.zoomAt) / 1000)
    this.zoomAt = now
    this.shown = Math.exp(Math.log(this.shown) + (Math.log(target) - Math.log(this.shown)) * (1 - Math.exp(-wall / 0.25)))
    const c = size / 2
    const r = c - 7
    const k = r / this.shown
    const ch = Math.cos(h)
    const sh = Math.sin(h)
    // World offset → radar point (heading up).
    const at = (dx: number, dz: number, out: [number, number]) => {
      out[0] = c + (dx * ch + dz * sh) * k
      out[1] = c + (-dx * sh + dz * ch) * k
      return out
    }
    ctx.save()
    ctx.beginPath()
    ctx.arc(c, c, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(6, 16, 30, ${RADAR.radarBack})`
    ctx.fill()
    ctx.clip()
    if (RADAR.islands > 0 && this.maskRow >= MASK) {
      ctx.save()
      ctx.translate(c, c)
      ctx.rotate(-h)
      ctx.scale(k, k)
      ctx.globalAlpha = RADAR.islands
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.mask, -MAP_HALF - ox, -MAP_HALF - oz, 2 * MAP_HALF, 2 * MAP_HALF)
      ctx.restore()
    }
    // The world edge, when in range.
    const edgeD = Math.hypot(ox, oz)
    if (edgeD + this.shown > PLANE.edge) {
      const e = at(-ox, -oz, P)
      ctx.beginPath()
      ctx.arc(e[0], e[1], PLANE.edge * k, 0, Math.PI * 2)
      ctx.strokeStyle = "rgba(255, 200, 97, 0.55)"
      ctx.setLineDash([3, 4])
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
    // Rings and the heading notch.
    ctx.lineWidth = 1
    ctx.strokeStyle = "rgba(244, 247, 251, 0.18)"
    ctx.beginPath()
    ctx.arc(c, c, r / 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = "rgba(244, 247, 251, 0.55)"
    ctx.beginPath()
    ctx.arc(c, c, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(c, c - r - 4)
    ctx.lineTo(c, c - r + 5)
    ctx.strokeStyle = INK
    ctx.stroke()
    ctx.font = FONT
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    shadow(ctx)
    // North on the rim.
    ctx.fillStyle = "rgba(244, 247, 251, 0.85)"
    ctx.fillText("N", c - sh * (r - 9), c - ch * (r - 9))
    // Contacts: islands under, boats, carriers, jets, missiles on top.
    const me = s.me
    for (const b of s.boats) {
      if (!b.alive || (me && b.id === me.id)) continue
      const p = at(b.x - ox, b.z - oz, P)
      if (Math.hypot(p[0] - c, p[1] - c) > r - 3) continue
      boat(ctx, p[0], p[1], teamCss(b.team), hostile(me, b.team, b.id), 3.2)
    }
    for (const ship of s.ships) {
      const own = me?.ship === ship.id
      const enemy = hostile(me, ship.team)
      const p = at(ship.x - ox, ship.z - oz, P)
      const dx = p[0] - c
      const dy = p[1] - c
      const d = Math.hypot(dx, dy)
      ctx.globalAlpha = sinking(s.hulls, ship.id) ? 0.35 : 1
      const color = teamCss(ship.team)
      if (d > r - 6) {
        // Pinned to the rim: a pip pointing out toward it.
        if (!enemy && !own) continue
        rimPip(ctx, c + (dx / d) * (r - 1), c + (dy / d) * (r - 1), Math.atan2(dy, dx), color, enemy)
      } else hull(ctx, p[0], p[1], ship.heading - h, color, enemy, own ? 11 : 13)
      ctx.globalAlpha = 1
    }
    for (const j of s.jets.values()) {
      if (!j.alive) continue
      const p = at(j.x - ox, j.z - oz, P)
      if (Math.hypot(p[0] - c, p[1] - c) > r - 3) continue
      const enemy = hostile(me, j.team, j.id)
      arrow(ctx, p[0], p[1], noseHeading(j) - h, teamCss(j.team), enemy, enemy ? 5 : 4.2)
      const dy = j.y - jet.y
      if (Math.abs(dy) > 250) {
        const y = p[1] + (dy > 0 ? -8 : 8)
        ctx.beginPath()
        ctx.moveTo(p[0] - 3, y)
        ctx.lineTo(p[0] + 3, y)
        ctx.strokeStyle = teamCss(j.team)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    this.missilesOn(ctx, s, (x, z) => at(x - ox, z - oz, P), (x, y) => Math.hypot(x - c, y - c) <= r - 2)
    // Our jet in the middle.
    arrow(ctx, c, c, 0, INK, true, 5.5)
    // Range, in the corner outside the disc.
    ctx.textAlign = "right"
    ctx.textBaseline = "alphabetic"
    ctx.fillStyle = "rgba(244, 247, 251, 0.8)"
    const km = Math.round(target / 1000)
    ctx.fillText(`${km} KM`, size - 1, size - 1)
    noShadow(ctx)
  }

  /** Missiles homing on us, blinking. */
  private missilesOn(ctx: CanvasRenderingContext2D, s: RadarScene, at: (x: number, z: number) => [number, number], inside: (x: number, y: number) => boolean): void {
    const me = s.me
    if (!me || (this.clock * 4) % 1 > 0.7) return
    for (const m of s.missiles) {
      if (!m.alive || m.kind !== "missile" || m.target !== me.id) continue
      const p = at(m.x, m.z)
      if (!inside(p[0], p[1])) continue
      ctx.beginPath()
      ctx.arc(p[0], p[1], 3, 0, Math.PI * 2)
      ctx.fillStyle = RED
      ctx.fill()
    }
  }

  private drawMap(s: RadarScene): void {
    const hud = Number.parseFloat(document.documentElement.style.getPropertyValue("--hud")) || 1
    const size = Math.round(Math.min(innerWidth, innerHeight) * RADAR.mapSize)
    const ctx = this.fit(this.map, size)
    const pad = 26 * hud
    const c = size / 2
    const k = (c - pad) / MAP_HALF
    const at = (x: number, z: number, out: [number, number]) => {
      out[0] = c + x * k
      out[1] = c + z * k
      return out
    }
    ctx.fillStyle = "rgba(6, 16, 30, 0.8)"
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = "rgba(244, 247, 251, 0.22)"
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1)
    // A 2 km grid.
    ctx.strokeStyle = "rgba(244, 247, 251, 0.06)"
    ctx.beginPath()
    for (let g = -8000; g <= 8000; g += 2000) {
      const q = c + g * k
      ctx.moveTo(q, pad * 0.5)
      ctx.lineTo(q, size - pad * 0.5)
      ctx.moveTo(pad * 0.5, q)
      ctx.lineTo(size - pad * 0.5, q)
    }
    ctx.stroke()
    if (this.maskRow >= MASK) {
      ctx.globalAlpha = Math.max(0.5, RADAR.islands)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.mask, c - MAP_HALF * k, c - MAP_HALF * k, 2 * MAP_HALF * k, 2 * MAP_HALF * k)
      ctx.globalAlpha = 1
    }
    ctx.beginPath()
    ctx.arc(c, c, PLANE.edge * k, 0, Math.PI * 2)
    ctx.strokeStyle = "rgba(255, 200, 97, 0.5)"
    ctx.setLineDash([4, 5])
    ctx.stroke()
    ctx.setLineDash([])
    shadow(ctx)
    ctx.font = FONT_MAP
    ctx.letterSpacing = "0.2em"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = "rgba(244, 247, 251, 0.85)"
    ctx.fillText("N", c, pad * 0.5)
    const me = s.me
    for (const b of s.boats) {
      if (!b.alive) continue
      const p = at(b.x, b.z, P)
      boat(ctx, p[0], p[1], teamCss(b.team), hostile(me, b.team, b.id), 3.6)
    }
    for (const ship of s.ships) {
      const own = me?.ship === ship.id
      const enemy = hostile(me, ship.team)
      const p = at(ship.x, ship.z, P)
      const color = teamCss(ship.team)
      ctx.globalAlpha = sinking(s.hulls, ship.id) ? 0.35 : 1
      hull(ctx, p[0], p[1], ship.heading, color, enemy, 16)
      if (own) {
        ctx.beginPath()
        ctx.arc(p[0], p[1], 13, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.stroke()
      }
      const name = s.crew?.ships.find((x) => x.id === ship.id)?.name.replace(/^CV-\d+\s+/, "") ?? ""
      ctx.fillStyle = color
      ctx.fillText(name, p[0], p[1] + 20)
      ctx.globalAlpha = 1
    }
    for (const j of s.jets.values()) {
      if (!j.alive) continue
      const p = at(j.x, j.z, P)
      const enemy = hostile(me, j.team, j.id)
      arrow(ctx, p[0], p[1], noseHeading(j), teamCss(j.team), enemy, enemy ? 5.5 : 4.8)
    }
    this.missilesOn(ctx, s, (x, z) => at(x, z, P), () => true)
    if (s.jet) {
      const p = at(s.jet.x, s.jet.z, P)
      arrow(ctx, p[0], p[1], noseHeading(s.jet), INK, true, 6.5)
    }
    // Scale bar: 2 km.
    const bar = 2000 * k
    const bx = pad * 0.6
    const by = size - pad * 0.45
    ctx.beginPath()
    ctx.moveTo(bx, by - 3)
    ctx.lineTo(bx, by)
    ctx.lineTo(bx + bar, by)
    ctx.lineTo(bx + bar, by - 3)
    ctx.strokeStyle = "rgba(244, 247, 251, 0.7)"
    ctx.stroke()
    ctx.textAlign = "left"
    ctx.fillStyle = "rgba(244, 247, 251, 0.75)"
    ctx.fillText("2 KM", bx + bar + 6, by - 1)
    ctx.letterSpacing = "0px"
    noShadow(ctx)
  }
}

const P: [number, number] = [0, 0]

function shadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "rgba(10, 30, 60, 0.7)"
  ctx.shadowBlur = 3
}

function noShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "transparent"
  ctx.shadowBlur = 0
}

/** A jet: an arrow along `angle` (rad, clockwise from up), filled (enemies, us) or outlined. */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, filled: boolean, s: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, -s * 1.3)
  ctx.lineTo(s, s)
  ctx.lineTo(0, s * 0.45)
  ctx.lineTo(-s, s)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.3
    ctx.stroke()
  }
  ctx.restore()
}

/** A carrier: a hull along `angle`, `len` px long, filled (enemies) or outlined (ours). */
function hull(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, filled: boolean, len: number): void {
  const w = len * 0.3
  const l = len / 2
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, -l)
  ctx.lineTo(w, -l + w * 1.2)
  ctx.lineTo(w, l)
  ctx.lineTo(-w, l)
  ctx.lineTo(-w, -l + w * 1.2)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

/** A carrier out of range: a triangle on the rim pointing out along `angle` (canvas radians). */
function rimPip(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, filled: boolean): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(4, 0)
  ctx.lineTo(-5, -5)
  ctx.lineTo(-5, 5)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

/** A boat: a small diamond. */
function boat(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, filled: boolean, s: number): void {
  ctx.beginPath()
  ctx.moveTo(x, y - s)
  ctx.lineTo(x + s, y)
  ctx.lineTo(x, y + s)
  ctx.lineTo(x - s, y)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.2
    ctx.stroke()
  }
}
