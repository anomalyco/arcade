# Office polish

The **Office detail** control switches between Today and Polished. Each effect also has its own controls in the Backquote panel. Implementations live in `src/polish/`; shared kit code is unchanged.

- **Dust:** 1,200 deterministic world-space points, with subpixel energy compensation and a damped walking wake. Surface lighting and dust use the same aperture/slat cookie. Dust samples real spot depth maps and waits for their selection fade to finish. Camera cuts do not inject a wake.
- **Tube:** `tubeSignal` derives level and ignition edges from the kit's seeded fluorescent signal. The central tube, its light, electrode glow and spatial ballast mixer consume that signal. Hum and crackle are original PCM synthesis. Live and offline audio use the same graph.
- **Lens:** edge softness, bright-source fringe, midtone grain and restrained vignette use the existing bloom/ACES pipeline. Turning the lens off restores the previous finish. Smoke uses the original shader and grade tuple.
- **Props:** chair translation/swivel use damped impulses and wall/chair collision checks. Paper responds to actual camera travel, so pushing against a wall does not excite it. Cord motion retains velocity as the handset moves; its shader displacement vanishes at both endpoints. Rest-source mesh transforms update the same buffers used for visible props and shadow casters.
- **Continuity:** a seeded controller switches a chair angle, drawer opening, mug position or far-screen pattern only outside conservative swept frustum bounds and at least eight seconds after last sight. Occlusion is not permission. Default intervals shorten from 75 to 28 seconds after the call. Seed changes reset the sequence and poses.

## Evidence (2026-10-21)

`scripts/polish-proof.ts` builds the production bundle and runs headless, muted Chromium with Metal. It records actual keyboard input at 60 Hz, encodes 30 fps GPU readbacks and renders a stereo Foley tape offline. The final cut explicitly skips 90 seconds while looking away to demonstrate a rare continuity change.

The 24-second tape has 1,440 simulation frames, 22 movement/room events and 11 starter-crackle frames, with no browser/GPU errors. The chair moves 0.263 m in the contact segment; paper reaches 13.2 mm lift. The continuity event occurs at scene time 112 s, outside the frustum, last seen at 20.983 s. Stereo audio peaks at −26.81 dBFS with no clipping.

The M2 Max Metal measurement at 1280×720 alternates Today/Polished/Polished/Today, with 12 warmup frames and 24 samples per block. Whole-frame GPU timestamps include spot-shadow submissions and a dependent marker after the final composite. Median: **3.789 ms Today → 5.529 ms Polished (+1.740 ms)**. This is a shared-worker observation, not an isolated per-effect cost or a cross-device guarantee; block medians ranged 3.607–4.067 ms for Today and 4.960–5.608 ms for Polished.

`tests/polish.test.ts` covers deterministic continuity, visible/recently seen bounds, collision/rest, cord rest, dust replay, blocked paper motion and exact kit flicker parity. `scripts/polish-trace.ts` writes a 2,400-frame deterministic state trace. TypeScript, cycle detection, seven Naga shader validations and the production capture build passed.

Evidence: [sound-enabled showcase](https://studio.taila8e7c7.ts.net:8444/raw/nightshift-2026-10-20/polish-showcase.mp4). Independent model review and release are pending.
