import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import { SPAWN_POINTS } from "../../shared/spawn-points"
import { applyDeathSnapshot } from "../../shared/death/net"
import { DEFAULT_DEATH_TUNING, deathControls, type DeathState, type DeathTuning, type LifeState } from "../../shared/death/rules"
import { forceLife } from "../../shared/death/runtime"
import { LocalSession } from "../../shared/session"
import type { CoopView } from "../coop-view"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import type { NetSession } from "../net-session"
import type { OutbreakSettings } from "../settings"
import { FallenBodies } from "./bodies"
import { DeathHud } from "./hud"
import { lifeIn, localSlot, spectateTarget } from "./spectate"

let hud: DeathHud | null = null
let bodies: FallenBodies | null = null
let watching: number | null = null
let lastSession: object | null = null

const deathOf = (session: LocalSession | NetSession) => session.sim.getFeatureState<DeathState>("death")

function nameOf(session: LocalSession | NetSession, coop: CoopView, index: number): string {
  if ("local" in session) return index === session.local.index ? coop.localName : session.nameOf(index)
  return index === session.slot.index ? coop.localName : `Teammate ${index}`
}

/** Lab and command actions on the offline session: the local survivor, or the first teammate the Lab added. */
function act(session: LocalSession | NetSession, settings: OutbreakSettings, who: "me" | "mate", life: LifeState): string {
  if (!(session instanceof LocalSession)) throw new Error("Offline only: a co-op room decides who lives")
  const tuning: DeathTuning = { ...DEFAULT_DEATH_TUNING, ...settings.death }
  const slot = who === "me" ? session.slot : session.sim.slots.find((s) => s !== session.slot)
  if (!slot) throw new Error("No teammate: add one first")
  forceLife(session.sim, slot, life, tuning)
  return `${slot.id}: ${lifeIn(deathOf(session), slot.index)}`
}

/** A teammate standing beside the local survivor (offline), drawn and hurt like a co-op one but given no commands. */
function addTeammate(session: LocalSession | NetSession): string {
  if (!(session instanceof LocalSession)) throw new Error("Offline only")
  const sim = session.sim
  if (sim.slots.length >= SPAWN_POINTS.length) throw new Error("The squad is full")
  const index = Math.max(...sim.slots.map((s) => s.index)) + 1
  const slot = sim.addSurvivor(`mate-${index}`, index)
  const p = session.slot.survivor
  Object.assign(slot.survivor, { x: p.x + Math.cos(p.aim + 1.2) * 1.1, y: p.y + Math.sin(p.aim + 1.2) * 1.1, aim: p.aim })
  sim.rebuildSolids()
  return slot.id
}

function frameState(ctx: OutbreakClientFrameContext): DeathState | undefined {
  if (ctx.session !== lastSession) {
    lastSession = ctx.session
    watching = null
    bodies?.reset()
  }
  return deathOf(ctx.session)
}

/**
 * Death (AR-61), client half: the viewpoint while watching a teammate, bodies on the floor, the down screen, revive
 * markers, the run-over card, the Lab's Death group (Backquote › Death: "Today" turns it off) with Down/Kill/Revive
 * me and teammate actions, `death.*` commands and harness telemetry. Sounds are `audio/death.ts`; the rules are
 * `shared/death/`.
 */
export const outbreakDeathFeature = registerOutbreakClientFeature({
  id: "death",
  order: 40,
  settingsGroup: { subsystem: "death", defaults: DEFAULT_DEATH_TUNING },
  labControls: (host): LabControl[] => {
    const run = (label: string, fn: () => unknown): LabControl => ({
      key: `death-${label.toLowerCase().replace(/\W+/g, "-")}`,
      label,
      group: "Death",
      type: "action",
      run: () => {
        if (host.progressionHost.offline()) fn()
      },
    })
    return [
      ...(deathControls as readonly LabControl[]),
      run("Down me", () => act(host.session(), host.settings, "me", "down")),
      run("Kill me", () => act(host.session(), host.settings, "me", "dead")),
      run("Revive me", () => act(host.session(), host.settings, "me", "alive")),
      run("Add a teammate", () => addTeammate(host.session())),
      run("Down teammate", () => act(host.session(), host.settings, "mate", "down")),
      run("Kill teammate", () => act(host.session(), host.settings, "mate", "dead")),
    ]
  },
  gameCommands: (host): LabCommand[] => {
    const life = (id: string, label: string, to: LifeState): LabCommand => ({
      id,
      label,
      shortLabel: label,
      category: "Scene",
      undoable: false,
      args: { who: { type: "string", description: "me (default) or mate" } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => ({ result: act(host.session(), host.settings, args?.who === "mate" ? "mate" : "me", to) }),
    })
    return [
      life("death.down", "Down a Survivor", "down"),
      life("death.kill", "Kill a Survivor", "dead"),
      life("death.revive", "Revive a Survivor", "alive"),
      {
        id: "death.mate",
        label: "Add a Teammate",
        shortLabel: "Teammate",
        category: "Scene",
        undoable: false,
        enabled: () => !host.coop.net,
        run: () => ({ id: addTeammate(host.session()) }),
      },
    ]
  },
  harnessState: (host) => {
    const session = host.session()
    const state = deathOf(session)
    return {
      death: {
        local: lifeIn(state, localSlot(session).index),
        records: state ? Object.values(state.records).map((r) => ({ index: r.index, state: r.state, bleed: Number(r.bleed.toFixed(2)), revive: Number(r.revive.toFixed(2)), kills: r.kills })) : [],
        bodies: state?.bodies.length ?? 0,
        runOver: Boolean(state?.runOver),
        watching,
        hud: hud ? { ...hud.shown } : null,
      },
    }
  },
  netSession: {
    onApplyWorld: (net, shared) => {
      const state = deathOf(net)
      if (state) applyDeathSnapshot(state, shared.death, shared.time)
    },
  },
  frame: {
    viewpoint: (session, coop) => {
      const state = deathOf(session)
      const local = localSlot(session)
      if (lifeIn(state, local.index) !== "dead" || state?.runOver) {
        watching = null
        return null
      }
      watching = state?.records[local.index]?.watching ?? spectateTarget(state, session.sim.slots, local.index, watching)
      const target = watching === null ? undefined : session.sim.slots.find((s) => s.index === watching)
      if (!target) return null
      const p = coop.net && target === local ? coop.pose(target.survivor) : target.survivor
      return { x: p.x, y: p.y, aim: p.aim, health: p.health, maxHealth: p.maxHealth }
    },
    hidesSurvivor: (sim, slot) => {
      const state = sim.getFeatureState<DeathState>("death")
      return Boolean(state?.tuning.deathMode) && lifeIn(state, slot.index) !== "alive"
    },
    batches: (ctx) => {
      const state = frameState(ctx)
      if (!state) return []
      bodies ??= new FallenBodies(ctx.renderer)
      return bodies.collect(ctx.session, ctx.coop, ctx.vision, ctx.settings.blood, ctx.session.view.time)
    },
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      const state = frameState(ctx)
      hud ??= new DeathHud()
      const { coop, settings } = ctx
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
      hud.update(ctx, state, watching, (index) => nameOf(ctx.session, coop, index))
    },
  },
})
