import { describe, expect, test } from "bun:test"
import { CoopRoomCore, type Conn } from "../server/room-core"
import { createAIAgent, hasSeveredLeg, isTorsoCrawler, zombieTraitsFromSeed } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import {
  findFinisherTarget,
  MELEE_WEAPON_IDS,
  MELEE_WEAPONS,
  type MeleeWeaponId,
} from "../shared/combat"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { applyZombieState, decodeServerText, decodeSnapshot, packCommand, type ServerMsg } from "../shared/net-protocol"
import { LOOT_TABLES, OutbreakProgression } from "../shared/progression"
import { LocalSession, type Command } from "../shared/session"
import { SoundDirector, type SoundEvent } from "../src/audio/director"
import { soundWorld } from "../src/audio/world"
import { OutbreakCombatFX } from "../src/combat-fx"
import { ActorFeedback } from "../src/hud/actor-feedback"
import { Survivor, weaponWearStage } from "../src/survivor"
import { ZombieCrowdRenderer } from "../src/zombies"

function createSession() {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const progression = session.sim.progression
  const ledger = progression.ledger
  const p = session.view.player
  const step = (cmd: Partial<Command> = {}, n = 1) => {
    for (let i = 0; i < n; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: p.aim, interact: false, ...cmd }, 0)
    }
  }
  const equip = (weapon: MeleeWeaponId, durability = MELEE_WEAPONS[weapon].durability) => {
    const hb = ledger.store("player/hotbar")!
    hb.slots[2] = { item: weapon, count: 1, charge: durability }
    hb.selected = 2
    hb.rev = ++ledger.rev
    progression.project(session.slot)
  }
  const stand = (x: number, y: number, aim = 0) => {
    Object.assign(p, { x, y, vx: 0, vy: 0, aim })
    session.rebuildCollision()
  }
  return { session, progression, ledger, p, step, equip, stand }
}

describe("Melee weapons catalog & loot tables", () => {
  test("all 9 melee weapons are registered in the ledger with distinct stats and durability charges", () => {
    const { session, ledger, progression } = createSession()
    expect(MELEE_WEAPON_IDS).toEqual([
      "knife",
      "hammer",
      "pipe",
      "crowbar",
      "machete",
      "bat",
      "spiked-board",
      "axe",
      "fire-axe",
    ])
    for (const id of MELEE_WEAPON_IDS) {
      const def = MELEE_WEAPONS[id]
      const item = ledger.items.get(id)
      expect(item).toBeDefined()
      expect(item?.slot).toBe(2)
      expect(item?.charge?.max).toBe(def.durability)
      expect(item?.charge?.ammo).toBeUndefined()
      expect(def.damage).toBeGreaterThanOrEqual(18)
      expect(def.reach).toBeGreaterThan(1.3)
      expect(def.arc).toBeGreaterThan(1.0)
      expect(def.noise).toBeLessThan(12)
    }
    // Crowbar takes 4 light body hits (3-5 body hits, 2-3 headshots) to kill a 100 HP zombie, knocking back on every hit
    expect(MELEE_WEAPONS.crowbar.damage).toBe(24)
    expect(MELEE_WEAPONS.crowbar.knockback).toBeGreaterThan(1.5)
    // Granting a melee weapon places it in hotbar slot 2 with full durability
    expect(ledger.apply({ kind: "grant", actor: "player", item: "bat" }).ok).toBe(true)
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, hotbarSlot: 2 }, 0)
    expect(progression.heldUse("player")).toBe("melee")
    expect(session.view.player.meleeWeapon).toBe("bat")
    expect(session.view.player.meleeDurability).toBe(MELEE_WEAPONS.bat.durability)
  })

  test("loot tables place appropriate melee weapons in hardware, kitchens, garages/warehouses, and police", () => {
    const hardwareItems = (LOOT_TABLES.hardware?.shelf ?? []).map((r) => r.item)
    expect(hardwareItems).toEqual(expect.arrayContaining(["crowbar", "hammer", "pipe", "axe", "machete", "fire-axe"]))

    const kitchenItems = (LOOT_TABLES.house?.counter ?? []).map((r) => r.item)
    expect(kitchenItems).toContain("knife")
    const dinerKitchen = (LOOT_TABLES.diner?.counter ?? []).map((r) => r.item)
    expect(dinerKitchen).toEqual(expect.arrayContaining(["knife", "machete"]))

    const garageItems = (LOOT_TABLES.garage?.shelf ?? []).map((r) => r.item)
    expect(garageItems).toEqual(expect.arrayContaining(["pipe", "crowbar", "hammer", "axe"]))

    const policeItems = (LOOT_TABLES.police?.shelf ?? []).map((r) => r.item)
    expect(policeItems).toEqual(expect.arrayContaining(["bat", "crowbar", "machete", "fire-axe"]))
  })
})

