import type { LabControl } from "@arcade/kit/lab-panel"
import type { DeathState } from "../../shared/death/rules"
import { dayCycle } from "../../shared/day-cycle"
import { SECRETS, type SecretId } from "../../shared/secrets/catalog"
import { CELLAR_STORE, cellarLock, type SecretsState } from "../../shared/secrets/cellar"
import type { SecretHost } from "../../shared/secrets/hosts"
import { secretRun, type SecretRun } from "../../shared/secrets/select"
import { DEFAULT_SECRETS_TUNING } from "../../shared/secrets/catalog"
import type { LocalSession } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import type { CoopView } from "../coop-view"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import type { NetSession } from "../net-session"
import { DialReadout, SecretGlance } from "./glance"
import { SecretsPresenter, type SecretFrame } from "./presenter"
import { DEFAULT_SECRETS_SETTINGS, secretsLookControls, secretsSimControls, type OutbreakSecretsSettings } from "./settings"
import { SECRET_SCENES, stageSecret, type SecretScene, type SecretStageHooks } from "./stage"
import { CardTally, SecretMemory } from "./tally"

let presenter: SecretsPresenter | null = null
let glance: SecretGlance | null = null
let dials: DialReadout | null = null
let tally: CardTally | null = null
let memory: SecretMemory | null = null
let lastSession: object | null = null
let frame: SecretFrame | null = null
const nights = { count: 0, wasDark: false }
const force: SecretStageHooks["force"] = { lateChalk: false, apparition: null, ring: false }

const mem = () => (memory ??= new SecretMemory())
const settingsOf = (s: { secrets: OutbreakSecretsSettings }) => ({ ...DEFAULT_SECRETS_SETTINGS, ...s.secrets })

/** The run and its hosts as the session's sim planned them (the room's defaults in co-op). */
function runOf(session: LocalSession | NetSession): { run: SecretRun; hosts: ReadonlyMap<SecretId, SecretHost> } {
  const state = session.sim.getFeatureState<SecretsState>("secrets")
  if (state) return { run: state.run, hosts: state.hosts }
  return { run: secretRun(session.sim.town, DEFAULT_SECRETS_TUNING), hosts: new Map() }
}

function newRun(session: object): void {
  if (session === lastSession) return
  lastSession = session
  presenter?.reset()
  glance?.hide()
  mem().newRun()
  nights.count = 0
  nights.wasDark = false
  force.lateChalk = false
  force.apparition = null
  force.ring = false
}

function localOf(session: LocalSession | NetSession, coop: CoopView) {
  const slot = "local" in session ? session.local : session.slot
  return { slot, pose: coop.net ? coop.pose(slot.survivor) : slot.survivor }
}

/** Builds this frame's view for the presenter, counting nights as they begin. */
function frameOf(ctx: OutbreakClientFrameContext): SecretFrame {
  const { session, coop, settings } = ctx
  newRun(session)
  const view = session.view
  const { run, hosts } = runOf(session)
  const { slot, pose } = localOf(session, coop)
  const dark = dayCycle(view.hour).lamps > 0.35
  if (dark && !nights.wasDark) nights.count++
  nights.wasDark = dark
  const death = session.sim.getFeatureState<DeathState>("death")
  const s = settingsOf(settings)
  return {
    view,
    run,
    hosts,
    me: { x: pose.x, y: pose.y, aim: pose.aim, flashlightOn: slot.survivor.flashlightOn },
    mates: session.sim.slots.filter((o) => o !== slot && o.survivor.health > 0).map((o) => ({ x: o.survivor.x, y: o.survivor.y })),
    night: Math.max(nights.count, death?.night ?? 0),
    dt: ctx.dt,
    vanish: s.secretVanish,
    force,
  }
}

const notice = (id: SecretId) => mem().notice(id)

