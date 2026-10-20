import { DEFAULT_DEATH_TUNING } from "../../shared/death/rules"
import { forceLife } from "../../shared/death/runtime"
import type { Town } from "../../shared/map"
import { SECRETS, secretDef, secretToggleKey, type SecretId } from "../../shared/secrets/catalog"
import { CELLAR_LOOT, CELLAR_STASH, CELLAR_STORE } from "../../shared/secrets/cellar"
import { isSecretHome, secretHosts } from "../../shared/secrets/hosts"
import { secretSitesIn, type SecretPiece, type SecretSite } from "../../shared/secrets/places"
import { secretRun, type SecretRun } from "../../shared/secrets/select"
import { LocalSession } from "../../shared/session"
import { generateWorldChunk, worldToChunk, type WorldMode } from "../../shared/world"
import type { NetSession } from "../net-session"
import type { ProgressionLabHost } from "../progression/lab"
import type { OutbreakSecretsSettings } from "./settings"

/** Staged views for the Lab, `secrets.stage` and the contact sheet: one per secret, plus the open cellar and the tally. */
export const SECRET_SCENES = [
  "calendar",
  "clock",
  "photo",
  "chalk",
  "chalk-late",
  "nod",
  "tallMan",
  "audience",
  "litWindow",
  "footprints",
  "phone",
  "rockingChair",
  "cellar",
  "cellar-open",
  "procession",
  "visitor",
  "tally",
] as const
export type SecretScene = (typeof SECRET_SCENES)[number]

/** What a stage asks of the presenter and the run's memory. */
export type SecretStageHooks = {
  force: { lateChalk: boolean; apparition: "tallMan" | "procession" | "visitor" | null; ring: boolean }
  notice: (id: SecretId) => void
}

const PIECE: Partial<Record<SecretScene, SecretPiece>> = {
  calendar: "calendar",
  clock: "clock",
  photo: "photo",
  chalk: "chalk",
  "chalk-late": "chalk",
  nod: "nod",
  audience: "chair",
  litWindow: "window",
  footprints: "footprint",
  phone: "phone",
  rockingChair: "rocker",
  cellar: "hatch",
  "cellar-open": "hatch",
}

const SECRET_OF: Partial<Record<SecretScene, SecretId>> = { "chalk-late": "chalk", "cellar-open": "cellar", tally: "calendar" }

/** A town made of one generated chunk, enough to place a building's secrets without streaming it in. */
function chunkTown(base: Town, cx: number, cy: number, mode: WorldMode): Town {
  const c = generateWorldChunk(base.seed, base.houseSeed, cx, cy, mode)
  return { ...base, chunks: [c.bounds], buildings: c.buildings, barriers: c.barriers, doors: c.doors, windows: c.windows, props: c.props, lamps: c.lamps, vehicles: c.vehicles }
}

/** The nearest site of `piece` in the run: in its host house, or the first house round `from` that has one. */
export function findSecretSite(town: Town, mode: WorldMode, run: SecretRun, piece: SecretPiece, secret: SecretId, from: { x: number; y: number }): SecretSite | null {
  const hosts = secretHosts(town, mode, run.picked)
  const host = hosts.get(secret)
  const pickSite = (sites: SecretSite[]) => {
    const all = sites.filter((s) => s.piece === piece && s.secret === secret)
    return piece === "footprint" ? (all.find((s, i) => i > 0 && Math.abs(s.x - all[i - 1]!.x) > 0.3) ?? all[0] ?? null) : (all[0] ?? null)
  }
  if (host) {
    const t = chunkTown(town, host.cx, host.cy, mode)
    const b = t.buildings.find((x) => x.id === host.buildingId)
    return b ? pickSite(secretSitesIn(t, b, run, hosts)) : null
  }
  const c0 = worldToChunk(from.x, from.y)
  for (let r = 0; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const t = mode === "classic" && (c0.cx + dx < 0 || c0.cx + dx > 2 || c0.cy + dy < 0 || c0.cy + dy > 2) ? null : chunkTown(town, c0.cx + dx, c0.cy + dy, mode)
        if (!t) continue
        for (const b of t.buildings) {
          if (!isSecretHome(b)) continue
          const s = pickSite(secretSitesIn(t, b, run, hosts))
          if (s) return s
        }
      }
    }
  }
  return null
}

