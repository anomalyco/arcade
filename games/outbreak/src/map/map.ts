import type { LabCommand } from "@arcade/kit/lab/commands"
import { CHUNK } from "../../shared/map"
import { districtAtBlock, MACRO_CHUNKS, type WorldMode } from "../../shared/world"
import { MapCompass, MapMinimap, type Project } from "./compass"
import { blockName, DISTRICT_LABELS, groupSightings, MapMemory, type ChunkSource, type VisionWindow } from "./memory"
import { MapScreen, type MapActor, type MapPing, type MapVehicle } from "./screen"
import type { MapObjectives } from "./objectives"
import { MINIMAP_COMPASS, MINIMAP_CORNER, type MapSettings } from "./settings"
import { PALETTES } from "./style"
import { MapTiles } from "./tiles"
import "./map.css"

/** The map's binding: physical KeyN on every layout (labelled N via keyLabel). */
export const MAP_KEY = "KeyN"

export type MapFrame = {
  /** performance.now() in milliseconds. */
  now: number
  /** Simulation time in seconds. */
  time: number
  seed: number
  houseSeed: number
  mode: WorldMode
  vision: VisionWindow
  /** Vision explored new cells this frame. */
  visionChanged: boolean
  /** The 3 × 3 streaming window moved this frame. */
  windowChanged: boolean
  source: ChunkSource
  zombies: readonly { x: number; y: number; state: string }[]
  /** Whether the local survivor can see a point now (zombie sightings). */
  sees: (x: number, y: number) => boolean
  self: MapActor
  teammates: readonly MapActor[]
  pings: readonly MapPing[]
  vehicles: readonly MapVehicle[]
  project: Project
  ground: number
  /** Features' objectives (the way out), drawn on the sheet and as bearings on the compass ring. */
  objectives?: MapObjectives
}

const OBSERVE_MS = 200
const ZOMBIE_MS = 250
const PREWARM_MS = 120

type Sample = number[]
const pct = (xs: Sample, p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}

/**
 * Outbreak's map: per-chunk exploration memory, a cached tile pyramid, the full-screen sheet on `KeyN` and an optional
 * compass ring or corner minimap. `main.ts` calls `update` once per drawn frame; everything else is internal.
 */
export class OutbreakMap {
  readonly memory = new MapMemory()
  readonly tiles: MapTiles
  readonly screen: MapScreen
  readonly compass: MapCompass
  readonly minimap: MapMinimap
  private signature = ""
  private seed = 0
  private observePending = true
  private lastObserve = -Infinity
  private lastZombies = -Infinity
  private lastPrewarm = -Infinity
  private last: MapFrame | null = null
  private origin: [number, number] = [0, 0]
  private readonly costs: Sample = []
  private readonly openCosts: Sample = []

  constructor(
    parent: HTMLElement,
    readonly settings: MapSettings,
    private readonly storage: Storage | null,
  ) {
    const palette = PALETTES[settings.mapStyle] ?? PALETTES[0]
    this.tiles = new MapTiles(this.memory, palette)
    this.screen = new MapScreen(parent, this.memory, this.tiles, palette, () => this.seed)
    this.screen.onMarkers = () => this.saveMarkers()
    this.compass = new MapCompass(parent)
    this.minimap = new MapMinimap(parent)
    // Tells a Lab station embedding the game that N opens the map here, not a voice note.
    const keys = new Set((document.documentElement.dataset.pageKeys ?? "").split(" ").filter(Boolean))
    keys.add(MAP_KEY)
    document.documentElement.dataset.pageKeys = [...keys].join(" ")
  }

