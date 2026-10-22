import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_WINDOW_ROOM_SETTINGS, windowRoomControls } from "./settings"

/**
 * Lit rooms behind the windows (Lab › Look · Lit rooms, Today one setting away): the window glass in `shaders.ts`
 * calls `outbreakWindowRoom` (`window-rooms/wgsl.ts`) when `OL.rooms.x` is on.
 */
export const outbreakWindowRoomsFeature = registerOutbreakClientFeature({
  id: "window-rooms",
  order: 35,
  settingsGroup: { subsystem: "windowRooms", defaults: DEFAULT_WINDOW_ROOM_SETTINGS },
  labControls: () => windowRoomControls,
  harnessState: (host) => ({ windowRooms: { on: host.settings.windowRooms.windowRoomStyle > 0.5 } }),
})
