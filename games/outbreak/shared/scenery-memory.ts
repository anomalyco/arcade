import type { Town } from "./map"
import { FOG_CELL, FOG_SIZE, type Vision } from "./vision"

/** Static room discovery only. Never use this texture to decide whether an actor is visible. */
export class SceneryMemory {
  readonly mask = new Uint8Array(FOG_SIZE * FOG_SIZE)
  private rooms = new Set<string>()
  update(town:Town,vision:Vision):boolean {
    let changed=false
    for(const b of town.buildings) for(let room=0;room<2;room++) {
      const [x,z,r,e]=b.rect, top=room?z+5.7:z, bottom=room?e:z+5.5, key=`${b.id}-${room}`
      const rx0=b.kind==="house"&&room===0?x+2:x, rx1=b.kind==="house"&&room===0?x+9.5:r
      if(this.rooms.has(key)) continue
      const inside=vision.x>rx0 && vision.x<rx1 && vision.y>top && vision.y<bottom
      if(!inside && !vision.visible(x+5.7,(top+bottom)/2)) continue
      this.rooms.add(key); changed=true
      for(let y=Math.floor(top/FOG_CELL);y<Math.ceil(bottom/FOG_CELL);y++) for(let a=Math.floor(rx0/FOG_CELL);a<Math.ceil(rx1/FOG_CELL);a++) this.mask[y*FOG_SIZE+a]=255
    }
    return changed
  }
}
