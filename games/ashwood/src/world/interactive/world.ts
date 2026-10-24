import { Box3, Group, Ray, Vector3, type Camera, type Mesh } from "three/webgpu"
import type { Box, WorldContext } from "../context"
import type { DoorInternals } from "../../game/hunter/nav"
import { visibleInHierarchy } from "../../gpu/world-bridge"
import { InteractiveProp, type Item, type Part, type PropEvent, type PropState, type PropTarget } from "./prop"

export type InteractiveHost = {
  body: () => Box3
  hasKey: (id: string) => boolean
  take: (item: Item) => boolean
  event: (event: PropEvent) => void
  /** Invalidate hunter navigation after moving shelving, rather than leaving its old occupancy behind. */
  geometryChanged: () => void
}
export type InteractiveState = { version: 1; props: PropState[] }

export class InteractiveWorld {
  readonly root = new Group()
  readonly props = new Map<string, InteractiveProp>()
  private readonly boxes = new Map<Mesh, Box>()
  private readonly bounds = new Box3()
  private readonly point = new Vector3()
  private readonly ray = new Ray()
  private readonly cameraPosition = new Vector3()
  private readonly direction = new Vector3()
  private dirty = false

  constructor(private readonly ctx: Pick<WorldContext, "scene" | "colliders"> & Partial<Pick<WorldContext, "doors">>, private readonly host: InteractiveHost) {
    this.root.name = "interactive-props"
    ctx.scene.add(this.root)
  }

  add(prop: InteractiveProp): InteractiveProp {
    if (this.props.has(prop.id)) throw new Error(`Duplicate interactive prop ${prop.id}`)
    this.props.set(prop.id, prop)
    this.root.add(prop.root)
    prop.bind({ hasKey: this.host.hasKey, take: this.host.take, event: this.host.event, canMove: (p, part, next) => this.canMove(p, part, next) })
    prop.root.updateWorldMatrix(true, true)
    for (const mesh of prop.solids) {
      const box: Box = { min: [0, 0, 0], max: [0, 0, 0] }
      this.boxes.set(mesh, box)
      this.ctx.colliders.push(box)
      this.syncBox(mesh, box)
    }
    this.host.geometryChanged()
    return prop
  }

  private meshBounds(mesh: Mesh): Box3 {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    return this.bounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
  }

  private syncBox(mesh: Mesh, box: Box) {
    const b = this.meshBounds(mesh)
    box.min = [b.min.x, b.min.y, b.min.z]
    box.max = [b.max.x, b.max.y, b.max.z]
  }

  private canMove(prop: InteractiveProp, part: Part, next: number): boolean {
    const body = this.host.body()
    const moving = prop.solids.filter(mesh => {
      for (let node: Mesh | Group | null = mesh; node; node = node.parent as Group | null) if (node === part.pivot) return true
      return false
    })
    const before = moving.map(mesh => this.meshBounds(mesh).clone())
    const own = new Set(prop.solids.map(mesh => this.boxes.get(mesh)))
    prop.pose(part, next)
    let clear = true
    for (const [i, mesh] of moving.entries()) {
      const sweep = before[i].union(this.meshBounds(mesh))
      if (sweep.intersectsBox(body)) { clear = false; break }
      for (const box of this.ctx.colliders) {
        if (own.has(box)) continue
        const other = new Box3(new Vector3(...box.min), new Vector3(...box.max))
        if (sweep.intersectsBox(other)) { clear = false; break }
      }
      if (!clear) break
    }
    prop.pose(part, part.amount)
    if (clear) this.dirty = true
    return clear
  }

  update(dt: number): void {
    for (const prop of this.props.values()) {
      prop.update(dt)
      prop.root.updateWorldMatrix(true, true)
      for (const mesh of prop.solids) this.syncBox(mesh, this.boxes.get(mesh)!)
    }
    if (this.dirty) { this.dirty = false; this.host.geometryChanged() }
  }

  hiddenIn(): string | null {
    const body = this.host.body()
    for (const prop of this.props.values()) if (prop.hides(body)) return prop.id
    return null
  }

  /** The closest aimed handle/socket wins, provided no physical sheet or building wall intervenes. */
  target(camera: Camera, reach = 2.2): PropTarget | null {
    camera.getWorldPosition(this.cameraPosition)
    camera.getWorldDirection(this.direction)
    let best: PropTarget | null = null, score = Infinity
    for (const prop of this.props.values()) for (const target of prop.targets) {
      if (!target.available() || !visibleInHierarchy(target.node)) continue
      target.node.getWorldPosition(this.point)
      const distance = this.point.distanceTo(this.cameraPosition)
      if (distance > reach) continue
      const delta = this.point.clone().sub(this.cameraPosition)
      const along = delta.dot(this.direction)
      const off = delta.addScaledVector(this.direction, -along).length()
      if (along <= 0 || off > Math.max(0.035, distance * 0.13)) continue
      this.ray.set(this.cameraPosition, this.point.clone().sub(this.cameraPosition).normalize())
      const hit = new Vector3()
      const blocked = this.ctx.colliders.some(box => {
        this.bounds.set(new Vector3(...box.min), new Vector3(...box.max))
        return this.ray.intersectBox(this.bounds, hit) && hit.distanceTo(this.cameraPosition) < distance - 0.06
      }) || (this.ctx.doors?.all() as readonly DoorInternals[] | undefined)?.some(door => {
        const o = this.ray.origin, d = this.ray.direction
        const hit = door.ray(o.x, o.y, o.z, d.x, d.y, d.z)
        return hit >= 0 && hit < distance - 0.06
      })
      const rank = off / Math.max(distance, 0.01) + distance * 0.015
      if (!blocked && rank < score) { score = rank; best = target }
    }
    return best
  }

  save(): InteractiveState { return { version: 1, props: [...this.props.values()].map(p => p.save()) } }

  restore(state: InteractiveState): void {
    if (state.version !== 1) throw new Error("Unsupported interactive save version")
    for (const entry of state.props) {
      const prop = this.props.get(entry.id)
      if (!prop) throw new Error(`Unknown saved prop ${entry.id}`)
      prop.restore(entry)
    }
    this.update(0)
    this.host.geometryChanged()
  }

  dispose(): void {
    const owned = new Set(this.boxes.values())
    for (let i = this.ctx.colliders.length - 1; i >= 0; i--) if (owned.has(this.ctx.colliders[i])) this.ctx.colliders.splice(i, 1)
    for (const prop of this.props.values()) prop.dispose()
    this.props.clear(); this.boxes.clear(); this.root.removeFromParent()
    this.host.geometryChanged()
  }
}
