import { describe, expect, test } from "bun:test"
import { LabCommandRegistry, RADIAL_COMPASS } from "./lab-commands"
import {
  buildTourStepUrl,
  normalizeNoteArgs,
  normalizeNoteTarget,
  registerPanelLabCommands,
  registerStageCameraCommands,
  registerUiNoteCommand,
  resolveNavigationPath,
  resolveTourAssetUrl,
  validateTourDefinition,
  type DevNotePayload,
} from "./dev-control"
import { LabNavigation, type LabControl, type LabSettings } from "./lab-navigation"
import type { LabPanel } from "./lab-panel"
import type { Stage } from "./lab/stage"

describe("Canonical LabCommandRegistry with DevControl", () => {
  test("validates args schema, availability, undoable transactions, and returns state", () => {
    const registry = new LabCommandRegistry()
    let mode: "edit" | "play" = "edit"
    const executed: { id: string; args?: Record<string, unknown>; seed?: number }[] = []

    registry.register({
      id: "ground.spawn-here",
      label: "Spawn Prop Here",
      shortLabel: "Spawn",
      category: "Scene",
      undoable: true,
      args: {
        asset: { type: "string", required: true },
        at: { type: "string" },
        count: { type: "number", min: 1, max: 24 },
        shape: { type: "string", enum: ["one", "row", "grid"] },
      },
      enabled: () => mode !== "play",
      disabledReason: () => "Unavailable in Play mode",
      run: (ctx, args) => {
        if (args?.asset === "nonexistent") {
          throw new Error('Unknown spawn asset "nonexistent".')
        }
        executed.push({ id: "ground.spawn-here", args, seed: ctx?.seed })
        return { spawned: args?.asset, seed: ctx?.seed ?? 7 }
      },
    })

    // Unknown command
    const unknown = registry.invoke("does.not.exist")
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.code).toBe("unknown_command")
    }

    // Missing required arg
    const missing = registry.invoke("ground.spawn-here", {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.code).toBe("invalid_args")
      expect(missing.error).toContain('Missing required argument "asset"')
    }

    // Out-of-range arg
    const outOfRange = registry.invoke("ground.spawn-here", { asset: "cone", count: 99 })
    expect(outOfRange.ok).toBe(false)
    if (!outOfRange.ok) {
      expect(outOfRange.code).toBe("invalid_args")
      expect(outOfRange.error).toContain("<= 24")
    }

    // Invalid enum arg
    const badEnum = registry.invoke("ground.spawn-here", { asset: "cone", shape: "spiral" })
    expect(badEnum.ok).toBe(false)
    if (!badEnum.ok) {
      expect(badEnum.code).toBe("invalid_args")
      expect(badEnum.error).toContain("one, row, grid")
    }

    // Unknown arg key
    const unknownKey = registry.invoke("ground.spawn-here", { asset: "cone", extra: 123 })
    expect(unknownKey.ok).toBe(false)
    if (!unknownKey.ok) {
      expect(unknownKey.code).toBe("invalid_args")
      expect(unknownKey.error).toContain('Unknown argument "extra"')
    }

    // Domain validation error from run()
    const badAsset = registry.invoke("ground.spawn-here", { asset: "nonexistent" })
    expect(badAsset.ok).toBe(false)
    if (!badAsset.ok) {
      expect(badAsset.code).toBe("invalid_args")
    }

    // Valid execution with seed
    const ok = registry.invoke("ground.spawn-here", { asset: "hydrant", count: 3, seed: 42 })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.id).toBe("ground.spawn-here")
      expect(ok.result).toEqual({ spawned: "hydrant", seed: 42 })
    }
    expect(executed).toHaveLength(1)
    expect(executed[0]?.seed).toBe(42)

    // Unavailable in Play mode
    mode = "play"
    const blocked = registry.invoke("ground.spawn-here", { asset: "cone" })
    expect(blocked).toEqual({
      ok: false,
      id: "ground.spawn-here",
      code: "unavailable",
      error: "Unavailable in Play mode",
    })
  })

  test("resolves 8 fixed radial compass sectors keeping disabled commands in place", () => {
    const registry = new LabCommandRegistry()
    for (const { slot, compass } of RADIAL_COMPASS) {
      registry.register({
        id: `obj.slot.${slot}`,
        label: `Slot ${compass}`,
        shortLabel: compass,
        category: "Object",
        radial: { context: "object", slot },
        enabled: () => slot !== 1,
        disabledReason: () => "Only characters can be possessed",
        run: () => {},
      })
    }
    const ring = registry.resolveRadialRing("object")
    expect(ring).toHaveLength(8)
    expect(ring.map(s => s.angle)).toEqual([0, 45, 90, 135, 180, 225, 270, 315])
    expect(ring[1]?.enabled).toBe(false)
    expect(ring[1]?.disabledReason).toBe("Only characters can be possessed")
    expect(ring[2]?.enabled).toBe(true)
  })
})

