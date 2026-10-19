/**
 * Every shared Outbreak feature, registered with `outbreakSharedFeatures` by importing its folder. `CoopSim` imports
 * this list once; a new feature adds one line here and never edits `coop-sim.ts`.
 */
import "./discovery/index"
import "./hordes/index"
import "./melee/index"
import "./pacing/index"
import "./progression/index"
import "./radios/index"
import "./specials/index"
import "./vehicles/index"
