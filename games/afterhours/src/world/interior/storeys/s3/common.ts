import { type DocumentId, type DocumentPlacement, documentGeometry, documentMaterial } from "../../../../render/documents"
import { MODELS } from "../../../../render/models"
import { type Builder, type RoomHandle, FLOOR_Y } from "../../api"

/** Shared state while storey 3 builds: seeded random, the paperwork list, room handles to update. */
export class S3 {
  private seed = 31337
  readonly docs: DocumentPlacement[] = []
  readonly rooms: RoomHandle[] = []
  constructor(readonly b: Builder) {}
  rnd = () => ((this.seed = (this.seed * 16807) % 2147483647) / 2147483647)
  /** A sheet on a wall (normal along ±x/±z) or flat on a surface (normal [0, 1, 0]). Ground-floor coordinates. */
  doc(id: DocumentId, position: readonly [number, number, number], normal: readonly [number, number, number], o: Omit<DocumentPlacement, "id" | "position" | "normal"> = {}) {
    this.docs.push({ id, position, normal, ...o })
  }
  flushDocs() {
    if (this.docs.length) this.b.add(documentMaterial(), documentGeometry(this.docs), { worldUV: false, cast: false })
  }
}

export const DESK_TOP = FLOOR_Y + MODELS.office_desk.size[1]
