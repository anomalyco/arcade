import { join } from "node:path"
import { runGameDev } from "../../../scripts/game-dev"

await runGameDev({ root: join(import.meta.dir, ".."), workerPort: 8797, clientPort: 5197, buildId: true, restartOnExit: true })
