# Blackout floor-lighting streaks

The fan-shaped streaks come from the existing polar shadow filter. Its five widely spaced, nearest-ray samples
produce five repeated silhouettes around chair and desk shadows. The grade makes them easier to see.

At seed 4, the all-Look-off office image is RGB-identical to main (`e462588`). The streaks survive every original
Look switch tested alone. Disabling specular leaves the streaks; disabling polar-shadow visibility removes them.
Those controlled captures rule out the floor reflection and tone curve as the source.

## Filter angular visibility

`Smooth Polar Shadows` defaults on in the Lab's Look group. It integrates nine weighted angular taps, interpolating
visibility between neighboring rays at each tap. The angular step follows fixture size divided by receiver distance,
with a half-ray minimum. A world-anchored sub-stratum offset breaks up the remaining coherent sample edges.
Blocker distances are never interpolated across silhouettes. The change adds no fullscreen blur.

All Look off retains the original shader and original pixels. This switch also works downtown and in the vehicle lot.
The paired GPU costs are recorded with the motion-blur measurements in `blackout-motion.md`.

## Evidence

- `captures/blackout-shadow/before/`: all off, all on, and each of the original nine Look switches alone.
- `captures/blackout-shadow/no-shadow/` and `no-spec/`: controlled shader ablations.
- `captures/blackout-shadow/after/`: the corrected filter and the original switches alone.
- `captures/blackout-shadow/filter.jpg`: matched before/after crops, 1200 pixels wide.

Run `bun scripts/look-proof.ts --shadow=after`, `--shadow=no-shadow`, or `--shadow=no-spec`
from `games/blackout` through the fleet runner. `after/office-off.png` reproduces the original all-off image;
compare it with `after/office-lookShadowFilter.png`. The retained `before` images were captured before the shader edit.
The runner uses headless Metal and muted audio. It checks each Lab switch independently.
