import { angleDiff, distToRect, type Rect } from "@arcade/kit/sim/geom"
import { propShape, type Door, type Town, type WindowOpening } from "./map"
import { DEFAULT_STAMINA_TUNING, DOOR_NOISE, VAULT_NOISE } from "./stamina"

export const INTERACT_RANGE = 2.2
export const VAULT_DURATION = 0.30
export const VAULT_STAMINA_COST = 0.18
export const FENCE_VAULT_NOISE = 10.0
export const PEEK_CONE = 165
export const PEEK_AWARENESS = 4.2

export type InteractableKind = "door" | "window" | "fence" | (string & {})
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
  stamina?: number
  exhausted?: boolean
  sprinting?: boolean
  regenCooldown?: number
  noise: number
  peekingWindowId: string | null
  peekOriginX: number
  peekOriginY: number
  peekOriginDist: number
  lastPeekedWindowId: string | null
  cycledTargetId: string | null
  cycledActionIndex: number
  vault: VaultState | null
}

export function createInteractActorState(): Pick<
  InteractActorState,
  | "peekingWindowId"
  | "peekOriginX"
  | "peekOriginY"
  | "peekOriginDist"
  | "lastPeekedWindowId"
  | "cycledTargetId"
  | "cycledActionIndex"
  | "vault"
