import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { BARRICADE_DURATION, PISTOL_RELOAD_TIME, SEARCH_DURATION } from "../shared/combat"
import { LocalSession, type Command } from "../shared/session"
import { ActorFeedback, lootCallout } from "../src/hud/actor-feedback"
import { CalloutModel, FADE_OUT, type CalloutKind } from "../src/hud/callouts"

describe("callout model", () => {
  test("stacks newest on top, keeps progress nearest the head, and caps the stack", () => {
    const m = new CalloutModel({ durationScale: 1, maxVisible: 3 })
    m.callout("a", "Reloading", "progress", { key: "reload", progress: 0.2 })
    m.callout("a", "+6 9mm", "result")
    m.callout("a", "+1 plank", "result")
    m.advance(0.01)
    const slots = Object.fromEntries(m.forActor("a").map((c) => [c.text, c.slot]))
    expect(slots).toEqual({ Reloading: 0, "+6 9mm": 1, "+1 plank": 2 })

    m.callout("a", "Out of ammo", "warning")
    m.advance(0.01)
    const texts = m.forActor("a").map((c) => c.text)
    expect(texts).toContain("Reloading")
    expect(texts).not.toContain("+6 9mm")
    expect(m.forActor("a").find((c) => c.text === "Out of ammo")!.slot).toBe(2)
  })

  test("keyed callouts update in place and progress ends when refreshes stop", () => {
    const m = new CalloutModel()
    m.callout("a", "Searching shelf", "progress", { key: "channel", progress: 0.1 })
    m.advance(0.1)
    m.callout("a", "Searching shelf", "progress", { key: "channel", progress: 0.6 })
    expect(m.items).toHaveLength(1)
    expect(m.items[0]!.progress).toBeCloseTo(0.6)
    m.callout("a", "Nothing here", "info", { key: "channel" })
    expect(m.items).toHaveLength(1)
    expect(m.items[0]!.kind).toBe("info")
    m.advance(5)
    expect(m.items).toHaveLength(0)

    m.callout("a", "Reloading", "progress", { key: "reload", progress: 0.5 })
    m.advance(0.3 + FADE_OUT + 0.01)
    expect(m.items).toHaveLength(0)
  })

  test("actors stack independently and duration scale applies", () => {
    const m = new CalloutModel({ durationScale: 2, maxVisible: 2 })
    m.callout("a", "Shove", "info")
    m.callout("b", "Shove", "info")
    m.advance(1.3)
    expect(m.items).toHaveLength(2)
    expect(m.items.every((c) => c.slot === 0)).toBe(true)
    m.advance(1.5 + FADE_OUT)
    expect(m.items).toHaveLength(0)
  })

  test("result pops float up; reduced motion keeps them still", () => {
    const m = new CalloutModel()
    const c = m.callout("a", "+6 9mm", "result")
    m.advance(1)
    expect(m.drift(c)).toBeGreaterThan(0.1)
    expect(m.drift(c, true)).toBe(0)
  })
})

describe("actor feedback from simulation state", () => {
  type Seen = { text: string; kind: CalloutKind }
  const setup = () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const seen: Seen[] = []
    const fb = new ActorFeedback((text, kind) => seen.push({ text, kind }))
    const observe = () =>
      fb.observe(session.view.player, {
        time: session.view.time,
        town: session.view.town,
        prompt: session.view.prompt,
        inventory: session.view.inventory,
        noises: session.view.noises,
        noiseSource: "player",
        lowBattery: 0.25,
        reloadKey: "P",
      })
    const step = (cmd: Partial<Command> = {}, n = 1) => {
      for (let i = 0; i < n; i++) {
        session.update(TICK_DT, { mx: 0, my: 0, aim: session.view.player.aim, interact: false, ...cmd }, 0)
        observe()
      }
    }
    observe()
    return { session, seen, step, texts: () => seen.map((s) => s.text) }
  }

  test("reload shows progress then the loaded count", () => {
    const { session, seen, step } = setup()
    session.view.player.magAmmo = 2
    step({ reload: true })
    expect(seen.at(-1)).toEqual({ text: "Reloading", kind: "progress" })
    step({}, Math.ceil(PISTOL_RELOAD_TIME / TICK_DT) + 1)
    expect(seen.at(-1)).toEqual({ text: "Reloaded 8/8", kind: "result" })
  })

  test("search shows progress and item pops", () => {
    const { session, seen, step, texts } = setup()
    const p = session.view.player
    const c = session.view.containers.find((x) => x.ammo > 0 && x.planks > 0) ?? session.view.containers.find((x) => x.ammo > 0)!
    Object.assign(p, { x: c.x, y: c.y + 0.75, aim: -Math.PI / 2 })
    session.rebuildCollision()
    step({ interact: true, aim: -Math.PI / 2 })
    expect(seen.at(-1)!.kind).toBe("progress")
    expect(seen.at(-1)!.text).toMatch(/^Searching /)
    step({ aim: -Math.PI / 2 }, Math.ceil(SEARCH_DURATION / TICK_DT) + 2)
    expect(texts()).toContain(`+${c.ammo} 9mm`)
    if (c.planks) expect(texts()).toContain(`+${c.planks} plank${c.planks > 1 ? "s" : ""}`)
  })

  test("barricade shows progress then the plank count, and warns with no planks", () => {
    const { session, seen, step, texts } = setup()
    const p = session.view.player
    Object.assign(p, { x: 27.7, y: 36.2, aim: -Math.PI / 2 })
    session.rebuildCollision()
    step({ barricade: true })
    expect(seen).toContainEqual({ text: "Boarding up door", kind: "progress" })
    expect(seen).toContainEqual({ text: "Noise 10 m", kind: "noise" })
    step({}, Math.ceil(BARRICADE_DURATION / TICK_DT) + 2)
    expect(texts()).toContain("Boarded 1/3")
    p.planks = 0
    step({ barricade: true })
    expect(seen.at(-1)).toEqual({ text: "No planks", kind: "warning" })
  })

  test("doors, flashlight, slots, empty magazine and damage each report", () => {
    const { session, step, texts, seen } = setup()
    const p = session.view.player
    Object.assign(p, { x: 27.7, y: 36.2, aim: -Math.PI / 2 })
    session.rebuildCollision()
    step()
    step({ interact: true })
    expect(texts()).toContain("Door opened")
    step({ flashlight: true })
    expect(texts()).toContain("Flashlight off")

    p.magAmmo = 1
    p.reserveAmmo = 0
    step({ fire: true, aim: Math.PI / 2 })
    expect(seen.find((s) => s.text === "Out of ammo")?.kind).toBe("warning")
    expect(texts()).toContain("Noise 32 m")

    step({ hotbarSlot: 1 })
    expect(texts().some((t) => t === "9mm Pistol" || t === "Slot 2 empty")).toBe(true)

    p.health -= 12
    step()
    expect(seen.at(-1)).toEqual({ text: "\u221212 HP", kind: "danger" })
  })

  test("loot sentences map to short callouts", () => {
    expect(lootCallout("Found +6 9mm ammo")).toBeNull()
    expect(lootCallout("Searched nightstand: empty")?.text).toBe("Nothing here")
    expect(lootCallout("Out of 9mm ammo! Search houses (E) or shove (V)")).toEqual({ text: "Out of ammo", kind: "warning", key: "ammo" })
    expect(lootCallout("Blocked by barricade (2/3 planks)")?.text).toBe("Boarded up 2/3")
    expect(lootCallout("Already fully barricaded (3/3 planks)")?.text).toBe("Fully boarded")
  })
})
