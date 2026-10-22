import type { LabControl } from "@arcade/kit/lab-panel"
import { leftTheHouse } from "../../shared/onboarding/training"
import type { LocalSession } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import { inventoryPresenter } from "../inventory/hooks"
import { BEATS, TrainingGuide, type BeatId } from "./beats"
import { Fade, HintView, SkipChip } from "./hints"
import { quietHint, startPractice, stepPractice, type Practice } from "./practice"
import { boardsUp, carryBoards, isTrainingSession, stageTrainingSession } from "./session"
import { BEAT_SPOTS, stageBeat } from "./stage"
import {
  forgetTraining,
  markTrainingDone,
  PRACTICE_OFF,
  requestTraining,
  takeTrainingRequest,
  trainingControls,
  trainingDone,
  type TrainingSettings,
} from "./state"

/**
 * The lobby's practice space (AR-89; Kit: "Maybe a tutorial in the loadout. While loading out you can train."): while
 * the lobby is open, solo or in a co-op room, you stand in Ash at dawn in your own local session with the kit you
 * picked, the same wordless hints over you and a chained zombie that keeps coming back. Changing the kit swaps it live;
 * Play Solo, or the room starting, drops you into the run. Nothing reaches the room: `coop.net` reads null meanwhile.
 *
 * The training room (one setting away, Off by default since the practice space replaced it): a solo start wakes
 * you in Ash at dawn, before the outbreak reaches the street. One wordless hint at a time (key caps and glyphs) walks
 * you through moving, the flashlight, searching and taking, the recipe board, a door open and shut, crouching over
 * glass, boarding the window the dead came through, sprinting, the front door and a chained zombie; stepping out to
 * the street cuts to the run at dusk with your boards still up. Hold Esc to skip. Solo only: co-op rooms never make
 * an offline session, so they never see it. Lab: Backquote › Onboarding; station `outbreak-onboarding`.
 */
const SKIP_HOLD = 0.8

type Training = { session: LocalSession; guide: TrainingGuide; skipHeld: number; finishing: boolean; age: number }

let training: Training | null = null
let practice: Practice | null = null
let restart: (() => void) | null = null
let carry: Record<string, number> | null = null
let hints: HintView | null = null
let skip: SkipChip | null = null
let fade: Fade | null = null
let escDown = false

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && training) escDown = true
  })
  window.addEventListener("keyup", (e) => {
    if (e.code === "Escape") escDown = false
  })
  window.addEventListener("blur", () => (escDown = false))
}

