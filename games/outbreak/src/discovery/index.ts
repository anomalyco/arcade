import type { OutbreakAISubsystem } from "../../shared/ai"
import { PIN_FOUND, type PageSite } from "../../shared/discovery/found"
import { ideaToken, matStoreId, pinStoreId, triedToken } from "../../shared/discovery/tinker"
import { carStoreId, ds, hideStoreId, tripStoreId } from "../../shared/discovery/verbs"
import { vignetteDropId, vignetteScene, type VignetteKind, type VignetteScene } from "../../shared/discovery/vignettes"
import type { SessionView } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { ProgressionLabHost } from "../progression/index"
import type { ClosetView } from "./closet"
import type { PageGlance } from "./glance"
import type { DiscoveryProps } from "./props"
import { DEFAULT_DISCOVERY_SETTINGS, discoveryControls } from "./settings"

export { DEFAULT_DISCOVERY_SETTINGS, discoveryControls, type DiscoverySettings } from "./settings"
export { DiscoveryProps } from "./props"
export { BenchLean } from "./lean"
export { PageGlance } from "./glance"
export { ClosetView } from "./closet"

/** What the Discovery Lab scenes need: the progression host (view, pose, clock, inventory HUD) and the world props. */
export type DiscoveryHost = ProgressionLabHost & { props: DiscoveryProps; glance: PageGlance; closet?: ClosetView }

/** Staged scenes for the `outbreak-discovery` Lab station and proofs. */
export const DISCOVERY_SCENES = [
  "low-flashlight",
  "weakened-barricade",
  "open-containers",
  "drops",
  "bench-tinker",
  "corkboard",
  "dark-bench",
  "page",
  "page-read",
  "found-pages",
  "held-out",
  "crouch",
  "closet",
  "peephole",
  "tripwire",
  "bottle",
  "car-alarm",
  "repair",
  "broken-in",
  "hid",
  "lured",
  "spent-alarm",
] as const
export type DiscoveryScene = (typeof DISCOVERY_SCENES)[number]

function stock(view: SessionView, id: string, items: readonly (readonly [string, number])[]): void {
  const ledger = view.progression.ledger
  const st = ledger.store(id)
  if (!st) return
  st.slots.fill(null)
  items.forEach(([item, count], i) => (st.slots[i] = { item, count }))
  st.revealed = true
  st.rev = ++ledger.rev
}

/** Boards up a portal with `planks` boards and sets the barricade's hit points to `wear` of nominal. */
export function boardUp(view: SessionView, ai: OutbreakAISubsystem, id: string, planks: number, wear: number): void {
  const st = ai.portalStates.get(id)
  if (!st) return
  st.barricadePlanks = 0
  st.barricadeHp = 0
  for (let i = 0; i < planks; i++) ai.addBarricadePlank(id, 100)
  st.barricadeHp = planks * 100 * wear
  ai.rebuildTopology(view.town)
}

/** Gives the survivor `items` and stands them at the Ash workbench, facing it. */
function atBench(host: DiscoveryHost, hour: number, items: readonly (readonly [string, number])[]): string {
  const view = host.view()
  const ledger = view.progression.ledger
  const bench = view.progression.benches.find((b) => b.id === "bench:ash")!
  host.setHour(hour)
  for (const [item, count] of items) ledger.apply({ kind: "grant", actor: view.actorId, item, count })
  host.pose(bench.bench.x - 0.85, bench.bench.y + 0.25, 0)
  return bench.id
}

/** Pins `recipe` to the corkboard as if the survivor in `seat` had made it, or found it as a page. Lab staging only. */
function pin(view: SessionView, recipe: string, seat: number, found: keyof typeof PIN_FOUND | null = null): void {
  const ledger = view.progression.ledger
  const bench = view.progression.benches.find((b) => b.id === "bench:ash")!
  if (!view.progression.learned(recipe)) ledger.apply({ kind: "grant", actor: view.actorId, item: `learned:${recipe}`, store: "team/known" })
  if (ledger.store(pinStoreId(recipe))) ledger.deleteStore(pinStoreId(recipe))
  const initial: Record<string, number> = found ? { seat: seat + 1, found: PIN_FOUND[found] } : { seat: seat + 1 }
  ledger.createStore({ id: pinStoreId(recipe), mode: "counters", scope: "shared", owner: `seat${seat}`, at: { x: bench.bench.x, y: bench.bench.y }, initial })
}

