import { Box3, Mesh, MeshStandardMaterial, Vector3, type Object3D, type Material } from "three/webgpu"
import type { Player } from "../../player"
import type { WorldContext } from "../context"
import type { Builder } from "../interior/kit"
import type { Prop } from "../interior/props"
import { MODELS, type ModelName } from "../../render/models"
import { ITEMS, NOTES, addItem, addNote, bindPropPersistence, hasItem, type ItemId, type NoteId } from "../../game/inventory"
import { emitNoise } from "../../game/hunter/noise"
import { showSubtitle } from "../../game/shell/subtitles"
import { hooks } from "../../audio/hooks"
import { power } from "../power"
import { desk, filingCabinet, keyCabinet, lockerBank, mobileShelving, terminalHousing, wallSafe } from "./assemblies"
import { InteractiveWorld, type InteractiveState } from "./world"
import { InteractiveProp, type Item, type PropState } from "./prop"
import { Terminal } from "./terminal"
import { facilityServices } from "./services"
import { ThreeTerminal } from "./three-terminal"
import { visibleInHierarchy } from "../../gpu/world-bridge"
import { interiorDoors } from "../interior/registry"

export class FacilityInteractions {
  readonly world: InteractiveWorld
  readonly terminals: ThreeTerminal[] = []
  readonly initial = new Map<string, PropState>()
  readonly changedStoreys = new Set<number>()
  private readonly materials = new Map<string, Material>()
  simulation = true
  private readonly body = new Box3()
  private readonly at = new Vector3()

  constructor(private readonly ctx: WorldContext, readonly player: Player) {
    this.world = new InteractiveWorld(ctx, {
      body: () => {
        const p = player.pos, h = player.state.eyeHeight + 0.1
        return this.body.set(new Vector3(p.x - 0.29, p.y + 0.06, p.z - 0.29), new Vector3(p.x + 0.29, p.y + h, p.z + 0.29))
      },
      hasKey: hasItem,
      take: item => {
        if (item.id in NOTES) addNote(item.id as NoteId)
        else if (item.id in ITEMS) addItem(item.id as ItemId)
        else return false
        showSubtitle("", `Taken: ${item.label}`, 2.5)
        return true
      },
      event: event => {
        const prop = this.world.props.get(event.prop)
        if (!prop) return
        const p = prop.root.getWorldPosition(this.at)
        emitNoise(p, event.kind === "take" ? 2 : 8, "knock")
        hooks.sfx?.play(event.kind === "take" ? "int-paper" : "int-keys", { bus: "doors", pos: p, gain: 0.6, ref: 2 })
      },
      geometryChanged: storey => this.changedStoreys.add(storey),
    })
    bindPropPersistence({ save: () => this.world.save(), restore: state => this.restore(state) })
  }

  get focused() { return this.terminals.some(t => t.terminal.active) }
  get moving() { return [...this.world.props.values()].some(p => [...p.parts.values()].some(j => j.amount !== j.target)) }

  add(prop: InteractiveProp, parent: Object3D) {
    // Repeated fittings share material programs; moving trays/doors remain separate meshes.
    prop.root.traverse(node => {
      if (!(node instanceof Mesh) || !(node.material instanceof MeshStandardMaterial)) return
      const material = node.material, existing = this.materials.get(material.name)
      if (existing) { node.material = existing; material.dispose() }
      else this.materials.set(material.name, material)
    })
    this.world.add(prop, parent)
    this.initial.set(prop.id, prop.save())
    return prop
  }

  placeModel(b: Builder, name: ModelName, p: Prop): boolean {
    if (p.tilt || !["office_desk", "filing_cabinet", "filing_cabinet_open"].includes(name) || Math.abs(p.position[1] - 0.16) > 0.05) return false
    const cabinet = name !== "office_desk", id = `${cabinet ? "filing_cabinet" : name}@${b.storey}:${p.position[0].toFixed(2)},${p.position[2].toFixed(2)}`
    const placement = { id, storey: b.storey, x: p.position[0], z: p.position[2], yaw: (p.yaw ?? 0) + Math.PI }
    const note: Item = { id: `map-floor-${b.storey}`, kind: "map", label: `Storey ${b.storey} plan` }
    const prop = cabinet ? filingCabinet(placement, [note]) : desk(placement, [{ id: "note-shift", kind: "clipboard", label: "Shift clipboard" }, note])
    const size = MODELS[cabinet ? "filing_cabinet" : "office_desk"].size, scale = typeof p.scale === "number" ? p.scale : 1
    prop.root.scale.set(size[0] / (cabinet ? 0.545 : 1.5) * scale, size[1] / (cabinet ? 1.25 : 0.7825) * scale, size[2] / (cabinet ? 0.685 : 0.78) * scale)
    if (name === "filing_cabinet_open") { const part = prop.parts.get("drawer-0")!; part.amount = part.target = 1; prop.pose(part, 1) }
    this.add(prop, b.props)
    return true
  }

