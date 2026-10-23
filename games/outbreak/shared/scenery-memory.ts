import type { Town } from "./map"
import { FOG_CELL, FOG_SIZE, type Vision } from "./vision"

/** Static room discovery only. Never use this texture to decide whether an actor is visible. */
export class SceneryMemory {
  readonly mask = new Uint8Array(FOG_SIZE * FOG_SIZE)
  private rooms = new Set<string>()
  originX = 0
  originY = 0

  setWindowOrigin(ox: number, oy: number, town: Town): boolean {
    if (ox === this.originX && oy === this.originY) return false
    this.originX = ox
    this.originY = oy
    this.mask.fill(0)
    for (const b of town.buildings) {
      for (let room = 0; room < 2; room++) {
        const key = `${b.id}-${room}`
        if (!this.rooms.has(key)) continue
        this.stampRoom(b, room)
      }
    }
    return true
  }

  private stampRoom(b: Town["buildings"][number], room: number): void {
    const [x, z, r, e] = b.rect
    const split = Math.min(z + 5.5, (z + e) * 0.5)
    const top = room ? split + 0.2 : z
    const bottom = room ? e : split
    const rx0 = b.kind === "house" && !b.footprint && room === 0 ? x + 2 : x
    const rx1 = b.kind === "house" && !b.footprint && room === 0 ? x + 9.5 : r
    const y0 = Math.max(0, Math.floor((top - this.originY) / FOG_CELL))
    const y1 = Math.min(FOG_SIZE, Math.ceil((bottom - this.originY) / FOG_CELL))
    const x0 = Math.max(0, Math.floor((rx0 - this.originX) / FOG_CELL))
    const x1 = Math.min(FOG_SIZE, Math.ceil((rx1 - this.originX) / FOG_CELL))
    for (let y = y0; y < y1; y++) {
      for (let a = x0; a < x1; a++) {
        this.mask[y * FOG_SIZE + a] = 255
      }
    }
  }

  update(town:Town,vision:Vision):boolean {
    let changed=false
    if (vision.originX !== this.originX || vision.originY !== this.originY) {
      this.setWindowOrigin(vision.originX, vision.originY, town)
      changed = true
    }
    for(const b of town.buildings) for(let room=0;room<2;room++) {
      const [x,z,r,e]=b.rect
      const split = Math.min(z + 5.5, (z + e) * 0.5)
      const top=room?split+0.2:z, bottom=room?e:split, key=`${b.id}-${room}`
      const rx0=b.kind==="house"&&!b.footprint&&room===0?x+2:x, rx1=b.kind==="house"&&!b.footprint&&room===0?x+9.5:r
      if(this.rooms.has(key)) continue
      const inside=vision.x>rx0 && vision.x<rx1 && vision.y>top && vision.y<bottom
      const midY=(top+bottom)/2
      // Your own sight only: a teammate's beam shows a room for as long as it lights it, but you haven't been there.
      if(!inside && !vision.ownVisible((rx0+rx1)/2,midY) && !vision.ownVisible(Math.min(rx1-1.0,x+5.7),midY) && !vision.ownVisible(rx1-2.5,midY) && !vision.ownVisible(rx0+2.5,midY)) continue
      this.rooms.add(key); changed=true
      this.stampRoom(b, room)
    }
    return changed
  }
}