/** Puts a building's page back where it lay, unread. */
function unread(view: SessionView, building: string): PageSite {
  const site = view.progression.pages.find((p) => p.buildingId === building)!
  const st = view.progression.ledger.store(site.id)
  if (st) {
    st.counts.page = 1
    st.rev = ++view.progression.ledger.rev
  }
  return site
}

/** Puts `item` in the survivor's hand, granting `count` first. */
function inHand(view: SessionView, item: string, count = 1): void {
  const ledger = view.progression.ledger
  if (ledger.count(view.actorId, item) < count) ledger.apply({ kind: "grant", actor: view.actorId, item, count: count - ledger.count(view.actorId, item) })
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === item) ?? -1
  if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
}

/** Sets a door open or shut, as staging does before posing. */
function setDoor(view: SessionView, id: string, open: boolean): void {
  const door = view.town.doors.find((d) => d.id === id)
  if (door) door.open = open
}

/** The alarm car nearest the crossroads, out on the street, and a spot `back` metres west of it. */
function alarmCar(view: SessionView, back: number) {
  const near = (c: { x: number; y: number }) => Math.hypot(c.x - 44, c.y - 44)
  const car = view.progression.cars.filter((c) => c.alarm).sort((a, b) => near(a) - near(b))[0]!
  return { car, x: car.rect[0] - back, y: car.y }
}

/** Seeds a vignette afresh (its battery or bottle back, its car's alarm spent) and returns where it lies. */
function vignette(view: SessionView, kind: VignetteKind, target: string): VignetteScene {
  const ledger = view.progression.ledger
  const scene = vignetteScene(view.town, kind, target)
  if (!scene) throw new Error(`No room for a ${kind} vignette at ${target}`)
  for (const id of [vignetteDropId(kind, target), ...(scene.car ? [carStoreId(scene.car)] : [])]) if (ledger.store(id)) ledger.deleteStore(id)
  view.progression.seedVignette(kind, target)
  return scene
}

