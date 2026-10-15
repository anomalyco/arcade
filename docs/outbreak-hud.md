# Outbreak character HUD

Outbreak shows what matters this second on the survivor and leaves slow-changing state at the screen edge. Action
callouts sit under the survivor; stamina, reload, health and battery are small rings beside the body that only appear
while they have something to say. Code: `games/outbreak/src/hud/`. Proof: `games/outbreak/scripts/hud-proof.ts`.

## How other games split it (October 2026 survey)

Checked against a source:

- **Breath of the Wild**: the stamina wheel appears next to Link only while an action spends stamina, turns red when
  empty and stays red until it refills; hearts stay top-left. The wheel sits where the player is already looking, and
  a circle keeps the obstruction small (Zelda Wiki "Stamina Wheel"; Max Frequency, "Breath of the Wild fixed stamina").
- **Dead Space**: health runs down Isaac's spine, stasis is a crescent on his back and ammo floats over the gun. Shape
  tells the meters apart and colour tells the range (blue, yellow, red), so they read from the corner of the eye
  (Ars Technica, Chuck Beaver 2008; Giant Bomb, "Markers I"). Its weak spot: when the camera is pushed into a wall the
  meters move into the screen corner.
- **Project Zomboid**: timed actions (reloading, crafting, eating) show a small bar over the character's head;
  moodles sit top-right (PZwiki "Moodle"; Project Zomboid modding docs, `BaseAction.UseProgressBar`).
- **Hades**: health, Cast ammo and the boon list are on the screen edges (health bottom-left, Rail ammo beside it);
  enemy health, armour and curses sit on the enemies, and rewards on the doors. Low health pulses (Hades Wiki,
  "Gameplay mechanics"; Game Design Lab, "Hades systems"). So Hades keeps the player's own numbers off the character.
- **Helldivers 2**: health, weapon and ammo are in the bottom-left panel and stamina visibility can be set to
  Dynamic. The most downloaded HUD mods (HD2 HUD+, Reticle Ammo HUD) move ammo, reload and stamina rings next to the
  crosshair, which says players want them in the gaze path (Helldivers Wiki "Heads-Up Display"; Nexus Mods pages).

From memory, not rechecked here: Enter the Gungeon draws its reload bar over the player; Diablo IV keeps health and
resource orbs at the bottom centre with damage numbers in the world. Diablo IV's optional on-character bars, The
Ascent, Dead Nation, Darkwood, Death's Door, Children of Morta and Alienation were on the list but not verified in
this pass, so they did not inform the choices.

The pattern: anything that changes within a second and gates the next move (stamina while sprinting, a reload, an
action in progress, a hit) goes on the character, because the eyes are there and the information is about the body.
Totals and slow state (ammo reserve, the clock, inventory, map) stay at the edge. Two constraints matter more for a
three-quarter top-down camera. The area ahead of the aim is where threats are, so nothing should sit in it; and in
the dark the world can't be relied on to light a diegetic meter, so labels carry their own dark backing.

## What Outbreak does

- **Callouts below the survivor** by default (Lab HUD › Callout placement: Below, Above, Beside). "Below" is the
  lowest projected point of a 0.2 m circle around the feet, so it is screen-below under the camera tilt. Above was the
  previous placement; it stacks over whatever the survivor walks toward, and in co-op it would collide with name tags.
- **Keep clear of aim** (on by default): when the survivor aims within 55° of the side a stack is on, it slides to the
  opposite side, and comes back once the aim is more than 68° away. Alignment and position ease over about 0.1 s.
- **Rings beside the survivor** (Lab HUD › Stamina & status: beside, under the feet, or the old bars at the screen
  edge). Order outward from the body: stamina, reload, health, battery. Stamina is a bare ring shown while not full or
  sprinting; amber below 30 % (Stamina low at), red and flashing when exhausted. Reload is a ring around the magazine
  count while reloading and for 0.9 s after, and red at 0 with spare ammo. Health has a cross and shows for 3 s after a
  hit and while at or below 35 HP. Battery has a cell icon and shows only while the light is on below the flicker
  threshold, or dead. With rings on the character the bottom stamina and battery bars are hidden.
- **Teammates** get the same components from replicated flags only (health, exhausted, reloading, pistol, light),
  at 0.8× (Teammate HUD size), under their name tag. Reload progress is timed locally from when the flag rose because
  the snapshot carries no reload timer; stamina, ammo and battery are private, so their rings don't appear. Teammate
  callouts default to Important only (progress, warnings, damage).
- Reduced motion turns off drift, slides and the exhausted flash.

## HUD styles

Lab › HUD › HUD style switches between five directions, the same options as the team board's AR-24 decision
(D-13). Callout placement and Stamina & status default to "Style default"; setting either overrides the style's
choice. The game default is Diegetic, Kit's pick on D-13 (`DEFAULT_HUD_SETTINGS.hudStyle` in
`src/hud/settings.ts`); switching to another option is that one value.

| Style | Callouts | Stamina, reload, health, battery | Screen edge |
| --- | --- | --- | --- |
| Today | above the head, never swap sides | bars over the hotbar | summary and hotbar |
| Below Feet | below the feet, swap away from the aim | rings beside the body | summary and hotbar |
| Hades Style | below the bars | thin bars under the feet | no summary, dimmed hotbar |
| Zomboid Style | outlined text and an action bar over the head | status icons top right (Winded, Hurt, Battery low) | summary and hotbar |
| Diegetic (default) | outlined text below the feet, info callouts dropped | stamina (left) and health (right) as arcs of a ground ring in front of the feet; reload and battery as rings | hotbar only for 2.2 s after a slot change |

