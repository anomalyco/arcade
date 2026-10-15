import { packAngle, unpackAngle } from "@arcade/kit/net/bytes"
import {
  DEFAULT_MELEE_TUNING,
  DETACHABLE_BONES,
  MELEE_WEAPON_IDS,
  type CombatMeleeEvent,
  type CombatMeleeHit,
  type DetachableBone,
  type MeleeTuning,
} from "../combat"
import { registerOutbreakSharedFeature } from "../feature-registry"
import { sightRects } from "../map"

export * from "../combat"

const SEC_MELEE = 128
const MELEE_BONES: readonly (DetachableBone | null)[] = [null, ...DETACHABLE_BONES]
const cm = (v: number) => Math.round(v * 100)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const outbreakMeleeSharedFeature = registerOutbreakSharedFeature<
  undefined,
  CombatMeleeEvent[],
  MeleeTuning,
  CombatMeleeEvent[]
>({
  id: "melee",
  order: 22,
  tuning: {
    namespace: "melee",
    legacyNamespaces: ["combat"],
    defaults: DEFAULT_MELEE_TUNING,
  },
  stepSurvivorActions: ({ sim, slot, command, dt, resolved, viewTime }) => {
    const p = slot.survivor
    if (p.meleePhase === "idle" && !p.meleeWeapon) return
    const blockers = sightRects(sim.town)
    const runSwing = () =>
      sim.combat.stepMelee(
        p,
        dt,
        sim.time,
        Boolean(command.fireHeld),
        sim.ai,
        blockers,
        sim.progression.melee(slot.id),
        resolved.melee,
        slot.id,
        slot.index,
        sim.town,
        (text, kind, key) => sim.progression.notify(slot, text, kind, key),
      )
    const meleeRes =
      viewTime !== undefined && viewTime < sim.time && p.meleePhase !== "idle"
        ? sim.rewind.withRewoundPositions(sim.ai.agents, viewTime, runSwing)
        : runSwing()
    sim.progression.project(slot)
    if (meleeRes.topologyChanged) return { topologyChanged: true }
  },
  netSection: {
    bit: SEC_MELEE,
    key: "meleeSwings",
    collect: ({ sim, isDelta, baseSnap }) => {
      const maxBaseMeleeId = isDelta && baseSnap ? (baseSnap.meleeSwings ?? []).reduce((m, s) => Math.max(m, s.id), 0) : 0
      const newMelee: CombatMeleeEvent[] = []
      for (const m of sim.combat.meleeSwings) {
        if (isDelta && m.id <= maxBaseMeleeId) continue
        const ageMs = clamp(Math.round((sim.time - m.time) * 1000), 0, 65535)
        newMelee.push({
          ...m,
          time: Number((sim.time - ageMs / 1000).toFixed(4)),
          x: cm(m.x) / 100,
          y: cm(m.y) / 100,
          aim: unpackAngle(packAngle(m.aim)),
          arc: Math.round(m.arc * 100) / 100,
          reach: Math.round(m.reach * 100) / 100,
          charge: Math.round(m.charge * 100) / 100,
          hits: m.hits.map((h) => ({
            ...h,
            x: cm(h.x) / 100,
            y: cm(h.y) / 100,
          })),
        })
      }
      const allMelee =
        isDelta && baseSnap
          ? [...(baseSnap.meleeSwings ?? []).filter((m) => sim.time - m.time <= 0.6), ...newMelee]
          : newMelee
      return {
        snapshotValue: allMelee.length > 0 ? allMelee : undefined,
        shouldWrite: newMelee.length > 0,
        writePayload: newMelee,
      }
    },
    encode: (w, newMelee, { sim }) => {
      const timeF32 = Math.fround(sim.time)
      w.u8(newMelee.length)
      for (const m of newMelee) {
        const ageMs = clamp(Math.round((timeF32 - m.time) * 1000), 0, 65535)
        const wpnIdx = Math.max(0, MELEE_WEAPON_IDS.indexOf(m.weapon))
        const flags =
          ((m.combo - 1) & 3) |
          (m.heavy ? 4 : 0) |
          (m.weaponBroke ? 8 : 0) |
          (m.durabilityLow ? 16 : 0) |
          (m.doorBroke ? 32 : 0) |
          (m.hitDoorId ? 64 : 0) |
          (m.finisher ? 128 : 0)
        w.uvar(m.id)
        w.u16(ageMs)
        w.u8(((m.attackerIndex & 0x0f) << 4) | (wpnIdx & 0x0f))
        w.u8(flags)
        w.i32(cm(m.x)).i32(cm(m.y)).u16(packAngle(m.aim))
        w.u8(Math.round(clamp(m.arc, 0, 2.55) * 100))
        w.u8(Math.round(clamp(m.reach, 0, 2.55) * 100))
        w.u8(Math.round(clamp(m.charge, 0, 1) * 100))
        if (m.hitDoorId) w.str(m.hitDoorId)
        w.u32(m.seed)
        w.u8(m.hits.length)
        for (const h of m.hits) {
          w.uvar(h.zombieId)
          w.i32(cm(h.x)).i32(cm(h.y))
          w.u8(Math.round(clamp(h.damage, 0, 255)))
          const hFlags =
            (h.killed ? 1 : 0) |
            (h.knockdown ? 2 : 0) |
            (h.headshot ? 4 : 0) |
            (Math.max(0, MELEE_BONES.indexOf(h.detachBone)) << 3) |
            (h.finisher ? 64 : 0) |
            (h.crawler ? 128 : 0)
          w.u8(hFlags)
          w.u32(h.seed)
        }
      }
    },
    decode: (r, { time, isDelta, baseSnap }) => {
      const newMelee: CombatMeleeEvent[] = []
      for (let n = r.u8(), i = 0; i < n; i++) {
        const id = r.uvar()
        const ageMs = r.u16()
        const attAndWpn = r.u8()
        const attackerIndex = (attAndWpn >>> 4) & 0x0f
        const weapon = MELEE_WEAPON_IDS[attAndWpn & 0x0f] ?? "crowbar"
        const flags = r.u8()
        const combo = (((flags & 3) + 1) as 1 | 2 | 3)
        const heavy = Boolean(flags & 4)
        const weaponBroke = Boolean(flags & 8)
        const durabilityLow = Boolean(flags & 16)
        const doorBroke = Boolean(flags & 32)
        const hasDoor = Boolean(flags & 64)
        const x = r.i32() / 100
        const y = r.i32() / 100
        const aim = unpackAngle(r.u16())
        const arc = r.u8() / 100
        const reach = r.u8() / 100
        const charge = r.u8() / 100
        const hitDoorId = hasDoor ? r.str() : null
        const seed = r.u32()
        const hitCount = r.u8()
        const hits: CombatMeleeHit[] = []
        for (let k = 0; k < hitCount; k++) {
          const zombieId = r.uvar()
          const hx = r.i32() / 100
          const hy = r.i32() / 100
          const damage = r.u8()
          const hFlags = r.u8()
          const hSeed = r.u32()
          hits.push({
            zombieId,
            x: hx,
            y: hy,
            damage,
            killed: Boolean(hFlags & 1),
            knockdown: Boolean(hFlags & 2),
            headshot: Boolean(hFlags & 4),
            ...(hFlags & 64 ? { finisher: true } : {}),
            ...(hFlags & 128 ? { crawler: true } : {}),
            detachBone: MELEE_BONES[(hFlags >>> 3) & 7] ?? null,
            seed: hSeed,
          })
        }
        newMelee.push({
          id,
          time: Number((time - ageMs / 1000).toFixed(4)),
          attackerId: `seat:${attackerIndex}`,
          attackerIndex,
          weapon,
          x,
          y,
          aim,
          arc,
          reach,
          combo,
          heavy,
          ...(flags & 128 ? { finisher: true } : {}),
          charge,
          hits,
          hitDoorId,
          doorBroke,
          weaponBroke,
          durabilityLow,
          seed,
        })
      }
      const meleeSwings =
        isDelta && baseSnap
          ? [...(baseSnap.meleeSwings ?? []).filter((m) => time - m.time <= 0.6), ...newMelee]
          : newMelee
      return meleeSwings.length > 0 ? meleeSwings : undefined
    },
    decodeOmitted: ({ time, isDelta, baseSnap }) => {
      if (!isDelta || !baseSnap?.meleeSwings) return undefined
      const kept = baseSnap.meleeSwings.filter((m) => time - m.time <= 0.6)
      return kept.length > 0 ? kept : undefined
    },
  },
})