export function stageDiscovery(host: DiscoveryHost, scene: DiscoveryScene, ai: OutbreakAISubsystem): void {
  const view = host.view()
  host.hud.close()
  host.glance.hide()
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const ledger = view.progression.ledger
  // Out of any closet a previous scene left the survivor in.
  const hidden = view.progression.hiddenIn(view.actorId)
  if (hidden) ledger.deleteStore(hideStoreId(hidden.id))
  switch (scene) {
    case "crouch": {
      // Outside the pharmacy in the afternoon with the door open and cans strung across the step: hold Ctrl to step over them.
      host.setHour(16)
      setDoor(view, "pharmacy-front", true)
      const trip = ledger.store(tripStoreId("pharmacy-front"))
      if (trip) {
        trip.counts.armed = 1
        trip.counts.down = 0
        trip.rev = ++ledger.rev
      }
      host.pose(58.7, 70.2, -Math.PI / 2)
      return
    }
    case "tripwire": {
      // On the pharmacy's step, facing the cans someone strung across its front door: E works them loose quietly.
      host.setHour(14)
      view.player.flashlightOn = false
      setDoor(view, "pharmacy-front", false)
      const trip = ledger.store(tripStoreId("pharmacy-front"))
      if (trip) {
        trip.counts.armed = 1
        trip.counts.down = 0
        trip.rev = ++ledger.rev
      }
      host.pose(58.2, 69.5, -Math.PI / 2 + 0.4)
      return
    }
    case "closet": {
      // Hidden in Ash's bedroom closet at dusk, seeing the room through the louvres. E steps back out.
      host.setHour(18)
      const closet = view.progression.closets.find((c) => c.id.startsWith("closet:") && c.x > ash.rect[0] && c.x < ash.rect[2] && c.y < ash.rect[3])!
      host.pose(closet.out.x, closet.out.y, -Math.PI / 2)
      ledger.createStore({ id: hideStoreId(closet.id), mode: "counters", scope: "shared", owner: view.actorId, at: { x: closet.x, y: closet.y }, initial: { in: 1 } })
      Object.assign(view.player, { x: closet.x, y: closet.y, flashlightOn: false })
      return
    }
    case "peephole": {
      // Looking out through Ash's front door at the porch, the door still shut. E stops.
      host.setHour(15)
      view.player.flashlightOn = false
      setDoor(view, "ash-front", false)
      const door = view.town.doors.find((d) => d.id === "ash-front")!
      host.pose(27.7, door.rect[1] - 0.7, Math.PI / 2)
      Object.assign(view.player, { peekingWindowId: door.id, peekOriginX: 27.7, peekOriginY: door.rect[1] - 0.7, peekOriginDist: 0.7 })
      return
    }
    case "bottle": {
      // Dusk on the street with bottles in hand and a car down the road: throw one beside it.
      host.setHour(18.5)
      inHand(view, "bottle", 3)
      const { car, x, y } = alarmCar(view, 7)
      host.pose(x, y, Math.atan2(car.y - y, car.x - x))
      return
    }
    case "car-alarm": {
      // A car with its window in, the alarm wailing and its indicators flashing, glass on the road beside it.
      host.setHour(21)
      const { car } = alarmCar(view, 0)
      const id = carStoreId(car.key)
      if (ledger.store(id)) ledger.deleteStore(id)
      ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: car.x, y: car.y }, initial: { smashed: 1, alarm: 1, start: ds(view.time), until: ds(view.time + 3600) } })
      ledger.createStore({ id: `glass:lab-${Math.round(view.time * 10)}`, mode: "counters", scope: "shared", at: { x: car.x + 1.2, y: car.rect[3] + 0.6 }, initial: { t: ds(view.time) } })
      const x = car.x - 1.6
      const y = car.rect[3] + 3
      host.pose(x, y, Math.atan2(car.y - y, car.x - x))
      return
    }
    case "repair": {
      // Ash's south-west window boarded twice and worn to under half: with the crowbar in hand, B re-nails it.
      host.setHour(14)
      view.player.flashlightOn = false
      const win = view.town.windows.find((w) => w.id === "ash-south-west")!
      boardUp(view, ai, win.id, 2, 0.45)
      inHand(view, "crowbar")
      host.pose((win.rect[0] + win.rect[2]) / 2 + 0.9, win.rect[1] - 1.9, Math.PI / 2 + 0.4)
      return
    }
    case "broken-in": {
      // Someone's house broken into through its side window: glass on the floor, a survivor down with a snapped bat.
      host.setHour(15)
      view.player.flashlightOn = true
      const scene = vignette(view, "broken-in", "ash")
      host.pose(scene.x - 2.4, scene.y + 1.6, Math.atan2(-1.6, 2.4))
      return
    }
    case "hid": {
      // Someone held out in this bedroom closet: the dead in front of it, the casings at its door, a battery left.
      host.setHour(15)
      view.player.flashlightOn = true
      const scene = vignette(view, "hid", "elm")
      host.pose(scene.x + 1.8, scene.y + 1.6, Math.atan2(-1.6, -1.8))
      return
    }
    case "lured": {
      // Bottles broken in a line away from the pharmacy door, and the dead bunched at the last one.
      host.setHour(16)
      view.player.flashlightOn = false
      const scene = vignette(view, "lured", "pharmacy")
      host.pose(scene.x + 3, scene.y + 1.5, Math.atan2(-1.5, -3))
      return
    }
    case "spent-alarm": {
      // A car that wailed until its battery died, the dead it called piled round it.
      host.setHour(15)
      view.player.flashlightOn = false
      const { car } = alarmCar(view, 0)
      const scene = vignette(view, "alarm-car", car.key)
      host.pose(scene.x - 2.5, car.rect[3] + 2.6, Math.atan2(car.y - car.rect[3] - 2.6, 2.5))
      return
    }
    case "bench-tinker": {
      // Daylight, a handful of materials, and plank + scrap already laid on the mat: hold E to try them.
      const bench = atBench(host, 15, [["plank", 1], ["scrap", 3], ["chem", 2], ["battery", 1]])
      view.player.flashlightOn = false
      ledger.apply({ kind: "deposit", actor: view.actorId, to: matStoreId(bench), items: { plank: 1, scrap: 1 } })
      return
    }
    case "corkboard": {
      // A few days in: three sketches by three players, an idea waiting on the toolbox, two crossed-out tries, and
      // a fresh spiked board on the mat.
      const bench = atBench(host, 15, [["scrap", 2], ["chem", 1]])
      view.player.flashlightOn = false
      pin(view, "bandage", 0)
      pin(view, "spiked-board", 1)
      pin(view, "lure", 2)
      for (const token of [ideaToken("battery"), triedToken("plank+plank"), triedToken("plank+chem")]) {
        if (!ledger.count("team/known", token)) ledger.apply({ kind: "grant", actor: view.actorId, item: token, store: "team/known" })
      }
      if (!view.progression.mat(bench).length) ledger.apply({ kind: "grant", actor: view.actorId, item: "spiked-board", store: matStoreId(bench) })
      return
    }
    case "dark-bench": {
      // Night with the flashlight off: too dark to try the pair on the mat until a beam is on it.
      const bench = atBench(host, 23, [["chem", 2]])
      view.player.flashlightOn = false
      ledger.apply({ kind: "deposit", actor: view.actorId, to: matStoreId(bench), items: { chem: 2 } })
      return
    }
    case "page": {
      // A flyer left on a hardware-store shelf, unread: walk up and press E.
      host.setHour(14)
      view.player.flashlightOn = false
      const site = unread(view, "hardware")
      host.pose(site.x - 0.35, site.y + 1.05, -Math.PI / 2 + 0.3)
      return
    }
    case "page-read": {
      // The pharmacy's chart just read: its diagram held up to the camera.
      host.setHour(14)
      view.player.flashlightOn = false
      const site = unread(view, "pharmacy")
      host.pose(site.x - 0.35, site.y + 1.05, -Math.PI / 2 + 0.3)
      host.glance.show(site, 3600)
      return
    }
    case "found-pages": {
      // Days in: a sketch made at this bench beside a flyer, a chart and a photo found in town, each on its pin.
      atBench(host, 15, [])
      view.player.flashlightOn = false
      pin(view, "spiked-board", 0)
      pin(view, "reinforced", 1, "flyer")
      pin(view, "bandage", 2, "chart")
      pin(view, "lure", 3, "photo")
      return
    }
    case "held-out": {
      // A held-out window, as streamed warehouses have one: here the hardware store's, boarded and strapped from inside.
      host.setHour(14)
      view.player.flashlightOn = false
      const win = view.town.windows.find((w) => w.id === "hardware-south-east")!
      boardUp(view, ai, win.id, 2, 1.8)
      const cx = (win.rect[0] + win.rect[2]) / 2
      const cy = (win.rect[1] + win.rect[3]) / 2
      host.pose(cx - 0.4, cy + 1.6, Math.atan2(-1.6, 0.4))
      return
    }
    case "low-flashlight": {
      host.setHour(23)
      const p = view.player
      p.flashlightOn = true
      p.battery = 0.12
      p.batteryDepleted = false
      host.pose(ash.rect[0] + 6.2, ash.rect[3] + 3.4, Math.PI / 2 - 0.35)
      return
    }
    case "weakened-barricade": {
      host.setHour(13)
      view.player.flashlightOn = false
      const win = view.town.windows.find((w) => w.id === "ash-south-west")!
      const door = view.town.doors.find((d) => d.id === "ash-front")!
      boardUp(view, ai, win.id, 3, 0.5)
      boardUp(view, ai, door.id, 2, 1)
      // From inside, where the defenders watch the boards give.
      host.pose((win.rect[0] + win.rect[2]) / 2 + 0.9, win.rect[1] - 2.6, Math.PI / 2 + 0.35)
      return
    }
    case "open-containers": {
      host.setHour(15)
      const mine = view.containers.filter((c) => c.buildingId === "ash")
      const fill: Record<string, [string, number][]> = {
        dresser: [["ammo", 6], ["medkit", 1], ["scrap", 2]],
        nightstand: [["battery", 1], ["noisemaker", 1]],
        counter: [["chem", 2], ["knife", 1]],
        fridge: [["chem", 1]],
        shelf: [["plank", 2], ["hammer", 1]],
      }
      for (const c of mine) stock(view, c.id, fill[c.kind] ?? [])
      const dresser = mine.find((c) => c.kind === "dresser") ?? mine[0]!
      // Beside it rather than in front, so the survivor does not hide the open drawer from the camera.
      host.pose(dresser.x + 0.85, dresser.y + 0.95, Math.atan2(-0.95, -1.2))
      return
    }
    case "drops": {
      host.setHour(19)
      host.pose(44, 44, 0)
      const ledger = view.progression.ledger
      for (const [item, count] of [["medkit", 1], ["ammo", 12], ["plank", 2], ["crowbar", 1]] as const)
        ledger.apply({ kind: "grant", actor: view.actorId, item, count })
      ledger.apply({ kind: "drop", actor: view.actorId, at: { x: 45.2, y: 44.1 }, items: { medkit: 1, ammo: 6 } })
      ledger.apply({ kind: "drop", actor: view.actorId, at: { x: 44.4, y: 45.3 }, items: { plank: 2 } })
    }
  }
}

