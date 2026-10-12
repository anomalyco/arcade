import { DT, type Gun, SPEED, SPRINT_SPEED, type Weapon } from "../config"
import { type Kit, bareKit, gunKit } from "./kit"
import { MODE_FACTORIES, Mode, type ModeId } from "./modes"
import type { Player, World } from "./world"

/**
 * Infected, gun game and one in the chamber. Their loadouts come from Mode.loadout (see shared/sim/kit.ts), and the
 * melee swipe they share is in shared/sim/melee.ts.
 */

/** The parts of the mode view these modes add. */
export type RulesView =
  | { id: "inf"; countdown: number; survivors: number; infected: number }
  | { id: "gun"; ladder: string[]; winner: string }
  | { id: "oitc"; lives: number; max: number; left: number; winner: string }

/** Modes where the gun and equipment picks don't count: the mode hands out the loadout. */
export const FIXED_LOADOUT: readonly ModeId[] = ["inf", "gun", "oitc"]

/** Per-player numbers these modes keep, in Player.stats so the scoreboard sees them. */
const stat = (p: Player, k: "score" | "tier" | "lives") => p.stats[k] ?? 0
const add = (p: Player, k: "score" | "tier" | "lives", n: number) => {
  p.stats[k] = stat(p, k) + n
}
export const tierOf = (p: Player) => stat(p, "tier")
export const livesOf = (p: Player) => stat(p, "lives")

// Infected --------------------------------------------------------------------------------------------------------

/**
 * Infected: countdown before the first infection, round length, the infected respawn, survivors score a point every
 * `every` seconds alive, infected walk and sprint speeds as multiples of the usual, and the room size that gets two
 * patient zeros.
 */
export const INF = { countdown: 10, round: 180, respawn: 2, every: 10, walk: 1.3, run: 1.12, two: 8, infect: 3 }
export const INF_TEAMS = ["SURVIVORS", "INFECTED"] as const

/**
 * Everyone starts a survivor (team 0) with a rifle or shotgun and one frag. After the countdown one player (two in a
 * room of eight or more) turns infected (team 1): faster, bare-handed, a swipe kills. Anyone who dies after that comes
 * back infected two seconds later. The infected win when nobody's left alive as a survivor; survivors win if any make
 * it to the end of the clock.
 */
export class Infected extends Mode {
  override readonly id: ModeId = "inf"
  started = false
  private startAt = 0
  private acc = 0

  override get seconds(): number {
    return INF.countdown + INF.round
  }

  override start(w: World): void {
    this.score = [0, 0]
    this.started = false
    this.startAt = w.time
    this.acc = 0
    for (const p of w.players.values()) p.team = 0
    for (const p of w.players.values()) w.spawn(p)
  }

  /** Before the first infection you join the survivors; after it, the infected. */
  override join(_w: World, p: Player): boolean {
    p.team = this.started ? 1 : 0
    return true
  }

  override loadout(_w: World, p: Player): Kit {
    if (p.team === 1) return bareKit({ id: "claws", label: "CLAWS", walk: SPEED * INF.walk, run: SPRINT_SPEED * INF.run })
    const gun: Gun = p.pick === "sniper" ? "rifle" : p.pick
    return gunKit(gun, "frag")
  }

  override killed(w: World, victim: Player, killer: Player): void {
    victim.respawnAt = w.time + INF.respawn
    if (victim.team === 1) {
      if (killer.team === 0) add(killer, "score", 1)
      return
    }
    if (!this.started) return
    victim.team = 1
    if (killer !== victim && killer.team === 1) add(killer, "score", INF.infect)
  }

  /** Turns a survivor infected where nobody is, at full health. */
  private infect(w: World, p: Player): void {
    p.team = 1
    if (p.alive) w.spawn(p)
  }