function clockOf(hour: number): string {
  const h = Math.floor(hour) % 24
  const m = Math.round((hour - Math.floor(hour)) * 60)
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

/** Leaves the training room for the run: marked done, boards carried, a cut to black and the run's hour. */
function finish(t: Training, runHour: number): void {
  if (t.finishing) return
  t.finishing = true
  markTrainingDone()
  carry = boardsUp(t.session)
  const go = () => {
    training = null
    restart?.()
  }
  if (typeof document === "undefined" || !fade) go()
  else fade.play(clockOf(runHour), go)
}

/** Starts the training room now (Lab, station, commands): the next session is it. */
function startTraining(): boolean {
  if (!restart) return false
  requestTraining(true)
  restart()
  return true
}

function active(session: unknown): Training | null {
  return training && training.session === session ? training : null
}

function practising(session: unknown): Practice | null {
  return practice && practice.session === session ? practice : null
}

/** The guided session the Lab, commands and harness stage beats in: the practice space, else the training room. */
function guided(session: unknown): Training | Practice | null {
  return practising(session) ?? active(session)
}

export const outbreakOnboardingFeature = registerOutbreakClientFeature({
  id: "onboarding",
  order: 62,
  session: (ctx) => {
    restart = ctx.restart
    const settings = ctx.settings.hud as unknown as TrainingSettings
    const lobby = ctx.coop.lobby
    const practise = (lobby?.mode === "start" || lobby?.mode === "coop") && settings.lobbyPractice !== PRACTICE_OFF
    if (lobby) lobby.practice = practise
    if (practise && lobby) {
      training = null
      // Kept across the lobby's own restarts (solo to hosting a room), so you stay where you were.
      practice ??= startPractice(ctx.make(ctx.seed), lobby.loadout)
      return practice.session
    }
    practice = null
    // The room's run, or automation that never opened the lobby.
    if (ctx.coop.net) return null
    const mode = settings.trainingRoom
    if (takeTrainingRequest(mode)) {
      carry = null
      const session = stageTrainingSession(ctx.make(ctx.seed))
      training = { session, guide: new TrainingGuide(), skipHeld: 0, finishing: false, age: 0 }
      return session
    }
    training = null
    if (carry) {
      const session = ctx.make(ctx.seed)
      carryBoards(session, carry)
      carry = null
      return session
    }
    return null
  },
  labControls: (host) => [
    ...(trainingControls as readonly LabControl[]),
    {
      key: "trainingStart",
      label: "Start the training room",
      group: "Onboarding",
      type: "action" as const,
      run: () => {
        if (host.progressionHost.offline()) startTraining()
      },
    },
    {
      key: "trainingForget",
      label: "Forget it was done (next solo start trains)",
      group: "Onboarding",
      type: "action" as const,
      run: () => forgetTraining(),
    },
  ],
  onSettingChanged: (_host, rawKey) => {
    if (!rawKey.endsWith("lobbyPractice")) return false
    restart?.()
    return true
  },
  frame: {
    overlay: (ctx) => {
      const t = active(ctx.session)
      if (typeof document !== "undefined") {
        hints ??= new HintView()
        skip ??= new SkipChip()
        fade ??= new Fade()
      }
      const lobby = ctx.coop.lobby
      const pr = practising(ctx.session)
      if (pr) {
        const bag = inventoryPresenter()
        lobby?.tuck(Boolean(bag?.owns() && bag.open))
        hints?.update(ctx.session.view, ctx.cam, ctx.w, ctx.h, stepPractice(pr, lobby?.loadout, ctx.dt, !bag?.owns() || bag.open))
        skip?.update(false, 0)
        return
      }
      lobby?.tuck(false)
      if (!t) {
        hints?.update(ctx.session.view, ctx.cam, ctx.w, ctx.h, null)
        skip?.update(false, 0)
        return
      }
      const view = ctx.session.view
      t.age += ctx.dt
      // The case (AR-94) is taught by opening it; Today's dock sheet has nothing new to teach.
      const bag = inventoryPresenter()
      if (!bag?.owns() || bag.open) t.guide.noteCase()
      const beat = t.guide.step(t.session.sim, view.actorId, ctx.dt)
      const hint = t.age > 1.2 && !t.finishing ? quietHint(t.guide.hint(t.session.sim, view.actorId, beat), view.prompt) : null
      hints?.update(view, ctx.cam, ctx.w, ctx.h, hint)
      t.skipHeld = escDown ? t.skipHeld + ctx.dt : 0
      skip?.update(!t.finishing, Math.min(1, t.skipHeld / SKIP_HOLD))
      if (t.skipHeld >= SKIP_HOLD || leftTheHouse(view.player)) finish(t, ctx.settings.ai.startHour ?? 17.5)
    },
  },
  gameCommands: (host) => [
    {
      id: "onboarding.start",
      label: "Start the Training Room",
      shortLabel: "Training Room",
      category: "Scene",
      undoable: false,
      enabled: () => !host.coop.net,
      run: () => ({ started: startTraining() }),
    },
    {
      id: "onboarding.beat",
      label: "Jump to a Training Room Beat (in the lobby's practice space when it is open)",
      shortLabel: "Training Beat",
      category: "Scene",
      undoable: false,
      args: { beat: { type: "string", description: `Beat (${BEATS.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const beat = String(args?.beat ?? "move") as BeatId
        if (!(beat in BEAT_SPOTS)) throw new Error(`Unknown beat ${beat}`)
        if (!guided(host.session())) startTraining()
        const t = guided(host.session())
        if (!t) throw new Error("No training room")
        stageBeat(t.session, t.guide, beat)
        t.age = 2
        return { beat }
      },
    },
    {
      id: "onboarding.skip",
      label: "Leave the Training Room",
      shortLabel: "Skip Training",
      category: "Scene",
      undoable: false,
      enabled: () => Boolean(active(host.session())),
      run: () => {
        const t = active(host.session())
        if (t) finish(t, host.settings.ai.startHour ?? 17.5)
        return { skipped: Boolean(t) }
      },
    },
  ],
  harnessMethods: (host, harness) => ({
    /** Starts the training room now. */
    startTraining: () => startTraining(),
    /** Jumps the practice space (or the training room, starting it if needed) to `beat` and snaps the camera there. */
    trainingBeat(beat: BeatId) {
      if (!guided(host.session())) startTraining()
      const t = guided(host.session())
      if (!t) return false
      stageBeat(t.session, t.guide, beat)
      t.age = 2
      const p = t.session.view.player
      harness.pose(p.x, p.y, p.aim)
      return true
    },
    /** Leaves the training room as if by the street (fade, done, boards carried). */
    skipTraining() {
      const t = active(host.session())
      if (t) finish(t, host.settings.ai.startHour ?? 17.5)
      return Boolean(t)
    },
    /** Opens or closes the recipe panel as E at a bench does (the keyboard path is the input controller's). */
    benchPanel(open: boolean) {
      if (open) host.progressionHost.hud.openBench()
      else host.progressionHost.hud.close()
    },
  }),
  harnessState: (host) => {
    const t = active(host.session())
    const pr = practising(host.session())
    return {
      practice: pr
        ? {
            beat: pr.guide.current(),
            done: BEATS.filter((b) => pr.guide.done.has(b)),
            loadout: pr.loadout,
            hint: hints?.current ?? null,
          }
        : null,
      onboarding: {
        training: Boolean(t) || isTrainingSession(host.session()),
        beat: t?.guide.current() ?? null,
        hint: hints?.current ?? null,
        done: t ? BEATS.filter((b) => t.guide.done.has(b)) : [],
        completed: trainingDone(),
      },
    }
  },
})
