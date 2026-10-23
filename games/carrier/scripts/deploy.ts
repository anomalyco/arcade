// Keep Carrier's existing local command; the shared pipeline skips identical builds and waits for empty rooms.
// --dry fingerprints without deploying; --no-build reuses a checked build. See docs/deploy-pipeline.md.
import { deployGame } from "../../../scripts/deploy-game"

await deployGame()
