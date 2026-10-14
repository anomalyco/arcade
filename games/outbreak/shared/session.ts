import { pushOut } from "@arcade/kit/sim/geom"
import { advanceHour } from "./day-cycle"
import {
  createInteractActorState,
  cycleInteractAction,
  executeInteraction,
  peekInfoFor,
  selectInteractTarget,
  stepInteractionState,
  type InteractActionId,
  type InteractActorState,
  type InteractTarget,
  type PeekInfo,
} from "./interact"
import { makeTown, SIZE, solidRects, type Town } from "./map"
import {
  createStaminaState,
  DEFAULT_STAMINA_TUNING,
  stepStamina,
  type StaminaState,
  type StaminaTuning,
} from "./stamina"

export type Command = {
  mx: number
  my: number
  aim: number
  interact: boolean
  sprint?: boolean
  cycle?: boolean
  interactAction?: InteractActionId
}
export type Survivor = { x: number; y: number; vx: number; vy: number; aim: number } & StaminaState & InteractActorState
export type SessionView = {
  town: Town
  player: Survivor
  hour: number
  time: number
  revision: number
  prompt: InteractTarget | undefined
  peek: PeekInfo | null
}
/** Transport boundary: M4 can implement the same update/view contract with snapshots. */
export interface Session {
  readonly view: SessionView
  update(dt: number, command: Command, timeScale: number, tuning?: StaminaTuning): void
  close(): void
}

export class LocalSession implements Session {
  readonly view: SessionView
  private solids
  constructor(seed: number, houseSeed = seed, terrain = .22) {
    const town = makeTown(seed, houseSeed, terrain)
    const player: Survivor = {
      x: 27.7,
      y: 41,
      vx: 0,
      vy: 0,
      aim: -Math.PI / 2,
      ...createStaminaState(),
      ...createInteractActorState(),
    }
    this.view = {
      town,
      player,
      hour: 18,
      time: 0,
      revision: 0,
      prompt: selectInteractTarget(town, player),
      peek: null,
    }
    this.solids = solidRects(town)
  }
  update(dt: number, command: Command, timeScale: number, tuning: StaminaTuning = DEFAULT_STAMINA_TUNING): void {
    const view = this.view, p = view.player
    dt = Math.max(0, Math.min(.1, dt))
    if (!p.vault) p.aim = command.aim
    if (command.cycle) {
      cycleInteractAction(view.town, p)
    }
    if (command.interact) {
      const outcome = executeInteraction(view.town, p, command.interactAction)
      if (outcome.topologyChanged) {
        view.revision++
        this.solids = solidRects(view.town)
      }
    }
    const x = p.x, y = p.y
    if (stepInteractionState(view.town, p, dt)) {
      stepStamina(p, false, false, dt, tuning)
      if (!p.vault) {
        pushOut(p, .3, this.solids)
        p.x = Math.max(.4, Math.min(SIZE - .4, p.x))
        p.y = Math.max(.4, Math.min(SIZE - .4, p.y))
      }
    } else {
      const rawLen = Math.hypot(command.mx, command.my)
      const moving = rawLen > 1e-4
      const length = Math.max(1, rawLen)
      const speed = stepStamina(p, moving, Boolean(command.sprint), dt, tuning)
      const steps = Math.max(1, Math.ceil(dt * 60))
      for (let i = 0; i < steps; i++) {
        p.x += command.mx / length * speed * dt / steps
        p.y += command.my / length * speed * dt / steps
        pushOut(p, .3, this.solids)
        p.x = Math.max(.4, Math.min(SIZE - .4, p.x)); p.y = Math.max(.4, Math.min(SIZE - .4, p.y))
      }
      stepInteractionState(view.town, p, 0)
    }
    p.vx = dt > 0 ? (p.x - x) / dt : 0; p.vy = dt > 0 ? (p.y - y) / dt : 0
    view.peek = peekInfoFor(view.town, p)
    view.prompt = selectInteractTarget(view.town, p)
    view.time += dt
    view.hour = advanceHour(view.hour, dt, timeScale)
  }
  close(): void {}
  rebuildCollision(): void {
    this.solids = solidRects(this.view.town)
    this.view.peek = peekInfoFor(this.view.town, this.view.player)
    this.view.prompt = selectInteractTarget(this.view.town, this.view.player)
  }
}
