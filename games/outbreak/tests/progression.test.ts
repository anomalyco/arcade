import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { packCommand, unpackCommand } from "../shared/net-protocol"
import { DEFAULT_PROGRESSION_TUNING, lootSites, type LootSite } from "../shared/progression"
import { LocalSession, type Command } from "../shared/session"
import { makeTown } from "../shared/map"

const T = DEFAULT_PROGRESSION_TUNING

function setup() {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const progression = session.sim.progression
  const ledger = progression.ledger
  const p = session.view.player
  const step = (cmd: Partial<Command> = {}, n = 1) => {
    for (let i = 0; i < n; i++) session.update(TICK_DT, { mx: 0, my: 0, aim: p.aim, interact: false, ...cmd }, 0)
  }
  const give = (item: string, count = 1) => expect(ledger.apply({ kind: "grant", actor: "player", item, count }).ok).toBe(true)
  const notices = () => session.view.notices.splice(0).map((n) => n.text)
  const stand = (x: number, y: number, aim: number) => {
    Object.assign(p, { x, y, aim })
    session.rebuildCollision()
  }
  const fill = (site: LootSite, stacks: { item: string; count: number }[], revealed = false) => {
    const st = ledger.store(site.id)!
    st.slots.fill(null)
    stacks.forEach((s, i) => (st.slots[i] = { ...s }))
    st.revealed = revealed
  }
  const besideContainer = (kind: string) => {
    const c = session.view.containers.find((x) => x.kind === kind && x.buildingId === "ash")!
    stand(c.x, c.y + 0.75, -Math.PI / 2)
    return c
  }
  return { session, progression, ledger, p, step, give, notices, stand, fill, besideContainer }
}

