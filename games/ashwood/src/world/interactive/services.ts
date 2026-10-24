import type { Doors } from "../doors"
import { interiorDoors } from "../interior/registry"
import type { InteractiveWorld } from "./world"
import type { TerminalRow, TerminalServices } from "./terminal"

/** Direct adapters to the live door and prop registries. Logs/specimens are supplied by the scenario, never invented. */
export function facilityServices(options: {
  world: InteractiveWorld
  doors: Doors
  powered: () => boolean
  allowedDoors: ReadonlySet<string>
  logs: () => TerminalRow[]
  specimens: () => TerminalRow[]
}): TerminalServices {
  return {
    powered: options.powered,
    lockers: () => [...options.world.props.values()].filter(p => p.hideVolume).map(p => ({ id: p.id, text: `${p.id} / STOREY ${p.storey} / ${p.parts.get("door")!.amount > 0.1 ? "OPEN" : "CLOSED"}` })),
    logs: options.logs,
    specimens: options.specimens,
    doors: () => options.doors.all().filter(d => options.allowedDoors.has(d.id)).map(d => {
      const entry = interiorDoors.find(e => e.id === d.id)
      return { id: d.id, label: entry?.sign ? `${entry.sign.number} ${entry.sign.label ?? ""}` : d.id, open: d.isOpen, locked: d.locked }
    }),
    setDoor: (id, open) => {
      const door = options.doors.get(id)
      if (!options.powered() || !options.allowedDoors.has(id) || !door || door.locked) return false
      open ? door.open() : door.close()
      return true
    },
  }
}
