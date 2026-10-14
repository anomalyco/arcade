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
bun run arcade open <target>                           # Navigate existing page: hub, catalogue, characters, lab, getaway-lab, blackout-lab, outbreak-lab, getaway, blackout, outbreak, carrier, or /arcade/…
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
bun run arcade note "Noir A/B Wipe" --body "Left: current · Right: noir" --target setting:compare
bun run arcade tour .arcade-tours/look-review.json     # Open ONE browser tab with a top Studio Tab Strip of mini-tabs
bun run arcade tour .arcade-tours/overnight.json --multi-tab # Legacy mode: open one separate browser tab per step
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

Pages (Hub, Lab Workbench, Catalogue, Characters page on `rig-page`, and games) register their command table and state reader via `registerDevControl({ kind, commands, getState, getCanvas, captureCanvas, isBusy })`. Any page mounting `LabPanel` automatically exposes `lab.get`, `scene.set-param`, `nav.open`, `ui.note`, `state`, and `screenshot`.

## Show Kit things

To call Kit's attention to a specific feature in an open tab or walk him through several setups across tabs:

- **One-off pinned note (`ui.note` / `arcade note`)**:
  Renders a compact, dark, non-blocking card at the top of the page, prefixes `document.title` with `▸ <title>` so tabs are distinguishable, and optionally pulses a highlight ring around a scene object (`--object` or `--target <id>`), a Details inspector control (`--setting <key>` or `--target setting:<key>`), a 3D world point (`--world x,y,z`), a DOM element (`--selector <css>`), or a screen rectangle (`--rect x,y,w,h`). Pressing `Esc` or clicking `×` dismisses the card without stealing input focus.

  ```sh
  bun run arcade note "Outliner & Car Details" \
    --body "Muscle car selected; vehicle & skid controls prioritized in Details." \
    --target character:active
  bun run arcade note --clear
  ```

- **Single-tab Studio Tours (`arcade tour`)**:
  Opens **one** browser tab by default (`singleTab: true`; pass `--multi-tab` for the legacy one-browser-tab-per-step behavior, or `--no-open` to stage without opening a tab) and renders a persistent, dark, collapsible **Studio Tab Strip** (`[data-arcade-studio-strip]`) across the top of every Arcade page (Hub, Lab, Catalogue, Characters, and games).
  - Each tour step appears as a numbered mini-tab (`1 Title`, `2 Title`, …) with its active step highlighted.
  - Switch between mini-tabs by clicking any tab, clicking `‹`/`›`, or pressing `Alt+[` / `Alt+]` (`Option+[` / `Option+]` on macOS).
  - **Fast in-place switching (no reload)**: If the target step shares the current page (e.g. switching Lab sections/presets/cameras on `/arcade/lab/` or player poses on `/arcade/outbreak/`), its `setup` commands and `ui.note` card apply in place in milliseconds without reloading or recreating the WebGPU device. If the target step is on a different page, the tab navigates in place and resumes the strip from `sessionStorage` and the WebSocket bridge so **at most one WebGPU context is ever alive at a time**.
  - **Static Studio Landing Pages (`"kind": "page"`)**: Steps can also be zero-WebGPU landing pages rendered inside the studio shell (`/arcade/getaway/dev.html#tour/<id>/<step>`) with `"markdown"` and/or `"images"` (served from `.arcade-tours/assets/<id>/` via `/__arcade/tour-assets/<id>/<file>`, with click-to-zoom lightbox).
  - **Multi-Tile Variation Grids (`"kind": "grid"` / `arcade grid`)**: Renders 2–9 numbered, labeled variants of the same Lab scene (`looks`, `explosions`, `smoke`, `materials`, `foliage`, `lighting`, or custom `tiles`) live into a single WebGPU canvas using per-tile viewports/scissors at reduced per-tile resolution and a shared simulation timeline/seed (~0.6–0.8 ms total for 6 tiles). Click a tile or press `1`–`9` (or `arcade grid focus <1..9>`) to zoom that tile full-size; press `Esc` or `G` (or `arcade grid focus 0` / `arcade grid close`) to return to the grid or close it.
  - Append a step from the CLI with `arcade tour --add-step <tour> --title "..." [--kind page|grid|scene] [--preset looks|explosions] [--markdown "..."] [--images a.png,b.png]`.

  ```sh
  bun run arcade grid looks
  bun run arcade grid explosions
  bun run arcade grid focus 2
  bun run arcade grid close
  ARCADE_OPEN=pro bun run arcade tour .arcade-tours/look-review.json \
    --base-url https://kits-mac-studio.taila8e7c7.ts.net:5180
  ```

  Example tour JSON (`.arcade-tours/look-review.json`):

  ```json
  {
    "id": "look-review",
    "title": "Outbreak Look Review",
    "singleTab": true,
    "steps": [
      {
        "kind": "page",
        "title": "Paint-Over Targets · Street & Open",
        "body": "Side-by-side comparison of current Outbreak captures vs Noir and Dusk paint-over targets.",
        "markdown": "- **#1 Value Structure**: Darkness owns the frame outside practical pools.\n- **#2 Ground Detail**: Cracked asphalt, weeds over curb joints, gravel, and leaves.",
        "images": [
          { "src": "street.png", "label": "Current · Street", "tag": "Current" },
          { "src": "target-noir-street.png", "label": "Target · Noir Street", "tag": "Noir Target" },
          { "src": "target-dusk-street.png", "label": "Target · Dusk Street", "tag": "Dusk Target" }
        ]
      },
      {
        "kind": "grid",
        "title": "Looks Grid · 6 Style Directions",
        "body": "3×2 live WebGPU Variation Grid in the Looks debug room (Current, Noir, Painterly, Dusk, 70s Sodium, Cozy).",
        "url": "/arcade/lab/?section=looks",
        "preset": "looks"
      },
      {
        "kind": "grid",
        "title": "Explosion Variants · 4 Live Recipes",
        "body": "2×2 synchronized live WebGPU grid sharing one timeline and seed.",
        "url": "/arcade/lab/?section=effects",
        "preset": "explosions"
      },
      {
        "title": "Vignette · Noir, game camera",
        "body": "Same lot with the Noir preset. Compare value structure with the paint-over tab.",
        "url": "/arcade/lab/?game=outbreak&section=outbreak-vignette",
        "setup": [
          { "command": "vignette.preset", "args": { "direction": "noir" } },
          { "command": "vignette.camera", "args": { "preset": "game", "cutaway": "cutaway" } }
        ],
        "target": { "setting": "directionPreset" }
      }
    ]
  }
  ```

## Proof

Run the headless Metal end-to-end proof via Hivemind:

```sh
hivemind run --fetch captures/dev-control -- bun scripts/prove-dev-control.ts
```
