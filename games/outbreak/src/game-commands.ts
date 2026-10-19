import type { Camera } from "@arcade/kit/client/camera"
import type { DiscoveryHost } from "./discovery/stage"
import type { Input } from "@arcade/kit/client/input"
import { registerGameCommands } from "@arcade/kit/dev-control"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { LabPanel } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import type { AIState } from "../shared/ai"
import { sightRects } from "../shared/map"
import type { SceneryMemory } from "../shared/scenery-memory"
import type { LocalSession } from "../shared/session"
import { FOG_SIZE, type Vision } from "../shared/vision"
import type { CoopView } from "./coop-view"
import type { OutbreakFeelTracker } from "./feel-events"
import type { OutbreakHarness } from "./harness"
import type { OutbreakHud } from "./hud"
import type { OutbreakMap } from "./map/map"
import type { NetSession } from "./net-session"
import { type ProgressionLabHost } from "./progression/lab"
import type { InventoryHud } from "./inventory-hud"
import type { OutbreakSettings } from "./settings"
import type { Survivor } from "./survivor"
import { showGlyphSheet } from "./hud/glyph-sheet"
import { stageVehicleScene, type VehicleLabHost } from "./vehicle-lab"
import type { OutbreakWeatherController } from "./weather/controller"

/** The feature command hooks (the client feature registry, passed in by `main.ts`). */
export interface OutbreakCommandFeatures {
  collectGameCommands(host: OutbreakGameCommandsHost): LabCommand[]
}

export interface OutbreakGameCommandsHost {
  readonly features: OutbreakCommandFeatures
  readonly device: GPUDevice
  readonly renderer: Renderer
  readonly session: () => LocalSession | NetSession
  readonly vision: () => Vision
  readonly scenery: () => SceneryMemory
  readonly avatar: () => Survivor
  readonly cam: Camera
  readonly input: Input
  readonly settings: OutbreakSettings
  readonly feelTracker: OutbreakFeelTracker
  readonly hud: OutbreakHud
  readonly inventoryHud?: InventoryHud
  readonly map?: OutbreakMap
  readonly coop: CoopView
  readonly lab: LabPanel
  readonly progressionHost: ProgressionLabHost
  readonly discoveryHost: DiscoveryHost
  readonly vehicleHost: VehicleLabHost
  readonly weatherController: OutbreakWeatherController
  readonly harness: () => OutbreakHarness
  readonly resetPeek: () => void
  readonly draw: (dt: number) => void
}

