/**
 * Every client Outbreak feature, registered with `outbreakClientFeatures` by importing its folder. `main.ts` imports
 * this module once and passes the registry to the Lab, commands, harness, feel tracker and `NetSession`; a new
 * feature adds one line here and never edits `main.ts`.
 */
import "./discovery/index"
import "./hordes/index"
import "./map/index"
import "./melee/index"
import "./pacing/index"
import "./progression/index"
import "./vehicles/index"
import "./weather/index"

export { outbreakClientFeatures } from "./feature-registry"