describe("inventory baseline", () => {
  test("hand tools fill their own hotbar slots, supplies go on the belt, overflow goes in the pack", () => {
    const { session, ledger, give } = setup()
    expect(session.view.inventory.slots.map((s) => s?.kind ?? null)).toEqual(["flashlight", "pistol", null, null, null])
    expect(ledger.count("player/belt", "ammo")).toBe(6)
    expect(ledger.count("player/belt", "plank")).toBe(2)
    give("crowbar")
    give("medkit", 2)
    give("noisemaker")
    give("scrap", 3)
    give("key")
    expect(session.view.inventory.slots.map((s) => s?.kind ?? null)).toEqual(["flashlight", "pistol", "crowbar", "medkit", "noisemaker"])
    expect(session.view.inventory.slots[3]?.count).toBe(2)
    expect(ledger.count("player/belt", "scrap")).toBe(3)
    expect(ledger.count("player/belt", "key")).toBe(1)
    // A second melee tool has no free hand slot and goes in the pack; parts always do.
    give("spiked-board")
    give("toolbox")
    expect(ledger.store("player/pack")!.slots.map((s) => s?.item ?? null)).toEqual(["spiked-board", "toolbox", null, null])
    // Belt caps hold.
    expect(ledger.apply({ kind: "grant", actor: "player", item: "plank", count: 5 }).ok).toBe(false)
  })

  test("Tab pack: a digit swaps a pack slot into the selected hand slot", () => {
    const { session, ledger, give, step } = setup()
    for (const item of ["crowbar", "medkit", "noisemaker", "spiked-board"]) give(item)
    expect(ledger.store("player/pack")!.slots[0]?.item).toBe("spiked-board")
    step({ hotbarSlot: 2 })
    step({ pick: { mode: "pack", index: 0 } })
    expect(session.view.inventory.slots[2]?.kind).toBe("spiked-board")
    expect(ledger.store("player/pack")!.slots[0]?.item).toBe("crowbar")
  })

  test("quiet search and loud smash differ in time and noise; the contents stay visible until taken", () => {
    const { session, ledger, step, fill, besideContainer, notices } = setup()
    const dresser = besideContainer("dresser")
    fill(dresser, [{ item: "ammo", count: 5 }, { item: "medkit", count: 1 }])
    step({ interact: true })
    expect(session.view.player.channel?.label).toBe("Searching dresser")
    expect(session.view.noises.at(-1)?.radius).toBe(T.searchQuietNoise)
    step({}, Math.ceil(T.searchQuietTime / TICK_DT) + 1)
    expect(ledger.store(dresser.id)!.revealed).toBe(true)
    expect(notices()).toContain("Found 5 9mm, First Aid Kit")
    expect(session.view.prompt?.primary.id).toBe("take")

    const nightstand = besideContainer("nightstand")
    fill(nightstand, [{ item: "battery", count: 1 }])
    step({ interact: true, sprint: true })
    expect(session.view.player.channel?.label).toBe("Smashing nightstand")
    expect(session.view.noises.at(-1)?.radius).toBe(T.searchSmashNoise)
    step({}, Math.ceil(T.searchSmashTime / TICK_DT) + 1)
    expect(ledger.store(nightstand.id)!.revealed).toBe(true)
  })

  test("take one with a digit, take all with E, and 'Inventory full' when the belt cannot hold it", () => {
    const { ledger, step, fill, besideContainer, notices, give } = setup()
    const dresser = besideContainer("dresser")
    give("ammo", 12)
    fill(dresser, [{ item: "medkit", count: 1 }, { item: "ammo", count: 9 }], true)
    step({ pick: { mode: "take", index: 0 } })
    expect(ledger.count("player", "medkit")).toBe(1)
    notices()
    step({ interact: true })
    expect(ledger.count("player/belt", "ammo")).toBe(24)
    expect(ledger.count(dresser.id, "ammo")).toBe(3)
    expect(notices()).toEqual(["+6 9mm", "Inventory full"])
  })

  test("walking away or sprinting cancels a search", () => {
    const { ledger, step, fill, besideContainer, p } = setup()
    const dresser = besideContainer("dresser")
    fill(dresser, [{ item: "ammo", count: 5 }])
    step({ interact: true })
    expect(p.channel).not.toBeNull()
    p.x += 4
    step()
    expect(p.channel).toBeNull()
    step({}, Math.ceil(T.searchQuietTime / TICK_DT) + 1)
    expect(ledger.store(dresser.id)!.revealed).toBe(false)
  })

  test("medkit heals over a channel and refuses at full health", () => {
    const { p, step, give, notices, ledger } = setup()
    give("medkit")
    step({ hotbarSlot: 3 })
    step({ fire: true })
    expect(notices()).toContain("Not hurt")
    p.health = 40
    step({ fire: true })
    expect(p.channel?.kind).toBe("heal")
    step({}, Math.ceil(T.healTime / TICK_DT) + 1)
    expect(p.health).toBe(40 + T.medkitHeal)
    expect(ledger.count("player", "medkit")).toBe(0)
  })

  test("a crowbar hits harder than bare hands and can finish a wounded zombie", () => {
    const { session, step, give, stand } = setup()
    give("crowbar")
    stand(44, 44, 0)
    const z = session.ai.spawnZombie(session.view.town, 45.1, 44, "chase", Math.PI)
    z.hp = 20
    step({ hotbarSlot: 2 })
    step({ fire: true })
    step({}, 6)
    expect(z.state).toBe("dead")
  })

  test("a thrown noisemaker keeps calling the dead to where it landed", () => {
    const { session, progression, step, give, stand } = setup()
    give("noisemaker")
    stand(44, 44, 0)
    step({ hotbarSlot: 4 })
    step({ fire: true })
    expect(progression.lures).toHaveLength(1)
    const lure = progression.lures[0]!
    expect(lure.x).toBeGreaterThan(48)
    step({}, 90)
    const calls = session.view.noises.filter((n) => n.kind === "lure")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.radius).toBe(T.lureNoise)
    step({}, Math.ceil((T.lureSeconds + 1) / TICK_DT))
    expect(progression.lures).toHaveLength(0)
  })

  test("store back rooms open with a key (spent) or a crowbar (loud), and say so when you have neither", () => {
    const { session, ledger, step, give, notices, stand } = setup()
    const door = session.view.town.doors.find((d) => d.id === "hardware-room")!
    expect(door.locked && door.keyed).toBe(true)
    const cx = (door.rect[0] + door.rect[2]) / 2
    stand(cx + 0.7, door.rect[3] + 0.6, -Math.PI / 2)
    expect(session.view.prompt?.primary.label).toBe("Locked")
    step({ interact: true })
    expect(notices()).toContain("Locked. A key or a crowbar opens it")
    give("key")
    step()
    expect(session.view.prompt?.primary.id).toBe("unlock")
    step({ interact: true })
    expect(door.locked).toBe(false)
    expect(ledger.count("player", "key")).toBe(0)

    const pharmacy = session.view.town.doors.find((d) => d.id === "pharmacy-room")!
    give("crowbar")
    stand((pharmacy.rect[0] + pharmacy.rect[2]) / 2 + 0.7, pharmacy.rect[3] + 0.6, -Math.PI / 2)
    expect(session.view.prompt?.primary.id).toBe("pry")
    step({ interact: true })
    expect(session.view.noises.at(-1)?.radius).toBe(T.pryNoise)
    step({}, Math.ceil(T.pryTime / TICK_DT) + 1)
    expect(pharmacy.locked).toBe(false)
    expect(pharmacy.open).toBe(true)
  })

  test("G drops the held item where a teammate can pick it up; hold G leaves an ammo and plank bundle", () => {
    const { session, ledger, step, give, stand } = setup()
    give("medkit", 2)
    stand(44, 44, 0)
    step({ hotbarSlot: 3 })
    step({ drop: true })
    expect(ledger.count("player", "medkit")).toBe(1)
    const drop = [...ledger.stores.values()].find((s) => s.id.startsWith("drop:"))!
    expect(drop.slots[0]).toEqual({ item: "medkit", count: 1 })
    step({ bundle: true })
    expect(ledger.count("player/belt", "ammo")).toBe(0)
    expect(ledger.count("player/belt", "plank")).toBe(0)
    expect(session.view.prompt?.kind).toBe("drop")
  })

  test("Q pings what you face for the squad and it fades", () => {
    const { progression, step, fill, besideContainer } = setup()
    const dresser = besideContainer("dresser")
    fill(dresser, [{ item: "ammo", count: 6 }], true)
    step({ ping: true })
    expect(progression.pings).toHaveLength(1)
    expect(progression.pings[0]!.label).toBe("Dresser: 6 9mm")
    step({}, Math.ceil(7 / TICK_DT))
    expect(progression.pings).toHaveLength(0)
  })

  test("R with the flashlight in hand swaps in a spare battery", () => {
    const { p, ledger, step, give } = setup()
    give("battery")
    p.battery = 0.2
    step({ hotbarSlot: 0 })
    step({ reload: true })
    expect(p.battery).toBeGreaterThan(0.99)
    expect(ledger.count("player", "battery")).toBe(0)
  })

  test("barricading draws planks from the belt", () => {
    const { session, ledger, step, stand } = setup()
    stand(27.7, 36.2, -Math.PI / 2)
    step({ barricade: true })
    step({}, Math.ceil(T.barricadeTime / TICK_DT) + 1)
    expect(session.ai.getBarricadePlanks("ash-front")).toBe(1)
    expect(ledger.count("player/belt", "plank")).toBe(1)
  })
})

