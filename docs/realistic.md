# Realistic games: the playbook

The default build for any game whose style is **realistic** (its `AGENTS.md` says so). It lists what to turn on, in
what order, which gates to pass and what Kit has already decided. [realism.md](realism.md) has each technique's cost
and pitfalls; [quality-checklist.md](quality-checklist.md) is the per-task checklist this extends.

**Shipped** means it is on `main` and a game can turn it on today. **Landing** means a branch is building it; that
branch fills in the row when it merges.

## Turn these on

| Feature | Kit module and setting | Status | Notes |
| --- | --- | --- | --- |
| Highlight shoulder | Forest: `highlightShoulder` (`packages/kit/forest/settings.ts`). Other games: `shoulder` in `packages/kit/look.ts` (0 in every preset) | Shipped | Kit approved it as BARBARA's default. Outside the forest, check paired stills before making it a default. |
| Physical night sky | `skyMode: "physical"` (`packages/kit/sky/settings.ts`); adapters in BARBARA (via forest), Lot, Night Shift, Outbreak | Shipped | Night exteriors. Never raise ambient to make stars show. |
| Exposure model | Forest scene meter (`packages/kit/forest/exposure.ts`); flash recovery `EyeAdaptation` (`packages/kit/weather/exposure.ts`) | Shipped | One exposure controller per frame; correct by 1–2 stops at most, no pumping. |
| Physical lights | `physicalLightHooks` (`packages/kit/gpu/lights/physical.ts`) | Shipped | Lot and Night Shift use it. |
| Practical lights | Torch `SceneLight.beam` (`lights/beam.ts`), lens street lamps (`lights/street.ts`), panels `SceneLight.rect` (`lights/rect.ts`), flicker (`lights/flicker.ts`), emissive bowls with `bloomGate` | Shipped | Light comes from a visible source. |
| CRT display and screen light | Landing on `kit-crt` | Landing | |
| Key-light shadows | Spot shadow maps for the 2–3 lights that matter (`gpu/shadows/spot-shadows.ts`); contact shadows (`gpu/contact-shadows.ts`); capsule shadows for bodies (`gpu/shadows/capsule-shadows.ts`) | Shipped | |
| Fog only where lit | Lamp airlight and fog bank (`gpu/fog-scatter.ts`); pooled mist with a mask and `FogLamp.glowRange`; clear air near the eye (forest) | Shipped | Mist gets no sky light at night; distant darks fade into fog. |
| Indirect light | Top-down: plan bounce (`gpu/gi/plan-bounce.ts`). Interiors: baked lightmaps, landing on `kit-lightmaps` | Shipped / Landing | First-person torch hit bounce is not built. |
| Surfaces | Scans (Poly Haven, ambientCG; [assets.md](assets.md)); footprint-filtered recipes (`gpu/surface-materials.ts`); `normal-mips`, `image-mips` | Shipped | No flat colour near the camera. |
| Wear and finish materials | Landing on `kit-finish` | Landing | Until then: the Lot's `src/interior/finishes.ts`, Outbreak's vertex tone stamp. |
| Textured props | `gpu/textured-mesh`, `props/textured`; Outbreak Props › PBR textures | Candidate, `kit-textured-props` | Three furniture GLBs and BARBARA cooler; Kit's visual pick pending. [Cost and limits](../perf/textured-props.md). |
| Glass and interiors | `thinGlassHooks`, `interiorWindowHooks` (`gpu/materials/glass.ts`) | Shipped | |
| Wet ground and reflections | `gpu/reflections/wet.ts`; SSR (`gpu/reflections/ssr.ts`) where wet or glossy floors face the camera | Shipped | SSR is Lot-only so far. |
| TAA | `gpu/temporal.ts` with the reactive mask (`gpu/reactive.ts`) | Shipped | Lot and Night Shift use it; Outbreak keeps MSAA by default. |
| Camera feel | `client/walk.ts`, `client/walk-camera.ts`; camera filters off | Shipped | 0.5–1.5 cm translation, 0.1–0.35° roll tied to contacts, no idle sine. |
| Realistic people | `@arcade/kit/people` ([people.md](people.md)) | Shipped | BARBARA's default; other games still draw blocky people. |
| Quality tiers that carry the look | `packages/kit/quality.ts`, per-game tier values; optional explicit `ultra` profile | Shipped | A look too heavy for the mini goes into tiers, not cut. Auto stays capped at High. |
| Rendered-frame quality gates | `packages/kit/proof/legibility.ts`, `scripts/quality-gate.ts` ([guide](quality-gates.md)) | Shipped | BARBARA Looks and Lab spider adapters; slab heuristics warn unless the spec opts into failure. |

## Order of work

1. **Target**: reference or paint-over (`arcade-lookdev`).
2. **Greybox with the camera fixed**: framing and feel on primitives ([prototyping.md](prototyping.md)).
3. **Models**: a method per asset, then the finish pass (`arcade-props`).
4. **Surfaces**: scans or filtered recipes, albedos in range.
5. **Practical lights** from visible sources, then shadows for the key lights.
6. **Atmosphere** only where light lands.
7. **Indirect light**: bounce or baked lightmaps.
8. **Camera**: exposure, highlight shoulder, grade from received light, TAA.
9. **Stability**: the game's motion script.
10. **Gates, then Kit**: the checks below, then Today and the candidate side by side.

## Gates

The checklist's [pre-flight](quality-checklist.md#5-pre-flight-gates): subject legible at game exposure, no crushed
or clipped frame, nothing at the lens, stable in motion, an aligned capture beside the target.
Run `hivemind run --kind browser -- bun scripts/quality-gate.ts barbara --states scripts/quality/states/barbara.json`
before review; [quality-gates.md](quality-gates.md) documents the spider command and scoreboard. Inspect slab
warnings; only calibrated specs should make them fatal. GPU timing is reported, not gated.

## What Kit has decided

Approved:

- Outbreak defaults: bounce at ×3 (D-47), soft capsule shadows (D-48), lens street lamps (D-49), pooled low mist
  (D-50), rooms behind glass (D-51), contact shadows (D-52), Darkwood Diablo Blend trees (D-42).
- BARBARA defaults: physical night sky, highlight shoulder, bloom contained at the source, camp detail rounds 8–11,
  realistic friends.
- Flash adaptation after lightning; camera filters as options, off by default.

Turned down:

- Faint lamp rain: rain in a lamp must read.
- Volumetric storm clouds (D-59): Today's storm stays; the experiment is parked.
- Cutting a look for cost (D-53, withdrawn): hardware scales the look through tiers.
- Outbreak's first look study: too flat and washed out.
- White overlays and exposure pumping on lightning; loud footsteps.

Pending: open water, clear air near you, the BARBARA road flare and storm looks, brighter rain
([realism-log.md](research/realism-log.md#candidates-awaiting-kit)).