describe("Melee attack input, combos, heavy charge, stamina & durability", () => {
  test("tap swings through windup -> active -> recovery, and chaining taps executes a 3-swing combo", () => {
    const { session, p, step, equip, stand } = createSession()
    equip("machete")
    stand(44, 44, 0)

    // Tap 1: starts combo 1 in windup
    step({ fire: true }, 1)
    expect(p.meleePhase).toBe("windup")
    expect(p.meleeCombo).toBe(1)

    // Advance into active frames, then queue combo 2
    step({}, 4)
    expect(p.meleePhase).toBe("active")
    step({ fire: true }, 1)
    expect(p.meleeComboQueued).toBe(true)

    // Advance until combo 2 starts
    for (let i = 0; i < 18 && p.meleeCombo === 1; i++) step({}, 1)
    expect(p.meleeCombo).toBe(2)
    expect(p.meleePhase).toBe("windup")

    // Advance into combo 2 active frames and queue combo 3 (overhead finisher)
    for (let i = 0; i < 10 && p.meleePhase !== "active"; i++) step({}, 1)
    expect(p.meleePhase).toBe("active")
    step({ fire: true }, 1)
    for (let i = 0; i < 18 && p.meleeCombo === 2; i++) step({}, 1)
    expect(p.meleeCombo).toBe(3)
    for (let i = 0; i < 10 && p.meleePhase !== "active"; i++) step({}, 1)
    expect(p.meleeSwingId).toBe(3)
    expect(session.view.meleeSwings.at(-1)?.combo).toBe(3)

    // Let combo 3 finish recovery back to idle
    step({}, 20)
    expect(p.meleePhase).toBe("idle")
  })

  test("holding fire charges a heavy swing that drains more stamina and deals higher damage + knockdown", () => {
    const { session, p, step, equip, stand } = createSession()
    equip("bat")
    stand(44, 44, 0)
    const zLight = session.ai.spawnZombie(session.view.town, 45.4, 44, "chase", Math.PI)
    zLight.hp = 200
    zLight.maxHp = 200

    // Light tap swing
    const stamBeforeLight = p.stamina
    step({ fire: true }, 1)
    step({}, 10)
    const lightDamage = 200 - zLight.hp
    const lightStamCost = stamBeforeLight - p.stamina
    expect(lightDamage).toBeGreaterThan(0)
    expect(lightStamCost).toBeCloseTo(MELEE_WEAPONS.bat.stamina, 2)

    // Wait for recovery to finish and reset zombie
    step({}, 30)
    p.stamina = 1
    p.meleeComboUntil = -Infinity
    zLight.x = 45.4
    zLight.y = 44
    zLight.hp = 200
    zLight.state = "chase"

    // Heavy charged swing (hold fireHeld for 24 ticks, then release)
    step({ fire: true, fireHeld: true }, 1)
    step({ fireHeld: true }, 24)
    expect(p.meleePhase).toBe("windup")
    expect(p.meleeHeavy).toBe(true)
    expect(p.meleeCharge).toBeGreaterThan(0.8)

    // Release to unleash heavy active sweep
    step({ fireHeld: false }, 8)
    const heavyDamage = 200 - zLight.hp
    const heavyStamCost = 1 - p.stamina
    expect(heavyDamage).toBeGreaterThan(lightDamage * 1.4)
    expect(heavyStamCost).toBeGreaterThan(lightStamCost * 1.4)
    expect(zLight.state as string).toBe("knockdown")
  })

  test("shove stays on V without spending melee weapon durability", () => {
    const { session, p, step, equip, stand } = createSession()
    equip("crowbar", 10)
    stand(44, 44, 0)
    const z = session.ai.spawnZombie(session.view.town, 45.0, 44, "chase", Math.PI)
    step({ melee: true }, 1)
    expect(p.shoveAnim).toBeGreaterThan(0)
    expect(z.state).toBe("stagger")
    expect(p.meleeDurability).toBe(10)
  })

  test("durability reads diegetically from the world (bent/cracked mesh, strained hit sound, break sound & pieces, no text callouts)", () => {
    const { session, p, step, equip, stand } = createSession()
    const callouts: { text: string; kind: string }[] = []
    const feedback = new ActorFeedback((text, kind) => callouts.push({ text, kind }))
    const director = new SoundDirector(11)
    const fx = new OutbreakCombatFX({ addModel: () => 0 })
    const crowd = new ZombieCrowdRenderer({ addModel: () => 0 })
    const addSprites = new Float32Array(256 * 12)

    // Wear stages progress 0 (fresh) -> 1 (bent) -> 2 (cracked) as durability drops
    expect(weaponWearStage(45, 45)).toBe(0)
    expect(weaponWearStage(22, 45)).toBe(1)
    expect(weaponWearStage(8, 45)).toBe(2)

    // Start with 5 durability on crowbar (max 45 -> low threshold is 16)
    equip("crowbar", 5)
    stand(44, 44, 0)
    const z = session.ai.spawnZombie(session.view.town, 45.2, 44, "chase", Math.PI)
    z.hp = 1000
    z.maxHp = 1000

    feedback.observe(p, { time: session.view.time, notices: session.view.notices.splice(0) })
    director.observe(soundWorld(session.sim), p)

    // Low-durability swing drops durability 5 -> 4, shifts hit sound pitch, and emits NO text callout
    const lowEvents: SoundEvent[] = []
    step({ fire: true }, 1)
    for (let i = 0; i < 18; i++) {
      step({}, 1)
      z.x = 45.2
      z.y = 44
      for (const s of director.observe(soundWorld(session.sim), p)) lowEvents.push(s)
      feedback.observe(p, { time: session.view.time, notices: session.view.notices.splice(0) })
    }
    expect(p.meleeDurability).toBe(4)
    expect(callouts.some((c) => c.text.includes("durability") || c.text.includes("broke"))).toBe(false)
    const metalHit = lowEvents.find((e) => e.id === "melee.hit.metal")
    expect(metalHit).toBeDefined()
    expect(metalHit?.rate).toBeLessThan(0.85)
    expect(lowEvents.some((e) => e.id === "melee.break" && (e.gain ?? 1) < 0.6)).toBe(true)

    // Set durability to 1 and swing again -> breaks weapon with sound + physical 3D pieces, and NO text callout
    equip("crowbar", 1)
    p.meleePhase = "idle"
    const breakEvents: SoundEvent[] = []
    step({ fire: true }, 1)
    for (let i = 0; i < 12; i++) {
      step({}, 1)
      for (const s of director.observe(soundWorld(session.sim), p)) breakEvents.push(s)
      feedback.observe(p, { time: session.view.time, notices: session.view.notices.splice(0) })
      fx.processMeleeSwings(session.view.meleeSwings, session.view.time, TICK_DT, session.ai, crowd, () => 0, addSprites, 0)
    }
    expect(p.meleeWeapon).toBeNull()
    expect(p.meleeDurability).toBe(0)
    expect(callouts.some((c) => c.text.includes("broke") || c.text.includes("durability"))).toBe(false)
    expect(breakEvents.some((e) => e.id === "melee.break" && (e.gain ?? 1) >= 0.95)).toBe(true)
    expect(fx.brokenPieces.length).toBeGreaterThanOrEqual(4)
  })
})