describe("safehouse workbench", () => {
  const atBench = (ctx: ReturnType<typeof setup>, hour = 12) => {
    const bench = ctx.progression.benches.find((b) => b.id === "bench:ash")!
    ctx.session.sim.hour = hour
    ctx.stand(bench.bench.x - 0.85, bench.bench.y, 0)
    return bench
  }

  test("every house archetype gets a bench and stash in its back room; stores do not", () => {
    const { progression, session } = setup()
    expect(progression.benches.map((b) => b.id)).toEqual(["bench:ash", "bench:elm"])
    for (const b of progression.benches) {
      const house = session.view.town.buildings.find((x) => x.id === b.buildingId)!
      expect(b.bench.y).toBeLessThan(house.rect[1] + 5.5)
      expect(b.stash.y).toBeLessThan(house.rect[1] + 5.5)
    }
  })

  test("the first scrap is noted for the squad but not announced (Discovered, Not Told)", () => {
    const { session, progression, give, notices } = setup()
    const mate = session.sim.addSurvivor("mate", 1)
    give("scrap", 2)
    give("battery")
    expect(notices()).toEqual([])
    expect(mate.notices).toEqual([])
    expect(progression.seen("scrap")).toBe(true)
  })

  test("at the bench E installs a carried toolbox (tier 2) without a word; the stash takes supplies but not ammo or keys", () => {
    const ctx = setup()
    const { ledger, progression, give, step, notices, session, stand } = ctx
    const mate = session.sim.addSurvivor("mate", 1)
    const bench = atBench(ctx)
    give("scrap", 4)
    give("key")
    give("toolbox")
    step()
    expect(session.view.prompt?.kind).toBe("bench")
    expect(session.view.prompt?.primary.id).toBe("install")
    step({ interact: true })
    expect(ledger.count("bench:ash", "toolbox")).toBe(1)
    expect(ledger.count("player/belt", "scrap")).toBe(4)
    expect(progression.tier("bench:ash")).toBe(2)
    expect(notices()).toEqual([])
    expect(mate.notices).toEqual([])
    stand(bench.stash.x + 0.8, bench.stash.y, Math.PI)
    expect(session.view.prompt?.kind).toBe("stash")
    step({ interact: true, interactAction: "deposit" })
    expect(ledger.count("bench:ash", "scrap")).toBe(4)
    expect(ledger.count("bench:ash", "plank")).toBe(2)
    expect(ledger.count("player", "ammo")).toBe(6)
    expect(ledger.count("player", "key")).toBe(1)
  })

  test("the generator lights the bench at night and hums loud enough to draw the dead", () => {
    const ctx = setup()
    const { ledger, progression, step, session } = ctx
    atBench(ctx, 23)
    ledger.apply({ kind: "grant", actor: "player", item: "car-battery", store: "bench:ash" })
    expect(progression.tier("bench:ash")).toBe(2)
    expect(progression.benchLight("bench:ash", 23, [])).toBeGreaterThan(T.researchLight)
    step({}, 4)
    const hum = session.view.noises.find((n) => n.kind === "generator")!
    expect(hum.radius).toBe(T.generatorNoise)
  })

  test("once learned, a teammate crafts it in the field from their own belt", () => {
    const ctx = setup()
    const { session, ledger, progression } = ctx
    ledger.apply({ kind: "grant", actor: "player", item: "learned:bandage", store: "team/known" })
    const mate = session.sim.addSurvivor("mate", 1)
    Object.assign(mate.survivor, { x: 60, y: 45 })
    ledger.apply({ kind: "grant", actor: "mate", item: "chem", count: 1 })
    expect(progression.craftable().map((r) => r.id)).toEqual(["bandage"])
    const cmd = { mx: 0, my: 0, aim: 0, interact: false }
    session.sim.stepSurvivor(mate, { ...cmd, pick: { mode: "craft", index: 0 } }, TICK_DT)
    expect(mate.survivor.channel).toBeNull()
    session.sim.stepWorld(TICK_DT, 0)
    expect(mate.survivor.channel?.kind).toBe("craft")
    for (let i = 0; i < Math.ceil(T.craftTime / TICK_DT) + 1; i++) {
      session.sim.stepSurvivor(mate, cmd, TICK_DT)
      session.sim.stepWorld(TICK_DT, 0)
    }
    expect(ledger.count("mate", "bandage")).toBe(1)
    expect(ledger.count("mate", "chem")).toBe(0)
    expect(mate.notices.map((n) => n.text)).toContain("Crafted Bandage")
  })

  test("a reinforced board costs a scrap and holds 80% more", () => {
    const { session, ledger, step, stand, give } = setup()
    ledger.apply({ kind: "grant", actor: "player", item: "learned:reinforced", store: "team/known" })
    give("scrap", 1)
    stand(27.7, 36.2, -Math.PI / 2)
    step({ barricade: true })
    step({}, Math.ceil(T.barricadeTime / TICK_DT) + 1)
    expect(session.ai.portalStates.get("ash-front")!.barricadeHp).toBe(T.reinforcedPlankHp)
    expect(ledger.count("player", "scrap")).toBe(0)
    step({ barricade: true })
    step({}, Math.ceil(T.barricadeTime / TICK_DT) + 1)
    expect(session.ai.portalStates.get("ash-front")!.barricadeHp).toBe(T.reinforcedPlankHp + 100)
  })

  test("the stash takes the held item, gives items back by digit, and keeps installed parts", () => {
    const ctx = setup()
    const { session, ledger, give, step, stand, progression, notices } = ctx
    const bench = progression.benches.find((b) => b.id === "bench:ash")!
    give("medkit")
    ledger.apply({ kind: "grant", actor: "player", item: "toolbox", store: "bench:ash" })
    stand(bench.stash.x + 0.8, bench.stash.y, Math.PI)
    expect(session.view.prompt?.kind).toBe("stash")
    step({ hotbarSlot: 3 })
    step({ interact: true })
    expect(ledger.count("bench:ash", "medkit")).toBe(1)
    expect(ledger.count("player", "medkit")).toBe(0)
    const order = progression.contents("bench:ash").map((s) => s.item)
    step({ pick: { mode: "take", index: order.indexOf("toolbox") } })
    expect(notices()).toContain("That part is installed in the bench")
    step({ pick: { mode: "take", index: order.indexOf("medkit") } })
    expect(ledger.count("player", "medkit")).toBe(1)
  })
})

