import { angleDiff, distToRect, type Rect } from "@arcade/kit/sim/geom"
import { propShape, type Door, type Town, type WindowOpening } from "./map"
import { DOOR_NOISE, VAULT_NOISE } from "./stamina"

export const INTERACT_RANGE = 1.8
export const PEEK_MOVE_RELEASE = 0.45
export const VAULT_DURATION = 0.32
export const PEEK_CONE = 155
export const PEEK_AWARENESS = 3.5

export type InteractableKind = "door" | "window" | (string & {})
export type InteractActionId = "toggle" | "lock" | "peek" | "climb"
export type InteractAction = { id: InteractActionId; label: string }

export type VaultState = {
  windowId: string
  fromX: number
  fromY: number
  toX: number
  toY: number
  aim: number
  elapsed: number
  duration: number
}

export type PeekInfo = {
  windowId: string
  buildingId: string
  buildingIndex: number
  eyeX: number
  eyeY: number
  cutX: number
  cutY: number
  aim: number
  cone: number
  awareness: number
  camOffsetX: number
  camOffsetY: number
}

export type InteractActorState = {
  x: number
  y: number
  aim: number
  sprinting?: boolean
  noise: number
  peekingWindowId: string | null
  peekOriginX: number
  peekOriginY: number
  lastPeekedWindowId: string | null
  cycledTargetId: string | null
  cycledActionIndex: number
  vault: VaultState | null
}

export function createInteractActorState(): Pick<
  InteractActorState,
  "peekingWindowId" | "peekOriginX" | "peekOriginY" | "lastPeekedWindowId" | "cycledTargetId" | "cycledActionIndex" | "vault"
> {
  return {
    peekingWindowId: null,
    peekOriginX: 0,
    peekOriginY: 0,
    lastPeekedWindowId: null,
    cycledTargetId: null,
    cycledActionIndex: 0,
    vault: null,
  }
}

export type RawInteractCandidate = {
  kind: InteractableKind
  id: string
  rect: Rect
  buildingId?: string
  buildingIndex?: number
  actions: InteractAction[]
  defaultAction: InteractAction
}

export type InteractTarget = RawInteractCandidate & {
  dist: number
  facing: number
  score: number
  activeAction: InteractAction
}

export type InteractOutcome = {
  handled: boolean
  kind?: InteractableKind
  targetId?: string
  action?: InteractActionId
  topologyChanged?: boolean
  noise?: number
}

export type InteractionHandler = {
  readonly kind: InteractableKind
  candidates(town: Town, actor: InteractActorState): RawInteractCandidate[]
  execute(town: Town, actor: InteractActorState, targetId: string, action: InteractActionId): InteractOutcome
}

function nearestPointOnRect(x: number, y: number, r: Rect): [number, number] {
  const nx = Math.max(r[0], Math.min(r[2], x))
  const ny = Math.max(r[1], Math.min(r[3], y))
  if (nx === x && ny === y) {
    return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]
  }
  return [nx, ny]
}

function candidateScore(actor: InteractActorState, rect: Rect): { dist: number; facing: number; score: number } {
  const dist = distToRect(actor.x, actor.y, rect)
  const [nx, ny] = nearestPointOnRect(actor.x, actor.y, rect)
  const toAngle = Math.atan2(ny - actor.y, nx - actor.x)
  const facing = Math.cos(angleDiff(actor.aim, toAngle))
  // Closer and more directly in front of the survivor's aim wins.
  const score = (INTERACT_RANGE - dist) + facing * 0.75
  return { dist, facing, score }
}

function doorActions(door: Door): { actions: InteractAction[]; defaultAction: InteractAction } {
  if (door.open) {
    const close: InteractAction = { id: "toggle", label: "Close door" }
    return { actions: [close], defaultAction: close }
  }
  if (door.locked) {
    const unlock: InteractAction = { id: "lock", label: "Unlock door" }
    return { actions: [unlock], defaultAction: unlock }
  }
  const open: InteractAction = { id: "toggle", label: "Open door" }
  const lock: InteractAction = { id: "lock", label: "Lock door" }
  return { actions: [open, lock], defaultAction: open }
}