describe("Hit detection, obstacles, headshots, limb detachment & door breaching", () => {
  test("solid walls and closed doors block melee swings", () => {
    const { session, step, equip, stand } = createSession()
    equip("fire-axe")
    // Ash House front door is closed at y = 35.28..35.5, x = 27..28.4; stand outside at y = 36.1 and place zombie inside at y = 34.5
    stand(27.7, 36.1, -Math.PI / 2)
    const zBehindDoor = session.ai.spawnZombie(session.view.town, 27.7, 34.5, "wander", Math.PI / 2)
    expect(zBehindDoor.y).toBeLessThan(35.0)
    const hpBefore = zBehindDoor.hp
    step({ fire: true }, 1)
    step({}, 12)
    expect(zBehindDoor.hp).toBe(hpBefore)
  })

  test("head-aligned sweet-spot hits deal bonus damage and sharp/heavy hits detach limbs", () => {
    const { session, step, equip, stand } = createSession()
    equip("machete")
    stand(44, 44, 0)

    // Center-aligned zombie (headshot sweet spot) vs side-arc zombie
    const zCenter = session.ai.spawnZombie(session.view.town, 45.2, 44.0, "chase", Math.PI)
    const zSide = session.ai.spawnZombie(session.view.town, 45.0, 44.65, "chase", Math.PI)
    zCenter.hp = zSide.hp = 200
    zCenter.maxHp = zSide.maxHp = 200

    step({ fire: true, fireHeld: true }, 1)
    step({ fireHeld: true }, 22)
    step({ fireHeld: false }, 8)

    const dmgCenter = 200 - zCenter.hp
    const dmgSide = 200 - zSide.hp
    expect(dmgCenter).toBeGreaterThan(dmgSide * 1.4)
    expect(zCenter.detachedLimbs.length).toBeGreaterThan(0)
  })

  test("fire axe breaches a locked store back-room door in two heavy swings", () => {
    const { session, step, equip, stand } = createSession()
    equip("fire-axe")
    const door = session.view.town.doors.find((d) => d.id === "hardware-room")!
    expect(door.locked).toBe(true)
    expect(door.open).toBe(false)
    const cx = (door.rect[0] + door.rect[2]) * 0.5
    stand(cx, door.rect[3] + 0.85, -Math.PI / 2)

    // Two heavy swings breach the door open
    for (let s = 0; s < 2; s++) {
      step({ fire: true, fireHeld: true }, 1)
      step({ fireHeld: true }, 20)
      step({ fireHeld: false }, 22)
    }
    expect(door.open).toBe(true)
    expect(door.locked).toBe(false)
  })
})

