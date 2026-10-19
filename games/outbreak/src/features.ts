/**
 * Every client Outbreak feature, registered with `outbreakClientFeatures` by importing its folder. `main.ts` imports
 * this module once and passes the registry to the Lab, commands, harness, feel tracker and `NetSession`; a new
 * feature adds one line here and never edits `main.ts`.
 */
import "./blood/index"
import "./bodies/index"
import "./crafting/index"
import "./death/index"
import "./details/index"
import "./discovery/index"
import "./dogs/index"
import "./fire/index"
import "./flares/index"
import "./hordes/index"
import "./lights-out/index"
import "./look/index"
import "./map/index"
import "./melee/index"
import "./night-lights/index"
import "./night-ramp/index"
import "./pacing/index"
import "./progression/index"
import "./props/index"
import "./radios/index"
import "./specials/index"
import "./vehicles/index"
import "./weather/index"

export { outbreakClientFeatures } from "./feature-registry"
