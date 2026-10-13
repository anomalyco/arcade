# Dev Hub

Getaway and Blackout serve the unlisted developer entry at `dev.html`, next to `lab.html`.
For example, the production path is `/arcade/getaway/dev.html`. The page has `noindex,nofollow` and
has no public landing link. Each game keeps its existing Worker routes.

Games lists Getaway, Blackout, Wings and Carrier. Outbreak stays inside a closed Prototypes disclosure.
Local previews accepts explicit `http://name.localhost:1355/` Nexus URLs and stores them in this browser's
localStorage. Empty entries use production links. The hub never discovers ports or starts services.
Wings remains an independent project; its link does not import its dependencies.

Sandbox opens the current host's shared `lab.html`. The Lab toolbar's Hub link returns to Games.
Catalogue opens a searchable grid and a single WebGPU viewer. Both hosts use the shipped spawn adapters:
seven Getaway vehicles, 17 street props and Blackout's soldier. IDs come from those registries, and
dimensions and mass come from the game configuration. The viewer uses production geometry with the
existing shared Lab shading, not full game material/lighting parity.

## Catalogue input

Click a card to focus an asset. Click the viewport to select its single asset. Option-drag orbits;
Shift-drag or middle-drag pans. Scroll zooms. The toolbar also provides orbit and zoom buttons.
With the viewport focused, F frames, arrows orbit, plus/minus zoom, and Esc clears the selection and
focuses search. Right-click or Control-click opens Frame and Export feedback actions.
Text fields keep their keys. Cmd shortcuts and Ctrl-wheel remain browser-owned, including browser
pinch events delivered as Ctrl-wheel. Physical multitouch gesture recognition is not claimed.

This viewer is read-only and contains one asset, so it has no box selection or transform gesture.
Placement and multiple-object editing stay in the Sandbox. There is no Place in Sandbox button because
the shipped workbench has no safe cross-page asset placement contract.

Lighting setups (Neutral, Day, Night, Interior) use the shared Lab panel. Each changes the existing
stage lighting settings live. They are inspection recipes rather than reconstructions of game scenes.
No simulation or audio starts in the catalogue. Rendering is demand-driven; Games and hidden documents
submit no further frames. Navigation away releases the viewer device, with a retained device for browser
back/forward-cache pages until restoration.

## Feedback

Draft text is stored locally per asset ID. Export opens selectable JSON, and Copy writes the same JSON
to the clipboard, falling back to the dialog when clipboard access fails. JSON includes asset ID,
feedback, lighting settings, camera and fixture seed 7. There is no remote feedback service.

## Proof

`bun scripts/prove-dev-hub.ts` runs isolated headless Chromium/Metal fixtures for both hosts.
It checks the production/default links, explicit Nexus overrides, prototype separation, catalogue IDs,
filtering, lighting export, context actions, keyboard focus, text input and native Ctrl-wheel ownership,
zero AudioContexts, hidden-route rendering, synthetic document visibility, and Lab return navigation.
It captures desktop and 390-pixel layouts under `captures/dev-hub/`.