  override step(w: World): void {
    const players = [...w.players.values()]
    if (!this.started) {
      if (w.time - this.startAt >= INF.countdown) {
        // Alone there's nobody to infect: keep waiting.
        if (players.length < 2) this.startAt = w.time
        else {
          this.started = true
          const pool = [...players]
          for (let i = 0; i < (players.length >= INF.two ? 2 : 1); i++) this.infect(w, pool.splice(w.rng.int(pool.length), 1)[0]!)
        }
      }
    } else {
      // Every infected player left: a survivor turns.
      const survivors = players.filter((p) => p.team === 0)
      if (!players.some((p) => p.team === 1) && survivors.length >= 2) this.infect(w, w.rng.pick(survivors))
      this.acc += DT
      if (this.acc >= INF.every) {
        this.acc -= INF.every
        for (const p of players) if (p.team === 0 && p.alive) add(p, "score", 1)
      }
      if (!players.some((p) => p.team === 0)) w.endMatch()
    }
    this.score = [players.filter((p) => p.team === 0).length, players.filter((p) => p.team === 1).length]
  }

  /** Survivors win while any are left; the top scorer is the player of the match. */
  override result(w: World): { winner: string; team: number } {
    const ranked = [...w.players.values()].sort((a, b) => stat(b, "score") - stat(a, "score") || b.kills - a.kills)
    return { winner: ranked[0]?.id ?? "", team: this.members(w, 0).length ? 0 : 1 }
  }

  override view(w: World, viewer: string) {
    return { ...super.view(w, viewer), rules: { id: "inf" as const, countdown: this.started ? 0 : Math.max(0, INF.countdown - (w.time - this.startAt)), survivors: this.score[0], infected: this.score[1] } }
  }
}

// Gun game --------------------------------------------------------------------------------------------------------

type Tier = { label: string; gun: Gun | null; over?: Partial<Kit> }

/** One tier per kill; a kill with the last (the knife) wins. */
export const LADDER: readonly Tier[] = [
  { label: "RIFLE", gun: "rifle" },
  { label: "SHOTGUN", gun: "shotgun" },
  { label: "SNIPER", gun: "sniper" },
  { label: "SMG", gun: "rifle", over: { cooldown: 0.065, damage: 17, mag: 40 } },
  { label: "MARKSMAN", gun: "rifle", over: { auto: false, cooldown: 0.16, damage: 34, mag: 12 } },
  { label: "SAWN-OFF", gun: "shotgun", over: { mag: 2, cooldown: 0.3 } },
  { label: "SNIPER · ONE ROUND", gun: "sniper", over: { mag: 1 } },
  { label: "KNIFE", gun: null },
]

/** The kit for a gun game tier: everyone can also swing (V). */
export function tierKit(tier: number): Kit {
  const t = LADDER[Math.max(0, Math.min(LADDER.length - 1, tier))]!
  const id = `tier${tier}`
  return t.gun ? gunKit(t.gun, null, { ...t.over, id, label: t.label, melee: true }) : bareKit({ id, label: t.label, walk: SPEED * 1.1, run: SPRINT_SPEED * 1.05 })
}

/**
 * Gun game: free for all up a fixed ladder of weapons, one tier per kill, swapped on the spot. Getting killed by a
 * melee swing knocks you down a tier. A kill on the last tier wins.
 */
export class GunGame extends Mode {
  override readonly id: ModeId = "gun"
  /** Whoever got a kill on the last tier. */
  private champ = ""

  override start(w: World): void {
    this.champ = ""
    for (const p of w.players.values()) p.stats.tier = 0
    super.start(w)
  }

  /** Late joiners start level with whoever's furthest behind. */
  override join(w: World, p: Player): boolean {
    const others = [...w.players.values()].filter((q) => q !== p)
    p.stats.tier = others.length ? Math.min(...others.map(tierOf)) : 0
    return super.join(w, p)
  }

  override loadout(_w: World, p: Player): Kit {
    return tierKit(tierOf(p))
  }

