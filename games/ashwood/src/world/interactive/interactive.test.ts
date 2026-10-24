import { describe, expect, test } from "bun:test"
import { Box3, BoxGeometry, Matrix4, Scene, Vector3 } from "three/webgpu"
import { packWorldGeometry } from "../../gpu/world-bridge"
import { desk, filingCabinet, keyCabinet, locker, mobileShelving, wallSafe } from "./assemblies"
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