export function registerOutbreakGameCommands(host: OutbreakGameCommandsHost): void {
  const {
    device,
    renderer,
    cam,
    input,
    settings,
    feelTracker,
    hud,
    coop,
  } = host

  registerGameCommands((commands) => {
    commands.registerAll([
      {
        id: "ai.spawn",
        label: "Spawn Zombie",
        shortLabel: "Spawn Zombie",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", description: "World X (default: ahead of survivor)" },
          y: { type: "number", description: "World Y (default: ahead of survivor)" },
          state: { type: "string", description: "Initial AI state (wander, investigate, alert, chase, search)" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const session = host.session()
          const p = session.view.player
          const x = typeof args?.x === "number" ? args.x : p.x + Math.cos(p.aim) * 4.5
          const y = typeof args?.y === "number" ? args.y : p.y + Math.sin(p.aim) * 4.5
          const state = (typeof args?.state === "string" ? args.state : "wander") as AIState
          const z = session.ai.spawnZombie(session.view.town, x, y, state)
          z.targetX = p.x
          z.targetY = p.y
          settings.ai.zombieCount = session.view.zombies.filter((a) => a.state !== "dead").length
          return { spawned: z.id, x: z.x, y: z.y, state: z.state, total: settings.ai.zombieCount }
        },
      },
      {
        id: "ai.set-state",
        label: "Set Zombie AI State",
        shortLabel: "Set AI State",
        category: "Scene",
        undoable: false,
        args: {
          state: {
            type: "string",
            required: true,
            description: "Target AI state (wander, investigate, alert, chase, search)",
          },
          id: { type: "number", description: "Optional specific zombie ID" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const session = host.session()
          const p = session.view.player
          const state = String(args?.state ?? "wander") as AIState
          const id = typeof args?.id === "number" ? args.id : undefined
          const updated = session.ai.setZombieState(state, p.x, p.y, id)
          return { state, updated }
        },
      },
      {
        id: "ai.make-noise",
        label: "Emit AI Noise Event",
        shortLabel: "Make Noise",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", description: "World X (default: survivor X)" },
          y: { type: "number", description: "World Y (default: survivor Y)" },
          radius: { type: "number", description: "Noise radius in metres (default: 18)" },
          kind: { type: "string", description: "Noise kind (gunshot, glass, door, vault, sprint)" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          const session = host.session()
          const p = session.view.player
          const x = typeof args?.x === "number" ? args.x : p.x
          const y = typeof args?.y === "number" ? args.y : p.y
          const radius = typeof args?.radius === "number" ? args.radius : 18
          const kind = typeof args?.kind === "string" ? args.kind : "glass"
          const ev = session.ai.emitNoise(x, y, radius, kind, session.view.time, "player")
          return { noise: ev }
        },
      },
      {
        id: "player.pose",
        label: "Position Survivor & Aim",
        shortLabel: "Pose",
        category: "Scene",
        undoable: false,
        args: {
          x: { type: "number", required: true, description: "World X coordinate" },
          y: { type: "number", required: true, description: "World Y/Z coordinate" },
          aim: { type: "number", description: "Aim angle in radians" },
          flashlight: { type: "boolean", description: "Flashlight on/off" },
          clearZombiesRadius: { type: "number", description: "Clear nearby zombies within radius" },
          openDoor: { type: "boolean", description: "Open nearby interior doors" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const session = host.session()
          const vision = host.vision()
          const scenery = host.scenery()
          const avatar = host.avatar()
          const x = Number(args?.x ?? session.view.player.x)
          const y = Number(args?.y ?? session.view.player.y)
          const aim = typeof args?.aim === "number" ? args.aim : session.view.player.aim
          Object.assign(session.view.player, {
            x,
            y,
            aim,
            vx: 0,
            vy: 0,
            peekingWindowId: null,
            holdTargetId: null,
            holdElapsed: 0,
            holdTriggered: false,
            holdPendingPrimary: null,
            vault: null,
            channel: null,
          })
          if (typeof args?.flashlight === "boolean") {
            session.view.player.flashlightOn = args.flashlight
            session.view.player.flashlightOutput = args.flashlight ? 1 : 0
          }
          if (typeof args?.clearZombiesRadius === "number" && args.clearZombiesRadius > 0) {
            const rad = args.clearZombiesRadius
            for (const z of session.view.zombies) {
              if (Math.hypot(z.x - x, z.y - y) < rad) {
                z.x = 6
                z.y = 6
                z.state = "wander"
              }
            }
          }
          if (args?.openDoor) {
            for (const d of session.view.town.doors) {
              if (d.id.startsWith("0-")) d.open = true
            }
            const bRects = sightRects(session.view.town)
            for (const [vx, vy, va] of [
              [30, 41, -1.57],
              [20, 35, -1.57],
              [20, 26, 0],
              [30, 21, 1.57],
              [38, 32, 3.14],
            ] as const) {
              vision.update(vx, vy, va, bRects, settings.vision, null)
              scenery.update(session.view.town, vision)
            }
            renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
            session.view.revision++
          }
          host.resetPeek()
          session.rebuildCollision()
          avatar.reset()
          cam.snap(x, y)
          cam.dist = settings.view.zoom
          cam.update(innerWidth / Math.max(1, innerHeight))
          const ahead = cam.project(x + Math.cos(aim) * 4, 0, y + Math.sin(aim) * 4, innerWidth, innerHeight)
          if (ahead.ok) {
            input.mouse.x = ahead.x
            input.mouse.y = ahead.y
          }
          session.update(
            1 / 60,
            { mx: 0, my: 0, aim, interact: false },
            settings.dayCycle.timeScale,
            settings,
          )
          host.draw(1 / 60)
          await device.queue.onSubmittedWorkDone()
          return {
            x: session.view.player.x,
            y: session.view.player.y,
            aim: session.view.player.aim,
            flashlightOn: session.view.player.flashlightOn,
            prompt: session.view.prompt
              ? {
                  id: session.view.prompt.id,
                  kind: session.view.prompt.kind,
                  primary: session.view.prompt.primary.label,
                  secondary: session.view.prompt.secondary?.label,
                }
              : null,
          }
        },
      },
      {
        id: "camera.impulse",
        label: "Trigger Camera & Motion Impulse",
        shortLabel: "Impulse",
        category: "Scene",
        undoable: false,
        args: {
          kind: {
            type: "string",
            required: true,
            description: "Impulse kind (shot, shove, hit-taken, explosion)",
          },
          power: { type: "number", description: "Multiplier (default: 1)" },
          damage: { type: "number", description: "Damage amount for hit-taken" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const p = host.session().view.player
          const kind = String(args?.kind ?? "shot")
          const power = typeof args?.power === "number" ? args.power : 1
          const damage = typeof args?.damage === "number" ? args.damage : 25
          feelTracker.triggerImpulse(kind, p, { power, damage })
          host.draw(1 / 60)
          await device.queue.onSubmittedWorkDone()
          return {
            kind,
            ...feelTracker.inspect(),
          }
        },
      },
      {
        id: "hud.demo",
        label: "Show Character HUD Sample",
        shortLabel: "HUD Sample",
        category: "Scene",
        undoable: false,
        enabled: () => true,
        run: () => hud.demo(host.session().view.player),
      },
      {
        id: "hud.state",
        label: "Show HUD State",
        shortLabel: "HUD State",
        category: "Scene",
        undoable: false,
        args: { state: { type: "string", description: "idle (dim dock), awake, pack (Tab open), craft (recipe panel open), vehicle or icons (the prompt glyph sheet)" } },
        enabled: () => Boolean(host.inventoryHud),
        run: (_ctx, args) => {
          const inv = host.inventoryHud!
          const view = host.session().view
          const state = String(args?.state ?? "awake")
          showGlyphSheet(state === "icons")
          inv.close()
          const grant = (item: string, count: number) => view.progression.ledger.apply({ kind: "grant", actor: view.actorId, item, count })
          if (state !== "idle") for (const [item, n] of [["scrap", 2], ["plank", 2], ["ammo", 6], ["noisemaker", 1]] as const) grant(item, n)
          if (state === "pack") {
            grant("toolbox", 1)
            inv.togglePack()
          }
          if (state === "craft") {
            view.progression.ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:bandage", store: "team/known" })
            grant("chem", 2)
            inv.toggleCraft()
          }
          if (state === "idle") inv.dock?.sleep()
          else inv.dock?.wake()
          if (state === "vehicle") stageVehicleScene(host.vehicleHost, "night-headlights")
          return { state, packOpen: inv.packOpen, craftOpen: inv.craftOpen, dockIdle: inv.dock?.idle ?? null }
        },
      },
      {
        id: "survivor.aim-demo",
        label: "Preview Survivor Pistol Stance",
        shortLabel: "Aim Demo",
        category: "Scene",
        undoable: false,
        args: {
          mode: {
            type: "string",
            description: "Stance mode (aim-fire, low-ready, reload, before)",
          },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const session = host.session()
          const avatar = host.avatar()
          const mode = String(args?.mode ?? "aim-fire")
          const p = session.view.player
          p.equippedItem = "pistol"
          p.magAmmo = p.magCapacity
          p.reserveAmmo = 16
          avatar.legacyUnarmedPistol = mode === "before"
          if (mode === "low-ready") {
            p.fireCooldown = 0
            p.recoil = 0
            p.reloadRemaining = 0
            avatar.holdRemaining = 0
            avatar.aimWeight = 0
            for (let i = 0; i < 24; i++) host.draw(1 / 60)
          } else if (mode === "reload") {
            p.magAmmo = 2
            p.reloadRemaining = 0.68
            avatar.holdRemaining = settings.survivor.aimHoldTime
            for (let i = 0; i < 12; i++) host.draw(1 / 60)
          } else {
            p.reloadRemaining = 0
            session.update(
              1 / 60,
              { mx: 0, my: 0, aim: p.aim, interact: false, fire: true },
              0,
              settings,
            )
            for (let i = 0; i < 12; i++) host.draw(1 / 60)
          }
          await device.queue.onSubmittedWorkDone()
          return {
            mode,
            aimWeight: avatar.aimWeight,
            holdRemaining: avatar.holdRemaining,
            legacyBefore: avatar.legacyUnarmedPistol,
          }
        },
      },
      ...host.features.collectGameCommands(host),
    ])
  })
}
