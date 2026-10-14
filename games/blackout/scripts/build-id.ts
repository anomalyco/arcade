import { join } from "node:path"
import { writeBuildId } from "../../../scripts/build-id"

writeBuildId(join(import.meta.dir, ".."))
