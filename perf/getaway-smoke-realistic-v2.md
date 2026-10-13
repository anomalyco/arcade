# Shipped tyre smoke, v2

The sole renderer is advected billows, formerly style 6. The selector and all experimental render paths were removed.
The code is rebased onto `getaway-look` `5f9b839`, including the startup-flash fix and baked effects.

## Behaviour

| Route | Peak smoke samples | Skid segments | End smoke samples |
| --- | ---: | ---: | ---: |
| Drift | 312 | 136 | 0 |
| Burnout / launch | 144 | 190 | 0 |
| Standing nitro | 74 | 56 | 0 |
| Rolling nitro | 0 | 0 | 0 |
| Shift / lift-off | 0 | 0 | 0 |
| Cold exhaust | 0 | 0 | 0 |

Every recorded pose and emission count matched between the still and portrait captures. All six routes completed
with no browser/GPU errors. Sources, source-frame motion inspection and decoded-video inspection are under
`captures/getaway-smoke-realistic-v2/`. The nitro launch starts after ten stationary frames; the rolling route
starts at 25 m/s. The drift, burnout, pop and cold routes use the earlier study's inputs and seed.

The sheet is 1440×1440. The silent phone clip is 720×1280, 15 fps, 40.133 s and 8,001,888 bytes. `ffprobe` confirms
H.264 Main and limited-range yuv420p. The `moov` atom is before `mdat`. Both files were sent to the requested Kit
iMessage address; outgoing history confirmed the image and video attachments.

Wheelspin is a presentation proxy driven by controls and specs, not a tyre-RPM simulation. It lasts at most 1.25 s,
fades with speed to zero at 24 m/s, and ramps heat faster than drift smoke. It scales with `accel / grip`, boost
strength and drive layout. The Compact now specifies FWD and the Interceptor AWD; other unspecified specs default
to RWD. Remote snapshots can trigger nitro launches through `boosting`, but ordinary throttle/brake-release launches
still require local controls. Drift clouds live 4.5–5.3 seconds after emission, independently of grip returning.

Grass suppresses white tyre smoke and road skid marks. The surface classifier follows the visible park lawn inset,
crossing paths and central paving, using a circular approximation for the 16-sided paved ring. It does not model
snow traction or make dust. The stronger practical-light response still uses only 32 packed lights in the vertex
stage. Normal gameplay adds one smoke draw, no smoke shadows and no new render pass.

## Paired whole-GPU cost

Apple M5 Max, Chromium `apple / metal-3`, 960×640, existing 4× MSAA/post pipeline. One warmup route precedes the
measurements. Each frozen pose uses a discarded warmup pair and nine alternating on/off pairs, eight frames per
member. Every pair verifies identical poses. The interval starts at the first shadow pass and ends at a dependent
load/store of the same final composite target. No pass times are summed. The marker exists only in benchmark mode
and has equal overhead in both members.

The final on/off toggle includes tyre billows, skid ribbons, attached flames, cold wisps and pop lights. Simulation,
emission bookkeeping and unrelated lights stay active, so this measures rendering cost rather than CPU work.
`getaway-smoke-realistic-v2.json` retains all raw on/off frame intervals, pair deltas and a common pose for each group.
The local full capture also retains duplicate per-frame poses and route history. An initial run held skid rendering
on in both members; it is retained locally as `timings-smoke-exhaust-only.json` and is not the table below.

| Route / frame | Median paired Δ (ms) | MAD (ms) | Pair min / max (ms) |
| --- | ---: | ---: | ---: |
| drift / 30 | 0.0174 | 0.0018 | 0.0116 / 0.0284 |
| drift / 64 | 0.0250 | 0.0697 | -0.2138 / 1.5304 |
| drift / 100 | 0.0393 | 0.0238 | -0.0053 / 0.0880 |
| drift / 150 | 0.0846 | 0.0092 | 0.0425 / 0.0937 |
| burnout / 30 | 0.0055 | 0.0025 | -0.0069 / 0.0089 |
| burnout / 64 | 0.0100 | 0.0018 | -0.0014 / 0.0140 |
| burnout / 100 | 0.0254 | 0.0027 | 0.0176 / 0.0294 |
| burnout / 150 | 0.0426 | 0.0017 | 0.0387 / 0.0581 |
| launch / 30 | 0.0043 | 0.0301 | -0.6285 / 1.5090 |
| launch / 64 | 0.0200 | 0.0058 | 0.0012 / 0.0370 |
| launch / 100 | 0.0254 | 0.0068 | 0.0130 / 0.0470 |
| launch / 150 | 0.0395 | 0.0024 | 0.0330 / 0.0420 |
| nitro / 30 | -0.0049 | 0.0770 | -0.3839 / 0.6787 |
| nitro / 64 | 0.0020 | 0.0122 | -0.2395 / 0.2282 |
| nitro / 100 | -0.0008 | 0.0013 | -0.0030 / 0.0046 |
| pops / 30 | 0.0030 | 0.0014 | 0.0005 / 0.0083 |
| pops / 64 | 0.0004 | 0.0023 | -0.0037 / 0.0055 |
| pops / 100 | 0.0036 | 0.0015 | 0.0019 / 0.0060 |
| cold / 30 | 0.0060 | 0.0013 | -0.0033 / 0.0148 |
| cold / 64 | 0.0098 | 0.0017 | -0.0116 / 0.0178 |
| cold / 100 | 0.0085 | 0.0028 | -0.0047 / 0.0281 |

All pose medians are below 0.3 ms. Negative deltas and large outliers reflect shared-device noise, not a rendering
saving. Small flame costs are near measurement resolution. These measurements do not establish a many-car budget,
phone-device performance, or an improvement over v1, which ran under different device load and look code.

## Reproduce

From `games/getaway`:

```sh
hivemind run --kind browser --fetch captures/getaway-smoke-realistic-v2 -- bun scripts/prove-smoke-realistic.ts --fixture
hivemind run --kind browser --fetch captures/getaway-smoke-realistic-v2 -- bun scripts/prove-smoke-realistic.ts --fixture --video
hivemind run --kind browser --fetch captures/getaway-smoke-realistic-v2/timings.json -- bun scripts/prove-smoke-realistic.ts --fixture --timing
python3 scripts/smoke-realistic-sheet.py
bun run check
```

The headless fixture binds private loopback, mutes audio and closes on completion. Capture/encoding ran through
Hivemind on Studio. Encoding uses `h264_videotoolbox`, Main, 1600 kbps, limited-range yuv420p and fast-start.
The final check passes 116 tests, 12 existing skips, typechecks and the production build. Tests cover driven-wheel
masks, power scaling, transient expiry, highway-speed cutoff, airborne/popped wheels, grass versus paths/plazas,
rear-only launch tracks, bounded skid storage/fading, heat, persistence, dissipation, pops and cold condensation.