describe("Lab tuning", () => {
  test("costs and times change live; a new loot rate restocks only unsearched containers", () => {
    const { progression, ledger, fill, session } = setup()
    const [searched, untouched] = session.view.containers.filter((c) => c.kind === "dresser")
    fill(searched!, [{ item: "ammo", count: 3 }], true)
    progression.setTuning({ costScale: 2, researchTime: 0.5, unrelatedLabKey: 7 })
    expect(ledger.rules.get("tinker:bandage")).toMatchObject({ duration: 0.5, consume: { chem: 2 } })
    expect(ledger.rules.get("craft:lure")!.consume).toEqual({ scrap: 2, battery: 2 })
    progression.setTuning({ lootRate: 0 })
    expect(ledger.count(searched!.id, "ammo")).toBe(3)
    expect(progression.contents(untouched!.id)).toEqual([])
    progression.setTuning({ lootRate: 2.5 })
    expect(progression.contents(untouched!.id).length).toBeGreaterThan(0)
  })
})

describe("loot from building archetypes", () => {
  test("every container is seeded from its building's table, deterministically, and the hardware back room holds the parts", () => {
    const town = makeTown(7, 7)
    const a = lootSites(town, T)
    const b = lootSites(makeTown(7, 7), T)
    expect(JSON.stringify(a.stores)).toBe(JSON.stringify(b.stores))
    const parts = a.stores.flatMap((s) => (s.initial as unknown as { item: string }[]).filter((x) => x.item === "toolbox" || x.item === "car-battery").map((x) => ({ item: x.item, at: s.at! })))
    expect(parts.map((x) => x.item).sort()).toEqual(["car-battery", "toolbox"])
    const hardware = town.buildings.find((x) => x.kind === "hardware")!
    for (const part of parts) {
      expect(part.at.x).toBeGreaterThan(hardware.rect[0])
      expect(part.at.y).toBeLessThan(hardware.rect[1] + 5.5)
    }
    const empty = lootSites(town, { ...T, lootRate: 0 })
    expect(empty.stores.every((s) => (s.initial as unknown[]).every((x) => (x as { item: string }).item === "toolbox" || (x as { item: string }).item === "car-battery"))).toBe(true)
  })
})

describe("wire", () => {
  test("new verbs survive the command tuple", () => {
    const c: Command = { mx: 0, my: 0, aim: 1, interact: false, drop: true, bundle: true, ping: true, pick: { mode: "craft", index: 2 } }
    const back = unpackCommand(JSON.parse(JSON.stringify(packCommand(c))))
    expect(back).toMatchObject({ drop: true, bundle: true, ping: true, pick: { mode: "craft", index: 2 } })
    expect(unpackCommand(packCommand({ mx: 0, my: 0, aim: 0, interact: false, pick: { mode: "take", index: 0 } })).pick).toEqual({ mode: "take", index: 0 })
  })
})