describe("Shared Lab & Camera Commands", () => {
  test("registerPanelLabCommands reads and writes through LabNavigation with validation", () => {
    const settings: LabSettings = { shardSize: 1, surface: "glass", loop: true }
    const controls: LabControl[] = [
      { key: "shardSize", label: "Shard size", group: "Glass shards", min: 0.25, max: 3, step: 0.05, unit: "×" },
      {
        key: "surface",
        label: "Surface",
        group: "Emitter",
        options: [
          { value: "glass", label: "Glass pane" },
          { value: "metal", label: "Metal wall" },
        ],
      },
      { key: "loop", label: "Loop", group: "Emitter" },
    ]
    const navigation = new LabNavigation(settings, controls)
    const fakePanel = {
      navigation,
      sync() {},
      isInteracting: () => false,
    } as unknown as LabPanel

    const commands = new LabCommandRegistry()
    registerPanelLabCommands(commands, { getPanels: () => [fakePanel] })

    const getOne = commands.invoke("lab.get", { path: "Shard size" })
    expect(getOne.ok).toBe(true)
    if (getOne.ok) {
      expect((getOne.result as any).key).toBe("shardSize")
      expect((getOne.result as any).value).toBe(1)
    }

    const setRange = commands.invoke("scene.set-param", { key: "Glass shards.shardSize", value: 2.25 })
    expect(setRange.ok).toBe(true)
    expect(settings.shardSize).toBe(2.25)

    const outOfBounds = commands.invoke("scene.set-param", { key: "shardSize", value: 9.5 })
    expect(outOfBounds.ok).toBe(false)
    if (!outOfBounds.ok) expect(outOfBounds.code).toBe("invalid_args")

    const setSelectByLabel = commands.invoke("scene.set-param", { key: "surface", value: "Metal wall" })
    expect(setSelectByLabel.ok).toBe(true)
    expect(settings.surface).toBe("metal")
  })

  test("registerStageCameraCommands updates Stage spherical camera and frames targets", () => {
    const state = {
      focus: [0, 0, 0],
      camYaw: 0,
      camPitch: 0.7,
      camDist: 20,
      camCustom: false,
      eye: new Float32Array([0, 12, 16]),
      updateCamera() {},
      frameTarget(x: number, y: number, z: number, dist = 17) {
        state.focus[0] = x
        state.focus[1] = y
        state.focus[2] = z
        state.camDist = dist
        state.camCustom = true
      },
    }
    const fakeStage = state as unknown as Stage

    const commands = new LabCommandRegistry()
    registerStageCameraCommands(commands, {
      stage: fakeStage,
      render: () => {},
      resolveFrameTarget: id => (id === "hydrant" ? { x: 4, y: 0.5, z: -6, dist: 12 } : null),
    })

    const setRes = commands.invoke("camera.set", {
      orbit: 90,
      elevation: 45,
      distance: 14,
      targetX: 2,
      targetY: 1,
      targetZ: -3,
    })
    expect(setRes.ok).toBe(true)
    expect(fakeStage.focus).toEqual([2, 1, -3])
    expect(fakeStage.camDist).toBe(14)
    expect(fakeStage.camYaw).toBeCloseTo(Math.PI / 2, 4)

    const frameRes = commands.invoke("camera.set", { frame: "hydrant" })
    expect(frameRes.ok).toBe(true)
    expect(fakeStage.focus).toEqual([4, 0.5, -6])
    expect(fakeStage.camDist).toBe(12)
  })

  test("resolveNavigationPath resolves page shorthands and rejects unknown targets", () => {
    expect(resolveNavigationPath("hub")).toBe("/arcade/getaway/dev.html#games")
    expect(resolveNavigationPath("catalogue")).toBe("/arcade/getaway/dev.html#catalogue")
    expect(resolveNavigationPath("catalogue/getaway:muscle")).toBe("/arcade/getaway/dev.html#catalogue/getaway%3Amuscle")
    expect(resolveNavigationPath("lab")).toBe("/arcade/getaway/lab.html")
    expect(resolveNavigationPath("lab?section=looks")).toBe("/arcade/getaway/lab.html?section=looks")
    expect(resolveNavigationPath("blackout-lab")).toBe("/arcade/blackout/lab.html")
    expect(resolveNavigationPath("characters")).toBe("/arcade/blackout/characters.html")
    expect(resolveNavigationPath("getaway")).toBe("/arcade/getaway/?solo&seed=7")
    expect(() => resolveNavigationPath("unknown-page")).toThrow()
  })

  test("ui.note command validates title, target shapes, step badge, and clear", () => {
    const commands = new LabCommandRegistry()
    const state: { shown: DevNotePayload | null; docTitle: string } = {
      shown: null,
      docTitle: "Lab Workbench",
    }

    registerUiNoteCommand(commands, {
      onShow: note => {
        state.shown = note
        state.docTitle = note.title.startsWith("▸ ") ? note.title : `▸ ${note.title}`
        return { x: 120, y: 180, width: 88, height: 88, shape: "pill" }
      },
      onClear: () => {
        state.shown = null
        state.docTitle = "Lab Workbench"
      },
      getDocumentTitle: () => state.docTitle,
    })

    // Missing title fails validation
    const missingTitle = commands.invoke("ui.note", { body: "No title" })
    expect(missingTitle.ok).toBe(false)
    if (!missingTitle.ok) expect(missingTitle.code).toBe("invalid_args")

    // Invalid target field fails validation
    const badTarget = commands.invoke("ui.note", { title: "Bad target", target: { bogus: 123 } as any })
    expect(badTarget.ok).toBe(false)
    if (!badTarget.ok) expect(badTarget.code).toBe("invalid_args")

    // Invalid rect dimensions fail validation
    const badRect = commands.invoke("ui.note", { title: "Bad rect", target: { rect: [10, 20, -5, 40] } as any })
    expect(badRect.ok).toBe(false)
    if (!badRect.ok) expect(badRect.code).toBe("invalid_args")

    // Valid object target note
    const okNote = commands.invoke("ui.note", {
      title: "Car selected in Outliner",
      body: "Vehicle & skid controls prioritized in Details",
      step: "9/10",
      accent: "amber",
      target: { objectId: "character:active" },
    })
    expect(okNote.ok).toBe(true)
    if (okNote.ok) {
      expect(okNote.result.active).toBe(true)
      expect(okNote.result.documentTitle).toBe("▸ Car selected in Outliner")
      expect(okNote.result.step).toBe("9/10")
      expect(okNote.result.targetResolved).toBe(true)
    }
    expect(state.shown?.title).toBe("Car selected in Outliner")
    expect(state.shown?.target).toEqual({ objectId: "character:active" })

    // Target string shorthands normalize cleanly
    expect(normalizeNoteTarget("setting:skidWidth")).toEqual({ setting: "skidWidth" })
    expect(normalizeNoteTarget("rect:10,20,100,50")).toEqual({ rect: [10, 20, 100, 50] })
    expect(normalizeNoteTarget("world:27.7,1.2,38.5")).toEqual({ world: [27.7, 1.2, 38.5] })
    expect(normalizeNoteTarget("#prompt")).toEqual({ selector: "#prompt" })
    expect(normalizeNoteArgs({ clear: true })).toEqual({ clear: true })

    // Clear restores title and clears active note
    const cleared = commands.invoke("ui.note", { clear: true })
    expect(cleared.ok).toBe(true)
    expect(state.shown).toBeNull()
    expect(state.docTitle).toBe("Lab Workbench")
  })

  test("validateTourDefinition and buildTourStepUrl validate steps, setup commands, and tour query params", () => {
    const tour = validateTourDefinition(
      [
        {
          title: "Outbreak Dusk Street",
          body: "Flashlight cone at 18:00 dusk",
          url: "/arcade/outbreak/?seed=7",
          setup: [
            { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
            { command: "player.pose", x: 27.7, y: 41, aim: -1.5708 },
          ],
          target: { world: [27.7, 1, 38.5] },
        },
        {
          title: "Lab Looks A/B Wipe",
          url: "lab?section=looks",
          setup: [{ cmd: "look.preset", preset: "noir" }],
          target: "setting:compare",
        },
      ],
      "overnight",
    )

    expect(tour.id).toBe("overnight")
    expect(tour.steps).toHaveLength(2)
    expect(tour.steps[0]?.setup[1]).toEqual({
      command: "player.pose",
      args: { x: 27.7, y: 41, aim: -1.5708 },
    })
    expect(tour.steps[1]?.url).toBe("/arcade/getaway/lab.html?section=looks")
    expect(tour.steps[1]?.target).toEqual({ setting: "compare" })

    const step1Url = buildTourStepUrl("https://kits-mac-studio.taila8e7c7.ts.net:5180", tour.steps[0]!.url, tour.id, 1, false)
    expect(step1Url).toBe("https://kits-mac-studio.taila8e7c7.ts.net:5180/arcade/outbreak/?seed=7&tour=overnight&step=1")

    const step2SingleUrl = buildTourStepUrl("http://127.0.0.1:5180", "/arcade/getaway/lab.html?section=looks#looks", tour.id, 2, true)
    expect(step2SingleUrl).toBe("http://127.0.0.1:5180/arcade/getaway/lab.html?section=looks&tour=overnight&step=2&singleTab=1#looks")

    // Default singleTab is true
    expect(tour.singleTab).toBe(true)
    expect(buildTourStepUrl("http://127.0.0.1:5180", "/arcade/outbreak/?seed=7", tour.id, 1)).toBe(
      "http://127.0.0.1:5180/arcade/outbreak/?seed=7&tour=overnight&step=1&singleTab=1",
    )

    // Static "kind": "page" steps with markdown and images auto-resolve to /arcade/getaway/dev.html#tour/<id>/<step>
    const studioTour = validateTourDefinition(
      {
        id: "look-review",
        title: "Outbreak Look Review",
        steps: [
          {
            kind: "page",
            title: "Paint-Over Targets",
            markdown: "### Findings\n- **Value structure**: darkness owns the frame",
            images: [
              "street.png",
              { src: "target-noir-street.png", label: "Target · Noir Street", tag: "Noir", caption: "Dark frame" },
            ],
          },
          {
            title: "Vignette · Noir",
            url: "outbreak-lab",
          },
        ],
      },
      "look-review",
    )
    expect(studioTour.singleTab).toBe(true)
    expect(studioTour.steps[0]?.kind).toBe("page")
    expect(studioTour.steps[0]?.url).toBe("/arcade/getaway/dev.html#tour/look-review/1")
    expect(studioTour.steps[0]?.images).toEqual([
      { src: "street.png" },
      { src: "target-noir-street.png", label: "Target · Noir Street", tag: "Noir", caption: "Dark frame" },
    ])
    expect(resolveTourAssetUrl("look-review", "street.png")).toBe("/__arcade/tour-assets/look-review/street.png")
    expect(resolveNavigationPath("tour/look-review/1")).toBe("/arcade/getaway/dev.html#tour/look-review/1")

    // "kind": "grid" steps auto-resolve to /arcade/getaway/lab.html and append grid.open setup command
    const gridTour = validateTourDefinition(
      [
        {
          kind: "grid",
          title: "Looks Grid · 6 Style Directions",
          preset: "looks",
          section: "looks",
          cols: 3,
        },
        {
          kind: "grid",
          title: "Explosion Variants · 4 Live Recipes",
          preset: "explosions",
          section: "effects",
          cols: 2,
        },
      ],
      "grid-demo",
    )
    expect(gridTour.steps[0]?.kind).toBe("grid")
    expect(gridTour.steps[0]?.url).toBe("/arcade/getaway/lab.html")
    expect(gridTour.steps[0]?.setup).toEqual([
      {
        command: "grid.open",
        args: {
          title: "Looks Grid · 6 Style Directions",
          preset: "looks",
          section: "looks",
          cols: 3,
        },
      },
    ])
    expect(gridTour.steps[1]?.kind).toBe("grid")
    expect(gridTour.steps[1]?.preset).toBe("explosions")

    // Invalid tours throw descriptive errors
    expect(() => validateTourDefinition([])).toThrow(/non-empty 'steps'/)
    expect(() => validateTourDefinition([{ title: "", url: "lab" }])).toThrow(/missing a non-empty "title"/)
    expect(() => validateTourDefinition([{ title: "Bad URL", url: "not-a-valid-page" }])).toThrow(/Unknown page target/)
    expect(() => validateTourDefinition([{ title: "Bad Setup", url: "lab", setup: [{}] }])).toThrow(/missing "command"/)
  })
})