function windowActions(
  win: WindowOpening,
  actor: InteractActorState,
): { actions: InteractAction[]; defaultAction: InteractAction } {
  const isPeekingThis = actor.peekingWindowId === win.id
  if (isPeekingThis) {
    const stopPeek: InteractAction = { id: "peek", label: "Stop peeking" }
    const actions: InteractAction[] = [stopPeek]
    if (!win.open && win.openable) actions.push({ id: "toggle", label: "Open window" })
    if (win.open) {
      actions.push({ id: "climb", label: "Climb through" })
      if (win.openable) actions.push({ id: "toggle", label: "Close window" })
    }
    return { actions, defaultAction: stopPeek }
  }

  if (!win.open) {
    const peek: InteractAction = { id: "peek", label: "Peek window" }
    if (!win.openable) {
      return { actions: [peek], defaultAction: peek }
    }
    const open: InteractAction = { id: "toggle", label: "Open window" }
    const actions = [peek, open]
    const defaultAction = actor.lastPeekedWindowId === win.id ? open : peek
    return { actions, defaultAction }
  }

  const climb: InteractAction = { id: "climb", label: "Climb through" }
  const peek: InteractAction = { id: "peek", label: "Peek window" }
  const actions: InteractAction[] = [climb, peek]
  if (win.openable) actions.push({ id: "toggle", label: "Close window" })
  return { actions, defaultAction: climb }
}

function computeVaultDestination(
  town: Town,
  win: WindowOpening,
  fromX: number,
  fromY: number,
): { toX: number; toY: number; aim: number } {
  const [x0, y0, x1, y1] = win.rect
  const horizontal = x1 - x0 > y1 - y0
  const wx = (x0 + x1) / 2
  const wy = (y0 + y1) / 2
  const clearance = 0.58
  const propRects = town.props.flatMap((p) => {
    const s = propShape(p)
    return s ? [s.rect] : []
  })
  const isClear = (cx: number, cy: number) => propRects.every((r) => distToRect(cx, cy, r) >= 0.28)

  if (horizontal) {
    const intoNorth = fromY >= wy
    const targetY = intoNorth ? y0 - clearance : y1 + clearance
    const aim = intoNorth ? -Math.PI / 2 : Math.PI / 2
    for (const offset of [0, -0.35, 0.35, -0.65, 0.65]) {
      const cx = Math.max(x0 + 0.3, Math.min(x1 - 0.3, wx + offset))
      if (isClear(cx, targetY)) return { toX: cx, toY: targetY, aim }
    }
    return { toX: wx, toY: targetY, aim }
  } else {
    const intoWest = fromX >= wx
    const targetX = intoWest ? x0 - clearance : x1 + clearance
    const aim = intoWest ? Math.PI : 0
    for (const offset of [0, -0.35, 0.35, -0.65, 0.65]) {
      const cy = Math.max(y0 + 0.3, Math.min(y1 - 0.3, wy + offset))
      if (isClear(targetX, cy)) return { toX: targetX, toY: cy, aim }
    }
    return { toX: targetX, toY: wy, aim }
  }
}

export const doorInteractionHandler: InteractionHandler = {
  kind: "door",
  candidates(town, actor) {
    const out: RawInteractCandidate[] = []
    for (const door of town.doors) {
      if (distToRect(actor.x, actor.y, door.rect) > INTERACT_RANGE) continue
      const { actions, defaultAction } = doorActions(door)
      out.push({
        kind: "door",
        id: door.id,
        rect: door.rect,
        actions,
        defaultAction,
      })
    }
    return out
  },
  execute(town, actor, targetId, action) {
    const door = town.doors.find((d) => d.id === targetId)
    if (!door || distToRect(actor.x, actor.y, door.rect) > INTERACT_RANGE) return { handled: false }
    if (action === "lock") {
      if (door.open) return { handled: false }
      door.locked = !door.locked
      actor.peekingWindowId = null
      actor.noise = Math.max(actor.noise, DOOR_NOISE * 0.7)
      return { handled: true, kind: "door", targetId: door.id, action: "lock", topologyChanged: false, noise: actor.noise }
    }
    if (action === "toggle") {
      if (door.locked) return { handled: false }
      // Do not close a door through the survivor.
      if (door.open && distToRect(actor.x, actor.y, door.rect) < 0.35) return { handled: false }
      door.open = !door.open
      actor.peekingWindowId = null
      actor.noise = Math.max(actor.noise, DOOR_NOISE)
      return { handled: true, kind: "door", targetId: door.id, action: "toggle", topologyChanged: true, noise: actor.noise }
    }
    return { handled: false }
  },
}