  override killed(w: World, victim: Player, killer: Player, how?: Weapon): void {
    if (killer === victim) return
    if (how === "melee") victim.stats.tier = Math.max(0, tierOf(victim) - 1)
    add(killer, "tier", 1)
    if (tierOf(killer) >= LADDER.length) {
      killer.stats.tier = LADDER.length - 1
      this.champ = killer.id
      return w.endMatch()
    }
    if (killer.alive) {
      w.arm(killer, tierKit(tierOf(killer)))
      killer.readyAt = w.time + 0.3
    }
  }

  /** Whoever finished the ladder, else the furthest up it. */
  override result(w: World): { winner: string; team: number } {
    if (this.champ && w.players.has(this.champ)) return { winner: this.champ, team: -1 }
    const ranked = [...w.players.values()].sort((a, b) => tierOf(b) - tierOf(a) || b.kills - a.kills || a.deaths - b.deaths)
    return { winner: ranked[0]?.id ?? "", team: -1 }
  }

  override target(): number {
    return LADDER.length
  }

  override view(w: World, viewer: string) {
    return { ...super.view(w, viewer), rules: { id: "gun" as const, ladder: LADDER.map((t) => t.label), winner: w.phase === "end" ? this.result(w).winner : "" } }
  }
}

// One in the chamber ----------------------------------------------------------------------------------------------

/** One in the chamber: lives each, the most bullets you can carry, and the match length. */
export const OITC = { lives: 3, max: 3, seconds: 300 }

export const oitcKit = (): Kit => gunKit("sniper", null, { id: "oitc", label: "ONE IN THE CHAMBER", mag: 1, reload: false, damage: 1000, cooldown: 0.5, melee: true })

/**
 * One in the chamber: free for all with one bullet that kills, no reloads; every kill (shot or swing) gives another,
 * up to three. Three lives each, then you watch. Last one standing wins, or the most kills when time runs out.
 */
export class OneInTheChamber extends Mode {
  override readonly id: ModeId = "oitc"

  override get seconds(): number {
    return OITC.seconds
  }

  override start(w: World): void {
    for (const p of w.players.values()) p.stats.lives = OITC.lives
    super.start(w)
  }

  /** Late joiners get as many lives as whoever has fewest left (still in); with nobody else, the full three. */
  override join(w: World, p: Player): boolean {
    const others = [...w.players.values()].filter((q) => q !== p && livesOf(q) > 0)
    p.stats.lives = others.length ? Math.min(...others.map(livesOf)) : OITC.lives
    return super.join(w, p)
  }

  override loadout(): Kit {
    return oitcKit()
  }

  override killed(w: World, victim: Player, killer: Player): void {
    victim.stats.lives = Math.max(0, livesOf(victim) - 1)
    if (livesOf(victim) === 0) victim.respawnAt = Infinity
    if (killer !== victim && killer.alive) killer.mag = Math.min(OITC.max, killer.mag + 1)
  }

  override step(w: World): void {
    const players = [...w.players.values()]
    if (players.length >= 2 && players.filter((p) => livesOf(p) > 0).length <= 1) w.endMatch()
  }

  /** The last one standing, else the most kills (then lives left). */
  override result(w: World): { winner: string; team: number } {
    const players = [...w.players.values()]
    const standing = players.filter((p) => livesOf(p) > 0)
    if (players.length >= 2 && standing.length === 1) return { winner: standing[0]!.id, team: -1 }
    const ranked = players.sort((a, b) => b.kills - a.kills || livesOf(b) - livesOf(a) || a.deaths - b.deaths)
    return { winner: ranked[0]?.id ?? "", team: -1 }
  }

  override view(w: World, viewer: string) {
    const left = [...w.players.values()].filter((p) => livesOf(p) > 0).length
    return { ...super.view(w, viewer), rules: { id: "oitc" as const, lives: OITC.lives, max: OITC.max, left, winner: w.phase === "end" ? this.result(w).winner : "" } }
  }
}

MODE_FACTORIES.inf = () => new Infected()
MODE_FACTORIES.gun = () => new GunGame()
MODE_FACTORIES.oitc = () => new OneInTheChamber()
