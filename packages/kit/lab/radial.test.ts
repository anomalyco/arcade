import { expect, test } from "bun:test"
import { LabCommandRegistry, RADIAL_COMPASS } from "./commands"
import {
  classifyRadialDisplacement,
  clampRadialCenter,
  RADIAL_CAPTION_PX,
  RADIAL_DEAD_ZONE_PX,
  RADIAL_EDGE_MARGIN_PX,
  RADIAL_OUTER_PX,
  RadialMenuStateMachine,
  radialWedgePath,
} from "./radial"
import type { LabWorldObject } from "./types"

function createTestRegistry(log: string[]) {
  const reg = new LabCommandRegistry()
  reg.registerAll([
    // Object ring (0..7)
    {
      id: "object.trigger",
      label: "Trigger / Wake Object",
      shortLabel: "Trigger",
      category: "Object",
      shortcut: "Space",
      accelerators: ["space"],
      radial: { context: "object", slot: 0 },
      enabled: () => true,
      run: () => log.push("object.trigger"),
    },
    {
      id: "object.possess",
      label: "Possess Character",
      shortLabel: "Possess",
      category: "Mode",
      shortcut: "P",
      accelerators: ["p"],
      radial: { context: "object", slot: 1 },
      enabled: ctx => ctx?.pickedObject?.category === "character",
      disabledReason: () => "Only characters can be possessed",
      run: () => log.push("object.possess"),
    },
    {
      id: "object.duplicate",
      label: "Duplicate Object",
      shortLabel: "Duplicate",
      category: "Object",
      shortcut: "D",
      accelerators: ["d"],
      radial: { context: "object", slot: 2 },
      enabled: ctx => Boolean(ctx?.pickedObject?.deletable),
      disabledReason: () => "Fixed scene object cannot be duplicated",
      run: () => log.push("object.duplicate"),
    },
    {
      id: "object.inspect",
      label: "Inspect Object",
      shortLabel: "Inspect",
      category: "Inspector",
      shortcut: "I",
      accelerators: ["i"],
      radial: { context: "object", slot: 3 },
      enabled: () => true,
      run: () => log.push("object.inspect"),
    },
    {
      id: "object.delete",
      label: "Delete Object",
      shortLabel: "Delete",
      category: "Object",
      shortcut: "⌫",
      accelerators: ["backspace", "delete"],
      radial: { context: "object", slot: 4 },
      enabled: ctx => Boolean(ctx?.pickedObject?.deletable),
      disabledReason: () => "Fixed scene object",
      run: () => log.push("object.delete"),
    },
    {
      id: "object.reset",
      label: "Reset Transform",
      shortLabel: "Reset",
      category: "Object",
      shortcut: "0",
      accelerators: ["0"],
      radial: { context: "object", slot: 5 },
      enabled: ctx => Boolean(ctx?.pickedObject?.movable),
      disabledReason: () => "Fixed room specimen",
      run: () => log.push("object.reset"),
    },
    {
      id: "object.move",
      label: "Move Object",
      shortLabel: "Move",
      category: "Object",
      shortcut: "G",
      accelerators: ["g"],
      radial: { context: "object", slot: 6 },
      enabled: ctx => Boolean(ctx?.pickedObject?.movable),
      disabledReason: () => "Fixed room specimen",
      run: () => log.push("object.move"),
    },
    {
      id: "object.frame",
      label: "Frame Object",
      shortLabel: "Frame",
      category: "Scene",
      shortcut: "F",
      accelerators: ["f"],
      radial: { context: "object", slot: 7 },
      enabled: () => true,
      run: () => log.push("object.frame"),
    },

    // Empty-ground ring (0..7)
    {
      id: "ground.trigger-here",
      label: "Trigger FX Here",
      shortLabel: "Trigger FX",
      category: "Scene",
      shortcut: "Space",
      accelerators: ["space"],
      radial: { context: "ground", slot: 0 },
      enabled: () => true,
      run: () => log.push("ground.trigger-here"),
    },
    {
      id: "ground.spawn-char",
      label: "Spawn Character Here",
      shortLabel: "Possess",
      category: "Scene",
      shortcut: "P",
      accelerators: ["p"],
      radial: { context: "ground", slot: 1 },
      enabled: () => true,
      run: () => log.push("ground.spawn-char"),
    },
    {
      id: "ground.spawn-here",
      label: "Spawn Prop Here",
      shortLabel: "Spawn Here",
      category: "Scene",
      shortcut: "A",
      accelerators: ["a", "e"],
      radial: { context: "ground", slot: 2 },
      enabled: () => true,
      run: () => log.push("ground.spawn-here"),
    },
    {
      id: "ground.drop-light",
      label: "Drop Light Here",
      shortLabel: "Drop Light",
      category: "Scene",
      shortcut: "L",
      accelerators: ["l", "i"],
      radial: { context: "ground", slot: 3 },
      enabled: () => true,
      run: () => log.push("ground.drop-light"),
    },
    {
      id: "ground.clear",
      label: "Clear Transients",
      shortLabel: "Delete FX",
      category: "Scene",
      shortcut: "⌫",
      accelerators: ["backspace", "delete"],
      radial: { context: "ground", slot: 4 },
      enabled: () => true,
      run: () => log.push("ground.clear"),
    },
    {
      id: "ground.reroll",
      label: "Reroll Room Seed",
      shortLabel: "Reroll",
      category: "Scene",
      shortcut: "R",
      accelerators: ["r", "0"],
      radial: { context: "ground", slot: 5 },
      enabled: () => true,
      run: () => log.push("ground.reroll"),
    },
    {
      id: "ground.move-here",
      label: "Move Selected Here",
      shortLabel: "Move",
      category: "Object",
      shortcut: "G",
      accelerators: ["g"],
      radial: { context: "ground", slot: 6 },
      enabled: () => true,
      run: () => log.push("ground.move-here"),
    },
    {
      id: "ground.frame",
      label: "Frame Scene",
      shortLabel: "Frame",
      category: "Scene",
      shortcut: "F",
      accelerators: ["f"],
      radial: { context: "ground", slot: 7 },
      enabled: () => true,
      run: () => log.push("ground.frame"),
    },
  ])
  return reg
}