  lockers(b: Builder, x: number, z: number, yaw: number, n: number, first: number) {
    const forward = new Vector3(0, 0, -0.175).applyAxisAngle(new Vector3(0, 1, 0), yaw)
    const prop = lockerBank({ id: `lockers@${b.storey}:${x},${z}`, storey: b.storey, x: x + forward.x, z: z + forward.z, yaw: yaw + Math.PI }, n, first,
      number => [{ id: b.storey === 3 && number === 14 ? "badge-hargrove" : "keyring-misc", kind: b.storey === 3 && number === 14 ? "badge" : "key", label: b.storey === 3 && number === 14 ? "Hargrove's badge" : `Locker ${number} keys` }])
    return this.add(prop, b.props)
  }

  keyCabinet(b: Builder, wallX: number, y: number, z: number, security: boolean, side = -1) {
    const id = security ? "security-key-cabinet" : "facilities-key-cabinet", special = security ? 9 : 6
    const prop = keyCabinet({ id, storey: 0, x: wallX + side * 0.054, z, height: y - 0.16 - 0.25, yaw: side * Math.PI / 2, key: security ? undefined : "cabinet-key" },
      Array.from({ length: 10 }, (_, i) => ({ number: i + 1, item: { id: i + 1 === special ? (security ? "cabinet-key" : "truck-keys") : "keyring-misc", kind: "key" as const, label: i + 1 === special ? (security ? "Facilities cabinet key" : "Truck 2 keys") : `Hook ${i + 1} keys` } })))
    prop.root.scale.set(0.4 / 0.645, 0.5 / 0.75, 0.1 / 0.165)
    const target = prop.targets[0], use = target.use
    target.label = () => !security && !hasItem("cabinet-key") ? "Read cabinet key tag" : `${prop.parts.get("door")!.target ? "Close" : "Open"} key cabinet`
    target.use = () => {
      if (!security && !hasItem("cabinet-key")) { addNote("cabinet-tag"); showSubtitle("", "Cabinet key held at Security, 0-38.", 3); return true }
      return use()
    }
    this.add(prop, b.props)
    const socket = prop.sockets.get(`hook-${special}`)!, at = socket.node.getWorldPosition(new Vector3()).toArray() as [number, number, number]
    return { door: prop.parts.get("door")!.pivot, keys: socket.node, at, open: () => { prop.parts.get("door")!.target = 1 } }
  }

  safe(b: Builder, x: number, z: number, yaw: number) {
    const prop = wallSafe({ id: "director-safe", storey: 4, x, z, yaw: yaw + Math.PI, combination: [2, 4, 7] }, [{ id: "map-floor-4", kind: "map", label: "Directorate plan" }, { id: "note-woods", kind: "clipboard", label: "North-array memorandum" }])
    prop.root.scale.set(0.75 / 0.645, 1.05 / 0.6, 0.7 / 0.405)
    this.add(prop, b.props)
  }

  shelving(b: Builder, x: number, direction: number) {
    const prop = mobileShelving({ id: `records-carriage:${x}`, storey: 1, x, z: -15.45 }, 1.1, 11.9)
    prop.root.scale.set(0.94, 2.3 / 2.23, 1)
    const part = prop.parts.get("carriage")!
    if (part.motion.kind === "slide") part.motion.offset.x *= direction
    this.add(prop, b.props)
  }

  terminal(b: Builder, id: string, x: number, y: number, z: number, yaw: number) {
    const base = facilityServices({ world: this.world, doors: this.ctx.doors, powered: () => power.on,
      allowedDoors: new Set(interiorDoors.filter(d => d.storey === b.storey).map(d => d.id)),
      logs: () => [{ id: "terminal-safe", text: "4-16 FILES SAFE / RESET 2-4-7" }, { id: "cabinet-tag", text: "FAC. CAB. KEY / SECURITY 0-38 / HOOK 9" }],
      specimens: () => [{ id: "terminal-specimens", text: "2-06 COLD / 2-07 ARCHIVE / 2-10 CONTAINMENT" }],
    })
    const terminal = new Terminal(id, { ...base,
      lockers: () => [{ id: "terminal-lockers", text: "HARGROVE / LOCKER 14 / OPERATORS 3-20" }, ...[...this.world.props.values()].filter(p => p.hidingCompartments.length).flatMap(p => [...p.parts.values()].map(part => ({ id: `${p.id}/${part.id}`, text: `STOREY ${p.storey} / ${part.label.toUpperCase()}` })))],
      discover: (row, page) => { const id = page === "lockers" ? "terminal-lockers" : row.id; if (id in NOTES) { addNote(id as NoteId); showSubtitle("", "Copied to your clipboard.", 2) } },
    })
    const housing = terminalHousing({ id, storey: b.storey, x, z, height: y - 0.16, yaw: yaw + Math.PI }, terminal)
    this.add(housing.prop, b.props)
    const view = new ThreeTerminal(this.ctx, terminal, housing.glass, b.storey)
    this.terminals.push(view)
    return view
  }

  update(dt: number) {
    if (this.simulation) this.world.update(dt)
    for (const view of this.terminals) {
      view.glass.getWorldPosition(this.at)
      const visible = visibleInHierarchy(view.glass) && this.at.distanceTo(this.ctx.camera.position) < 14
      view.update(dt, visible)
    }
  }

  restore(state?: InteractiveState) {
    for (const view of this.terminals) view.terminal.leave()
    const saved = new Map(state?.props.map(p => [p.id, p]) ?? [])
    this.world.restore({ version: 1, props: [...this.initial].map(([id, baseline]) => saved.get(id) ?? baseline) })
  }
}