  get isOpen(): boolean {
    return this.screen.isOpen
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  open(): void {
    const me = this.last?.self
    this.screen.open(me?.x ?? 48, me?.y ?? 48, this.settings.mapOpenZoom, this.settings.mapBackdrop)
  }

  close(): void {
    this.screen.close()
  }

  /** Keys while the sheet is open: + and − zoom. Returns true when the key was used. */
  key(code: string): boolean {
    if (!this.isOpen) return false
    if (code === "Equal" || code === "NumpadAdd") this.screen.zoomAt(1.6)
    else if (code === "Minus" || code === "NumpadSubtract") this.screen.zoomAt(1 / 1.6)
    else return false
    return true
  }

  /** Forgets everything (new session or world). Marks are kept per world in local storage. */
  reset(): void {
    this.memory.clear()
    this.tiles.clear()
    this.signature = ""
    this.observePending = true
    this.screen.markDirty()
    this.minimap.invalidate()
  }

  applySettings(): void {
    const palette = PALETTES[this.settings.mapStyle] ?? PALETTES[0]
    this.screen.setPalette(palette)
    this.screen.labels = this.settings.mapLabels
    this.screen.root.style.setProperty("--map-backdrop", String(this.settings.mapBackdrop))
    this.screen.markDirty()
    this.minimap.invalidate()
  }

  private storageKey(): string {
    return `outbreak.map.marks:${this.signature}`
  }

  private saveMarkers(): void {
    this.screen.markDirty()
    this.minimap.invalidate()
    try {
      this.storage?.setItem(this.storageKey(), JSON.stringify(this.memory.markers.map((m) => ({ x: m.x, y: m.y, label: m.label }))))
    } catch {}
  }

  private loadMarkers(): void {
    try {
      const raw = this.storage?.getItem(this.storageKey())
      const list = raw ? JSON.parse(raw) : []
      this.memory.setMarkers(Array.isArray(list) ? list : [])
    } catch {
      this.memory.setMarkers([])
    }
  }

  placeName(x: number, y: number): string {
    const bx = Math.floor(Math.floor(x / CHUNK) / MACRO_CHUNKS)
    const by = Math.floor(Math.floor(y / CHUNK) / MACRO_CHUNKS)
    const district = districtAtBlock(this.seed, bx, by)
    return `${blockName(this.seed, bx, by, district)} · ${DISTRICT_LABELS[district]}`
  }

  update(f: MapFrame): void {
    const t0 = performance.now()
    this.last = f
    this.seed = f.seed
    const sig = `${f.seed}:${f.houseSeed}:${f.mode}`
    if (sig !== this.signature) {
      this.memory.clear()
      this.tiles.clear()
      this.signature = sig
      this.loadMarkers()
      this.observePending = true
      this.screen.markDirty()
    }
    if (f.windowChanged) {
      this.memory.observeSaved(f.vision, this.origin[0], this.origin[1], f.source)
      this.memory.observeWindow(f.vision, f.source)
      this.observePending = false
      this.lastObserve = f.now
    } else {
      if (f.visionChanged) this.observePending = true
      if (this.observePending && f.now - this.lastObserve >= OBSERVE_MS) {
        this.memory.observe(f.vision, f.source)
        this.observePending = false
        this.lastObserve = f.now
      }
    }
    if (f.now - this.lastZombies >= ZOMBIE_MS) {
      this.lastZombies = f.now
      this.memory.observeZombies(f.zombies, f.sees, f.time, this.settings.mapHordeMemory)
    }
    this.origin[0] = f.vision.originX
    this.origin[1] = f.vision.originY
    const changed = this.memory.drainChanged()
    if (changed.length) {
      this.tiles.invalidate(changed)
      this.screen.markDirty()
      this.minimap.invalidate()
    }
    const live = {
      time: f.time,
      actors: [...f.teammates, f.self],
      pings: f.pings,
      // Vehicles show where you have explored; one you drove away stays visible because its ground is explored too.
      vehicles: f.vehicles.filter((v) => this.memory.explored(v.x, v.y)),
      hordeMemory: this.settings.mapHordeMemory,
      place: this.placeName(f.self.x, f.self.y),
      objectives: f.objectives,
    }
    if (this.isOpen) {
      this.screen.render(live, 3)
      this.compass.hide()
      this.minimap.hide()
    } else {
      if (f.now - this.lastPrewarm >= PREWARM_MS) {
        // Keep the tiles the sheet opens on ready, a little at a time, so opening it never has to build them all.
        this.lastPrewarm = f.now
        const dpr = Math.min(devicePixelRatio || 1, 2)
        this.tiles.prewarm({ x: f.self.x, y: f.self.y, zoom: this.settings.mapOpenZoom, w: innerWidth - 44, h: innerHeight - 44, dpr }, 0.6)
      }
      const mode = this.settings.mapMinimap
      if (mode === MINIMAP_COMPASS) {
        this.minimap.hide()
        this.compass.draw(this.memory, {
          self: f.self,
          ground: f.ground,
          teammates: f.teammates,
          pings: f.pings,
          project: f.project,
          radius: this.settings.mapCompassRadius,
          opacity: this.settings.mapCompassOpacity,
          range: this.settings.mapCompassRange,
          pins: f.objectives?.pins,
        })
      } else if (mode === MINIMAP_CORNER) {
        this.compass.hide()
        this.minimap.draw(this.tiles, this.memory, this.screen.palette, f.self, f.teammates, f.pings, this.settings.mapMinimapSize, this.settings.mapMinimapZoom, f.now)
      } else {
        this.compass.hide()
        this.minimap.hide()
      }
    }
    const ms = performance.now() - t0
    const list = this.isOpen ? this.openCosts : this.costs
    list.push(ms)
    if (list.length > 600) list.shift()
  }

  /** Last-known zombie groups as drawn on the sheet. */
  hordes() {
    return groupSightings(this.memory.sightings.values())
  }

  /** Telemetry and state for proofs and the dev console. */
  inspect() {
    let cells = 0
    let known = 0
    let pois = 0
    for (const c of this.memory.chunks.values()) {
      cells += c.count
      for (const b of c.buildings) {
        if (!b.known) continue
        known++
        if (b.poi) pois++
      }
    }
    return {
      open: this.isOpen,
      view: { ...this.screen.view },
      chunks: this.memory.chunks.size,
      exploredCells: cells,
      knownBuildings: known,
      knownPois: pois,
      sightings: [...this.memory.sightings.values()].map((s) => ({ ...s })),
      markers: this.memory.markers.map((m) => ({ ...m })),
      tiles: { ...this.tiles.stats },
      screen: { ...this.screen.stats },
      compass: { visible: this.compass.visible, ...this.compass.stats },
      minimap: { visible: this.minimap.visible, ...this.minimap.stats },
      updateMs: { closedP50: pct(this.costs, 0.5), closedP95: pct(this.costs, 0.95), closedMax: Math.max(0, ...this.costs), openP50: pct(this.openCosts, 0.5), openP95: pct(this.openCosts, 0.95), openMax: Math.max(0, ...this.openCosts) },
    }
  }

  /**
   * Lab demo: reveals ground around the survivor as if walked, drops two marks and a sighting, and opens the sheet.
   * It writes the local map memory and nothing in the simulation.
   */
  demo(radius = 150): ReturnType<OutbreakMap["inspect"]> {
    const f = this.last
    if (!f) return this.inspect()
    const { x, y } = f.self
    this.memory.reveal(x, y, radius, f.source)
    this.memory.reveal(x + radius * 0.9, y - radius * 0.2, radius * 0.45, f.source)
    if (!this.memory.markers.length) {
      this.memory.addMarker(x + radius * 0.55, y - radius * 0.35)
      this.memory.addMarker(x - radius * 0.4, y + radius * 0.5)
      this.saveMarkers()
    }
    this.memory.sightings.set(-1, { key: -1, x: x + radius * 0.35, y: y + radius * 0.2, count: 7, seenAt: f.time - 75 })
    this.memory.sightings.set(-2, { key: -2, x: x - radius * 0.5, y: y - radius * 0.3, count: 3, seenAt: f.time - 10 })
    this.tiles.invalidate(this.memory.drainChanged())
    this.screen.markDirty()
    this.minimap.invalidate()
    if (!this.isOpen) this.open()
    return this.inspect()
  }

  labCommands(): LabCommand[] {
    const base = { category: "Scene" as const, undoable: false, enabled: () => true }
    return [
      { ...base, id: "map.toggle", label: "Toggle Map", shortLabel: "Map", run: () => (this.toggle(), this.inspect()) },
      {
        ...base,
        id: "map.open",
        label: "Open Map",
        shortLabel: "Open Map",
        args: {
          zoom: { type: "number", description: "CSS pixels per metre (default: Lab opening zoom)" },
          x: { type: "number", description: "World X at the centre (default: survivor)" },
          y: { type: "number", description: "World Y at the centre (default: survivor)" },
        },
        run: (_ctx, args) => {
          this.open()
          if (typeof args?.zoom === "number") this.screen.zoomAt(args.zoom / this.screen.view.zoom)
          if (typeof args?.x === "number" && typeof args?.y === "number") this.screen.centreOn(args.x, args.y)
          return this.inspect()
        },
      },
      { ...base, id: "map.close", label: "Close Map", shortLabel: "Close Map", run: () => (this.close(), this.inspect()) },
      {
        ...base,
        id: "map.demo",
        label: "Map Demo: Reveal Surroundings",
        shortLabel: "Map Demo",
        args: { radius: { type: "number", description: "Metres revealed around the survivor (default: 150)" } },
        run: (_ctx, args) => this.demo(typeof args?.radius === "number" ? args.radius : 150),
      },
    ]
  }

  resetStats(): void {
    this.costs.length = 0
    this.openCosts.length = 0
    this.tiles.stats.built = 0
    this.tiles.stats.buildMs = 0
    this.tiles.stats.maxBuildMs = 0
    this.screen.stats.maxBaseMs = 0
    this.screen.stats.maxLiveMs = 0
  }
}
