import { devHub } from "@arcade/kit/dev-hub"
import { getawaySpawn } from "./lab/spawn"
import { blackoutSpawn } from "../../blackout/src/lab/spawn"
import { VEHICLES } from "../shared/config"
import { SPECS } from "./game/props/placement"

devHub({
  spawn(context) {
    const g = getawaySpawn(context)
    return { ...g, characters: [...g.characters, blackoutSpawn(context)] }
  },
  metrics(id) {
    const vehicle = VEHICLES.find(v => `getaway:${v.id}` === id)
    if (vehicle) return { Length: `${vehicle.length} m`, Width: `${vehicle.width} m`, Mass: `${vehicle.mass} t` }
    const prop = Object.entries(SPECS).find(([kind]) => `getaway:prop:${kind}` === id)?.[1]
    if (prop) return { Dimensions: prop.size.map(n => `${n} m`).join(" × "), Mass: `${prop.mass} kg` }
    return {}
  },
})