export const outbreakDiscoveryFeature = registerOutbreakClientFeature({
  id: "discovery",
  order: 24,
  settingsGroup: { subsystem: "discovery", defaults: DEFAULT_DISCOVERY_SETTINGS },
  labControls: (host) => [
    ...discoveryControls,
    {
      key: "discoveryForgetPrompts",
      label: "Forget learned prompts",
      group: "Discovery",
      type: "action",
      run: () => host.progressionHost.hud.resetFamiliar(),
    },
    ...DISCOVERY_SCENES.map((scene) => ({
      key: `discoveryStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Discovery",
      type: "action" as const,
      run: () => stageDiscovery(host.discoveryHost, scene, host.session().ai),
    })),
  ],
  gameCommands: (host) => [
    {
      id: "discovery.stage",
      label: "Stage a Discovery Scene",
      shortLabel: "Discovery Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${DISCOVERY_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "weakened-barricade") as DiscoveryScene
        if (!DISCOVERY_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        stageDiscovery(host.discoveryHost, scene, host.session().ai)
        return { scene }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a Discovery scene (`discovery.stage`). */
    stageDiscovery(scene: DiscoveryScene) {
      stageDiscovery(host.discoveryHost, scene, host.session().ai)
    },
    /** Boards up a portal at a given wear (0..1 of nominal hit points). */
    boardUp(id: string, planks: number, wear: number) {
      boardUp(host.session().view, host.session().ai, id, planks, wear)
    },
  }),
  harnessState: (host) => ({
    discovery: {
      shown: Object.fromEntries(host.discoveryHost.props.shown),
      barricades: Object.fromEntries(host.discoveryHost.props.barricades.looks),
      bench: Object.fromEntries(host.discoveryHost.props.bench.shown),
      reinforced: [...host.discoveryHost.props.barricades.reinforced],
      glance: host.discoveryHost.glance.showing,
      pages: host.session().view.progression.pages.map((p) => ({ ...p, unread: host.session().view.progression.ledger.count(p.id, "page") })),
      practice: { ...host.session().view.progression.mastery },
      verbs: { ...host.discoveryHost.props.verbs.shown, hidden: host.discoveryHost.closet?.hidden ?? false, crouching: Boolean(host.session().view.player.crouching) },
      vignettes: { ...host.discoveryHost.props.vignettes.shown, scenes: [...host.discoveryHost.props.vignettes.shown.scenes] },
    },
  }),
})
