import { angleDiff, distToRect, type Rect } from "@arcade/kit/sim/geom"
import { propShape, type Door, type Town, type WindowOpening } from "./map"
import { DEFAULT_STAMINA_TUNING, DOOR_NOISE, VAULT_NOISE } from "./stamina"

export const INTERACT_RANGE = 2.2
export const VAULT_DURATION = 0.30
export const VAULT_STAMINA_COST = 0.18
export const FENCE_VAULT_NOISE = 10.0
export const HOLD_DURATION = 0.38
/**
 * How much facing a target counts against being near it when several are in reach: at 1, looking (the cursor) picks
 * between targets up to half a metre apart in distance. It was 0.45 before AR-89, so the nearest almost always won.
 */
export const INTERACT_FACING_WEIGHT = 1
export const PEEK_CONE = 165
export const PEEK_AWARENESS = 4.2
/** A door's peephole: a fish-eye, narrower than a window and with less to it. */
export const PEEPHOLE_CONE = 120
export const PEEPHOLE_AWARENESS = 2.6

export type InteractableKind = "door" | "window" | "fence" | (string & {})
export type InteractActionId =
  | "toggle"
  | "lock"
  | "peek"
  | "climb"
  | "search"
  | "smash"
  | "take"
  | "deposit"
  | "install"
  | "board"
  | "read"
  | "store"
  | "unlock"
  | "pry"
  | "locked"
  | "barricade"
  | "enter"
  | "hide"
  | "disarm"
  | "arm"
  | "feed"
  | "revive"
  | "drag"
  | "set-down"
/** `modifier: "shift"` marks an alternative taken with Shift+E (smash a container instead of searching it). */
export type InteractAction = { id: InteractActionId; label: string; hold?: boolean; modifier?: "shift" }

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
  /** Looking through a shut door's peephole (the eye is past the door) rather than a window. */
  peephole: boolean
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
  holdTargetId: string | null
  holdElapsed: number
  holdTriggered: boolean
  holdPendingPrimary: InteractActionId | null
  vault: VaultState | null
}

export function createInteractActorState(): Pick<
  InteractActorState,
  | "peekingWindowId"
  | "peekOriginX"
  | "peekOriginY"
  | "peekOriginDist"
  | "holdTargetId"
  | "holdElapsed"
  | "holdTriggered"
  | "holdPendingPrimary"
  | "vault"
> {
  return {
    peekingWindowId: null,
    peekOriginX: 0,
    peekOriginY: 0,
    peekOriginDist: 0,
    holdTargetId: null,
    holdElapsed: 0,
    holdTriggered: false,
    holdPendingPrimary: null,
    vault: null,
  }
}

export type RawInteractCandidate = {
  kind: InteractableKind
  id: string
  rect: Rect
  worldX: number
  worldY: number
  /** What the target is, for prompts and strips ("Dresser", "Workbench · tier 2"). */
  label?: string
  buildingId?: string
  buildingIndex?: number
  primary: InteractAction
  secondary?: InteractAction
  /** Shift+E alternative. */
  alt?: InteractAction
  actions: InteractAction[]
  /** While E is held, wait for the release before taking the tap action, so a hold reaches `secondary` cleanly. */
  deferPrimary?: boolean
  /** Added to the target's score: something small lying on furniture (a page) wins over the furniture itself. */
  priority?: number
}

