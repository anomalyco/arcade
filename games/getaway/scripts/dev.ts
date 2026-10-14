import { join } from "node:path"
import { runGameDev } from "../../../scripts/game-dev"

await runGameDev({ root: join(import.meta.dir, ".."), workerPort: 8787, clientPort: 5190 })