Ring shape (Ring, Wheel, Arc) and Health on character apply to every style that draws rings. Noise callouts
("Noise 32 m" for actions heard 9 m or more away) are off by default since Kit didn't like them; Lab › HUD › Noise
callouts turns them back on. `ActorFeedback` still reports them, and `CharacterHud` drops them unless the setting is on.

Key names follow the controls rule (docs/controls.md): bindings are physical `KeyboardEvent.code`, and labels are the
QWERTY name of that key on every layout. The "Empty, R to reload" callout draws R with the shared key cap
(`keyCapHtml` from `@arcade/kit/client/key-cap`, passed as the callout's `keyCap` option), and the world prompt's
Hold E is that component's hold cap, whose ring fills with the game's hold timer.

The structure is `OutbreakHud` (projection, `ActorFeedback`, teammates) feeding `CharacterHud` (`src/hud/character.ts`),
which only needs each actor's screen box and meter inputs. The board prototype uses that split:
`scripts/hud-moment.ts` records a 14 s scripted moment (hold E to lock a door, search a kitchen cabinet and take
what it reveals, fire the pistol dry, reload, a zombie hit, sprint to exhaustion) as headless frames with the HUD hidden, plus a timeline of the survivor's box, state and every callout
the game emitted. The prototype plays the frames as a muted loop and replays the timeline through `CharacterHud`
bundled from `scripts/hud-prototype-entry.ts`, so what the board shows is the game's HUD code, not a mockup.

The `outbreak-hud` Lab station (`arcade station outbreak-hud`, `games/lab/src/stations/outbreak-hud.ts`) runs the live
game with one variant per style; each variant sets the style and runs `hud.demo`, which puts a sample on the survivor.
`games/lab/scripts/prove-page-station.ts outbreak-hud --serve --read hudStyle` proves every variant.

## Diegetic ground ring

Stamina and health are two arcs of one ring on the ground around the feet (`groundArc` in `src/hud/vitals.ts`). The
ring is a 0.62 m circle projected to the screen point by point (48 points, `OutbreakHud.body`), so the ellipse has the
camera's real perspective, and it is drawn as SVG paths with constant screen-pixel strokes: a dark casing for contrast
on lit ground, the empty track, and the fill as a dash of the arc's length. Each arc runs from a small gap at the
front round to just past the side (0.44π of plan angle); the back half is left open, because that is where the legs
and shadow are and a DOM overlay can't go behind them. Stamina fills the left arc and health the right, both from the
front. Colour gives the range (pale, amber, red), and a spent arc's track turns red so exhaustion reads even at zero.
Callouts below the feet start under the front of the ring while it shows. An earlier version drew two concentric
CSS ellipses with conic gradients: their strokes thinned on the short axis, the angles stretched, and both crossed the
legs, which is what Kit's voice note on D-13 pointed at.

## Text sharpness

Kit found HUD text blurry in the D-13 prototype. Causes found and fixed:

- The halo look (Zomboid, Diegetic) used four blurred text shadows, which made glyphs soft and smeared into the R key
  cap. It is now a hard dark outline drawn under the fill (`-webkit-text-stroke` with `paint-order: stroke fill`) and
  a 1 px drop; key caps inside callouts reset both.
- Labels were placed with `translate(-50%, -100%)` of their own size, so their corners landed on half pixels, and
  teammates were shrunk with `scale(0.8)`. Callouts are now measured once when their text or size changes and
  positioned by their top-left corner on whole device pixels (`snapToDevice`, ratio from `devicePixelRatio`);
  teammates get a smaller font size instead of a transform. Rings are sized with width and their own `--vital-size`
  instead of `scale()`, and snapped the same way.
- `will-change: transform, opacity` promoted every label and ring to its own compositor layer; removed.
- The prototype stage scaled the 1280-wide frame with a CSS transform over a 1280 × 800 video. It now uses CSS
  `zoom` (text laid out at the final size, snapping at DPR × zoom) over a 2560 × 1600 recording.

`scripts/hud-sharpness.ts` stages callouts and meters at a fractional position (with a teammate) and captures each at
DPR 1 and 2; `scripts/hud-sharpness.py` scores edge acutance (the strongest 8 % of per-pixel luminance steps over the
crop's luminance range, higher is sharper) and writes a zoomed before/after sheet. Boxed callouts (Below Feet) at DPR 1
went from 0.963 to 1.020 against 1.077 for the static status text, and at DPR 2 stayed level (0.784 to 0.779; the
status text is 0.765). The halo change doesn't score cleanly because the outline itself changes the edges, so its
evidence is the zoomed sheet. In the prototype at 2000 × 1250, DPR 2, the stage scene went from 0.132 to 0.176.

## Measured

`hud-proof.ts` on headless Metal at 1280 × 800, 2× DPR: 47 stills (placements × Noir/70s × street/interior, stamina
full/sprinting/low/exhausted in the same grid, every HUD style in both looks, reload, battery and health, a teammate,
and a crowded moment with three zombies and a hurt teammate), sheets from `hud-sheet.py`. Each style still asserts
the DOM it should produce (ring, bar or ground meters, status icons, halo look, chrome). `hud.update` with three callouts, three rings and a teammate
live: mean 0.06 ms, p95 0.2 ms, max 0.3 ms per frame (timer resolution 0.1 ms). Seven alternating 3 s pairs against
the old log with edge bars: style and layout −0.003 ms per frame (spread −0.016 to +0.006), script +0.021 ms (spread
−0.043 to +0.101); both are inside their spread, so the cost difference is not measurable.

## Known gaps

- When the survivor aims down while an interaction prompt is above, callouts go above and are pushed past the prompt,
  which can put them 60 px from the head. A lateral fallback would be closer.
- In a tight crowd a teammate's name tag can touch the local survivor's rings; there is no cross-actor layout.
- The teammate path was proved with an offline companion that reads only replicated fields, not in a live two-browser
  room.
