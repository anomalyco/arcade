import type { StoreState } from "@arcade/kit/sim/ledger"
import type { Town } from "../../../shared/map"
import { CELLAR_STORE, type SecretsState } from "../../../shared/secrets/cellar"
import { secretSitesIn, type SecretSite } from "../../../shared/secrets/places"
import { pulseLit } from "../../../shared/secrets/select"
import { holdAmbientSound, playAmbientSound } from "./hooks"

/**
 * The secrets' sounds (AR-85, `docs/outbreak-secrets.md`) that follow from shared state alone, struck on the same
 * clock the presenter draws with: every stopped clock's second hand ticking at the mark it never passes, the radio
 * man's set hissing between stations and beeping once per lit pulse, and his padlock clicking a notch per turn and
 * giving when it opens (the ledger's `turns` and `open`, so every co-op client hears it). The rocking chair and the
 * lit window depend on the presenter's own state and are struck there. Presentation only, through the hooks.
 */

type SecretWorld = {
  town: Town
  time: number
  secrets?: SecretsState
  progression?: { ledger: { readonly stores: ReadonlyMap<string, StoreState> } }
}

/** How far each is worth asking the soundscape for (m); its own ranges fade them out before this. */
const CLOCK_HEAR = 8
const SET_HEAR = 14
const LOCK_HEAR = 18

export class SecretSounds {
  private planKey = ""
  private planRun: SecretsState["run"] | null = null
  private planTown: Town | null = null
  private readonly perBuilding = new Map<string, { run: SecretsState["run"]; rect: string; sites: SecretSite[] }>()
  private clocks: SecretSite[] = []
  private set: SecretSite | null = null
  private prevTime = Number.NaN
  private turns = -1
  private open = false

  update(w: SecretWorld, listener: { x: number; y: number }): void {
    const state = w.secrets
    const t = w.time
    const prev = this.prevTime
    this.prevTime = t
    if (!state || state.run.picked.size === 0) return
    this.plan(w.town, state)
    const lx = listener.x
    const ly = listener.y
    // Back in time (a new session or a load): no edges this frame.
    const edges = prev === prev && t >= prev && t - prev < 1
    if (edges && Math.floor(t) !== Math.floor(prev))
      for (const c of this.clocks) if (Math.abs(c.x - lx) < CLOCK_HEAR && Math.abs(c.y - ly) < CLOCK_HEAR) playAmbientSound("scape.secret.twitch", c.x, c.y)
    const set = this.set
    if (set && Math.abs(set.x - lx) < SET_HEAR && Math.abs(set.y - ly) < SET_HEAR) {
      holdAmbientSound("secrets.set", "scape.secret.static", set.x, set.y)
      if (edges && pulseLit(state.run.pulses, t) && !pulseLit(state.run.pulses, prev)) playAmbientSound("scape.secret.pip", set.x, set.y)
    }
    const hatch = state.hatch
    const counts = w.progression?.ledger.stores.get(CELLAR_STORE)?.counts
    const turns = counts?.turns ?? 0
    const open = Boolean(counts?.open)
    // The first look (joining, loading, the house streaming in) only learns the lock; changes after it are heard.
    if (hatch && this.turns >= 0 && Math.abs(hatch.x - lx) < LOCK_HEAR && Math.abs(hatch.y - ly) < LOCK_HEAR) {
      if (turns > this.turns) playAmbientSound("scape.secret.dial", hatch.x, hatch.y, { rate: 0.96 + (turns % 5) * 0.02 })
      if (open && !this.open) {
        playAmbientSound("scape.secret.unlock", hatch.x, hatch.y, { delay: 0.05 })
        playAmbientSound("scape.secret.hatch", hatch.x, hatch.y, { delay: 0.7 })
      }
    }
    this.turns = hatch ? turns : -1
    this.open = open
  }

  reset(): void {
    this.planKey = ""
    this.planRun = null
    this.planTown = null
    this.perBuilding.clear()
    this.clocks = []
    this.set = null
    this.prevTime = Number.NaN
    this.turns = -1
    this.open = false
  }

  private plan(town: Town, state: SecretsState): void {
    // The sim's own key covers the tuning and the streamed town (`syncSecrets`).
    const run = state.run
    if (state.key === this.planKey && run === this.planRun && town === this.planTown) return
    this.planKey = state.key
    this.planRun = run
    this.planTown = town
    const clocks: SecretSite[] = []
    let set: SecretSite | null = null
    for (const b of town.buildings) {
      const rect = b.rect.join(",")
      let hit = this.perBuilding.get(b.id)
      if (!hit || hit.run !== run || hit.rect !== rect) {
        hit = { run, rect, sites: secretSitesIn(town, b, run, state.hosts).filter((s) => s.piece === "clock" || s.piece === "set") }
        this.perBuilding.set(b.id, hit)
      }
      for (const s of hit.sites) {
        if (s.piece === "clock") clocks.push(s)
        else set = s
      }
    }
    if (this.perBuilding.size > 128) this.perBuilding.clear()
    this.clocks = clocks
    this.set = set
  }
}
