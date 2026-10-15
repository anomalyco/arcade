import { describe, expect, test } from "bun:test"
import { checkScene, decodeSceneLink, emptyScene, encodeSceneLink, slug, type LabScene, type SceneCommand } from "./model"
import { CURRENT_LIGHTING, liftCommands, openCommands, sceneFromPreset, scenesFromTour, stageCommands } from "./migrate"
import { createSceneStore, memorySceneStorage, repoPath } from "./store"

const T0 = "2026-10-15T09:00:00.000Z"
const day = (n: number) => new Date(Date.parse(T0) + n * 24 * 3600 * 1000)

function scene(over: Partial<LabScene> = {}): LabScene {
  return { ...emptyScene({ id: "storm-street", collection: "weather", title: "Storm street", now: T0 }), ...over }
}

describe("scene model", () => {
  test("a well-formed scene passes and a bad one lists every problem", () => {
    expect(checkScene(scene()).ok).toBe(true)
    const bad = checkScene({ ...scene(), id: "Storm Street", stage: { sky: { part: "x" } }, settings: { a: Number.NaN }, things: [{ id: "a", part: "p" }, { id: "a", part: "p", at: [0, 1] }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.problems.join("\n")).toContain("id must be")
      expect(bad.problems.join("\n")).toContain("stage.sky is not a stage slot")
      expect(bad.problems.join("\n")).toContain("settings.a must be")
      expect(bad.problems.join("\n")).toContain('things[1].id "a" is used twice')
      expect(bad.problems.join("\n")).toContain("things[1].at must be three finite numbers")
    }
  })
  test("the opening variant and view must exist", () => {
    expect(checkScene(scene({ variant: "storm" })).ok).toBe(false)
    expect(checkScene(scene({ variants: [{ id: "storm", label: "Storm" }], variant: "storm" })).ok).toBe(true)
    expect(checkScene(scene({ view: "game" })).ok).toBe(false)
  })
  test("slugs are readable and unique", () => {
    expect(slug("Storm street")).toBe("storm-street")
    expect(slug("Storm street", ["storm-street", "storm-street-2"])).toBe("storm-street-3")
    expect(slug("  ")).toBe("scene")
  })
  test("a shared link comes back as a draft in Drafts", () => {
    const kept = scene({ status: "kept", settings: { intensity: 0.82, label: "Ünïcode ✓" } })
    const back = decodeSceneLink(encodeSceneLink(kept), T0)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.value.settings).toEqual(kept.settings)
      expect(back.value.collection).toBe("drafts")
      expect(back.value.status).toBe("draft")
    }
    expect(decodeSceneLink("not-a-scene", T0).ok).toBe(false)
  })
})

describe("scene store", () => {
  test("new scenes are drafts; keep, archive and restore move them through the lifecycle", () => {
    const store = createSceneStore({ storage: memorySceneStorage(), now: () => day(0) })
    const { ref } = store.create({ title: "Storm street", collection: "weather", host: { kind: "section", section: "weather" } })
    expect(ref).toBe("weather/storm-street")
    expect(store.get(ref)!.scene.status).toBe("draft")
    expect(store.keep(ref, { title: "Storm on the street" }).scene).toMatchObject({ status: "kept", title: "Storm on the street" })
    expect(store.archive(ref).scene.status).toBe("archived")
    expect(() => store.keep(ref)).toThrow("restore it first")
    expect(store.scenes({ collection: "weather" })).toHaveLength(0)
    expect(store.scenes({ collection: "weather", archived: true })).toHaveLength(1)
    expect(store.restore(ref).scene.status).toBe("kept")
    store.remove(ref)
    expect(store.get(ref)).toBeNull()
  })
  test("scenes survive a reload through storage", () => {
    const storage = memorySceneStorage()
    createSceneStore({ storage, now: () => day(0) }).create({ title: "Fog on the bay" })
    const again = createSceneStore({ storage, now: () => day(1) })
    expect(again.get("drafts/fog-on-the-bay")?.scene.title).toBe("Fog on the bay")
    expect(again.problems).toEqual([])
  })
  test("duplicating copies the scene as a new draft", () => {
    const store = createSceneStore({ storage: memorySceneStorage(), now: () => day(0) })
    const a = store.create({ title: "Storm street", collection: "weather" })
    store.save({ ...a.scene, settings: { intensity: 0.8 } })
    const b = store.create({ title: "Storm street", collection: "weather", from: a.ref })
    expect(b.ref).toBe("weather/storm-street-2")
    expect(b.scene.settings).toEqual({ intensity: 0.8 })
  })
  test("editing a repo scene keeps a local change that can be reverted; repo scenes can't be deleted here", () => {
    const repoScene = scene({ status: "kept" })
    const store = createSceneStore({ storage: memorySceneStorage(), repo: { scenes: [repoScene, { id: "broken" }] }, now: () => day(0) })
    expect(store.problems).toHaveLength(1)
    expect(store.get("weather/storm-street")!.source).toBe("repo")
    store.save({ ...repoScene, settings: { intensity: 1 } })
    expect(store.get("weather/storm-street")!.source).toBe("edited")
    expect(store.revert("weather/storm-street").scene.settings).toEqual({})
    expect(() => store.remove("weather/storm-street")).toThrow(repoPath(repoScene))
    const file = store.repoFile("weather/storm-street")
    expect(file.path).toBe("games/lab/scenes/weather/storm-street.scene.json")
    expect(JSON.parse(file.json)).toEqual(repoScene)
    expect(Object.keys(JSON.parse(file.json)).slice(0, 4)).toEqual(["schema", "id", "collection", "title"])
  })
  test("the sweep archives week-old drafts and deletes month-old archived scenes, never repo scenes", () => {
    const storage = memorySceneStorage()
    let t = day(0)
    const store = createSceneStore({ storage, repo: { scenes: [scene({ id: "repo-draft", status: "draft" })] }, now: () => t })
    const old = store.create({ title: "Old draft" })
    const kept = store.keep(store.create({ title: "Kept one" }).ref)
    t = day(8)
    expect(store.sweep()).toEqual({ archived: [old.ref], deleted: [] })
    expect(store.get(kept.ref)!.scene.status).toBe("kept")
    t = day(39)
    expect(store.sweep()).toEqual({ archived: [], deleted: [old.ref] })
    expect(store.get("weather/repo-draft")!.scene.status).toBe("draft")
  })
  test("archiving a collection archives its scenes; Drafts can't be archived", () => {
    const store = createSceneStore({ storage: memorySceneStorage(), now: () => day(0) })
    const review = store.createCollection({ title: "Splash rate review", kind: "review", board: { feature: "AR-19" } })
    store.create({ title: "Splash 1×", collection: review.id })
    store.create({ title: "Splash 2×", collection: review.id })
    expect(store.archiveCollection(review.id)).toEqual(["splash-rate-review/splash-1", "splash-rate-review/splash-2"])
    expect(store.collections().map(c => c.collection.id)).not.toContain(review.id)
    expect(store.collections({ archived: true }).find(c => c.collection.id === review.id)?.scenes).toHaveLength(2)
    expect(() => store.archiveCollection("drafts")).toThrow()
  })
  test("collections list scenes in their saved order", () => {
    const store = createSceneStore({
      storage: memorySceneStorage(),
      repo: {
        scenes: [scene({ id: "a", status: "kept" }), scene({ id: "b", status: "kept" })],
        collections: [{ schema: "arcade-lab-collection/v1", id: "weather", title: "Weather", kind: "feature", status: "active", order: ["b", "a"], created: T0, updated: T0 }],
      },
      now: () => day(0),
    })
    expect(store.collections().find(c => c.collection.id === "weather")!.scenes.map(e => e.scene.id)).toEqual(["b", "a"])
  })
})