/**
 * Secrets and lore (AR-85), client half: draws and runs them (`presenter.ts`), holds them up close (`glance.ts`),
 * keeps the quiet tally on the last card (`tally.ts`), Lab › Secrets with a stage per secret, `secrets.stage`, harness
 * telemetry. Nothing is announced.
 */
export const outbreakSecretsFeature = registerOutbreakClientFeature({
  id: "secrets",
  order: 49,
  settingsGroup: { subsystem: "secrets", defaults: DEFAULT_SECRETS_SETTINGS },
  labControls: (host): LabControl[] => {
    const hooks: SecretStageHooks = { force, notice }
    return [
      ...secretsSimControls,
      ...secretsLookControls,
      {
        key: "secrets-forget",
        label: "Forget noticed secrets",
        group: "Secrets",
        type: "action",
        run: () => mem().forget(),
      },
      ...SECRET_SCENES.map((scene) => ({
        key: `secrets-stage-${scene}`,
        label: `Stage: ${SECRETS.find((s) => s.id === scene)?.label ?? scene.replace(/-/g, " ")}`,
        group: "Secrets",
        type: "action" as const,
        run: () => {
          if (!host.progressionHost.offline()) return
          stageSecret(host.progressionHost, host.session(), host.settings.secrets, hooks, scene)
        },
      })),
    ]
  },
  gameCommands: (host) => [
    {
      id: "secrets.stage",
      label: "Stage a Secret",
      shortLabel: "Secret",
      category: "Scene",
      undoable: false,
      args: { secret: { type: "string", description: `Secret (${SECRET_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.secret ?? args?.scene ?? "cellar") as SecretScene
        if (!SECRET_SCENES.includes(scene)) throw new Error(`Unknown secret ${scene}`)
        return stageSecret(host.progressionHost, host.session(), host.settings.secrets, { force, notice }, scene)
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a secret (`secrets.stage`). */
    stageSecret(scene: SecretScene) {
      return stageSecret(host.progressionHost, host.session(), host.settings.secrets, { force, notice }, scene)
    },
  }),
  harnessState: (host) => {
    const { run, hosts } = runOf(host.session())
    return {
      secrets: {
        picked: [...run.picked],
        code: run.code,
        hosts: Object.fromEntries([...hosts.values()].map((h) => [h.id, h.buildingId])),
        noticed: [...mem().run],
        ever: [...mem().ever],
        lock: cellarLock(host.session().view.progression.ledger.store(CELLAR_STORE)),
        glance: glance?.showing ?? null,
        tally: tally?.shown ?? false,
        shown: presenter ? { ...presenter.shown } : null,
      },
    }
  },
  frame: {
    batches: (ctx) => {
      const s = settingsOf(ctx.settings)
      frame = frameOf(ctx)
      presenter ??= new SecretsPresenter(ctx.renderer)
      if (!s.secrets && !frame.run.picked.size) return []
      const ev = presenter.step(frame)
      for (const id of ev.noticed) mem().notice(id)
      if (ev.glance) {
        glance ??= new SecretGlance()
        glance.show(ev.glance.kind, frame.run, s.secretGlance, ev.glance.variant, ev.glance.key.length * 7)
      }
      return presenter.collect(frame)
    },
    lights: (ctx, lights, count, max) => (presenter && frame ? presenter.writeLights(frame, lights, count, max) : count),
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      glance?.update(ctx.dt)
      tally ??= new CardTally()
      tally.update(mem())
      dials ??= new DialReadout()
      const prompt = ctx.session.view.prompt
      const hatch = prompt?.kind === "padlock" ? presenter?.sitesOf("hatch")[0] : undefined
      if (!hatch) return dials.update(null, [], 0)
      const lock = cellarLock(ctx.session.view.progression.ledger.store(CELLAR_STORE))
      const town = ctx.session.view.town
      const p = ctx.cam.project(hatch.x, supportHeight(town, hatch.x, hatch.y) + 0.4, hatch.y - 0.6, ctx.w, ctx.h)
      dials.update(p.ok ? p : null, lock.dials, lock.dial)
    },
  },
})
