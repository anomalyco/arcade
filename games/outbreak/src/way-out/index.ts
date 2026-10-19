import type { LabCommand } from "@arcade/kit/lab/commands"
import type { LabControl } from "@arcade/kit/lab-panel"
import { COOP_TIME_SCALE } from "../../shared/coop-config"
import type { CoopSim } from "../../shared/coop-sim"
import type { DeathState } from "../../shared/death/rules"
import { LocalSession } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { DESTINATION_WORDS } from "../../shared/way-out/plan"
import { clueSites, evacuate, planOf, revealTo, signalEvac, type WayOutState } from "../../shared/way-out/runtime"
import { wayOutOf } from "../../shared/way-out/state"
import { DEFAULT_WAY_OUT_TUNING, wayOutControls, type WayOutTuning } from "../../shared/way-out/tuning"
import type { CoopView } from "../coop-view"
import { localSlot } from "../death/spectate"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import { registerMapObjectives } from "../map/objectives"
import type { NetSession } from "../net-session"
import type { OutbreakSettings } from "../settings"
import { WayOutHud } from "./hud"
import { WayOutProps } from "./props"
import { resetWayOut, stageWayOut, teleportTo, WAY_OUT_SCENES, type WayOutScene } from "./stage"

const G = "Way Out"
let hud: WayOutHud | null = null
let props: WayOutProps | null = null
let lastSession: object | null = null

const stateOf = (sim: CoopSim) => sim.getFeatureState<WayOutState>("wayOut")
/** Offline, the Lab's tuning; in a co-op room, the defaults the room plays. */
const tuningOf = (session: LocalSession | NetSession, settings: OutbreakSettings): WayOutTuning =>
  session instanceof LocalSession ? { ...DEFAULT_WAY_OUT_TUNING, ...settings.wayOut } : DEFAULT_WAY_OUT_TUNING

function nameOf(session: LocalSession | NetSession, coop: CoopView, index: number): string {
  if ("local" in session) return index === session.local.index ? coop.localName : session.nameOf(index)
  return index === session.slot.index ? coop.localName : `Teammate ${index}`
}

function offline(session: LocalSession | NetSession): LocalSession {
  if (!(session instanceof LocalSession)) throw new Error("Offline only: a co-op room decides the way out")
  return session
}

// The map shows what the squad knows: a rough area for a direction, the place and its route once confirmed.
registerMapObjectives((sim) => {
  const state = stateOf(sim)
  const v = wayOutOf(sim.progression.ledger)
  if (!state?.tuning.wayOut || !v || v.missed || v.won || v.tier < 2) return null
  const plan = planOf(sim, state.tuning)
  const w = DESTINATION_WORDS[plan.kind]
  if (v.tier < 3) return { pins: [], routes: [], areas: [{ x: plan.rough.x, y: plan.rough.y, r: plan.rough.r, label: `${w.short}?` }], crosses: [] }
  return { pins: [{ x: plan.x, y: plan.y, label: w.short }], routes: [plan.route.map((p) => ({ ...p }))], areas: [], crosses: [] }
})

function frameReset(ctx: OutbreakClientFrameContext): void {
  if (ctx.session === lastSession) return
  lastSession = ctx.session
  hud?.reset()
}

/**
 * The Way Out (AR-64), client half: the clues and the destination drawn in the world and lit at night, the goal line,
 * clue toasts and escape card, the map's pin and route, the Lab's Way Out group (Backquote › Way Out; "Off" is endless
 * survival) with reveal, teleport, stand and win actions and staged views, `wayout.*` commands and harness telemetry.
 * The rules are `shared/way-out/`.
 */