export const windowInteractionHandler: InteractionHandler = {
  kind: "window",
  candidates(town, actor) {
    const out: RawInteractCandidate[] = []
    for (const win of town.windows) {
      if (distToRect(actor.x, actor.y, win.rect) > INTERACT_RANGE) continue
      const { actions, defaultAction } = windowActions(win, actor)
      out.push({
        kind: "window",
        id: win.id,
        rect: win.rect,
        buildingId: win.buildingId,
        buildingIndex: win.buildingIndex,
        actions,
        defaultAction,
      })
    }
    return out
  },
  execute(town, actor, targetId, action) {
    const win = town.windows.find((w) => w.id === targetId)
    if (!win || distToRect(actor.x, actor.y, win.rect) > INTERACT_RANGE) return { handled: false }
    if (action === "peek") {
      if (actor.peekingWindowId === win.id) {
        actor.peekingWindowId = null
        actor.lastPeekedWindowId = win.id
      } else {
        actor.peekingWindowId = win.id
        actor.peekOriginX = actor.x
        actor.peekOriginY = actor.y
        actor.lastPeekedWindowId = win.id
      }
      return { handled: true, kind: "window", targetId: win.id, action: "peek", topologyChanged: false }
    }
    if (action === "toggle") {
      if (!win.openable) return { handled: false }
      win.open = !win.open
      actor.peekingWindowId = null
      actor.noise = Math.max(actor.noise, DOOR_NOISE)
      return { handled: true, kind: "window", targetId: win.id, action: "toggle", topologyChanged: true, noise: actor.noise }
    }
    if (action === "climb") {
      if (!win.open || actor.vault) return { handled: false }
      const dest = computeVaultDestination(town, win, actor.x, actor.y)
      actor.peekingWindowId = null
      actor.lastPeekedWindowId = null
      actor.vault = {
        windowId: win.id,
        fromX: actor.x,
        fromY: actor.y,
        toX: dest.toX,
        toY: dest.toY,
        aim: dest.aim,
        elapsed: 0,
        duration: VAULT_DURATION,
      }
      actor.aim = dest.aim
      actor.noise = Math.max(actor.noise, VAULT_NOISE)
      return { handled: true, kind: "window", targetId: win.id, action: "climb", topologyChanged: false, noise: actor.noise }
    }
    return { handled: false }
  },
}

export class InteractionRegistry {
  private readonly handlers = new Map<InteractableKind, InteractionHandler>()

  constructor(initial: readonly InteractionHandler[] = [doorInteractionHandler, windowInteractionHandler]) {
    for (const h of initial) this.register(h)
  }

  register(handler: InteractionHandler): void {
    this.handlers.set(handler.kind, handler)
  }

  get(kind: InteractableKind): InteractionHandler | undefined {
    return this.handlers.get(kind)
  }

  all(): readonly InteractionHandler[] {
    return [...this.handlers.values()]
  }
}

export const defaultInteractionRegistry = new InteractionRegistry()

/**
 * Selects the single best interaction target within reach, combining distance and facing angle.
 * While actively peeking a window in reach, that window remains the active target so E stops peeking.
 */
export function selectInteractTarget(
  town: Town,
  actor: InteractActorState,
  registry: InteractionRegistry = defaultInteractionRegistry,
): InteractTarget | undefined {
  if (actor.vault) return undefined
  const scored: InteractTarget[] = []
  for (const handler of registry.all()) {
    for (const raw of handler.candidates(town, actor)) {
      const { dist, facing, score } = candidateScore(actor, raw.rect)
      // Give the actively peeked window priority while the survivor remains at the sill.
      const peekBoost = raw.kind === "window" && actor.peekingWindowId === raw.id ? 10 : 0
      const activeAction =
        actor.cycledTargetId === raw.id && actor.cycledActionIndex > 0
          ? raw.actions[actor.cycledActionIndex % raw.actions.length]!
          : raw.defaultAction
      scored.push({
        ...raw,
        dist,
        facing,
        score: score + peekBoost,
        activeAction,
      })
    }
  }
  if (!scored.length) return undefined
  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}

/** Cycles to the next available action on the current target (bound to Q). */
export function cycleInteractAction(
  town: Town,
  actor: InteractActorState,
  registry: InteractionRegistry = defaultInteractionRegistry,
): InteractTarget | undefined {
  const current = selectInteractTarget(town, actor, registry)
  if (!current || current.actions.length <= 1) return current
  if (actor.cycledTargetId !== current.id) {
    actor.cycledTargetId = current.id
    const defaultIdx = current.actions.findIndex((a) => a.id === current.defaultAction.id)
    actor.cycledActionIndex = ((defaultIdx >= 0 ? defaultIdx : 0) + 1) % current.actions.length
  } else {
    actor.cycledActionIndex = (actor.cycledActionIndex + 1) % current.actions.length
  }
  return selectInteractTarget(town, actor, registry)
}

/** Executes the active or explicitly requested interaction action on the current target. */
export function executeInteraction(
  town: Town,
  actor: InteractActorState,
  explicitAction?: InteractActionId,
  registry: InteractionRegistry = defaultInteractionRegistry,
): InteractOutcome {
  if (actor.vault) return { handled: false }
  const target = selectInteractTarget(town, actor, registry)
  if (!target) {
    if (actor.peekingWindowId) {
      actor.peekingWindowId = null
      return { handled: true, kind: "window", action: "peek" }
    }
    return { handled: false }
  }
  const handler = registry.get(target.kind)
  if (!handler) return { handled: false }
  const actionId = explicitAction ?? target.activeAction.id
  const outcome = handler.execute(town, actor, target.id, actionId)
  if (outcome.handled) {
    actor.cycledTargetId = null
    actor.cycledActionIndex = 0
  }
  return outcome
}

