import { describe, expect, test } from "bun:test"
import { Box3, BoxGeometry, Float32BufferAttribute, Matrix4, Scene, Vector3 } from "three/webgpu"
import { packWorldGeometry, surfaceSections } from "../../gpu/world-bridge"
import { breaker, desk, filingCabinet, keyCabinet, locker, lockerBank, mobileShelving, wallSafe } from "./assemblies"
import { addNote, bindPropPersistence, hasNote, inventoryState, mapMarks, restoreInventory } from "../../game/inventory"
import { Terminal, type TerminalDoor } from "./terminal"
import { InteractiveWorld } from "./world"
import type { Box } from "../context"
import type { Item, PropEvent } from "./prop"

const key: Item = { id: "cabinet-key", kind: "key", label: "Facilities cabinet key" }
const placement = { id: "test", storey: 2, x: 3, z: 4 }
function harness() {
  let body = new Box3(new Vector3(100, 0, 100), new Vector3(101, 2, 101))
  const inventory = new Set<string>(), events: PropEvent[] = [], colliders: Box[] = []
  const world = new InteractiveWorld({ scene: new Scene(), colliders }, { body: () => body, take: item => { if (inventory.has(item.id)) return false; inventory.add(item.id); return true }, hasKey: id => inventory.has(id), event: e => events.push(e), geometryChanged: () => {} })
  return { world, inventory, events, colliders, body: (b: Box3) => { body = b }, advance: () => { for (let i = 0; i < 90; i++) world.update(1 / 60) } }
}

