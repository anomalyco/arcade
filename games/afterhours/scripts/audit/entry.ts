// Audit page entry (scripts/audit/audit.html): the real game page plus the interior room/door registry on a global,
// so audit scripts can attribute floor holes and doors to rooms. Built only by scripts/audit/vite.config.ts.
import { interiorDoors, interiorRooms } from "../../src/world/interior/registry"
;(globalThis as { __ahRegistry?: unknown }).__ahRegistry = { rooms: interiorRooms, doors: interiorDoors }
await import("../../src/main")
