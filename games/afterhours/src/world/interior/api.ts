// Public interior API for storey modules (src/world/interior/storeys/sN.ts). Import from here only — plus layout,
// render/models and render/materials — never from another storey's file or from the kit's internal files.

// Coordinates and the building program's fixed plan.
export * from "./plan"
// Construction primitives (Builder, materials, wall, door, ceiling, troffer, filtered patterns, constants).
export {
  Builder,
  type Mat,
  type Band,
  type Paint,
  type Opening,
  FLOOR_Y,
  CEIL_Y,
  STOREY_H,
  LAYER,
  DOOR_W,
  DOOR_H,
  M,
  T,
  paint,
  glow,
  wall,
  door,
  doorOpening,
  ceiling,
  troffer,
  louvre,
  fluorescentPanel,
  flicker,
  PANEL_ON,
  PANEL_WARM,
  TUBE,
  TUBE_WARM,
  aaStep,
  aaWindow,
  aaLines,
  aaFade,
  corridorBands,
} from "./kit"
// Program builders.
export { partition, studWall, column, type PartitionSpec, type POpening, type PDoor, type PGlazed, type PCased, type PClerestory, type PGap, type Finish } from "./partition"
export { doorway, type DoorwaySpec } from "./doorway"
export { room, dressWindow, type RoomOpts, type RoomHandle } from "./room"
export { spine, type SpineOpts, type SpineHandle } from "./spine"
export { serviceStack, riserW1, RISER_W1_OUTER, type ServiceOpts, type ServiceHandle, type ServiceRoom } from "./services"
export * from "./lights"
export * from "./fixtures"
export { STYLES, ROOM_BANDS, WET_BANDS, PLANT_BANDS, type Style } from "./styles"
// Models.
export { placeModels, wastebasket, blobMat, type Prop } from "./props"
// Registry (gameplay hooks).
export { interiorRooms, interiorDoors, registerDoor, type Anchor, type RoomEntry, type DoorEntry } from "./registry"
// Storey module contract.
export type { StoreyContext, StoreyHandle, StoreyModule } from "./storeys/types"