describe("articulated world", () => {
  test("contents move with a drawer, remain inaccessible when shut and cannot be collected twice", () => {
    const h = harness(), prop = h.world.add(desk(placement, [key])), socket = prop.sockets.get("drawer-0")!
    expect(prop.take(socket.id)).toBe(false)
    const before = socket.node.getWorldPosition(new Vector3())
    prop.toggle("drawer-0"); h.advance()
    const after = socket.node.getWorldPosition(new Vector3())
    expect(after.z - before.z).toBeCloseTo(0.66 * 0.85)
    expect(prop.take(socket.id)).toBe(true)
    expect(prop.take(socket.id)).toBe(false)
    expect(socket.node.visible).toBe(false)
    expect(h.events.filter(e => e.kind === "take")).toHaveLength(1)
    prop.toggle("drawer-0"); h.advance()
    expect(prop.parts.get("drawer-0")!.amount).toBe(0)
    h.world.dispose(); expect(h.colliders).toHaveLength(0)
  })

  test("cabinet drawers are independent and restore picked-up contents and intermediate poses", () => {
    const h = harness(), prop = h.world.add(filingCabinet(placement, [key]))
    prop.toggle("drawer-0"); h.advance(); prop.take("drawer-0")
    prop.toggle("drawer-1"); h.world.update(0.1)
    const saved = h.world.save()
    prop.toggle("drawer-2"); h.advance(); h.world.restore(saved)
    expect(prop.parts.get("drawer-1")!.amount).toBeCloseTo(0.18)
    expect(prop.parts.get("drawer-2")!.amount).toBe(0)
    expect(prop.sockets.get("drawer-0")!.node.visible).toBe(false)
    h.world.dispose()
  })

  test("locker has no solid across its interior and concealment requires a shut door", () => {
    const h = harness(), prop = h.world.add(locker({ ...placement, number: 14 }))
    const center = prop.root.localToWorld(new Vector3(0, 0.9, 0))
    expect(h.colliders.some(b => new Box3(new Vector3(...b.min), new Vector3(...b.max)).containsPoint(center))).toBe(false)
    expect(prop.hides(center)).toBe(true)
    prop.toggle("door"); h.advance(); expect(prop.hides(center)).toBe(false)
    h.world.dispose()
  })

  test("a player-sized body fits paired numbered lockers and closing both doors conceals it", () => {
    const h = harness(), prop = h.world.add(lockerBank({ ...placement, storey: 3 }, 6, 9, () => []))
    prop.toggle("locker-14"); prop.toggle("locker-13"); h.advance()
    const compartment = prop.hidingCompartments[0], center = compartment.volume.getCenter(new Vector3())
    for (const z of [0.9, 0.7, 0.5, 0.3, 0]) {
      const at = prop.root.localToWorld(new Vector3(center.x, 0, z))
      const path = new Box3(at.clone().add(new Vector3(-0.29, 0.06, -0.29)), at.clone().add(new Vector3(0.29, 1.75, 0.29)))
      expect(h.colliders.some(b => new Box3(new Vector3(...b.min), new Vector3(...b.max)).intersectsBox(path))).toBe(false)
    }
    const feet = prop.root.localToWorld(new Vector3(center.x, 0, 0))
    const body = new Box3(feet.clone().add(new Vector3(-0.29, 0.06, -0.29)), feet.clone().add(new Vector3(0.29, 1.75, 0.29)))
    h.body(body)
    expect(prop.hides(body)).toBe(false)
    prop.toggle("locker-14"); prop.toggle("locker-13"); h.advance()
    expect(prop.hides(body)).toBe(true)
    expect(h.world.hiddenIn()).toBe(prop.id)
    h.world.dispose()
  })

  test("shelving stops when a body occupies its swept path", () => {
    const h = harness(), prop = h.world.add(mobileShelving({ ...placement, storey: 1 }))
    prop.root.updateWorldMatrix(true, true)
    const at = prop.root.localToWorld(new Vector3(0.8, 1, 0))
    h.body(new Box3(at.clone().add(new Vector3(-0.3, -0.8, -0.3)), at.clone().add(new Vector3(0.3, 0.8, 0.3))))
    prop.toggle("carriage"); h.advance()
    expect(prop.parts.get("carriage")!.amount).toBeLessThan(0.2)
    h.world.dispose()
  })

  test("numbered key hooks and safe combination enforce their own local access rules", () => {
    const h = harness(), cabinet = h.world.add(keyCabinet({ ...placement, key: "door-key" }, [{ number: 7, item: key }]))
    expect(cabinet.toggle("door")).toBe(false)
    h.inventory.add("door-key"); expect(cabinet.toggle("door")).toBe(true); h.advance()
    expect(cabinet.take("hook-7")).toBe(true)
    const safe = h.world.add(wallSafe({ ...placement, id: "safe", x: 10, combination: [2, 4, 7] }))
    expect(safe.toggle("door")).toBe(false)
    safe.digits.splice(0, 3, 2, 4, 7); expect(safe.toggle("door")).toBe(true)
    h.world.dispose()
  })

  test("shelving also respects existing building walls", () => {
    const h = harness(), prop = h.world.add(mobileShelving({ ...placement, storey: 0 }))
    h.colliders.push({ min: [3.6, 0, 2], max: [3.7, 3, 6] })
    prop.toggle("carriage"); h.advance()
    expect(prop.parts.get("carriage")!.amount).toBeLessThan(0.2)
    h.world.dispose()
    expect(h.colliders).toHaveLength(1)
  })

  test("breaker restores circuit state as well as switch pose", () => {
    const h = harness()
    let power = true
    const prop = h.world.add(breaker(placement, on => { power = on }))
    prop.targets[0].use(); h.advance()
    expect(power).toBe(false)
    const saved = h.world.save()
    prop.targets[0].use(); h.advance()
    expect(power).toBe(true)
    h.world.restore(saved)
    expect(power).toBe(false)
    expect(prop.parts.get("switch")!.amount).toBe(1)
    h.world.dispose()
  })
})

