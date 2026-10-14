# Dev Control (`arcade` CLI)

To show Kit an orientation, scene, asset, or parameter setup in his already-open browser page without stealing window focus, use the local `arcade` CLI (`bun run arcade …` or `arcade …`).

`scripts/dev.ts` (`bun run dev`) exposes a loopback-only control endpoint (`/__arcade/control`) protected by a per-server `0600` token file (`.arcade-control.json` and `~/.cache/arcade/dev-control.json`) and strict same-origin checks. Production builds and Cloudflare Workers never include the control endpoint or client runtime.

To drive pages opened from another machine through Tailscale Serve, list the exact hostname in
`ARCADE_DEV_ALLOWED_HOSTS` (or Vite's `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, which the dev server also needs):

```sh
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=kits-mac-studio.taila8e7c7.ts.net PORT=5180 bun run dev
tailscale serve --bg --https=5180 http://127.0.0.1:5180
```

Listed hosts are accepted only over HTTPS with an Origin matching Host, plus the page token. The CLI endpoint stays
loopback-only; run `bun run arcade` on the machine serving the pages.

## Commands

Read-only commands:

```sh
bun run arcade status                                  # Server health and connected browser pages
bun run arcade pages                                   # Connected pages (* marks active target)
bun run arcade cmd list                                # Commands registered on the active page (LabCommandDescriptor[])
bun run arcade state                                   # Scene JSON (LabSceneState: mode, section, environment, seed, transport, camera, selection, objects, settings, lighting, compare, history, commands)
bun run arcade camera get                              # Orbit (°), elevation (°), distance (m), target [x,y,z]
bun run arcade lab get [path]                          # Read one control or all Lab settings
bun run arcade lab preset save [name] [--out file.json]# Export validated LabPresetSchema JSON (preset.export)
bun run arcade screenshot --out /tmp/shot.png          # Capture canvas PNG over the bridge (default <=1280px; --full for native)
```

Mutating commands (display a brief `CLI: …` indicator in the page, respect Kit's live drag/possession input, and record Undo history on the same stack as `⌘Z`):

```sh
bun run arcade open <target>                           # Navigate existing page: hub, catalogue, characters, lab, blackout-lab, getaway, blackout, outbreak, carrier, or /arcade/…
bun run arcade open hub --new                          # Open a background browser tab ONLY if 0 pages are connected
bun run arcade select <id|name>                        # object.select: scene object (prop:0, character:active, hydrant), catalog fixture, or asset
bun run arcade camera set --orbit 38 --elevation 24 --distance 13 --target 0,0.5,4
bun run arcade camera set --frame hydrant              # camera.set: frame an object or 'scene'
bun run arcade spawn hydrant --at 2,-4 --yaw 30        # ground.spawn-here: prop, character, or light (coords or center/ahead/ramp/pad/alcove/lane)
bun run arcade lab set skidWidth 0.32                  # scene.set-param: update a Lab control through LabNavigation.set
bun run arcade lab preset load preset.json             # preset.import: validate and apply a saved preset name or JSON file
bun run arcade env street --seed 9                     # scene.set-env: switch Lab environment/lighting look or Catalogue lighting setup
bun run arcade transport pause                         # transport.toggle / transport.step [frames] / transport.speed <mult> / ground.trigger-here
bun run arcade possess getaway:muscle                  # mode.play: enter Play mode on character
bun run arcade release                                 # mode.play: exit Play mode back to Edit mode and release input
bun run arcade run <command-id> '{"key":"value"}'      # Invoke any command ID from 'arcade cmd list'
bun run arcade run outliner.select '{"kind":"cone"}'   # Lab layout: select in the Outliner (also id, ids, additive)
bun run arcade run library.place '{"id":"spawn-prop:hydrant","at":"2,-4"}'  # Place a Library item at a ground point
bun run arcade run library.toggle '{"category":"materials"}'               # Open the Library drawer on a category
bun run arcade run watch.pin '{"key":"skidWidth"}'     # Pin a setting to the viewport Watch list (watch.unpin)
bun run arcade run details.filter '{"modified":true}'  # Details: show only modified settings (details.reveal jumps)
```

Global flags: `--json` (machine-readable output), `--page <id|kind>` (target a specific connected tab), `--control-file <path>`, `--timeout <ms>`.

Exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Dev server unreachable, missing/insecure token file, or runtime error |
| `2` | No browser page connected (`no_page_connected`) or `--page` not found |
| `3` | Command unavailable in current mode (e.g. Edit command while in `Play` mode) or blocked by live user drag/scrub (`unavailable` / `busy`) |
| `4` | Unknown command or invalid/out-of-range arguments (`unknown_command` / `invalid_args`) |

## Shared Command Registry (`@arcade/kit/lab-commands` & `@arcade/kit/dev-control`)

UI buttons, keyboard shortcuts, radial menus, the `⌘K` palette, and the `arcade` CLI share one `LabCommandRegistry` per page:

```ts
import { LabCommandRegistry, type LabCommand } from "@arcade/kit/lab-commands"
import {
  registerDevControl,
  registerPanelLabCommands,
  registerStageCameraCommands,
} from "@arcade/kit/dev-control"
```

Pages (Hub, Lab Workbench, Catalogue, Characters page on `rig-page`, and games) register their command table and state reader via `registerDevControl({ kind, commands, getState, getCanvas, captureCanvas, isBusy })`. Any page mounting `LabPanel` automatically exposes `lab.get`, `scene.set-param`, `nav.open`, `state`, and `screenshot`.

## Proof

Run the headless Metal end-to-end proof via Hivemind:

```sh
hivemind run --fetch captures/dev-control -- bun scripts/prove-dev-control.ts
```