/**
 * Advances active window vault movement and auto-releases window peeking when the survivor moves away.
 * Returns true while the survivor is mid-vault (so normal movement/collision is skipped for this step).
 */
export function stepInteractionState(town: Town, actor: InteractActorState, dt: number): boolean {
  if (actor.vault) {
    const v = actor.vault
    v.elapsed += dt
    const u = Math.max(0, Math.min(1, v.elapsed / v.duration))
    const s = u * u * (3 - 2 * u)
    actor.x = v.fromX + (v.toX - v.fromX) * s
    actor.y = v.fromY + (v.toY - v.fromY) * s
    actor.aim = v.aim
    if (v.elapsed >= v.duration) {
      actor.x = v.toX
      actor.y = v.toY
      actor.vault = null
    }
    return true
  }

  if (actor.peekingWindowId) {
    const win = town.windows.find((w) => w.id === actor.peekingWindowId)
    const movedFromOrigin = Math.hypot(actor.x - actor.peekOriginX, actor.y - actor.peekOriginY) > PEEK_MOVE_RELEASE
    const outOfRange = !win || distToRect(actor.x, actor.y, win.rect) > INTERACT_RANGE
    if (movedFromOrigin || outOfRange || actor.sprinting) {
      actor.peekingWindowId = null
    }
  }

  if (actor.lastPeekedWindowId) {
    const win = town.windows.find((w) => w.id === actor.lastPeekedWindowId)
    if (!win || distToRect(actor.x, actor.y, win.rect) > INTERACT_RANGE + 0.35) {
      actor.lastPeekedWindowId = null
    }
  }

  if (actor.cycledTargetId) {
    const target = selectInteractTarget(town, actor)
    if (!target || target.id !== actor.cycledTargetId) {
      actor.cycledTargetId = null
      actor.cycledActionIndex = 0
    }
  }

  return false
}

/** Computes the eye origin, roof-cutaway anchor, and camera lean for the currently peeked window. */
export function peekInfoFor(town: Town, actor: Pick<InteractActorState, "x" | "y" | "peekingWindowId">): PeekInfo | null {
  if (!actor.peekingWindowId) return null
  const win = town.windows.find((w) => w.id === actor.peekingWindowId)
  if (!win) return null
  const building = town.buildings[win.buildingIndex]
  if (!building) return null
  const [bx0, bz0, bx1, bz1] = building.rect
  const [x0, y0, x1, y1] = win.rect
  const horizontal = x1 - x0 > y1 - y0
  const wx = (x0 + x1) / 2
  const wy = (y0 + y1) / 2
  const insideBuilding = actor.x > bx0 && actor.x < bx1 && actor.y > bz0 && actor.y < bz1

  if (horizontal) {
    const lookingNorth = !insideBuilding ? actor.y >= wy : actor.y >= wy
    const dir = lookingNorth ? -1 : 1
    const eyeX = wx
    const eyeY = (dir < 0 ? y0 : y1) + dir * 0.35
    const cutX = wx
    const cutY = insideBuilding ? actor.y : Math.max(bz0 + 1.2, Math.min(bz1 - 1.2, wy + dir * 2.2))
    return {
      windowId: win.id,
      buildingId: win.buildingId,
      buildingIndex: win.buildingIndex,
      eyeX,
      eyeY,
      cutX,
      cutY,
      aim: dir < 0 ? -Math.PI / 2 : Math.PI / 2,
      cone: PEEK_CONE,
      awareness: PEEK_AWARENESS,
      camOffsetX: 0,
      camOffsetY: dir * 1.4,
    }
  } else {
    const lookingWest = !insideBuilding ? actor.x >= wx : actor.x >= wx
    const dir = lookingWest ? -1 : 1
    const eyeX = (dir < 0 ? x0 : x1) + dir * 0.35
    const eyeY = wy
    const cutX = insideBuilding ? actor.x : Math.max(bx0 + 1.2, Math.min(bx1 - 1.2, wx + dir * 2.2))
    const cutY = wy
    return {
      windowId: win.id,
      buildingId: win.buildingId,
      buildingIndex: win.buildingIndex,
      eyeX,
      eyeY,
      cutX,
      cutY,
      aim: dir < 0 ? Math.PI : 0,
      cone: PEEK_CONE,
      awareness: PEEK_AWARENESS,
      camOffsetX: dir * 1.4,
      camOffsetY: 0,
    }
  }
}

/** Vertical vault hop over a window sill (metres) for presentation. */
export function vaultLift(actor: Pick<InteractActorState, "vault">): number {
  if (!actor.vault) return 0
  const u = Math.max(0, Math.min(1, actor.vault.elapsed / actor.vault.duration))
  return Math.sin(u * Math.PI) * 0.58
}