test("terminal discoveries mark the clipboard and checkpoints restore physical drawers", () => {
  const h = harness(), prop = h.world.add(filingCabinet(placement))
  bindPropPersistence({ save: () => h.world.save(), restore: state => { if (state) h.world.restore(state) } })
  restoreInventory(undefined)
  const terminal = new Terminal("director", { powered: () => true, lockers: () => [], specimens: () => [], doors: () => [], setDoor: () => false,
    logs: () => [{ id: "terminal-safe", text: "4-16 / 2-4-7" }], discover: () => { addNote("terminal-safe") } })
  terminal.enter(); terminal.key("ArrowDown"); terminal.key("Enter"); terminal.key("Enter")
  expect(hasNote("terminal-safe")).toBe(true)
  expect(mapMarks().some(m => m.room === "4-16" && m.text.includes("2 / 4 / 7"))).toBe(true)
  prop.toggle("drawer-0"); h.advance()
  const saved = inventoryState()
  prop.toggle("drawer-0"); h.advance(); restoreInventory(saved)
  expect(prop.parts.get("drawer-0")!.amount).toBe(1)
  bindPropPersistence(null); restoreInventory(undefined); h.world.dispose()
})

test("terminal operates the live selected door, preserves locks, paginates and disconnects on power loss", () => {
  let power = true
  const doors: TerminalDoor[] = [{ id: "s0:0-38", label: "SECURITY", open: false, locked: true }, { id: "s2:2-06", label: "COLD ROOM", open: false, locked: false }]
  const commands: string[] = []
  const terminal = new Terminal("security-console", { powered: () => power, lockers: () => Array.from({ length: 14 }, (_, i) => ({ id: String(i), text: `LOCKER ${i}` })), logs: () => [], specimens: () => [], doors: () => doors,
    setDoor: (id, open) => { commands.push(id); doors.find(d => d.id === id)!.open = open; return true } })
  terminal.enter(); terminal.key("Enter")
  for (let i = 0; i < 11; i++) terminal.key("ArrowDown")
  expect(terminal.frame().lines[0]).toBe("LOCKER 10")
  terminal.key("Backspace"); terminal.key("ArrowDown"); terminal.key("ArrowDown"); terminal.key("Enter")
  terminal.frame(); terminal.key("Enter")
  expect(commands).toHaveLength(0)
  expect(terminal.status).toContain("ACCESS DENIED")
  terminal.key("ArrowDown"); terminal.frame()
  doors.reverse()
  terminal.key("Enter")
  expect(commands).toEqual(["s2:2-06"])
  expect(doors[0].open).toBe(true)
  power = false
  expect(terminal.frame().powered).toBe(false)
  expect(terminal.active).toBe(false)
  expect(terminal.enter()).toBe(false)
})

test("native bridge retains storey height, transformed normals and geometry groups", () => {
  const geometry = new BoxGeometry(2, 2, 2)
  const matrix = new Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 15.36, -4)
  const packed = packWorldGeometry(geometry, matrix, geometry.groups[0])
  expect(packed.byteLength).toBe(6 * 32)
  const data = new Float32Array(packed), normal = new Int8Array(packed)
  expect(data[1]).toBeCloseTo(16.36)
  expect(normal[14]).toBe(-127)
  expect(packWorldGeometry(geometry, matrix).byteLength).toBe(36 * 32)
  geometry.dispose()
})

test("merged interior paint keeps distinct metal and matte finishes and rejects released CPU buffers", () => {
  const geometry = new BoxGeometry(1, 1, 1).toNonIndexed()
  const count = geometry.getAttribute("position").count
  geometry.setAttribute("rm", new Float32BufferAttribute(Array.from({ length: count }, (_, i) => i < 6 ? [0.25, 0.8] : [0.9, 0]).flat(), 2))
  const sections = surfaceSections(geometry, { start: 0, count })
  expect(sections).toHaveLength(2)
  expect(sections[0].roughness).toBeCloseTo(0.25)
  expect(sections[0].metalness).toBeCloseTo(0.8)
  expect(sections[1].metalness).toBe(0)
  expect(sections.reduce((n, s) => n + s.span.count, 0)).toBe(count)
  expect(packWorldGeometry(sections[0].geometry, new Matrix4()).byteLength).toBe(6 * 32)
  const position = geometry.getAttribute("position") as Float32BufferAttribute
  position.array = new Float32Array(0)
  expect(() => packWorldGeometry(geometry, new Matrix4())).toThrow("before Ashwood releases")
  geometry.dispose()
})
