import { Box3, Group, Matrix4, Mesh, Vector3, type Object3D } from "three/webgpu"

export type Item = { id: string; kind: "key" | "badge" | "clipboard" | "map"; label: string }
export type Motion = { kind: "slide"; offset: Vector3 } | { kind: "hinge"; axis: "x" | "y" | "z"; angle: number }
export type Part = { id: string; label: string; pivot: Group; motion: Motion; amount: number; target: number; origin: Vector3; restAngle: number; key?: string }
export type Socket = { id: string; node: Group; item: Item; part?: string; taken: boolean }
export type PropEvent = { kind: "move"; prop: string; part: string; open: boolean } | { kind: "take"; prop: string; socket: string; item: Item } | { kind: "breaker"; prop: string; on: boolean }
export type PropState = { id: string; parts: Record<string, { amount: number; target: number }>; taken: string[]; digits: number[]; powered: boolean }
export type PropTarget = { id: string; node: Object3D; label: () => string; use: () => boolean; available: () => boolean }
export type PropHost = {
  hasKey: (id: string) => boolean
  take: (item: Item) => boolean
  event: (event: PropEvent) => void
  /** Tests a candidate pose against the player and other dynamic bodies; never move through an occupant. */
  canMove: (prop: InteractiveProp, part: Part, next: number) => boolean
}

export class InteractiveProp {
  readonly root = new Group()
  readonly parts = new Map<string, Part>()
  readonly sockets = new Map<string, Socket>()
  readonly targets: PropTarget[] = []
  readonly solids: Mesh[] = []
  readonly digits = [0, 0, 0]
  hideVolume: Box3 | null = null
  hidingCompartments: { volume: Box3; doors: string[] }[] = []
  combination: readonly number[] | null = null
  powered = true
  onRestore?: () => void
  private host: PropHost | null = null

  constructor(readonly id: string, readonly storey: number) { this.root.name = id }

  bind(host: PropHost) { this.host = host }

  part(id: string, label: string, pivot: Group, motion: Motion, handle: Object3D, key?: string): Part {
    if (this.parts.has(id)) throw new Error(`Duplicate part ${this.id}/${id}`)
    const p: Part = { id, label, pivot, motion, amount: 0, target: 0, origin: pivot.position.clone(), restAngle: motion.kind === "hinge" ? pivot.rotation[motion.axis] : 0, key }
    this.parts.set(id, p)
    this.targets.push({ id: `${this.id}/${id}`, node: handle, label: () => `${p.target ? "Close" : "Open"} ${p.label}`, use: () => this.toggle(id), available: () => true })
    return p
  }

  socket(id: string, node: Group, item: Item, part?: string): Socket {
    if (this.sockets.has(id) || (part && !this.parts.has(part))) throw new Error(`Invalid socket ${this.id}/${id}`)
    const socket: Socket = { id, node, item, part, taken: false }
    this.sockets.set(id, socket)
    this.targets.push({ id: `${this.id}/item/${id}`, node, label: () => `Take ${item.label}`, use: () => this.take(id), available: () => this.accessible(socket) })
    return socket
  }

  private accessible(socket: Socket) {
    return !socket.taken && (!socket.part || (this.parts.get(socket.part)?.amount ?? 0) >= 0.65)
  }

  toggle(id: string): boolean {
    const p = this.parts.get(id)
    if (!p || !this.host || (p.key && !this.host.hasKey(p.key))) return false
    if (this.combination && !this.combination.every((digit, i) => this.digits[i] === digit)) return false
    p.target = p.target ? 0 : 1
    this.host.event({ kind: "move", prop: this.id, part: id, open: p.target === 1 })
    return true
  }

  take(id: string): boolean {
    const socket = this.sockets.get(id)
    if (!socket || !this.accessible(socket) || !this.host?.take(socket.item)) return false
    socket.taken = true
    socket.node.visible = false
    this.host.event({ kind: "take", prop: this.id, socket: id, item: socket.item })
    return true
  }

  pose(part: Part, amount: number): void {
    const motion = part.motion
    if (motion.kind === "slide") part.pivot.position.copy(part.origin).addScaledVector(motion.offset, amount)
    else part.pivot.rotation[motion.axis] = part.restAngle + motion.angle * amount
    part.pivot.updateWorldMatrix(true, true)
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return
    // Small collision-tested increments also cover a long frame without tunnelling through the player.
    const steps = Math.ceil(Math.min(dt, 0.2) / (1 / 60))
    const step = Math.min(dt, 0.2) / steps * 1.8
    for (const part of this.parts.values()) for (let i = 0; i < steps; i++) {
      const next = part.amount + Math.sign(part.target - part.amount) * Math.min(Math.abs(part.target - part.amount), step)
      if (next === part.amount) break
      if (this.host && !this.host.canMove(this, part, next)) { part.target = part.amount; break }
      part.amount = next
      this.pose(part, next)
    }
  }

  /** This is physical concealment: the actor must be inside and the door shut, not teleported to a hiding flag. */
  hides(worldPosition: Vector3 | Box3): boolean {
    this.root.updateWorldMatrix(true, false)
    const local = worldPosition instanceof Box3 ? worldPosition.clone().applyMatrix4(new Matrix4().copy(this.root.matrixWorld).invert()) : this.root.worldToLocal(worldPosition.clone())
    const compartments = this.hideVolume ? [{ volume: this.hideVolume, doors: [...this.parts.keys()] }] : this.hidingCompartments
    return compartments.some(c => c.doors.every(id => this.parts.get(id)!.amount < 0.08) && (local instanceof Box3 ? c.volume.containsBox(local) : c.volume.containsPoint(local)))
  }

  save(): PropState {
    return { id: this.id, parts: Object.fromEntries([...this.parts].map(([id, p]) => [id, { amount: p.amount, target: p.target }])), taken: [...this.sockets.values()].filter(s => s.taken).map(s => s.id), digits: [...this.digits], powered: this.powered }
  }

  restore(state: PropState): void {
    if (state.id !== this.id) throw new Error(`Wrong prop state for ${this.id}`)
    for (const [id, p] of this.parts) {
      const value = state.parts[id]
      if (!value || ![value.amount, value.target].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error(`Invalid part state ${id}`)
    }
    if (typeof state.powered !== "boolean" || state.digits.length !== 3 || state.digits.some(n => !Number.isInteger(n) || n < 0 || n > 9) || state.taken.some(id => !this.sockets.has(id))) throw new Error(`Invalid prop state ${this.id}`)
    for (const [id, p] of this.parts) { Object.assign(p, state.parts[id]); this.pose(p, p.amount) }
    for (const s of this.sockets.values()) { s.taken = state.taken.includes(s.id); s.node.visible = !s.taken }
    this.digits.splice(0, 3, ...state.digits)
    this.powered = state.powered
    this.onRestore?.()
  }

  dispose(): void {
    this.root.removeFromParent()
    const geometries = new Set<Mesh["geometry"]>(), materials = new Set<Mesh["material"]>()
    this.root.traverse(node => { if (node instanceof Mesh) { geometries.add(node.geometry); materials.add(node.material) } })
    geometries.forEach(g => g.dispose())
    materials.forEach(m => { for (const material of Array.isArray(m) ? m : [m]) material.dispose() })
  }
}