> {
  return {
    peekingWindowId: null,
    peekOriginX: 0,
    peekOriginY: 0,
    peekOriginDist: 0,
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
  // Proximity dominates so walking right up to a window or fence selects it from any mouse angle;
  // facing direction breaks ties when equidistant between two openings.
  const score = (INTERACT_RANGE - dist) * 2.0 + facing * 0.45
  return { dist, facing, score }
}

function applyVaultStaminaCost(actor: InteractActorState, cost = VAULT_STAMINA_COST): void {
  if (typeof actor.stamina === "number") {
    actor.stamina = Math.max(0, actor.stamina - cost)
    actor.regenCooldown = Math.max(actor.regenCooldown ?? 0, DEFAULT_STAMINA_TUNING.staminaDelay)
    if (actor.stamina <= 1e-6) {
      actor.stamina = 0
      actor.exhausted = true
      actor.sprinting = false
    }
  }
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

  const peek: InteractAction = { id: "peek", label: "Peek window" }
  if (!win.open) {
    if (!win.openable) {
      return { actions: [peek], defaultAction: peek }
    }
    const open: InteractAction = { id: "toggle", label: "Open window" }
    return { actions: [peek, open], defaultAction: peek }
  }

  const climb: InteractAction = { id: "climb", label: "Climb through" }
  const actions: InteractAction[] = [peek, climb]
  if (win.openable) actions.push({ id: "toggle", label: "Close window" })
  return { actions, defaultAction: peek }
}

function isLandingSpotClear(town: Town, cx: number, cy: number, ignoreRect?: Rect): boolean {
  for (const b of town.barriers) {
    if (ignoreRect && b.rect === ignoreRect) continue
    if (distToRect(cx, cy, b.rect) < 0.32) return false
  }
  for (const d of town.doors) {
    if (!d.open && distToRect(cx, cy, d.rect) < 0.32) return false
  }
  for (const p of town.props) {
    const s = propShape(p)
    if (s && distToRect(cx, cy, s.rect) < 0.28) return false
    if (p.kind === "tree" && Math.hypot(cx - p.x, cy - p.y) < 0.45) return false
  }
  return true
}

function computeVaultDestination(
  town: Town,
  rect: Rect,
  fromX: number,
  fromY: number,
  preferAnchor = false,
): { toX: number; toY: number; aim: number } | null {
  const [x0, y0, x1, y1] = rect
  const horizontal = x1 - x0 > y1 - y0
  const wx = preferAnchor ? Math.max(x0 + 0.45, Math.min(x1 - 0.45, fromX)) : (x0 + x1) / 2
  const wy = preferAnchor ? Math.max(y0 + 0.45, Math.min(y1 - 0.45, fromY)) : (y0 + y1) / 2
  const clearance = 0.58

  if (horizontal) {
    const midY = (y0 + y1) / 2
    const intoNorth = fromY >= midY
    const targetY = intoNorth ? y0 - clearance : y1 + clearance
    const aim = intoNorth ? -Math.PI / 2 : Math.PI / 2
    for (const offset of [0, -0.35, 0.35, -0.7, 0.7]) {
      const cx = Math.max(x0 + 0.3, Math.min(x1 - 0.3, wx + offset))
      if (isLandingSpotClear(town, cx, targetY, rect)) return { toX: cx, toY: targetY, aim }
    }
    return preferAnchor ? null : { toX: wx, toY: targetY, aim }
  } else {
    const midX = (x0 + x1) / 2
    const intoWest = fromX >= midX
    const targetX = intoWest ? x0 - clearance : x1 + clearance
    const aim = intoWest ? Math.PI : 0
    for (const offset of [0, -0.35, 0.35, -0.7, 0.7]) {
      const cy = Math.max(y0 + 0.3, Math.min(y1 - 0.3, wy + offset))
      if (isLandingSpotClear(town, targetX, cy, rect)) return { toX: targetX, toY: cy, aim }
    }
    return preferAnchor ? null : { toX: targetX, toY: wy, aim }
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
    const dist = win ? distToRect(actor.x, actor.y, win.rect) : Infinity
    if (!win || dist > INTERACT_RANGE) return { handled: false }
    if (action === "peek") {
      if (actor.peekingWindowId === win.id) {
        actor.peekingWindowId = null
        actor.lastPeekedWindowId = win.id
      } else {
        actor.peekingWindowId = win.id
        actor.peekOriginX = actor.x
        actor.peekOriginY = actor.y
        actor.peekOriginDist = dist
        actor.sprinting = false
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
      if (!win.open || actor.vault || actor.exhausted) return { handled: false }
      const dest = computeVaultDestination(town, win.rect, actor.x, actor.y, false)
      if (!dest) return { handled: false }
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
      applyVaultStaminaCost(actor, VAULT_STAMINA_COST)
      actor.noise = Math.max(actor.noise, VAULT_NOISE)
      return { handled: true, kind: "window", targetId: win.id, action: "climb", topologyChanged: false, noise: actor.noise }
    }
    return { handled: false }
  },
}

export const fenceInteractionHandler: InteractionHandler = {
  kind: "fence",
  candidates(town, actor) {
    const out: RawInteractCandidate[] = []
    let fenceIdx = 0
    for (const b of town.barriers) {
      if (b.kind !== "fence") continue
      const id = `fence-${fenceIdx++}`
      if (distToRect(actor.x, actor.y, b.rect) > INTERACT_RANGE) continue
      const dest = computeVaultDestination(town, b.rect, actor.x, actor.y, true)
      if (!dest) continue
      const [nx, ny] = nearestPointOnRect(actor.x, actor.y, b.rect)
      const localRect: Rect = [
        Math.max(b.rect[0], nx - 0.35),
        Math.max(b.rect[1], ny - 0.35),
        Math.min(b.rect[2], nx + 0.35),
        Math.min(b.rect[3], ny + 0.35),
      ]
      const vaultAction: InteractAction = { id: "climb", label: "Vault fence" }
      out.push({
        kind: "fence",
        id,
        rect: localRect,
        actions: [vaultAction],
        defaultAction: vaultAction,
      })
    }
    return out
  },
  execute(town, actor, targetId, action) {
    if (action !== "climb" || actor.vault || actor.exhausted) return { handled: false }
    let fenceIdx = 0
    for (const b of town.barriers) {
      if (b.kind !== "fence") continue
      const id = `fence-${fenceIdx++}`
      if (id !== targetId) continue
      if (distToRect(actor.x, actor.y, b.rect) > INTERACT_RANGE) return { handled: false }
      const dest = computeVaultDestination(town, b.rect, actor.x, actor.y, true)
      if (!dest) return { handled: false }
      actor.peekingWindowId = null
      actor.vault = {
        windowId: id,
        fromX: actor.x,
        fromY: actor.y,
        toX: dest.toX,
        toY: dest.toY,
        aim: dest.aim,
        elapsed: 0,
        duration: VAULT_DURATION,
      }
      actor.aim = dest.aim
      applyVaultStaminaCost(actor, VAULT_STAMINA_COST)
      actor.noise = Math.max(actor.noise, FENCE_VAULT_NOISE)
      return { handled: true, kind: "fence", targetId: id, action: "climb", topologyChanged: false, noise: actor.noise }
    }
    return { handled: false }
  },
}

export class InteractionRegistry {
  private readonly handlers = new Map<InteractableKind, InteractionHandler>()

  constructor(
    initial: readonly InteractionHandler[] = [doorInteractionHandler, windowInteractionHandler, fenceInteractionHandler],
  ) {
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
 * Advances active window/fence vault movement and auto-releases window peeking when the survivor moves away.
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
    if (!win) {
      actor.peekingWindowId = null
    } else {
      const dist = distToRect(actor.x, actor.y, win.rect)
      // Keep peeking if the survivor moves closer to or along the window; release only when moving away.
      if (dist < actor.peekOriginDist) {
        actor.peekOriginDist = dist
      }
      const backedAway = dist > actor.peekOriginDist + 0.55
      const outOfRange = dist > INTERACT_RANGE
      if (backedAway || outOfRange) {
        actor.peekingWindowId = null
      }
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

/** Computes the eye origin, localised cutaway bubble center, and camera lean for the currently peeked window. */
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
    // Outside south window (actor.y >= wy): look north (-1) into the building.
    // Inside south window (actor.y < wy): look south (+1) out of the building.
    const lookingNorth = actor.y >= wy
    const dir = lookingNorth ? -1 : 1
    const eyeX = Math.max(x0 + 0.25, Math.min(x1 - 0.25, actor.x))
    const eyeY = (dir < 0 ? y0 : y1) + dir * 0.35
    const cutX = wx
    const cutY = insideBuilding ? actor.y : Math.max(bz0 + 1.2, Math.min(bz1 - 1.2, wy - 1.85))
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
      camOffsetY: dir * 1.45,
    }
  } else {
    // Outside east window (actor.x >= wx): look west (-1) into the building.
    // Inside east window (actor.x < wx): look east (+1) out of the building.
    const lookingWest = actor.x >= wx
    const dir = lookingWest ? -1 : 1
    // Avoid the interior partition wall at split = bz0 + 5.5..5.7 which bisects the east window.
    const split = bz0 + 5.6
    const inSouthRoom = actor.y >= split
    const eyeY = inSouthRoom ? Math.max(split + 0.42, Math.min(y1 - 0.2, actor.y)) : Math.min(split - 0.42, Math.max(y0 + 0.2, actor.y))
    const eyeX = (dir < 0 ? x0 : x1) + dir * 0.35
    const cutX = insideBuilding ? actor.x : Math.max(bx0 + 1.2, Math.min(bx1 - 1.2, wx - 1.85))
    const cutY = eyeY
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
      camOffsetX: dir * 1.45,
      camOffsetY: 0,
    }
  }
}

/** Vertical vault hop over a window sill or fence (metres) for presentation. */
export function vaultLift(actor: Pick<InteractActorState, "vault">): number {
  if (!actor.vault) return 0
  const u = Math.max(0, Math.min(1, actor.vault.elapsed / actor.vault.duration))
  return Math.sin(u * Math.PI) * 0.58
}