describe("commands to stage and back", () => {
  test("presets, their tuning and set-param lift into stage and settings, and come back in the same order", () => {
    const list: SceneCommand[] = [
      { command: "look.preset", args: { preset: "noir" } },
      { command: "look.set", args: { key: "grain", value: 0.3 } },
      { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
      { command: "effect.trigger" },
    ]
    const lifted = liftCommands(list)
    expect(lifted).toEqual({ stage: { look: { part: "look:noir", settings: { grain: 0.3 } } }, set: { timeScale: 0 }, setup: [{ command: "effect.trigger" }] })
    expect([...stageCommands(lifted.stage), ...Object.entries(lifted.set).map(([key, value]) => ({ command: "scene.set-param", args: { key, value } })), ...lifted.setup]).toEqual(list)
  })
  test("lists out of that order stay commands", () => {
    const list: SceneCommand[] = [
      { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
      { command: "vignette.preset", args: { direction: "noir" } },
    ]
    expect(liftCommands(list)).toEqual({ stage: {}, set: {}, setup: list })
  })
  test("opening runs stage, values, host setup, then the variant", () => {
    const s = scene({
      host: { kind: "section", section: "weather", setup: [{ command: "effect.trigger" }] },
      stage: { weather: { part: "weather:rain" } },
      settings: { flashlightOn: true },
      variants: [{ id: "storm", label: "Storm", stage: { weather: { part: "weather:storm" } } }],
      variant: "storm",
    })
    expect(openCommands(s).map(c => c.command)).toEqual(["weather.preset", "scene.set-param", "effect.trigger", "weather.preset"])
  })
})

describe("migrations", () => {
  test("a version 1 preset becomes a draft with lighting, character and props", () => {
    const s = sceneFromPreset(
      { version: 1, section: "spawn", settings: { skidWidth: 0.3 }, lighting: { lampPower: 2 }, spawn: { characterId: "getaway:muscle", props: [{ kind: "cone", x: 1, y: 0, z: 2, yaw: 0.5 }] } },
      { id: "car-cones", title: "Car into cones", now: T0 },
    )
    expect(s.stage.lighting).toEqual({ part: CURRENT_LIGHTING, settings: { lampPower: 2 } })
    expect(s.things.map(t => t.part)).toEqual(["character:getaway:muscle", "prop:cone"])
    expect(stageCommands(s.stage)).toEqual([{ command: "scene.set-param", args: { key: "lampPower", value: 2 } }])
  })
  test("a tour keeps Lab steps as scenes and leaves page steps", () => {
    const { scenes, notes } = scenesFromTour(
      {
        id: "look-review",
        title: "Look review",
        steps: [
          { kind: "page", title: "Paint-over targets" },
          { kind: "grid", title: "Looks grid", url: "/arcade/lab/?section=looks", preset: "looks" },
          { title: "Vignette noir", url: "/arcade/lab/?game=outbreak&section=outbreak-vignette", setup: [{ command: "vignette.preset", args: { direction: "noir" } }], body: "Compare value structure." },
        ],
      },
      { collection: "look-review", now: T0 },
    )
    expect(scenes.map(s => s.id)).toEqual(["looks-grid", "vignette-noir"])
    expect(scenes[1]).toMatchObject({ games: ["outbreak"], stage: { look: { part: "vignette:noir" } }, note: "Compare value structure." })
    expect(notes).toHaveLength(1)
  })
})