describe("Co-op melee attribution & friendly-fire off", () => {
  test("melee swings never damage co-op teammates and attribute kills to the swinging seat", () => {
    const core = new CoopRoomCore("melee", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, Date.now, "test")
    const mkClient = (name: string) => {
      const snaps: ReturnType<typeof decodeSnapshot>[] = []
      let id = ""
      const conn: Conn = {
        send(d) {
          if (typeof d === "string") {
            const m = decodeServerText(d) as ServerMsg
            if (m.t === "welcome") id = m.id
          } else {
            snaps.push(decodeSnapshot(d, 7))
          }
        },
        close() {},
      }
      core.open(conn)
      core.message(conn, JSON.stringify({ t: "hello", name, build: "test" }))
      return { conn, snaps, get id() { return id }, seq: 0 }
    }

    const ann = mkClient("Ann")
    const bob = mkClient("Bob")
    core.start()
    const slotA = core.sim.slot(ann.id)!
    const slotB = core.sim.slot(bob.id)!

    // Give Ann an axe and put Bob and a zombie both inside Ann's swing cone
    core.sim.progression.ledger.apply({ kind: "grant", actor: ann.id, item: "axe" })
    core.sim.progression.select(slotA, 2)
    core.sim.progression.project(slotA)

    Object.assign(slotA.survivor, { x: 44, y: 44, aim: 0 })
    Object.assign(slotB.survivor, { x: 45.0, y: 44.1, aim: Math.PI, health: 100 })
    const z = core.sim.ai.spawnZombie(core.sim.town, 45.2, 43.9, "wander", Math.PI)
    z.hp = 30

    for (let i = 0; i < 15; i++) {
      core.message(
        ann.conn,
        JSON.stringify({
          t: "in",
          s: ann.seq++,
          c: [packCommand({ mx: 0, my: 0, aim: 0, interact: false, fire: i === 0 })],
        }),
      )
      core.message(
        bob.conn,
        JSON.stringify({
          t: "in",
          s: bob.seq++,
          c: [packCommand({ mx: 0, my: 0, aim: Math.PI, interact: false })],
        }),
      )
      core.step()
    }

    // Bob took 0 friendly-fire damage; zombie was killed and attributed to Ann!
    expect(slotB.survivor.health).toBe(100)
    expect(z.state).toBe("dead")
    expect(z.lastHitBy).toBe(ann.id)

    const bobMeleeEvents = bob.snaps.flatMap((s) => s.shared.meleeSwings ?? [])
    expect(bobMeleeEvents.length).toBeGreaterThan(0)
    expect(bobMeleeEvents[0]!.attackerIndex).toBe(slotA.index)
    expect(bobMeleeEvents[0]!.weapon).toBe("axe")
  })

  test("downed zombies stay down ~2s before recovering and can be finished off with Mouse0 or V without spending pistol rounds", () => {
    const { session, p, equip, stand, step } = createSession()
    stand(40, 44, 0)

    // 1. Knockdown recovery after timer expires
    const zRecover = session.ai.spawnZombie(session.view.town, 43, 44, "knockdown", Math.PI)
    zRecover.awareness = 1
    zRecover.timer = 0.25
    step({}, 20)
    expect(zRecover.state).toBe("chase")

    // 2. Contextual boot stomp finisher while holding pistol (does NOT spend pistol ammo)
    session.ai.agents.length = 0
    const zDowned = session.ai.spawnZombie(session.view.town, 40.95, 44, "knockdown", Math.PI)
    zDowned.hp = 60
    zDowned.timer = 2.2
    const magBefore = p.magAmmo
    expect(findFinisherTarget(p, session.ai.agents)).toBe(zDowned)

    step({ fire: true }, 1)
    expect(zDowned.state).toBe("dead")
    expect(zDowned.hp).toBe(0)
    expect(zDowned.detachedLimbs).toContain("head")
    expect(p.magAmmo).toBe(magBefore)
    expect(p.stompAnim).toBeGreaterThan(0)

    // 3. Contextual downward strike finisher while holding crowbar
    step({}, 35)
    equip("crowbar")
    const zDowned2 = session.ai.spawnZombie(session.view.town, 41.0, 44, "knockdown", Math.PI)
    zDowned2.hp = 75
    zDowned2.timer = 2.2
    step({ fire: true }, 1)
    expect(zDowned2.state).toBe("dead")
    expect(p.meleeFinisher).toBe(true)
    expect(session.combat.meleeSwings.at(-1)?.finisher).toBe(true)
  })

  test("leg-loss crawlers and torso-only crawlers crawl slowly, grab ankles, and replicate over co-op snapshots", () => {
    const core = new CoopRoomCore("crawler", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, Date.now, "test")
    const snaps: ReturnType<typeof decodeSnapshot>[] = []
    let annId = ""
    const conn: Conn = {
      send(d) {
        if (typeof d === "string") {
          const m = decodeServerText(d) as ServerMsg
          if (m.t === "welcome") annId = m.id
        } else {
          snaps.push(decodeSnapshot(d, 7))
        }
      },
      close() {},
    }
    core.open(conn)
    core.message(conn, JSON.stringify({ t: "hello", name: "Ann", build: "test" }))
    core.start()
    const slotA = core.sim.slot(annId)!
    Object.assign(slotA.survivor, { x: 40, y: 44, aim: 0 })

    const zCrawler = core.sim.ai.spawnZombie(core.sim.town, 40.78, 44, "crawler", Math.PI)
    zCrawler.detachedLimbs.push("right.thigh")
    zCrawler.limping = true
    zCrawler.awareness = 1
    zCrawler.seesTarget = true
    zCrawler.targetX = 40
    zCrawler.targetY = 44
    zCrawler.focusId = annId
    expect(hasSeveredLeg(zCrawler)).toBe(true)
    expect(isTorsoCrawler(zCrawler)).toBe(false)

    const hpBefore = slotA.survivor.health
    const stamBefore = slotA.survivor.stamina
    for (let i = 0; i < 6; i++) {
      core.message(conn, JSON.stringify({ t: "in", s: i, c: [packCommand({ mx: 0, my: 0, aim: 0, interact: false })] }))
      core.step()
    }
    // Crawler ankle-grab deals damage and drains stamina
    expect(slotA.survivor.health).toBeLessThan(hpBefore)
    expect(slotA.survivor.stamina).toBeLessThan(stamBefore)

    // Second leg severed -> torso-only crawler
    zCrawler.detachedLimbs.push("left.thigh")
    expect(isTorsoCrawler(zCrawler)).toBe(true)
    for (let i = 6; i < 9; i++) {
      core.message(conn, JSON.stringify({ t: "in", s: i, c: [packCommand({ mx: 0, my: 0, aim: 0, interact: false })] }))
      core.step()
    }

    // Decoded snapshot replicates crawler state, limping flag, and detached limbs onto client agent
    const lastZ = snaps.at(-1)?.shared.zombies.find((z) => z.id === zCrawler.id)!
    expect(lastZ).toBeDefined()
    expect(lastZ.state).toBe("crawler")
    const clientAgent = createAIAgent(lastZ.id, lastZ.seed, lastZ.x, lastZ.y, lastZ.aim)
    applyZombieState(clientAgent, lastZ)
    expect(clientAgent.state).toBe("crawler")
    expect(clientAgent.limping).toBe(true)
    expect(clientAgent.detachedLimbs).toContain("right.thigh")
    expect(clientAgent.detachedLimbs).toContain("left.thigh")
  })

  test("deterministic per-zombie toughness, hitReaction (0..2), and deathVariant (0..3) span all variants", () => {
    const reactions = new Set<number>()
    const deaths = new Set<number>()
    const toughs = new Set<number>()
    for (let i = 1; i <= 48; i++) {
      const traits = zombieTraitsFromSeed((7 ^ Math.imul(i + 17, 0x85ebca6b)) >>> 0)
      reactions.add(traits.hitReaction)
      deaths.add(traits.deathVariant)
      toughs.add(traits.toughness)
    }
    expect(reactions.size).toBe(3)
    expect(deaths.size).toBe(4)
    expect(toughs.size).toBeGreaterThanOrEqual(4)
  })
})