export const outbreakWayOutFeature = registerOutbreakClientFeature({
  id: "wayOut",
  order: 45,
  settingsGroup: { subsystem: "wayOut", defaults: DEFAULT_WAY_OUT_TUNING },
  labControls: (host): LabControl[] => {
    const run = (label: string, fn: () => unknown): LabControl => ({
      key: `wayOut-${label.toLowerCase().replace(/\W+/g, "-")}`,
      label,
      group: G,
      type: "action",
      run: () => {
        if (host.progressionHost.offline()) fn()
      },
    })
    const sim = () => offline(host.session()).sim
    const tune = () => tuningOf(host.session(), host.settings)
    return [
      ...(wayOutControls as readonly LabControl[]),
      run("Reveal: rumour", () => revealTo(sim(), stateOf(sim())!, 1)),
      run("Reveal: direction", () => revealTo(sim(), stateOf(sim())!, 2)),
      run("Reveal: confirmed", () => revealTo(sim(), stateOf(sim())!, 3)),
      run("Teleport to the destination", () => teleportTo(host.discoveryHost, sim(), "destination", tune())),
      run("Teleport to the road sign", () => teleportTo(host.discoveryHost, sim(), "sign", tune())),
      run("Start the final stand", () => stageWayOut(host.discoveryHost, { sim: sim() }, "final-stand", tune())),
      run("Win now", () => stageWayOut(host.discoveryHost, { sim: sim() }, "escape-card", tune())),
      run("Forget the way out", () => resetWayOut(sim())),
      ...WAY_OUT_SCENES.map((scene) => run(`Stage: ${scene.replace(/-/g, " ")}`, () => stageWayOut(host.discoveryHost, { sim: sim() }, scene, tune()))),
    ]
  },
  gameCommands: (host): LabCommand[] => {
    const sim = () => offline(host.session()).sim
    const tune = () => tuningOf(host.session(), host.settings)
    const cmd = (id: string, label: string, run: LabCommand["run"], args?: LabCommand["args"]): LabCommand => ({
      id,
      label,
      shortLabel: label,
      category: "Scene",
      undoable: false,
      ...(args ? { args } : {}),
      enabled: () => !host.coop.net,
      run,
    })
    return [
      cmd(
        "wayout.reveal",
        "Reveal the Way Out's Clues",
        (_ctx, args) => {
          const tier = Math.max(1, Math.min(3, Math.round(Number(args?.tier ?? 3))))
          revealTo(sim(), stateOf(sim())!, tier)
          return { tier: wayOutOf(sim().progression.ledger)?.tier ?? 0 }
        },
        { tier: { type: "number", description: "1 rumour, 2 direction, 3 confirmed (default)" } },
      ),
      cmd(
        "wayout.teleport",
        "Teleport Along the Way Out",
        (_ctx, args) => {
          const to = String(args?.to ?? "destination") as Parameters<typeof teleportTo>[2]
          if (!["destination", "sign", "soldier", "police", "signal"].includes(to)) throw new Error(`Unknown place ${to}`)
          return { to, at: teleportTo(host.discoveryHost, sim(), to, tune()) }
        },
        { to: { type: "string", description: "destination (default), signal, sign, soldier or police" } },
      ),
      cmd("wayout.stand", "Start the Final Stand", () => ({ at: stageWayOut(host.discoveryHost, { sim: sim() }, "final-stand", tune()) })),
      cmd("wayout.signal", "Signal the Evacuation", () => ({ signalled: signalEvac(sim(), stateOf(sim())!, sim().slots[0]) })),
      cmd("wayout.win", "Win the Run Now", () => {
        const s = sim()
        stageWayOut(host.discoveryHost, { sim: s }, "escape-card", tune())
        return { won: evacuate(s, stateOf(s)!) }
      }),
      cmd(
        "wayout.stage",
        "Stage a Way Out View",
        (_ctx, args) => {
          const scene = String(args?.scene ?? "destination") as WayOutScene
          if (!WAY_OUT_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
          return { scene, at: stageWayOut(host.discoveryHost, { sim: sim() }, scene, tune()) }
        },
        { scene: { type: "string", description: `Scene (${WAY_OUT_SCENES.join(", ")})` } },
      ),
    ]
  },
  harnessMethods: (host) => ({
    /** Stages a Way Out view (`wayout.stage`). */
    stageWayOut(scene: WayOutScene) {
      return stageWayOut(host.discoveryHost, { sim: offline(host.session()).sim }, scene, tuningOf(host.session(), host.settings))
    },
  }),
  harnessState: (host) => {
    const session = host.session()
    const t = tuningOf(session, host.settings)
    const plan = planOf(session.sim, t)
    const v = wayOutOf(session.sim.progression.ledger)
    return {
      wayOut: {
        on: Boolean(t.wayOut),
        plan: { kind: plan.kind, x: plan.x, y: plan.y, distance: plan.distance, arrival: plan.arrival, bearing: plan.bearing },
        tier: v?.tier ?? 0,
        clues: v ? [...v.clues] : [],
        night: v?.night ?? 0,
        deadline: v?.deadline ?? t.deadlineNight,
        signalled: Boolean(v?.signalled),
        missed: Boolean(v?.missed),
        won: Boolean(v?.won),
        escaped: v?.escaped ?? [],
        hud: hud ? { ...hud.shown } : null,
        props: props ? { ...props.shown, clues: [...props.shown.clues] } : null,
      },
    }
  },
  frame: {
    batches: (ctx) => {
      frameReset(ctx)
      const sim = ctx.session.sim
      const state = stateOf(sim)
      const t = tuningOf(ctx.session, ctx.settings)
      if (!state || !t.wayOut) return []
      props ??= new WayOutProps(ctx.renderer)
      const plan = planOf(sim, t)
      const town = ctx.session.view.town
      return props.collect(ctx.session.view, plan, wayOutOf(sim.progression.ledger), clueSites(sim, state, plan), (x, z) => supportHeight(town, x, z))
    },
    lights: (ctx, lights, count, max) => {
      const t = tuningOf(ctx.session, ctx.settings)
      if (!props || !t.wayOut) return count
      const sim = ctx.session.sim
      const town = ctx.session.view.town
      return props.writeLights(ctx.session.view, planOf(sim, t), wayOutOf(sim.progression.ledger), (x, z) => supportHeight(town, x, z), lights, count, max)
    },
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      frameReset(ctx)
      const { session, coop, settings } = ctx
      const t = tuningOf(session, settings)
      hud ??= new WayOutHud()
      const net = coop.net
      hud.actions = {
        canFresh: !net,
        restart: (fresh) => {
          if (net) return net.restart()
          if (fresh) settings.world.houseSeed = (Math.random() * 0x7fffffff) >>> 0
          coop.onSessionChange?.()
        },
        lobby: () => {
          if (net) coop.leaveRoom()
          else if (coop.lobby) coop.lobby.openStart()
          else coop.onSessionChange?.()
        },
      }
      const local = localSlot(session)
      const p = coop.net ? coop.pose(local.survivor) : local.survivor
      hud.update({
        view: wayOutOf(session.sim.progression.ledger),
        plan: planOf(session.sim, t),
        tuning: t,
        death: session.sim.getFeatureState<DeathState>("death"),
        slots: session.sim.slots,
        localIndex: local.index,
        me: { x: p.x, y: p.y },
        hour: session.view.hour,
        time: session.view.time,
        timeScale: net ? COOP_TIME_SCALE : settings.dayCycle.timeScale,
        name: (index) => nameOf(session, coop, index),
      })
    },
  },
})
