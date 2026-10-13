# Sea of Thieves water, translated for `carrier`

This is a study of how Rare renders and networks the Sea of Thieves (SoT) ocean, and what we should copy into raw
WebGPU/WGSL. It complements `ocean-research.md`, which covers the mesh/LOD lattice, a full shading recipe, WebGPU
pitfalls and the decision against FFT. This document keeps to what Rare built, what they said about it, and where that
agrees with or changes the plan in `ocean-research.md`.

Every claim is tagged:

- **[doc]**: Rare said it, in the SIGGRAPH 2018 paper, the talk video, or another Rare talk.
- **[3p]**: a reliable third party said it (Digital Foundry, the Microsoft/Azure case study).
- **[inf]**: my inference. Treat it as a hypothesis.

---

## 0. TL;DR

- **SoT's sea is a plain Tessendorf FFT** [doc]. The look comes from four art-directed layers on top of it:
  1. a deep ↔ subsurface colour blend keyed by a wave-peak mask and the sun/view angle, with subsurface scatter (SSS)
     **boosted beyond realistic**;
  2. Jacobian crest foam pushed through a **progressively blurred feedback buffer**, then **re-textured with
     artist-authored foam** (high-frequency at fresh crests, low-frequency as it disperses);
  3. a **big area-light sun** specular (Karis's representative point) so a low sun throws a wide glitter path;
  4. planar reflections.
- **What Rare learned.** They tried stylising the wave *shape* and specular (simpler waves, less high-frequency
  detail), and "the water looked less good". So they kept the shape realistic and stylised the **foam and colour**
  instead [doc]. That is the most transferable lesson. Our faceting already stylises the shape, so put the remaining
  effort into colour, SSS, sun and foam.
- **Networking is time-only.** The FFT is "seeded on the global time, so we do not have to sync the water positions
  together, we just need to sync the time" via a replicated server time service [doc]. Every server shares the seed
  [3p]. Our `(seed, synced sea time)` design is the same idea, and it is better specified than theirs (float64 phase
  folding, origin snapping, analytic CPU mirror).
- **Biggest wins for us, in order:**
  1. SoT colour model and boosted crest SSS;
  2. area-sun specular for the glitter path;
  3. foam with age-driven texture (fresh = fine and crunchy, old = coarse patches);
  4. seabed-driven shallows and shore foam;
  5. camera-window wake/intersection foam once ships exist;
  6. a richer swell spectrum (wave groups, a detail band).

  A GPU FFT cascade is possible and fully deterministic (design in §2.4). It is not the next step.

---

## 1. What Rare actually said (primary facts)

Sources:

- **Paper:** SIGGRAPH 2018 Talks, *The Technical Art of Sea of Thieves*, Ang, Catling, Cifariello Ciardi and Kozin.
- **Talk video:** the same talk by Valentine Kozin. I pulled the transcript; times are given as mm:ss.
- **Visual Logger:** Unreal Fest Europe 2019, *The Visual Logger*, Andy Bastable (Rare principal gameplay engineer).

| topic | fact | source |
| --- | --- | --- |
| Simulation | "FFT water simulation based on Tessendorf's *Simulating Ocean Water* (2001). It's a fairly straightforward implementation." Built by Mark Lucas (lead rendering engineer) and team. Tech art built the surface shader on top of the sim data. | talk 4:50 [doc] |
| Not PBR | "It's not physically based. We haven't been able to find any particularly good models for doing water surface shading." | talk 5:10 [doc] |
| Stylisation | The FFT water "is very noisy, lots of high frequency detail, doesn't sit that well with our art style". Even in stylised CGI films the water tends to be realistic, so they "erred more on that side". "We mostly stylise the foam and we also boosted the strength of the subsurface scattering beyond what would be considered realistic." | talk 5:20 [doc] |
| Tried and rejected | "We did try to simplify the shape of the water, simplify the specular highlights, take away some of that high frequency detail, but … if we did that the water looked less good." | talk 6:00 [doc] |
| Art pillars | "Illustrative": "very averse to high frequency detail". "A world in motion": nothing static. | talk 3:00 [doc] |
| Colour | "We blend between a deep water colour and a sub-surface water colour based on a combination of view angle, sun direction and a wave peak mask." | paper §1.1 [doc] |
| SSS mask | "We use the choppiness vertex offsets from the FFT sim to generate a mask for where the sides of the waves are, and then we just use a dot product of the light and view vector for the SSS contribution." Paper: "where the choppiness offset is greater … wave peaks, which show more sub-surface due to shorter distance travelled by light." | talk 6:20, paper [doc] |
| Crest foam | Jacobian determinant of the choppy transform. Foam is generated where it goes negative, biased so more foam appears. Pixels are injected into a render target that tiles across the water surface. | talk 6:40 [doc] |
| Foam style | "Definitely far too noisy for our art style", so "we progressively blur the render target … where you have the peaks you still get sharp crests, then that foam gradually dissipates over the progressive blur frame by frame". Blended with artist foam textures: "a high-frequency foam texture at the crest of the wave, then we blend to a lower-frequency texture as it blends out". | talk 7:15 [doc] |
| Crest particles | "We also use the same wave crest where we generate foam to generate some particles off the top of the waves." | talk 8:12 [doc] |
| Sea states | Stormy water: "increase the amplitude of the waves and bias the Jacobian even further". Calm water: foam only around intersecting objects. Foam generation, dispersion and texture blend all vary with calm/normal/stormy. | talk 8:20, paper [doc] |
| Specular | "Area specular highlight to allow for a large low sun reflection using the closest point on sphere approximation [Karis 2013]." | paper [doc] |
| Reflections | "We don't use screen space reflections, we just use planar water reflections for the ocean." Digital Foundry: reflected trees and objects appear at lower detail. | talk 3:40 [doc], DF [3p] |
| Underwater | A Snell's window effect when looking up from below. | paper [doc] |
| Cost | "By far the most expensive bit of rendering in the game." On Xbox One at 900p: the FFT updates, resolves and normals are roughly constant; the surface draw is pixel-bound, about **8 ms of a 20 ms frame** when only water is on screen. | talk 8:30 [doc] |
| Bottleneck | Xbox One CPU and memory, not GPU. Many choices push work onto the GPU. | talk 4:10 [doc] |
| Deck water | Shallow-water sim on a 512 × 1024 deck heightfield (Mei et al. 2007 pipe model). Outflow is biased by the ship's tilt so water sloshes when it rocks. Wetness is kept in the green channel, both channels drain over time, and bow sensors trigger splashes. About 0.2 ms per ship, one ship at a time. | talk 9:10 [doc] |
| Intersection foam | A mesh is rendered into its own UV-space target, comparing each pixel's camera distance with the scene depth to mark intersections. The result is additively blended with the previous frame, blurred and scrolled. On the ocean this is "a travelling window render target around the player", giving foam trails behind objects and **foam around static geometry like islands**. Under 0.1 ms. | talk 12:00–14:30 [doc] |
| Clouds (sync) | Cloud meshes wrap around the player and are offset by wind. "We synchronise this offset vector across all clients." | paper §2 [doc] |
| Net sync | A replicated "time service": "Our water uses a fast Fourier transform … effectively seeded on the global time, so we do not have to sync the water positions together, we just need to sync the time, and then all the algorithms will stay in sync … authoritative time for both the server and the client." Their debug timeline used the time mod 10,000. | Visual Logger [doc] |
| Server queries | Server-side gameplay queries water height, for example chickens refusing underwater points. "Calm water zones" have flat water. | Visual Logger [doc] |
| Cross-server | "All servers are instantiated using the same seed … time of day, location and size of waves … If a boat is at the top of a wave on Server 1, when moved to … Server 2, that wave will be in the same place." Used for seamless server merging. | Microsoft/Azure case study [3p] |
| Ship feel | A Rare panel at EGX (second-hand recollection, not verified): driving ship physics directly from the water was too choppy and caused motion sickness, so ship motion follows a smoother "invisible layer". | LinkedIn comment [3p, weak] |

**Not public:** the FFT resolution, tile sizes and cascade count, the ocean mesh scheme, how the server evaluates the
FFT, and the exact colour equations. Everything below that depends on these is marked [inf].

---

## 2. Wave model

### 2.1 What SoT does

- **[doc]** Tessendorf FFT: height plus choppy horizontal displacement, with normals and the Jacobian from the same
  spectrum.
- **[inf]** The foam render target "tiles across the water surface", so the FFT is one or more periodic tiles. Storms
  are a separate world-space system: an amplitude multiplier and a Jacobian bias inside storm areas. The tile sizes are
  undisclosed. The typical Tessendorf-era setup is 1–3 cascades of 128²–256² over 50–1000 m.
- **[doc]** Ships and gameplay must get water height on the server, so some CPU-evaluable version of the sea exists.
  **[inf]** Most likely a CPU evaluation of the same spectrum at query points, or of its low-frequency part. Rare never
  mention GPU readback, and their CPU-bound Xbox One budget argues for a cheap, band-limited CPU path.

### 2.2 What that means for our Gerstner sum

- **Ours is "SoT minus the short waves".** The swell (90–300 m), secondary swell and chop (8–40 m) are where all the
  readable shape lives. An FFT would mainly add many waves under 8 m.
- **Facets swallow sub-facet detail.** Level-0 facets are 0.5 m in `ocean-research.md`, but at gameplay camera heights
  (tens to hundreds of metres) the visible facets are 2–20 m. Most of what an FFT adds would disappear into them.
- **So I agree with `ocean-research.md` §3:** no FFT now. Spend the effort on the bands the facets can show.

One SoT-motivated caveat: the main argument for FFT in SoT-style water is **anti-regularity**. With only 10–16
components, the eye can lock onto the pattern. Fix that inside the Gerstner sum first:

1. **Wave groups ("sets").** Real swell arrives in groups of large waves separated by lulls. Two to three primary
   components with close wavenumbers, about ±8% in λ and ±5° in direction, beat into groups with
   `L_group = 2π / |k1 − k2|`. For λ = 200 m and 216 m that is about 2.7 km, so a group passes a ship every 2–3
   minutes.
   - This is the cheapest source of SoT-style **awe**: every few minutes a set of noticeably bigger swells rolls
     through.
   - `makeSea` already log-stratifies the primary wavelengths. Consider deliberately pairing one or two of them
     (sea owner's call; it changes `shared/sea.ts`).
2. **Directional spread on chop.** It is already ±60° around the wind. Keep chop amplitudes uneven: one or two
   dominant chop components read as wind direction, which SoT's spectrum also shows.
3. **Detail band (cosmetic).** 8 Gerstner waves at 2–8 m, exactly as `ocean-research.md` §3 proposes. This is the
   cheap stand-in for SoT's high-frequency FFT content near the camera.

### 2.3 Physics: copy SoT's split between the visual and physical surface

- **Physical layer.** Our CPU `seaHeight`/`seaNormal` already evaluate the full Gerstner set exactly (Newton in rest
  space). That is the layer for buoyancy and gameplay, on server and client alike. Never let cosmetic bands (the
  detail waves, an FFT) enter it.
- **A 330 m hull averages waves anyway.** Sample buoyancy at hull points spread over 330 m × 40 m, and chop under
  about 40 m averages out. That is the "invisible smoother layer" Rare reportedly built, for free [inf].
- **Visual layer.** Rendered surface = physical layer + cosmetic bands, at the same `(seed, t)`. The mismatch between
  hull and drawn water is at most the cosmetic band's amplitude: about 5 cm for the 2–8 m detail band, or about 0.3 m
  if an FFT is ever added. Both are invisible at a carrier's waterline, especially with wake foam on top.

### 2.4 If we ever add an FFT cascade: a deterministic WebGPU design

Treat this as the "if the sea looks patterned in playtests" plan. It answers the brief's question directly.

- **Spectrum, CPU, once per room.**
  - JONSWAP with directional spreading around `sea.wind`, seeded with `mulberry32(seed ^ 0xff7)` and Box-Muller.
  - **Band-pass it** to λ ∈ [~2.5, 8] m so it does not double-count the Gerstner chop, which starts at 8 m.
  - Upload `h0(k)` and `conj(h0(−k))` as an `rgba32float` N × N texture.
- **Tile size: divide the origin grid.** Choose `L = SEA_ORIGIN_GRID / n` with integer `n`. Then every snapped origin
  is a whole number of tile periods, and the tile UV is just `p / L` with the small `p`.
  - Example: `n = 11`, giving L = 93.09 m, N = 64, so λ_min = 2L/N = 2.9 m.
  - A second cascade at `n = 43` (L = 23.8 m) is incommensurate with the first. Because 11 and 43 are coprime, the
    combined period is the full 1024 m, and the non-periodic Gerstner swell on top hides even that.
- **Exact, GPU-independent phase via integer time.**
  - Quantise each mode's dispersion to a period `T = 2^20 ticks` (tick = 1/256 s, so T = 4096 s):
    `n_k = round(ω_k · T / 2π)` and `ω_k' = 2π n_k / T`. The change is under 1.5e-3 rad/s, which is invisible.
  - Each frame the CPU sends `tick = floor(seaTime · 256)` as a u32 and `frac = fract(seaTime · 256)` as an f32.
  - In WGSL, `idx = (n_k * tick) & 0xFFFFF`. This is exact: u32 multiplication wraps mod 2^32, and 2^20 divides 2^32,
    so overflow is harmless.
  - Then `phase = 2π · (f32(idx) + f32(n_k) · frac) / 2^20` (in cycles, `n_k · t / T`). The integer part is
    bit-identical on every GPU and on the CPU. The f32 sum keeps about 6e-8 cycles of precision. Only the final
    `sin`/`cos` differs, within WGSL's 2^-11 absolute bound in [-π, π] (reduce the phase to that range first, as
    `seaPhase` does).
  - This is the FFT analogue of what `packSea` already does in float64. It never needs a "time wrap" pop.
- **Per frame, GPU.**
  - One compute pass builds `h(k,t)`, the choppy `Dx`, `Dz` and the slopes. Pack them as 4 complex fields in 2
    `rgba32float` textures.
  - One Stockham radix-2 IFFT per axis with N = 64 or 128 in workgroup memory: one workgroup per row, 7 stages, two
    dispatches.
  - Write `rgba16float` displacement and slope textures. The vertex shader reads them with
    `textureSampleLevel(…, 0)` at `p / L`.
- **Cost.** About 0.05–0.2 ms on desktop GPUs for one 128² cascade, plus one texture fetch per vertex. That is tiny next
  to SoT's 8 ms.
- **CPU mirror (only if gameplay ever needs it).**
  - The same integer phase lets the CPU run a 64² f64 IFFT in TypeScript (about 0.2–0.5 ms), or evaluate the 100
    strongest modes directly at a few points.
  - Lee Shore (UE5) goes further: it ports the GPU hash byte-for-byte and runs an automation test that fails the build
    if CPU and GPU diverge. That is worth copying if we go this way; we already have `tests/sea.test.ts` as the model.
- **Foam.** Add the cascade's Jacobian term to `1 − det J` in the vertex shader. It frays crest foam near the camera
  like SoT's high-frequency foam.

---

## 3. Mesh, LOD, distance, horizon

- **[doc]** Nothing public about SoT's ocean mesh topology.
  - **[inf]** UE4.10-era console water without hardware tessellation is usually a camera-following grid with distance
    LOD, sampling FFT textures in the vertex shader.
  - The paper's "camera centred window" foam buffer and "travelling window render target around the player" confirm
    that their interaction data is camera-relative.
- **[doc]** Distance handling: the pixel-bound surface draw dominates cost. Third-party SoT-style recreations fade
  normals and displacement with distance and fog into the horizon.
- **For us:** follow `ocean-research.md` §1 (world-anchored snapped levels, CDLOD morphing, per-wave band-limiting with
  lost slope moved into roughness, a seaHaze horizon). It is stricter than anything SoT needed, because faceting makes
  swimming vertices obvious.
- **One SoT-specific addition: tie FFT and foam windows to the snapped origin.** Any camera-window buffers (§4.4 wakes,
  §5) must:
  - snap to their own texel grid in **world** space, to avoid shimmer;
  - use toroidal addressing (`uv = fract(worldXZ / windowSize)`), so moving the window only clears the newly exposed
    strip instead of resampling;
  - be built from the f64-snapped origin, like `packSea`.

---

## 4. Shading: SoT's model in WGSL

These are drop-in pieces for the shading recipe in `ocean-research.md` §2. Variables follow that file:

| name | meaning |
| --- | --- |
| `n` | facet normal |
| `V` | direction to the eye |
| `L` | `F.sunDir.xyz` |
| `sun` | `F.sunColor.rgb * F.sunDir.w` |
| `v.y` | height |
| `v.p` | rest position |

### 4.1 Colour: deep ↔ subsurface blend (SoT-literal)

Rare's description has three inputs: view angle, sun direction and the wave-peak mask from the choppy offsets. In the
talk, the mask marks "the sides of the waves". For a Gerstner sum the analogue of the choppy offset is the horizontal
displacement `D.xz`, which peaks on the wave *flanks*. Height marks the *upper* part. Their product picks the thin upper
flanks just below each crest, which is where light really leaks through.

```wgsl
// Vertex shader (per vertex; cheap, it reuses the seaDisplace result):
let D = seaDisplace(p);                                        // (dx, y, dz)
let chop = length(D.xz) / CHOP_RMS;                            // CHOP_RMS = sqrt(Σ (Q A)^2 / 2), from the uniform
let crest = saturate(D.y / HS + 0.25);                         // HS = significant height; slightly below mean counts too
out.peak = saturate(chop * crest);                             // SoT "wave peak mask": upper flanks
// Alternative with more crest and less flank: saturate((1.0 - detJ) * k) * crest, re-using the foam Jacobian.

// Fragment shader:
let viewGraze = 1.0 - saturate(V.y);                           // low angles look *through* crests
let backlit   = pow(saturate(dot(-V, L)), 4.0);                // SoT: "dot product of the light and view vector"
let sssAmt    = v.peak * (SSS_BASE + SSS_BACK * backlit) * (0.4 + 0.6 * viewGraze);
let body      = mix(DEEP, SUBSURFACE, saturate(sssAmt)) * (sun * 0.35 + amb * F.zenith.rgb)
              + SUBSURFACE * sun * SSS_GLOW * v.peak * backlit; // the "boosted beyond realistic" emissive-ish glow
```

- **`SSS_BASE` ≈ 0.25–0.4.** This is SoT's "boost". Crests stay teal even with the sun behind the camera, and in the
  concepts the camera usually faces away from the sun. A purely physical backlit term would leave
  `shot-5-fleet.png`'s crests dark.
- **`SSS_GLOW` ≈ 1–3 (HDR).** It lets bloom catch the brightest backlit crest facets, which is the famous glowing-green
  look. Keep `SUBSURFACE` greener than the shallow-water turquoise, about linear `(0.02, 0.42, 0.33)`, so crests and
  lagoons stay distinguishable.
- **Faceted bonus.** `v.peak` varies per vertex, so flat facets on the upper flank get a gradient across them, while
  `dot(-V, L)` and the facet normal stay constant per facet. To make the glow read as faceted, multiply by a facet term
  such as `pow(0.5 - 0.5 * dot(L, n), 3.0)`, the Atlas k1 shape: facets tilted away from the sun glow and facets facing
  it do not. `ocean-research.md` already uses k1. The SoT-literal mask above is the extra term that boosts colour at
  any sun angle.

### 4.2 Fresnel and reflections

- **[doc]** SoT uses planar reflections and no SSR.
- **For us:** sky-only reflection is enough for open sea. Facet normals shatter object reflections, and the concepts
  show none except a hint in calm lagoons.
  - Use Schlick Fresnel with a stylised cap so grazing water stays blue, as in `ocean-research.md` step 6.
  - A trick worth adding from SoT-style recreations: compute Fresnel from a **flattened normal**,
    `normalize(vec3f(n.x * 0.5, n.y, n.z * 0.5))`. The facets then still shade body colour strongly, but reflection
    does not flicker facet-to-facet at grazing angles, which reads more painterly.
- **Planar reflection pass (later, optional).** Mirror the camera about y = 0, render static islands and ships at
  ½–¼ resolution into an `rgba16float` target, and sample it with `screenUV + n.xz * k`.
  - Cost: a second opaque pass on the reduced draw list.
  - Only worth it for lagoon hero shots. Put it behind a quality flag.

### 4.3 Sun: SoT's "large low sun" area specular (Karis representative point)

- **Why it matters more for us than for SoT.** A flat facet reflects a point sun only if its normal lands within the
  sun's 0.27° radius, so almost no facets ever glint. SoT used an area-light approximation to enlarge the
  reflection [doc].
- **For facets, a stylised sun radius of 1.5–4° is the knob.** It sets how many facets light up into the star-studded
  path of `shot-5-fleet.png`.
- It needs no textures and costs about 15 ALU.

```wgsl
// Representative point on the sun disc (Karis 2013, eq. 11) for a directional sun of angular radius `sunR`
// (radians). L is unit, so "distance" is 1 and sourceRadius ≈ tan(sunR).
fn sunAreaDir(L: vec3f, R: vec3f, sunR: f32) -> vec3f {
  let centerToRay = dot(L, R) * R - L;                 // corrected sign (see the cs418 note in §8)
  let closest = L + centerToRay * saturate(tan(sunR) / max(length(centerToRay), 1e-5));
  return normalize(closest);
}

let R   = reflect(-V, n);
let Ls  = sunAreaDir(L, R, SUN_R);                     // use Ls for specular only; diffuse keeps L
let Hs  = normalize(Ls + V);
let a   = ROUGH * ROUGH + v.sigma2;                    // GGX alpha^2, widened by the filtered slope (ocean-research)
let ap  = saturate(sqrt(a) + tan(SUN_R) / 3.0);        // Karis eq. 10: alpha' = alpha + radius / (3 · dist)
let norm = (a / (ap * ap));                            // eq. 14 energy normalisation (alpha / alpha')^2, in alpha^2 form
let NoH = saturate(dot(n, Hs));
let d   = NoH * NoH * (a - 1.0) + 1.0;
let D   = a / (3.14159 * d * d);
col += sun * min(D * norm * Fr * saturate(dot(n, Ls)) / (4.0 * NoV), 60.0);
```

- **Low sun (golden hour).** Raise `SUN_R` with sun elevation:
  `SUN_R = mix(0.06, 0.025, saturate(L.y * 2.0))`, which is 3.4° at the horizon and 1.4° high up.
- **Bloom.** The HDR peak should exceed the bloom threshold by 10–50× so facets become "stars". Keep the clamp so
  NaN/inf never reaches bloom.
- **Sun path.** Facets far from the sun line contribute nothing; the stretched path comes from facet normal variance.
  The `sigma2` widening and the per-facet tilt jitter in `ocean-research.md` supply it.

### 4.4 Foam: SoT pipeline → deterministic equivalent

SoT's foam pipeline:

```
Jacobian (biased) → inject into tiling RT → progressive blur with feedback (sharp crest, soft dispersing trail)
                  → blend: fresh = high-frequency artist texture, old = low-frequency texture → mix over water colour
```

We cannot tile (the Gerstner sum is not periodic), and per-client feedback buffers diverge between clients who joined
at different times. `ocean-research.md` §2 already has the right replacement for the buffer: **Lagrangian foam
memory**, which re-evaluates the Jacobian at the same rest point at `t − Δ`. In rest space that point is the same
water parcel, so the foam rides the water exactly like SoT's buffer does, deterministically.

To match SoT's look more closely, add two things:

1. **Foam age → texture frequency (SoT's high/low-frequency blend).** Track which memory tap won and output an age:

   ```wgsl
   // vertex: taps at Δ = 0, 1.2, 2.6, 4.5 s with weights 1, .75, .5, .25 (as ocean-research)
   var foam = f0; var age = 0.0;
   if (0.75 * f1 > foam) { foam = 0.75 * f1; age = 1.2; }       // vertex stage: no derivatives, so branches are fine
   if (0.50 * f2 > foam) { foam = 0.50 * f2; age = 2.6; }
   if (0.25 * f3 > foam) { foam = 0.25 * f3; age = 4.5; }
   out.foam = foam; out.foamAge = age / 4.5;                    // 0 fresh .. 1 old

   // fragment: fresh foam uses fine, crunchy cells; old foam uses big soft patches with holes ("dispersing")
   let fine   = foamNoise(q / 1.2, t);                          // ~1.2 m cells
   let coarse = foamNoise(q / 6.0, t);                          // ~6 m cells
   let pat    = mix(fine, coarse, smoothstep(0.2, 0.8, v.foamAge));
   let cover  = v.foam * mix(1.0, 0.6, v.foamAge);              // older = thinner
   ```

   Sample the noise in **rest space** (`q = p + anchor`), so the pattern rides the water parcel and never swims.
2. **The blur's "spread", without a blur.** SoT's blur widens old foam. Lower the smoothstep threshold for older taps
   (`lo_i = lo · (1 − 0.15 i)`), so older foam covers a wider band around where the crest was. One subtraction per
   tap.

Two more SoT details apply directly:

- **Sea state bias.** SoT stormy = more amplitude plus a stronger Jacobian bias; calm = no crest foam at all. Our
  `makeSea` already has an `energy` roll. Expose `foamBias = mix(−0.4σ, +0.3σ, energy)`, added to `sea.foam[0..1]`, so
  calm seeds keep foam only on the biggest set waves and lively seeds get regular whitecaps (sea owner's call).
- **Crest spray particles (later).** Spawn GPU particles where `foam` is fresh (`age == 0`) and `D.y > 0.6 HS`, with
  the wave's horizontal velocity `≈ Σ ω Q A d sin θ` plus wind. This is deterministic per (seed, t) if spawn
  positions come from a hashed rest-space lattice, but nobody would notice if it were not.

---

## 5. Shoreline, shallows, wakes, interaction

| SoT technique | for us |
| --- | --- |
| **Intersection foam via depth compare in a camera-centred window, blurred with feedback** [doc]. It produces both object trails and foam around islands. | **Islands:** we have something better. `bakeSeabed` already gives depth and distance-to-shore deterministically, so shore foam, surf lines and turquoise shallows are analytic (`ocean-research.md` §2 `surfFoam`, Beer-Lambert body). No depth compare is needed for static geometry. |
| Same window, for moving objects | **Ships, once they exist:** a 512² r16f toroidal window of about 1 km around the camera (about 2 m per texel). Each step at a fixed 60 Hz (scale by dt): (1) decay ×0.997; (2) blur 1 tap (SoT's progressive blur); (3) stamp each ship hull's waterline footprint plus a V-shaped Kelvin wedge (19.47°) behind the stern, intensity scaled by speed. Sample it in the ocean fragment shader with world UVs. About 0.1 ms, matching SoT's <0.1 ms. |
| Feedback state differs per client | The SoT trade-off is that a late joiner sees wakes start from when they joined. It converges after the decay time: ×0.997 per 60 Hz step is a 5.6 s e-fold, so a wake visibly trails about 15 s (roughly 120 m behind a carrier at 16 kn; lower the decay for longer wakes). `ocean-research.md` prefers analytic Kelvin segments from the synced track history: more deterministic, more ALU, and harder to make look painterly. **Recommendation:** use the SoT buffer for wakes. Wakes are pure cosmetics, and ship tracks are networked anyway, so every client stamps the same hulls; only history before joining differs. |
| Bow waves from sensors on the bow [doc] | Trigger a splash burst and a stamp spike in the wake buffer when the hull's bow point vertical velocity relative to the local water (CPU `seaHeight` at the bow, finite-differenced) exceeds a threshold. That is the "crash into a wave" moment. |
| Deck water shallow-water sim [doc] | Not needed: a carrier deck is 20 m above the sea. Keep the pipe-model idea for spray puddles only if we ever do small boats. |
| Snell's window [doc] | Not needed (no underwater camera). |

**Shallows colour (SoT does not cover this; the concepts need it).**

- Absorption over depth from the seabed bake: red dies by about 4 m, leaving turquoise, then cobalt. This is already
  in `ocean-research.md` §2.
- The SoT lesson to apply: do not let the subsurface crest colour and the shallow colour be the same hue. SoT's crest
  green-teal reads because the lagoons and deep water are distinctly bluer.

---

## 6. Networking

### 6.1 What SoT does

- **[doc] Replicated server time.** A "time service" replicates server time to every client. The FFT is a pure
  function of time, so "we do not have to sync the water positions, we just need to sync the time".
- **[3p] One seed for all servers.** Every server is instantiated with the same seed, so waves match even across
  server migration.
- **[doc] Weather and wind.** Storms are world objects that modulate wave amplitude and foam locally. Clouds use a
  single synced wind-offset vector. **[inf]** Storm position and intensity are replicated state, and the wave field
  inside a storm is still a pure function of (time, storm parameters).
- **[doc] Server gameplay queries water height** (chickens, ships). "Calm water zones" are flat by design.
- **[weak] Ship motion** follows a smoothed layer rather than the raw surface, for comfort.

### 6.2 Our design versus SoT

Ours is the same architecture: room `{seed, epoch}`, then `seaTime = (serverNow − epoch) / 1000`, with NTP-style
`ClockSync`, slew (±5%) and snap (1 s). It is better specified in three ways:

1. **Phase folding in float64.** `packSea` folds `k (d · origin) − ω t + φ` in f64 and wraps it to [0, 2π) before f32,
   so neither large time nor large coordinates ever reach the GPU. SoT's "mod 10,000" timeline hints they hit the same
   problem.
2. **Exact analytic CPU mirror.** The CPU evaluates the same sum (Newton in rest space), so server, physics and GPU
   agree to 0.2 mm within 8 km (`tests/sea.test.ts`).
3. **No GPU readback anywhere.**

**Confirmed: keep the approach.** Sync seed and clock only; never sync wave state.

### 6.3 Pitfalls, with numbers

| pitfall | magnitude | mitigation |
| --- | --- | --- |
| **Clock offset error between clients** (RTT asymmetry; `ClockSync` bounds it to RTT/2) | 30 ms error, 200 m swell (A 1.5 m, ω 0.55 rad/s, c 17.7 m/s): crest shifted 0.5 m, height error ≤ 2.5 cm. 10 m chop: c 4 m/s, so 12 cm. | Invisible. Do not over-engineer. |
| **Remote ships drawn with interpolation delay** while the sea is drawn at "now" | 100 ms delay: heave error up to A·ω·0.1 ≈ 8 cm on swell, plus pitch lag. Worse for small craft. Visible as a hull "bobbing out of phase" with the waves. | **Network plan pose only** (x, z, yaw, speed). Each client computes heave, pitch and roll **locally** from `seaHeight`/`seaNormal` at the render time, through the same hull-averaging filter the server uses. SoT's "invisible layer", made deterministic. |
| **Clock slew changes apparent wave speed** | ±5% for a few seconds while correcting | Fine. Do not raise `slew` above ~5%. Prefer slewing to snapping (a 1 s snap moves crests by up to 18 m). |
| **f32 time on the GPU** | `F.eye.w` wraps at 3600 s; f32 ulp at 3600 s is 0.24 ms | Wave phases never use it (`packSea` is f64). Cosmetic animation must use whole cycles per 3600 s. For an FFT, use the integer tick phase (§2.4). |
| **GPU vendor differences** | WGSL `sin`/`cos` absolute error ≤ 2^-11 in [-π, π]; × A = 2 m gives about 1 mm. FMA contraction and transcendental differences: sub-mm. | Already handled: phases are reduced to [-π, π]. No gameplay reads the GPU surface. |
| **f32 far from origin** | `k · d · p` at 100 km for 8 m chop is pure noise | Origin snapping (1024 m) plus per-level wave filtering. Skip waves with filter weight 0 (`ocean-research.md` §4). FFT tile UV must use `p / L` with `L = 1024 / n` (§2.4). |
| **Quality tiers** | A low tier dropping waves on the GPU is fine | Physics must always use the full set. Make tiers drop only render-only bands; Tidewater keys its phase hash on wavenumber so all tiers agree on the long waves. |
| **Per-client accumulated state** (foam buffers, wake buffers) | A late joiner differs until the decay time | Crest foam: analytic memory (§4.4). Wakes: accept SoT's trade-off (§5). |
| **Seed reuse across rooms or servers** | none | SoT relies on the same seed across servers for migration. Our "room forgets the world when empty" is fine, and resume-on-reconnect already covers blips. |
| **Weather later** | — | If we add storms or calm zones, make the amplitude envelope a pure function of `(seed, t, x, z)`, e.g. storm centre `= f(seed, t)`, mirrored in `sea.ts`. Never make it client state. |

---

## 7. Priorities: SoT techniques with the biggest visual jump for us

Costs are for a desktop GPU at 1080p with MSAA x4 and about 150k ocean triangles, on top of the `ocean-research.md`
baseline.

| # | technique (SoT origin) | what it buys | WebGPU cost | fit with faceted style |
| --- | --- | --- | --- | --- |
| 1 | **Deep ↔ subsurface blend with a wave-peak mask, SSS boosted beyond realistic** (§4.1) | The teal-glowing crest facets: the single most "SoT" read | ~20 ALU per pixel, 1 varying. ≈ 0 ms | Excellent. The mask varies per vertex and the backlit term per facet, so crest facets glow as distinct shards. |
| 2 | **Area-light sun specular (Karis representative point), sun radius as an art knob** (§4.3) | The star-studded glitter path; golden-hour drama | ~15 ALU. ≈ 0 ms | Essential. Without it almost no flat facet ever glints. |
| 3 | **Foam with fresh → old texture blend; sea-state Jacobian bias** (§4.4) | Crunchy white crests that dissolve into soft trails; calm versus lively seeds | Built on the memory-foam taps (≈ 0.3–0.6 ms vertex). The age-blend adds 1 noise octave per pixel. | Good. Make the noise blocky or Worley so it reads low-poly. |
| 4 | **Keep the shape rich; stylise colour and foam, not geometry** (§1 lesson; §2.2 wave groups and detail band) | Big readable swells arriving in sets: the "awe" | Wave groups are free (parameter choice). Detail band: +8 waves per vertex ≈ +0.2 ms. | Good. The detail band only lives within ~100 m. |
| 5 | **Shore and shallows** (SoT's island intersection foam, done analytically from the seabed bake) (§5) | Turquoise lagoons, reef surf lines, foam rings round islands | 1 texture tap + noise ≈ 0.1 ms | Excellent; matches `island-2-jungle-hero.png` directly. |
| 6 | **Camera-window wake/intersection foam buffer with feedback blur** (§5) | Ship wakes and bow foam like `shot-5-fleet.png` | 512² r16f, 1 compute pass ≈ 0.05–0.1 ms | Good. Blocky stamps read stylised. Needed once ships exist. |
| 7 | **Crest spray particles and bow-sensor splashes** (§4.4, §5) | "World in motion" on big sets | GPU particles, a few thousand quads ≈ 0.1–0.3 ms | Low-poly spray chunks fit well. |
| 8 | **Planar reflections** (§4.2) | Islands mirrored in calm lagoons | A second opaque pass at ½–¼ resolution ≈ 0.5–1.5 ms | Marginal: facets shatter reflections. Optional, quality-gated. |
| — | **FFT cascade** (§2.4) | Anti-regularity, true broadband chop | ≈ 0.1–0.2 ms per cascade | Only if the sea reads as patterned in playtests. Deterministic design ready. |

**Suggested order:** 1 → 2 → 5 → 3 → 4, then 6 and 7 when ships land, then 8 or FFT only if needed. This matches the
`ocean-research.md` tuning order (colour, reflection, sun, SSS, foam, fog) with SoT's two signature terms, boosted SSS
and the area sun, given priority.

---

## 8. Sources

**Rare, primary:**

- **SIGGRAPH 2018 paper** (2 pages): https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf
  (ACM: https://dl.acm.org/doi/10.1145/3214745.3214820). The exact one-paragraph descriptions of the colour model, SSS
  mask, foam, area sun, Snell's window and deck sim.
- **SIGGRAPH 2018 talk video** (Kozin; reupload): https://www.youtube.com/watch?v=y9BOz2dFZzs. Watch 4:50–8:40 for the
  ocean (SSS mask, foam blur, cost breakdown, "simplifying looked worse"), 9:10–14:30 for the deck sim and intersection
  foam, and 3:00 for the art pillars.
- **Unreal Fest Europe 2019, *The Visual Logger*** (Bastable, Rare): https://www.youtube.com/watch?v=hWpbco3F4L4. About
  24:00 covers the replicated time service ("we just need to sync the time"); about 12:30 shows server water-height
  queries and calm-water zones.
- **GDC 2019, *Sea of Thieves: Tech Art and Shader Development*** (Kozin): https://www.youtube.com/watch?v=KxnFr5ugAHs.
  The Houdini-to-shader baking mindset and the "painterly, low high-frequency" art direction. Little water content.
- **Microsoft/Azure case study (via DocsLib):** https://docslib.org/doc/1040699/rare-has-been-developing-video-games-for-more-than-three-decades.
  Shows that every server uses the same seed, so waves match across server migration.

**Techniques Rare cites:**

- **Tessendorf, *Simulating Ocean Water*:** https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf.
  Spectrum, choppy displacement, Jacobian foam, and the looping (quantised) dispersion trick used in §2.4.
- **Karis, *Real Shading in UE4* notes:** https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf.
  Representative point (eq. 11), α′ widening (eq. 10) and energy normalisation (eq. 14). See also the sign fix at
  https://cs418.cs.illinois.edu/website/text/ue4-pbr.html.
- **Mei et al. 2007, *Fast hydraulic erosion on GPU*.** The pipe-model shallow-water scheme behind SoT's deck water;
  useful if we ever do deck spray or puddles.

**Closely related talks and recreations:**

- **Atlas, GDC 2019** (Mihelich and Tcheblokov): https://gpuopen.com/gdc-presentations/2019/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf
  (video https://www.youtube.com/watch?v=Dqld965-Vv0). The k1–k4 scatter formula, variance-based distant shading,
  and foam "turbulent energy" injection with decay. Same UE4 era, and also MMO-synced.
- **Acerola, GarrettGunnell/Water:** https://github.com/GarrettGunnell/Water. Compact, readable HLSL of the Atlas
  scatter, Beckmann specular and FFT cascades; `FFTWater.shader` is the file to read.
- **open-ocean (three.js, "SoT-style"):** https://github.com/0-robert/open-ocean. A browser FFT with JONSWAP cascades
  at non-harmonic patch sizes, persistent advected foam, a world-space wake trail and windowed readback for buoyancy.
  The closest web reference.
- **Tidewater deterministic multiplayer demo:** https://gettidewater.com/demo/multiplayer.html. Two FFT oceans share
  only seed plus tick, with slewed clocks; the phase hash is keyed on wavenumber so quality tiers agree. Validates §6.
- **Lee Shore Ocean (UE5):** https://randompixelmedia.com/piece/lee-shore-ocean. Its CPU sampler reproduces the GPU
  hash bit-exactly, with a build-failing CPU/GPU agreement test and a buoyancy LOD ladder. The pattern to copy if an
  FFT ever enters gameplay.
- **Crest, network time:** https://crest.readthedocs.io/en/stable/user/time-providers.html. The standard "sync a time
  offset; dynamic waves cannot be synced" caveat.
- **Skittss/FFTOcean (three.js, SoT-inspired):** https://github.com/Skittss/FFTOcean. A small stylised FFT demo, useful
  for colour and foam tuning ideas.
- **Digital Foundry SoT tech analysis:** https://www.digitalfoundry.net/articles/digitalfoundry-2018-sea-of-thieves-tech-analysis.
  Third-party confirmation of synced waves, geometric (planar) reflections and crest light at sunset.
