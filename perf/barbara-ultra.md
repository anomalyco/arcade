# BARBARA Ultra (22 October 2026)

Ultra is an explicit shared-shell choice. Auto starts at High and never promotes to Ultra. Ultra may reduce
resolution, then move down through High/Balanced/Low on slow frames; after leaving Ultra it recovers only to High.
Settings reports the active tier and any reduced resolution. Selecting Ultra again restores full quality.

## Retained settings

| Setting | High | Ultra |
|---|---:|---:|
| DPR cap | 1.5 | 2 |
| Minimum adaptive scale | 0.7 | 0.75 |
| Fog samples / mist steps | 8 / 8 | 12 / 12 |
| Detailed trunks / ferns | 35 / 14 m | 60 / 22 m |
| Distant geometry | 140 m | 180 m |
| Shadow cap | 2048 | 2048 |
| Bloom levels / texture size | 5 / 1024 | 5 / 1024 |

The camera already reaches 300 m; `far` is the geometry/LOD distance, not its clip plane. At the default
depth-mist extinction (0.05/m after the clear zone), the added distant geometry is behind dense fog. The
matched forest view has no visible cutoff. Clear-air custom looks can expose the edge.

The current `SpotShadowSettings.size` API only accepts 512/1024/2048. Its allocation code is dimension-based,
so 4096 is a plausible extension, not a hardware limitation. This task leaves that torch-owned path alone.
The authored shadow-size setting still caps actual maps (default 1024). Ultra preserves High's two torch slots
and 4K map print instead of falling into the old “not High” low-detail branches.

## One requested measurement run

Mini, M4 Pro, headless Chromium/Metal, muted; `scripts/barbara-ultra.ts`. Production build based on main
`78f14f87`, before combined-deploy PR #476. One view north of camp, local torch on, fixed pose and clock;
High → Ultra → Ultra → High at each DPR. Each block warms 24 frames, then measures 24 complete game-frame
submissions including CPU encoding and GPU queue drain, plus 12 isolated whole-renderer GPU timestamp samples.
This is a static warmed view, with cached shadow maps, not walking or worst-case frame pacing. Other worker jobs
were running. Rough costs, not a 60 fps guarantee.

| CSS viewport / DPR | High canvas | Ultra canvas | High frame ms | Ultra frame ms | High GPU ms | Ultra GPU ms |
|---|---|---|---:|---:|---:|---:|
| 1600×900 / 1 | 1600×900 | 1600×900 | 15.4–15.5 | 19.2–19.5 | 12.63–12.65 | 16.16–16.16 |
| 1600×900 / 2 | 2400×1350 | 3200×1800 | 23.9–24.1 | 40.6–41.0 | 20.80–20.87 | 37.18–37.30 |

At equal resolution, the detail/sampling bundle costs about 3.5 ms GPU (+28%); at Retina, native pixels plus
that bundle cost about 16.4 ms (+79%). Drawn triangles rise from 1.94 M to 3.81 M. Retain 12 samples/steps,
rather than increasing them further: this already consumes the mini's 60 Hz budget at 900p. Native Retina
Ultra is for stronger GPUs or a lower frame rate, with the slow-frame fallback in normal play. Automation
pins Ultra so the measurements cannot silently step down.

No browser errors. The real Settings DOM showed all five choices and updated to `Auto: Balanced` while open,
at both DPRs. Unit coverage checks opt-in/persistence, native canvas size, deterministic pins, slow-frame Ultra
fallback, explicit reselection, and Auto's High ceiling. 37 quality/shell tests passed; Barbara, Outbreak and
root proof-script typechecks passed.

Evidence: [High/Ultra stills and raw samples](https://studio.taila8e7c7.ts.net:8444/raw/barbara-ultra-2026-10-22/index.html).
The stills share the camera, simulation time and exposure. TAA/noise history is allowed to settle per tier.