/**
 * Puts the survivor in front of a secret at the hour it shows: forces it into the run (Secrets › Force a secret, or
 * its toggle for the per-house ones), finds it, poses, and for the apparitions and the phone tells the presenter to
 * show them now. Offline only.
 */
export function stageSecret(host: ProgressionLabHost, session: LocalSession | NetSession, settings: OutbreakSecretsSettings, hooks: SecretStageHooks, scene: SecretScene): { scene: SecretScene; x: number; y: number } {
  if (!(session instanceof LocalSession)) throw new Error("Offline only: a co-op room plays the default secrets")
  const sim = session.sim
  const view = session.view
  const secret = SECRET_OF[scene] ?? (scene as SecretId)
  settings.secrets = 1
  settings[secretToggleKey(secret)] = 1
  settings.secretForce = secretDef(secret).tier === "subtle" && secret !== "nod" ? -1 : SECRETS.findIndex((s) => s.id === secret)
  hooks.force.lateChalk = scene === "chalk-late"
  hooks.force.apparition = null
  hooks.force.ring = false
  const run = secretRun(sim.town, settings)
  const mode = sim.worldStream.mode
  const p = view.player
  const pose = (x: number, y: number, aim: number, hour: number) => {
    host.setHour(hour)
    host.pose(x, y, aim)
    return { scene, x, y }
  }
  const NORTH = -Math.PI / 2
  switch (scene) {
    case "tallMan":
      hooks.force.apparition = "tallMan"
      p.flashlightOn = false
      return pose(44, 70, NORTH, 22)
    case "procession":
      hooks.force.apparition = "procession"
      p.flashlightOn = false
      return pose(36, 80, -Math.PI / 4, 3.1)
    case "visitor": {
      hooks.force.apparition = "visitor"
      const door = view.town.doors.find((d) => d.id === "ash-front")
      if (!door) throw new Error("No front door at Ash")
      if (door.open) {
        door.open = false
        session.rebuildCollision()
      }
      p.flashlightOn = false
      const x = (door.rect[0] + door.rect[2]) / 2
      const r = pose(x, door.rect[1] - 0.7, Math.PI / 2, 22)
      Object.assign(p, { peekingWindowId: door.id, peekOriginX: x, peekOriginY: door.rect[1] - 0.7, peekOriginDist: 0.7 })
      return r
    }
    case "tally": {
      for (const id of ["calendar", "clock", "chalk", "tallMan", "cellar", "photo", "phone"] as const) hooks.notice(id)
      forceLife(sim, session.slot, "dead", DEFAULT_DEATH_TUNING)
      return { scene, x: p.x, y: p.y }
    }
  }
  const piece = PIECE[scene]!
  const site = findSecretSite(sim.town, mode, run, piece, secret, p)
  if (!site) throw new Error(`No ${scene} in this town`)
  switch (scene) {
    case "chalk":
    case "chalk-late":
      return pose(site.x, site.y + 2.4, NORTH, 13)
    case "litWindow":
      return pose(site.x + 3, site.y + 20, NORTH - 0.15, 22)
    case "rockingChair":
      return pose(site.x + 1, site.y + 9, NORTH, 22)
    case "footprints":
      return pose(site.x + 1.5, site.y + 2.5, NORTH, 14)
    case "audience":
      return pose(site.x, site.y + 1.6, NORTH, 13)
    case "phone":
      hooks.force.ring = true
      return pose(site.x, site.y + 2.2, NORTH, 23)
    case "cellar":
    case "cellar-open": {
      const ledger = sim.progression.ledger
      for (const id of [CELLAR_STORE, CELLAR_STASH]) if (ledger.store(id)) ledger.deleteStore(id)
      if (scene === "cellar-open") {
        const [a, b, c] = run.code
        ledger.createStore({ id: CELLAR_STORE, mode: "counters", scope: "shared", at: { x: site.x, y: site.y }, initial: { d0: a, d1: b, d2: c, dial: 2, open: 1, turns: a + b + c } })
        ledger.createStore({ id: CELLAR_STASH, mode: "slots", scope: "shared", size: CELLAR_LOOT.length, at: { x: site.x, y: site.y }, initial: CELLAR_LOOT.map((s) => ({ ...s })) })
        ledger.rev++
      }
      return pose(site.x + 0.3, site.y + 1.3, NORTH, 13)
    }
    default:
      return pose(site.x, site.y + 1.0, NORTH, 13)
  }
}