describe("Shared rig melee posing while standing and moving", () => {
  test("poses wind-up, active and recovery across all 3 weapon classes with attached weapon frames", () => {
    const models: unknown[] = []
    const survivor = new Survivor({ addModel: (m) => models.push(m) - 1 })
    for (const weapon of ["crowbar", "machete", "fire-axe"] as const) {
      for (const phase of ["idle", "windup", "active", "recovery"] as const) {
        survivor.draw(
          {
            x: 10,
            y: 10,
            vx: 2.4,
            vy: 0,
            aim: 0,
            equippedItem: weapon,
            meleeWeapon: weapon,
            meleeDurability: phase === "recovery" ? 6 : phase === "active" ? 20 : 45,
            meleeMaxDurability: 45,
            meleePhase: phase,
            meleePhaseTime: 0.06,
            meleePhaseDuration: 0.12,
            meleeCombo: 1,
            meleeCharge: phase === "windup" ? 0.5 : 0,
            meleeHeavy: false,
          },
          1 / 60,
          0.5,
          () => 0,
        )
        expect(survivor.meleeWeaponFrame).not.toBeNull()
        expect(survivor.meleeTip).not.toBeNull()
        expect(survivor.gun).toBeNull()
        expect(survivor.meleeWearStage).toBe(phase === "recovery" ? 2 : phase === "active" ? 1 : 0)
      }
    }
  })
})
