import { type DocumentPlacement, documentGeometry, documentMaterial } from "../../../../render/documents"
import type { Builder } from "../../api"

// Paperwork for storey 1: collect placements (ground-floor coordinates) while the rooms build, then merge every sheet,
// pin and tape strip into the storey's batch as one draw (the documents atlas material).

export class Paper {
  readonly list: DocumentPlacement[] = []
  add(p: DocumentPlacement) {
    this.list.push({ seed: this.list.length * 7919 + 101, ...p })
  }
  /** Sheet flat on a surface at height y. `turn` = rotation about the vertical. */
  flat(id: DocumentPlacement["id"], x: number, y: number, z: number, turn = 0, extra: Partial<DocumentPlacement> = {}) {
    this.add({ id, position: [x, y, z], normal: [0, 1, 0], up: [Math.sin(turn), 0, -Math.cos(turn)], ...extra })
  }
  /** Sheet on a wall plane at (x, y, z) whose outward normal is (nx, nz). */
  wall(id: DocumentPlacement["id"], x: number, y: number, z: number, nx: number, nz: number, extra: Partial<DocumentPlacement> = {}) {
    this.add({ id, position: [x, y, z], normal: [nx, 0, nz], ...extra })
  }
  flush(b: Builder) {
    if (!this.list.length) return
    b.add(documentMaterial(), documentGeometry(this.list), { worldUV: false, cast: false })
  }
}
