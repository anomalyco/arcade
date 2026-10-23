// Menu previews with fake data, over the real offline sea (menu.html loads main.ts too).
//   menu.html?seed=7&show=teams    the Tab menu, pinned open, a busy room seen by a captain (?as=N: another player)
//   menu.html?seed=7&show=ops      DEPLOY, pinned open: one Hornet up, one recharging
import { joinCrew, joinShip, makeCrew, playerOf, recover, runOp, scuttle, shipOf, teamCss } from "../../shared/crew"
import { shipOps } from "../../shared/ops"
import { setLock } from "../../shared/squad"
import { OpsMenu } from "./ops-menu"
import { type JetStatus, TeamMenu } from "./team-menu"

const params = new URLSearchParams(location.search)
const show = params.get("show") ?? "teams"
const NAMES = ["ada", "bo", "mika", "jonas", "rhea", "sol", "kit", "nadia", "otto", "pia", "quinn", "ravi", "suki"]

{
  const now = 1_000_000
  const c = makeCrew(2026)
  NAMES.forEach((n, i) => joinCrew(c, i + 1, n, now + i))
  // Four carriers for themselves: one locked, jets up, one shot down and recharging, and one sunk with its replacement
  // still refitting (its crew moved to the first ship first).
  const sunk = c.ships.find((s) => s.team === 3)!
  for (const p of c.players.filter((p) => p.ship === sunk.id)) joinShip(c, p.id, c.ships[0]!.id, now + 20)
  scuttle(c, sunk.id, now + 25)
  setLock(c, 2, true)
  for (const p of c.players) if (p.role === "pilot") runOp(c, p.id, "hornet", now + 40)
  const downed = c.players.find((p) => p.plane >= 0 && p.team === 0)
  if (downed) recover(c, downed.id, "crashed", now - 11_000)
  const me = Number(params.get("as") ?? 1)
  const at = now + 100
  if (show === "teams") {
    const menu = new TeamMenu(document.body, { join() {}, create() {}, promote() {}, kick() {}, lock() {} })
    const status: JetStatus[] = ["air", "air", "down"]
    menu.jet = (id) => {
      const p = playerOf(c, id)
      return !p || p.role !== "pilot" ? null : p.plane < 0 ? "deck" : status[id % status.length]!
    }
    menu.stats = (id) => ({ kills: (id * 7) % 5, deaths: (id * 3) % 4 })
    menu.update(c, me, "kx7p", at)
    menu.pin(true)
  } else {
    const p = playerOf(c, me)!
    const s = shipOf(c, p.ship)!
    const ops = new OpsMenu(document.body, () => {})
    const info = { ship: s.name, color: teamCss(s.team), name: (id: number) => playerOf(c, id)?.name ?? "?" }
    ops.update(shipOps(c, me, at), info)
    ops.pin(true)
    let t = at
    setInterval(() => ops.update(shipOps(c, me, (t += 100)), info), 100)
  }
}