test("8 compass sectors stay at exact fixed angles across character, prop, fixed specimen, and ground", () => {
  const log: string[] = []
  const reg = createTestRegistry(log)

  const charObj: LabWorldObject = { id: "character:active", label: "Muscle", category: "character", x: 0, y: 0, z: 8, movable: true, deletable: false }
  const propObj: LabWorldObject = { id: "prop:0", label: "Hydrant #1", category: "prop", x: 0, y: 0, z: 2, movable: true, deletable: true }
  const specObj: LabWorldObject = { id: "specimen:glass", label: "Glass Pane", category: "specimen", x: 8.5, y: 0.9, z: 9, movable: false, deletable: false }

  const charRing = reg.resolveRadialRing("object", { pickedObject: charObj, groundHit: null })
  const propRing = reg.resolveRadialRing("object", { pickedObject: propObj, groundHit: null })
  const specRing = reg.resolveRadialRing("object", { pickedObject: specObj, groundHit: null })
  const groundRing = reg.resolveRadialRing("ground", { pickedObject: null, groundHit: { x: 0, y: 0, z: 0 } })

  for (const ring of [charRing, propRing, specRing, groundRing]) {
    expect(ring.map(s => s.angle)).toEqual([0, 45, 90, 135, 180, 225, 270, 315])
    expect(ring.map(s => s.compass)).toEqual(RADIAL_COMPASS.map(c => c.compass))
  }

  // Disabled slots stay in place without shifting neighbor indices
  expect(propRing[1]!.command.id).toBe("object.possess")
  expect(propRing[1]!.enabled).toBe(false)
  expect(propRing[2]!.command.id).toBe("object.duplicate")
  expect(propRing[2]!.enabled).toBe(true)
  expect(propRing[6]!.command.id).toBe("object.move")
  expect(propRing[6]!.enabled).toBe(true)

  expect(specRing[2]!.enabled).toBe(false)
  expect(specRing[4]!.enabled).toBe(false)
  expect(specRing[6]!.enabled).toBe(false)
  expect(specRing[0]!.enabled).toBe(true)
  expect(specRing[3]!.enabled).toBe(true)
  expect(specRing[7]!.enabled).toBe(true)
})

