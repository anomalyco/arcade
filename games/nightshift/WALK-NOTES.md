# Walking and Scrawl repair

Scrawl source: `scrawl-1792607599821-e82-31`, 2026-10-21. Four requests: footsteps/body/room sound, walking-camera motion, floating storage stacks, and turning striations.

## Camera research and choices

- [Amnesia's published movement code](https://github.com/FrictionalGames/AmnesiaTheDarkDescent/blob/master/amnesia/src/game/LuxMoveState_Normal.cpp#L576-L700) varies bob by actual movement, eases amplitude to rest, plays a footstep at the low point, and uses lateral motion at half the vertical frequency. This is a reference for the mechanics, not copied source or game assets.
- [Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/avoid-or-provide-option-to-disable-any-difference-between-controller-movement-and-camera-movement/) specifically calls out head bob, asynchronous weapon bob and camera tilt as motion-sickness triggers. [Xbox guideline 117](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/117) recommends adjustable camera motion. Small amplitudes cannot guarantee comfort for everyone.
- Source's Camera Bob community tutorial is a modification guide, not evidence that stock Half-Life 2 uses that camera motion. The other suggested games are aesthetic references; their private implementation constants have not been verified.

Night Shift uses a continuous **distance** clock: one contact per 0.72 m, lateral frequency half the contact rate. The head has an 8 mm vertical amplitude, a smooth 1.5 mm contact dip, 4 mm lateral amplitude and less than 0.26° turn/strafe roll. Amplitude scales with speed up to walking speed and then stays capped; sprint raises cadence. No automated yaw, pitch, zoom or input smoothing. The body keeps the shared controller's collision and acceleration.

Start/stop amplitude and turn roll use critically damped springs (duration 0.30 s, bounce 0). Pose offsets use a 0.10 s spring to keep velocity continuous when movement stops; foot audio is delayed 30 ms to match its group delay. Idle breathing is 0.7 mm at 0.23 Hz. Stops, walls and camera cuts do not emit distance contacts. Slow steps are quieter. The panel exposes camera amount, step length, settle time, movement volume, room tone and **Reduce camera motion**. Reduced motion starts from the OS preference and smoothly returns all offsets to zero while retaining sound.

## Sound

All movement and room sounds are original seeded PCM synthesis in `src/foley.ts`: low-passed carpet heel/toe noise, cloth rustle, stop/pivot scuff, damped chair impact, HVAC and a spatial 120 Hz fluorescent hum, plus sparse distant creaks. No downloaded samples. Variants are cached, one-shot nodes disconnect on completion, and the HVAC seam is overlap-crossfaded. The live mixer and offline recording use the same graph and contact events. Focus loss, the panel and mute gate playback; no audio starts before the canvas click.

Kit's playtest found the initial footsteps much too loud. The revised carpet bank has 32 seeded variants with 22–36 ms compression attacks, varied decay/colour/weight and a much weaker heel resonance. Contact gain is `.025 + .175 * min(speed / 1.7, 1)^1.6`; sprint raises cadence, not loudness. At 0.5 m/s, contacts are 12.1 dB quieter than at 1.7 m/s. Stop/pivot scuffs and cloth are also lowered. The existing movement/room controls stay at .8/.7.

Measured across all 32 variants using the loudest 100 ms RMS window, normal-walk contacts are 24.3–29.4 dB below the original bank/gain and at least 3.6 dB below the HVAC bed alone at default settings, even before stereo-pan attenuation. Slow contacts are a further 12.1 dB down. Measurements use generated PCM without playback (`iteration-17/carpet-levels.json`); the original walking clip below preserves the **earlier, louder mix**. The live development preview is the current audition surface. Six focused walk/audio tests, TypeScript and the production build passed after the change.

`scripts/walk-trace.ts` writes per-frame offsets and contact events at 30/60/120/144 Hz, including interrupted movement, speed changes, turns, reduced motion and focus loss. `scripts/walk-video.ts` drives the actual controller with keyboard events, captures GPU frames headlessly with `--mute-audio`, then renders the same event tape into an OfflineAudioContext and muxes the saved WAV. No speaker playback is needed.

## Storage contacts

The old tray pitch was 105 mm with 73 mm supports (32 mm air gaps). Cabinets also had drawer fronts extending 42 mm above the casing, and storage bases were guessed independently. Stack placement now measures actual generated bounds, with each next tray resting on the previous rim and each paper pile on its tray floor. The cabinet shell, not its drawer fronts, defines its support. `tests/stacks.test.ts` ray-checks bottom vertices against the actual packed supporting triangles, so a self-consistent metadata error cannot pass as contact.

## Turning diagnosis

`scripts/turn-proof.ts` records a matched turning tape with static lighting and no gait offsets. `motion-metrics.py` reprojects the same world points through each saved camera matrix to distinguish surface crawling from the intended turn. Over 48 frames, the affected left-panel region's frame-difference RMS was 0.011944 originally, 0.011993 with material detail removed, and 0.011942 with spotlight/blind shadows removed. Disabling screen-space contact shadows reduced it to 0.001563 (86.9%) and removed the visible bands. These are display-luminance measurements, not a perceptual score.

The contact pass reconstructed world positions using nearest-texel depth at arbitrary fractional UVs. Its half-resolution centres lie on full-resolution texel boundaries; floating-point UV neighbour offsets can select the wrong texel. The correction uses the shared integer-texel world reconstruction helper for origins, ±1 neighbours and ray samples. With contact shadows still enabled, the final capture removes the bands and measures 0.001563 RMS (86.9% below baseline). The other measured regions are effectively unchanged. An experimental integer-hash ablation failed shader validation and is not evidence.

Independent review also aligned each sky check with the exact integer texel used for reconstruction, and capped chair-bump expected travel at the controller's 50 ms timestep. The shared shader is not output-neutral for Lot or opt-in Outbreak: ray comparisons move by up to half a pixel. One matched Lot booth/curb before/after at half resolution (`scripts/lot-contact-review.ts`) retained contact shading with small local differences and no visible silhouette regression; both captures had zero browser/GPU errors. Outbreak contact shadows remain off by default.

## Verified result

The four-rate motion trace passes with the same 27 contacts at every rate; maximum offset speed is 0.181 m/s and maximum roll is 0.124°. The actual-input video covers 960 controller frames over 16 seconds: 17 steps, 17 cloth cues, seven scuffs, one chair bump and one distant creak. There are no footsteps while blocked, and five contacts during reduced-motion walking. Maximum per-frame camera translation is 1.95 mm at 60 Hz; the reduced-motion offsets settle to zero. Offline stereo audio peaks at −20.66 dBFS with zero clipped samples. All browser/GPU error lists are empty.

TypeScript, cycle checks, 12 game tests (2,850 assertions), five shared contact-shadow tests, all five shader validations and the production build passed. Captures and JSON traces are preserved in the gallery's `iteration-17/` directory. The first final capture timed out during startup; its diagnostic continuation succeeded without a production-code change.