/** Whether `id` is one of the target's own actions (its tap, hold, Shift+E or any listed). */
export function offersAction(target: RawInteractCandidate, id: InteractActionId): boolean {
  return target.primary.id === id || target.secondary?.id === id || target.alt?.id === id || target.actions.some((a) => a.id === id)
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
  noiseKind?: string
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
  const score = (INTERACT_RANGE - dist) * 2.0 + facing * INTERACT_FACING_WEIGHT
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

/** How an actor can open a keyed door (locked from the start, not by a survivor). */
export type DoorKeys = {
  access(actor: InteractActorState): { key: boolean; pry: boolean }
  open(actor: InteractActorState, door: Door, how: "unlock" | "pry"): { handled: boolean; noise?: number }
}

function doorActions(door: Door, actor?: InteractActorState, keys?: DoorKeys): { primary: InteractAction; secondary?: InteractAction; actions: InteractAction[] } {
  if (door.locked && door.keyed) {
    const can = actor && keys ? keys.access(actor) : { key: false, pry: false }
    const primary: InteractAction = can.key ? { id: "unlock", label: "Unlock with key" } : can.pry ? { id: "pry", label: "Pry open" } : { id: "locked", label: "Locked" }
    const secondary: InteractAction | undefined = can.key && can.pry ? { id: "pry", label: "Pry open", hold: true } : undefined
    return { primary, secondary, actions: secondary ? [primary, secondary] : [primary] }
  }
  if (door.locked) {
    const unlock: InteractAction = { id: "lock", label: "Unlock" }
    return { primary: unlock, actions: [unlock] }
  }
  const primary: InteractAction = { id: "toggle", label: door.open ? "Close" : "Open" }
  const secondary: InteractAction = { id: "lock", label: "Lock", hold: true }
  return { primary, secondary, actions: [primary, secondary] }
}

/** Outside doors (not a store's back room or a bedroom) have a peephole: Shift+E looks through it while shut. */
const hasPeephole = (door: Door) => !door.open && !door.id.endsWith("-room")

function windowActions(
  win: WindowOpening,
  actor: InteractActorState,
): { primary: InteractAction; secondary?: InteractAction; actions: InteractAction[] } {
  const isPeekingThis = actor.peekingWindowId === win.id
  if (!win.open) {
    const primary: InteractAction = { id: "peek", label: isPeekingThis ? "Stop peeking" : "Peek" }
    if (!win.openable) {
      return { primary, actions: [primary] }
    }
    const secondary: InteractAction = { id: "toggle", label: "Open", hold: true }
    return { primary, secondary, actions: [primary, secondary] }
  }

  // Open window: primary action is Climb, secondary action is Hold E to Close.
  const primary: InteractAction = { id: "climb", label: "Climb" }
  if (!win.openable) {
    return { primary, actions: [primary] }
  }
  const secondary: InteractAction = { id: "toggle", label: "Close", hold: true }
  return { primary, secondary, actions: [primary, secondary] }
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

export const doorInteractionHandler: InteractionHandler = createDoorHandler()

/** Doors: open, close, lock; keyed doors open with a key or a crowbar when `keys` is given. */
export function createDoorHandler(keys?: DoorKeys): InteractionHandler {
  return {
  kind: "door",
  candidates(town, actor) {
    const out: RawInteractCandidate[] = []
    for (const door of town.doors) {
      if (distToRect(actor.x, actor.y, door.rect) > INTERACT_RANGE) continue
      const { primary, secondary, actions } = doorActions(door, actor, keys)
      const peeking = actor.peekingWindowId === door.id
      const alt: InteractAction | undefined = hasPeephole(door) ? { id: "peek", label: peeking ? "Stop peeking" : "Peek", modifier: "shift" } : undefined
      out.push({
        kind: "door",
        id: door.id,
        rect: door.rect,
        worldX: (door.rect[0] + door.rect[2]) / 2,
        worldY: (door.rect[1] + door.rect[3]) / 2,
        // While peeking, E (or Shift+E) only stops.
        primary: peeking ? alt! : primary,
        secondary: peeking ? undefined : secondary,
        alt: peeking ? undefined : alt,
        actions: peeking ? [alt!] : alt ? [...actions, alt] : actions,
      })
    }
    return out
  },
  execute(town, actor, targetId, action) {
    const door = town.doors.find((d) => d.id === targetId)
    const dist = door ? distToRect(actor.x, actor.y, door.rect) : Infinity
    if (!door || dist > INTERACT_RANGE) return { handled: false }
    if (action === "peek") {
      if (actor.peekingWindowId === door.id) actor.peekingWindowId = null
      else if (hasPeephole(door)) {
        actor.peekingWindowId = door.id
        actor.peekOriginX = actor.x
        actor.peekOriginY = actor.y
        actor.peekOriginDist = dist
        actor.sprinting = false
      } else return { handled: false }
      return { handled: true, kind: "door", targetId: door.id, action: "peek", topologyChanged: false }
    }
    if (door.keyed && door.locked) {
      if (!keys || (action !== "unlock" && action !== "pry")) return { handled: false, kind: "door", targetId: door.id, action }
      const res = keys.open(actor, door, action)
      if (res.noise) actor.noise = Math.max(actor.noise, res.noise)
      return { handled: res.handled, kind: "door", targetId: door.id, action, topologyChanged: action === "unlock" && res.handled, noise: res.noise }
    }
    if (action === "lock") {
      if (door.open) {
        if (distToRect(actor.x, actor.y, door.rect) < 0.35) return { handled: false }
        door.open = false
        door.locked = true
        actor.peekingWindowId = null
        actor.noise = Math.max(actor.noise, DOOR_NOISE)
        return { handled: true, kind: "door", targetId: door.id, action: "lock", topologyChanged: true, noise: actor.noise }
      }
      door.locked = !door.locked
      actor.peekingWindowId = null
      actor.noise = Math.max(actor.noise, DOOR_NOISE * 0.7)
      return { handled: true, kind: "door", targetId: door.id, action: "lock", topologyChanged: false, noise: actor.noise }
    }
    if (action === "toggle") {
      if (door.locked) return { handled: false }
      if (door.open && distToRect(actor.x, actor.y, door.rect) < 0.35) return { handled: false }
      door.open = !door.open
      actor.peekingWindowId = null
      actor.noise = Math.max(actor.noise, DOOR_NOISE)
      return { handled: true, kind: "door", targetId: door.id, action: "toggle", topologyChanged: true, noise: actor.noise }
    }
    return { handled: false }
  },
  }
}

export const windowInteractionHandler: InteractionHandler = {
  kind: "window",
  candidates(town, actor) {
    const out: RawInteractCandidate[] = []
    for (const win of town.windows) {
      if (distToRect(actor.x, actor.y, win.rect) > INTERACT_RANGE) continue
      const { primary, secondary, actions } = windowActions(win, actor)
      out.push({
        kind: "window",
        id: win.id,
        rect: win.rect,
        worldX: (win.rect[0] + win.rect[2]) / 2,
        worldY: (win.rect[1] + win.rect[3]) / 2,
        buildingId: win.buildingId,
        buildingIndex: win.buildingIndex,
        primary,
        secondary,
        actions,
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
      if (!win.open && actor.peekingWindowId === win.id) {
        actor.peekingWindowId = null
      }
      actor.noise = Math.max(actor.noise, DOOR_NOISE)
      return { handled: true, kind: "window", targetId: win.id, action: "toggle", topologyChanged: true, noise: actor.noise }
    }
    if (action === "climb") {
      if (!win.open || actor.vault || actor.exhausted) return { handled: false }
      const dest = computeVaultDestination(town, win.rect, actor.x, actor.y, false)
      if (!dest) return { handled: false }
      actor.peekingWindowId = null
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
      const vaultAction: InteractAction = { id: "climb", label: "Vault" }
      out.push({
        kind: "fence",
        id,
        rect: localRect,
        worldX: nx,
        worldY: ny,
        primary: vaultAction,
        actions: [vaultAction],
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
 * Both primary (`E`) and secondary (`F` / Hold `E`) actions are exposed simultaneously on the returned target.
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
      const peekBoost = (raw.kind === "window" || raw.kind === "door") && actor.peekingWindowId === raw.id ? 10 : 0
      scored.push({
        ...raw,
        dist,
        facing,
        score: score + peekBoost + (raw.priority ?? 0),
        activeAction: raw.primary,
      })
    }
  }
  if (!scored.length) return undefined
  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}

/**
 * Executes the primary (`E`), secondary (`F`), or explicitly specified interaction action on the current target.
 */
export function executeInteraction(
  town: Town,
  actor: InteractActorState,
  slotOrAction?: "primary" | "secondary" | InteractActionId,
  registry: InteractionRegistry = defaultInteractionRegistry,
  interactHeld = false,
): InteractOutcome {
  if (actor.vault) return { handled: false }
  const target = selectInteractTarget(town, actor, registry)
  if (!target) {
    if (actor.peekingWindowId && (!slotOrAction || slotOrAction === "primary" || slotOrAction === "peek")) {
      actor.peekingWindowId = null
      return { handled: true, kind: "window", action: "peek" }
    }
    return { handled: false }
  }
  const handler = registry.get(target.kind)
  if (!handler) return { handled: false }
  let actionId: InteractActionId | undefined
  if (!slotOrAction || slotOrAction === "primary") {
    actionId = target.primary.id
    // On an open window (Climb vs Hold-E Close) or while already peeking a closed window (Stop peeking vs Hold-E Open),
    // defer the tap action until release if E is actively held down so a Hold-E gesture can complete without climbing/closing first.
    if (
      interactHeld &&
      target.secondary &&
      (target.deferPrimary || (target.kind === "window" && (target.primary.id === "climb" || actor.peekingWindowId === target.id)))
    ) {
      actor.holdTargetId = target.id
      actor.holdElapsed = 0
      actor.holdTriggered = false
      actor.holdPendingPrimary = target.primary.id
      return { handled: true, kind: target.kind, targetId: target.id, action: target.primary.id }
    }
  } else if (slotOrAction === "secondary") {
    actionId = target.secondary?.id
  } else {
    actionId = slotOrAction
  }
  if (!actionId) return { handled: false }
  actor.holdPendingPrimary = null
  return handler.execute(town, actor, target.id, actionId)
}

/**
 * Advances Hold-E timer (`HOLD_DURATION`) to trigger the target's secondary action (e.g. Lock door, Open/Close window),
 * or commits a deferred tap primary action when E is released before `HOLD_DURATION`.
 */
export function stepHoldInteraction(
  town: Town,
  actor: InteractActorState,
  interactHeld: boolean,
  dt: number,
  registry: InteractionRegistry = defaultInteractionRegistry,
): InteractOutcome {
  if (actor.vault) {
    actor.holdTargetId = null
    actor.holdElapsed = 0
    actor.holdTriggered = false
    actor.holdPendingPrimary = null
    return { handled: false }
  }
  if (!interactHeld) {
    if (actor.holdPendingPrimary && actor.holdTargetId && !actor.holdTriggered) {
      const pendingAction = actor.holdPendingPrimary
      const pendingTargetId = actor.holdTargetId
      actor.holdTargetId = null
      actor.holdElapsed = 0
      actor.holdTriggered = false
      actor.holdPendingPrimary = null
      const target = selectInteractTarget(town, actor, registry)
      if (target && target.id === pendingTargetId) {
        const handler = registry.get(target.kind)
        if (handler) return handler.execute(town, actor, target.id, pendingAction)
      }
    }
    actor.holdTargetId = null
    actor.holdElapsed = 0
    actor.holdTriggered = false
    actor.holdPendingPrimary = null
    return { handled: false }
  }
  const target = selectInteractTarget(town, actor, registry)
  if (!target || !target.secondary) {
    actor.holdTargetId = null
    actor.holdElapsed = 0
    actor.holdPendingPrimary = null
    return { handled: false }
  }
  if (actor.holdTargetId !== target.id) {
    actor.holdTargetId = target.id
    actor.holdElapsed = 0
    actor.holdTriggered = false
    actor.holdPendingPrimary = null
  }
  if (actor.holdTriggered) return { handled: false }
  actor.holdElapsed = Math.min(HOLD_DURATION, actor.holdElapsed + dt)
  if (actor.holdElapsed + 1e-6 >= HOLD_DURATION) {
    actor.holdTriggered = true
    actor.holdPendingPrimary = null
    const handler = registry.get(target.kind)
    if (handler) {
      return handler.execute(town, actor, target.id, target.secondary.id)
    }
  }
  return { handled: false }
}

/** Progress 0..1 of an in-flight Hold-E secondary interaction. */
export function holdProgress(actor: Pick<InteractActorState, "holdTargetId" | "holdElapsed" | "holdTriggered">): number {
  if (!actor.holdTargetId || actor.holdTriggered || actor.holdElapsed <= 0.04) return 0
  return Math.max(0, Math.min(1, actor.holdElapsed / HOLD_DURATION))
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
    const win = town.windows.find((w) => w.id === actor.peekingWindowId) ?? town.doors.find((d) => d.id === actor.peekingWindowId && !d.open)
    if (!win) {
      actor.peekingWindowId = null
    } else {
      const dist = distToRect(actor.x, actor.y, win.rect)
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

  return false
}

/** Computes the eye origin, localised cutaway bubble center, and camera lean for the currently peeked window. */
export function peekInfoFor(town: Town, actor: Pick<InteractActorState, "x" | "y" | "peekingWindowId">): PeekInfo | null {
  if (!actor.peekingWindowId) return null
  const win = town.windows.find((w) => w.id === actor.peekingWindowId) ?? doorPeephole(town, actor.peekingWindowId)
  if (!win) return null
  const building = town.buildings[win.buildingIndex]
  if (!building) return null
  const cone = "peephole" in win ? PEEPHOLE_CONE : PEEK_CONE
  const awareness = "peephole" in win ? PEEPHOLE_AWARENESS : PEEK_AWARENESS
  const [bx0, bz0, bx1, bz1] = building.rect
  const [x0, y0, x1, y1] = win.rect
  const horizontal = x1 - x0 > y1 - y0
  const wx = (x0 + x1) / 2
  const wy = (y0 + y1) / 2
  const insideBuilding = actor.x > bx0 && actor.x < bx1 && actor.y > bz0 && actor.y < bz1

  if (horizontal) {
    const lookingNorth = actor.y >= wy
    const dir = lookingNorth ? -1 : 1
    const eyeX = Math.max(x0 + 0.25, Math.min(x1 - 0.25, actor.x))
    // Through a window the eye sits in the opening, so both sides of the wall stay in its awareness; a peephole's eye
    // is just past the shut door, which blocks sight.
    const eyeY = "peephole" in win ? (dir < 0 ? y0 : y1) + dir * 0.35 : wy
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
      cone,
      awareness,
      camOffsetX: 0,
      camOffsetY: dir * 1.45,
      peephole: "peephole" in win,
    }
  } else {
    const lookingWest = actor.x >= wx
    const dir = lookingWest ? -1 : 1
    const split = bz0 + 5.6
    const inSouthRoom = actor.y >= split
    const eyeY = inSouthRoom ? Math.max(split + 0.42, Math.min(y1 - 0.2, actor.y)) : Math.min(split - 0.42, Math.max(y0 + 0.2, actor.y))
    const eyeX = "peephole" in win ? (dir < 0 ? x0 : x1) + dir * 0.35 : wx
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
      cone,
      awareness,
      camOffsetX: dir * 1.45,
      camOffsetY: 0,
      peephole: "peephole" in win,
    }
  }
}

/** A shut door seen as a window to peek through: its building is the one whose wall it sits in. */
function doorPeephole(town: Town, id: string): { id: string; rect: Rect; buildingId: string; buildingIndex: number; peephole: true } | null {
  const door = town.doors.find((d) => d.id === id)
  if (!door || door.open) return null
  const cx = (door.rect[0] + door.rect[2]) / 2
  const cy = (door.rect[1] + door.rect[3]) / 2
  let best = -1
  let bestD = 0.5
  town.buildings.forEach((b, i) => {
    const d = distToRect(cx, cy, b.rect)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  })
  return best < 0 ? null : { id: door.id, rect: door.rect, buildingId: town.buildings[best]!.id, buildingIndex: best, peephole: true }
}

/** Vertical vault hop over a window sill or fence (metres) for presentation. */
export function vaultLift(actor: Pick<InteractActorState, "vault">): number {
  if (!actor.vault) return 0
  const u = Math.max(0, Math.min(1, actor.vault.elapsed / actor.vault.duration))
  return Math.sin(u * Math.PI) * 0.58
}