test("dead zone (<14px), active ring (14..220px), and outer cancel (>220px) classify accurately", () => {
  expect(classifyRadialDisplacement(0, 0).zone).toBe("deadzone")
  expect(classifyRadialDisplacement(9, -9).zone).toBe("deadzone") // hypot(9,9) = 12.7 < 14
  expect(classifyRadialDisplacement(0, -RADIAL_DEAD_ZONE_PX)).toMatchObject({ zone: "ring", slot: 0 })
  expect(classifyRadialDisplacement(40, -40)).toMatchObject({ zone: "ring", slot: 1 })
  expect(classifyRadialDisplacement(50, 0)).toMatchObject({ zone: "ring", slot: 2 })
  expect(classifyRadialDisplacement(40, 40)).toMatchObject({ zone: "ring", slot: 3 })
  expect(classifyRadialDisplacement(0, 50)).toMatchObject({ zone: "ring", slot: 4 })
  expect(classifyRadialDisplacement(-40, 40)).toMatchObject({ zone: "ring", slot: 5 })
  expect(classifyRadialDisplacement(-50, 0)).toMatchObject({ zone: "ring", slot: 6 })
  expect(classifyRadialDisplacement(-40, -40)).toMatchObject({ zone: "ring", slot: 7 })
  expect(classifyRadialDisplacement(0, -225).zone).toBe("cancel")
})

test("tap (<180ms, <8px) latches open; hold (>180ms) in dead zone cancels with 0 actions; hold-flick executes", () => {
  const log: string[] = []
  const reg = createTestRegistry(log)
  const sm = new RadialMenuStateMachine(reg)
  const propObj: LabWorldObject = { id: "prop:0", label: "Hydrant #1", category: "prop", x: 0, y: 0, z: 2, movable: true, deletable: true }

  // 1. Hold 250ms and release inside 14px dead zone -> cancel, 0 actions
  sm.openPointer(300, 300, 800, 600, 1000, { pickedObject: propObj, groundHit: null })
  sm.movePointer(305, 304)
  const cancelRes = sm.releasePointer(305, 304, 1250)
  expect(cancelRes.outcome).toBe("cancel")
  expect(sm.phase).toBe("closed")
  expect(log).toEqual([])

  // 2. Quick tap (<180ms, <8px) -> latches open, then accelerator 'g' executes Move (slot 6)
  sm.openPointer(300, 300, 800, 600, 2000, { pickedObject: propObj, groundHit: null })
  const tapRes = sm.releasePointer(302, 301, 2090)
  expect(tapRes.outcome).toBe("latched")
  expect(sm.phase).toBe("latched")
  const keyRes = sm.handleKey("g")
  expect(keyRes?.outcome).toBe("execute")
  if (keyRes?.outcome === "execute") keyRes.sector.command.run(sm.commandContext)
  expect(log).toEqual(["object.move"])

  // 3. Hold-flick East (slot 2) on ground -> executes Spawn Prop Here
  sm.openPointer(400, 300, 800, 600, 3000, { pickedObject: null, groundHit: { x: 0, y: 0, z: -4 } })
  sm.movePointer(460, 300)
  const flickRes = sm.releasePointer(460, 300, 3220)
  expect(flickRes.outcome).toBe("execute")
  if (flickRes.outcome === "execute") flickRes.sector.command.run(sm.commandContext)
  expect(log).toEqual(["object.move", "ground.spawn-here"])

  // 4. Clamping near viewport edges keeps the whole ring, plus the caption below it, on screen
  expect(clampRadialCenter(10, 15, 740, 720)).toEqual({ x: RADIAL_EDGE_MARGIN_PX, y: RADIAL_EDGE_MARGIN_PX })
  expect(clampRadialCenter(735, 715, 740, 720)).toEqual({
    x: 740 - RADIAL_EDGE_MARGIN_PX,
    y: 720 - RADIAL_EDGE_MARGIN_PX - RADIAL_CAPTION_PX,
  })
  expect(RADIAL_EDGE_MARGIN_PX).toBeGreaterThan(RADIAL_OUTER_PX)
})

