import type { City } from "../../shared/sim/city"
import type { SimEvent, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"

export type HudContext = {
  myId: string
  cam: Camera
  width: number
  height: number
  dt: number
  events: SimEvent[]
  players: { id: string; name: string; human: boolean }[]
  room: string | null
  status: string
}

/** In-game DOM overlay. Owned by the HUD module; main.ts only calls update() each frame. */
export class Hud {
  constructor(
    readonly root: HTMLElement,
    readonly city: City,
  ) {}

  update(view: WorldView, ctx: HudContext) {
    void view
    void ctx
  }
}
