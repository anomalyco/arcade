# Realism log

Measurements, proofs, open candidates and sources behind [realism.md](../realism.md). The playbook says what to use
and what Kit decided; this page keeps the evidence. Headings follow the playbook's sections.

## Candidates awaiting Kit

- **Water.** Carrier's opt-in continuous ocean (`packages/kit/water/`): irregular filtered normal bands, sparse sun
  glints and turbulent surface foam; `water/wake.ts` adds a bounded Kelvin cusp-normal approximation at 19.47°,
  driven by the real boat poses. Wave geometry and authoritative buoyancy are unchanged. BARBARA's lake (Lab › Water ›
  Water look › Moonlit) reflects the shared `kit/sky` through a cached HDR cube with a 64-bin canopy mask, not a full
  planar forest reflection. Both keep Today as the default. Cost deliberately not gated by paired timing, per Kit.
  Evidence: [perf/water.md](../../perf/water.md), [perf/lake-water.md](../../perf/lake-water.md).
- **Clear air near you (Woods).** `packages/kit/forest/view.ts` scales torch in-scatter from 10% at the eye to 100% at
  8 m, with −0.25-stop compensation only while your torch is on. Renderer GPU delta −0.031 to +0.053 ms (mini/Metal,
  High, 1600×900, three views; [measurements](../../perf/woods-autoresearch.md#review-follow-up-optional-clear-near-air)).
  Default on in BARBARA and its Lab page at Kit's request; his final visual decision is pending. Mist → Clear air near
  you → off restores Today, including its exposure target, after adaptation settles; smoke stays Today.
- **Rain visibility follow-up (`weather-rain-look`).** Kit approved adaptation but rejected the faint lamp rain. On
  the branch, streak radiance receives attenuation once, with a forward-scattering lobe and no unlit floor. The far-drop
  budget samples world-anchored tiles around nearby light sources; the near field is tighter, and streak counts no
  longer fall to 34% at HiDPI. Splash/mist budgets are unchanged. A typed **Streak brightness** control defaults to 4×.
  Stills: `perf/weather-rain-look.md`; Today matches the shipped renderer. Motion and GPU cost unmeasured.
- **Road flare in BARBARA**, **forest storm** (Storm coming, Downpour): decision pending; see the playbook entries.
- **Night sky:** calibrated exposure and cloud composition remain integration work.

## Lights

- **Moonlight through the canopy** (BARBARA, PR #488). Moon sky: Krisciunas & Schaefer 1991 (PASP 103, 1033),
  Rayleigh (1.06 + cos²ρ) plus aerosol 10^(0.79 − ρ/40°) per lux, × (1 − 10^(−0.4·k·X)); a full moon at 34° (0.195 lx
  after extinction) puts the sky 60° away at ~0.0044 cd/m² and the dome's ground illuminance at ~11% of the moon's.
  Shafts march the bank's mean density 6–8 steps within 36 m (the billow noise cost more and the shadow gives them their
  shape). Stills (`games/barbara/scripts/moonlight-proof.ts`, 1600×900 High, torch off): near-black pixels ~75% → 31–48%,
  median luma 3 → 6–8 /255 across dense canopy, gap, clearing and lake; torch-on median 6 → 7. Paired GPU on the mini
  at the gap 10.47 → 11.18 ms with the earlier, heavier shaft march (upper bound). Clear-air shafts (`moonAir` 0.25–0.5)
  changed the gap's mean by under 0.2/255. Dark adaptation rarely acts under a full moon (the moonlit scene keeps the
  camera below its lift); moonless at the dense spot it lifts exposure ×1.74 → ×3.5. Gallery
  `barbara-moonlight-2026-10-22/`.
- **Night sky.** Initial sky-only mini Metal proof, 1920×1080 MSAA4: +0.204 ms median (MAD 0.028 ms), before the lunar
  occultation and mip-filtering follow-up; no whole-game cost claim. Integrated star energy varies 0.035% across 32
  subpixel positions; translation-free sky TAA drifts 0.031 px after 64 m camera travel in the isolated
  production-pass fixture. Ledgers: [night sky](../../perf/night-sky.md),
  [woods integration](../../perf/night-sky-woods.md).
- **Street lamps.** Research: `~/code/home/artifacts/lot-2026-10-20/lamps-*`, `lamps-research-2026-10-20.md`. On
  SwiftShader the lens path took CI's smoke from 66–116 s to 149 s, hence compile-time opt-in.
- **Torch beam targets** come from the woods research `RESEARCH.md` §D; wet-surface targets from Lagarde's *Water
  drop* series.

## Bounced light, fog and atmosphere

- **Lamp airlight.** Based on Aiden's Afterhours; equiangular sampling after Kulla & Fajardo.
- **Low mist.** Pooling made Outbreak's mist slightly cheaper (−0.05 to −0.12 ms paired against the old even layer),
  because the bank skips its noise where the mask is 0.

## Rain, storms and lightning

- **Rain.** Garg & Nayar 2006 (streak appearance depends on light and view); Tatarchuk 2006 (ToyShop).
- **Lightning.** `~/code/home/artifacts/lot-2026-10-20/storm/RESEARCH.md` (NOAA, Rakov & Uman, WCAG G15).
- **Forest storm cost.** Downpour vs Today at the camera-lab spot (mini Metal, 1600×900, 12-frame median, three
  runs): +0.6–1.4 ms High, +0.15–0.4 ms Low.

## Built structures

- **BARBARA camp construction.** Approved camp pose: triangles 780,622 → 789,329, draws 468 → 468, lights 21 → 42.
  Rough shared-Pro timing ~20 ms for the candidate is unpaired and does not establish incremental cost. No new render
  pass. Game lights pack before camp under the 64-light limit (`forest/lights.test.ts`).
  [Evidence and port status](../../perf/woods-autoresearch.md).

## Camera and post

- **Highlight shoulder.** Fixed near-bark clipping 9.52% → 0%, hotspot detail .001762 → .009900 at equal exposure
  .354. Isolated GPU delta unmeasured; the earlier whole candidate camp was roughly 12–13 ms on mini/Metal at 1600×900
  High, not the shoulder's cost.
  [Woods round 7](../../perf/woods-autoresearch.md#round-7-source-filtered-bloom-and-camp-delta-2026-10-22).
- **Bloom contained at the source.** Trunk-edge excess over no-bloom falls 94.6%; bulb/torch halo display-luminance
  contributions remain .187510/.027323. The mask is full within 3 m, fades to 6 m, and skips roughness below .4 to
  preserve reflections. MSAA and source filtering mix tags at silhouettes, allowing a small fringe and partial
  attenuation of subpixel emitters over tagged surfaces. Broad head-on torch haze remains even with bloom off.
- **Camera artifacts.** Contact sheet: gallery `woods-2026-10-21/camera-lab/`. Camera filter sources:
  `~/code/home/artifacts/agent-reports/camera-filters.md`.
- **Camera treatment targets** come from the woods research `RESEARCH.md` §F.

## Temporal stability

- **Signed metadata loses its sign in history.** `gpu/temporal.ts`'s `sampleHistory` clamps all four channels to
  ≥ 0 after Catmull–Rom sampling. Current-frame alpha is signed, but history loses Woods' negative bloom mask and
  Outbreak's negative flash mask. The later neighbourhood clamp restores a uniform negative area; at mixed edges,
  especially during motion, positive history weakens suppression. A fix should clamp RGB only and keep alpha until the
  neighbourhood clamp, with a moving-edge regression covering both signed masks and the non-negative roughness/shroud
  consumers. Left unchanged so far: cross-game temporal verification is broader than a cheap local fix, and settled
  stills do not prove that behaviour.

## Sources

- Storm (rain, wet BRDF, lightning, thunder, flash safety): `~/code/home/artifacts/lot-2026-10-20/storm/RESEARCH.md`.
- Night forest (scans, flashlight photometry, mist coefficients, camera treatment, asset licences):
  `~/code/home/artifacts/woods-2026-10-21/RESEARCH.md`.
- Web survey (Tidewater, web-ocean, Neon Zenith, three.js nodes, radiance cascades) and the Ashwood comparison:
  `~/code/home/artifacts/agent-reports/gfx-research.md`, `engine-comparison.md`, contact sheet
  `~/code/home/artifacts/gfx-research-2026-10-20/index.html`.
- Quality pipeline (prop textures, lighting rank, lookdev loop, finishing, why agents skipped the docs):
  `~/code/home/artifacts/2026-10-23-quality-pipeline/`.