test("pointer bearing drives the direction indicator only outside the dead zone", () => {
  const sm = new RadialMenuStateMachine(createTestRegistry([]))
  sm.openKeyboard(300, 300, 800, 600, 0, { pickedObject: null, groundHit: { x: 0, y: 0, z: 0 } })
  expect(sm.pointerAngle).toBeNull()
  sm.movePointer(305, 296)
  expect(sm.zone).toBe("deadzone")
  expect(sm.pointerAngle).toBeNull()
  sm.movePointer(340, 260)
  expect(sm.activeSlot).toBe(1)
  expect(sm.pointerAngle).toBeCloseTo(45, 5)
  sm.movePointer(300, 360)
  expect(sm.activeSlot).toBe(4)
  expect(sm.pointerAngle).toBeCloseTo(180, 5)
  sm.close()
  expect(sm.pointerAngle).toBeNull()
})

test("highlight wedge spans one 45 degree sector between the inner and outer radius", () => {
  const d = radialWedgePath(40, 110, 22.5)
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  // Outer arc starts at -22.5 deg on the outer radius and the path closes on the inner radius.
  expect(nums[0]).toBeCloseTo(-Math.sin((22.5 * Math.PI) / 180) * 110, 1)
  expect(nums[1]).toBeCloseTo(-Math.cos((22.5 * Math.PI) / 180) * 110, 1)
  expect(d.endsWith("Z")).toBe(true)
  // A gap insets both radial edges symmetrically.
  const inset = radialWedgePath(40, 110, 22.5, 2).match(/-?\d+(\.\d+)?/g)!.map(Number)
  expect(inset[0]).toBeGreaterThan(nums[0]!)
})

test("LabCommandRegistry invoke validates args schema, records undoable transactions, and returns serializable state()", () => {
  const log: string[] = []
  const transactions: string[] = []
  let sizeValue = 1
  const reg = createTestRegistry(log)
  reg.register({
    id: "scene.set-param",
    label: "Set Inspector Parameter",
    shortLabel: "Set Param",
    category: "Inspector",
    undoable: true,
    args: {
      key: { type: "string", required: true },
      value: { type: "number", required: true, min: 0.1, max: 10 },
    },
    enabled: () => true,
    run: (_ctx, args) => {
      if (args?.key === "size") sizeValue = Number(args.value)
    },
  })
  reg.configure({
    transact: (label, fn) => {
      transactions.push(label)
      fn()
    },
    getState: () => ({
      mode: "edit",
      section: "effects",
      environment: "yard",
      seed: 7,
      transport: { playing: false, loop: true, speed: 1, elapsed: 0.58, frames: 35 },
      camera: { focus: [0, 0, 0], yaw: 0, pitch: 0.75, distance: 15 },
      selection: { selectedIds: [], hoveredId: null, boxSelectMode: false },
      objects: [],
      settings: { size: sizeValue },
      lighting: {},
      compare: { activeSlot: "B", hasSlotA: true, wipeEnabled: false, frames: 35, diffs: [] },
      history: {
        canUndo: transactions.length > 0,
        canRedo: false,
        undoLabel: transactions.at(-1) ?? null,
        redoLabel: null,
        undoDepth: transactions.length,
        redoDepth: 0,
      },
    }),
  })

  // Missing or invalid args rejected cleanly without running command
  const bad = reg.invoke("scene.set-param", { key: "size", value: 99 })
  expect(bad.ok).toBe(false)
  expect(transactions).toEqual([])

  // Valid invocation runs through shared history transactor and returns updated state()
  const good = reg.invoke("scene.set-param", { key: "size", value: 2.5 })
  expect(good.ok).toBe(true)
  if (good.ok) {
    expect(good.undoable).toBe(true)
    expect(good.state?.settings.size).toBe(2.5)
    expect(good.state?.history.canUndo).toBe(true)
    expect(good.state?.history.undoLabel).toBe("Set Inspector Parameter")
    expect(good.state?.commands.some(c => c.id === "scene.set-param")).toBe(true)
  }
})

