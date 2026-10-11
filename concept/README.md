# Salvo — Concept Art

Concept art for *Salvo*, a browser artillery game where all players aim at the same time and every shot fires together.
Everything here was made with GPT Image 2.5 Sunburst. Each image was produced from a blank canvas with `opencode_image_edit`. All images after the art-direction section used `dir-c-tactical-2.png` as their style reference.

## 1. Art directions

### A — Graphic and flat
- `dir-a-graphic-1.png`: Daytime poster look with flat slate/sand/orange color blocks, single-color team units, dotted white arcs and a geometric crater burst.
- `dir-a-graphic-2.png`: Night travel-poster variant with layered indigo mountains, a teal cut-away showing tunnels, team-colored arcs across a big moon, and a polygon overhang breaking off.

### B — Moody pixel art
- `dir-b-pixel-1.png`: Dusk pixel art with an amber and magenta sky, parallax haze, scarred rock strata and a Noita-style debris explosion.
- `dir-b-pixel-2.png`: Stormy blue-hour pixel art with ruined towers in fog, wind-bent shell trails and an overhang blown apart into falling sand.

### C — Tactical and clean
- `dir-c-tactical-1.png`: Pure ballistic-display look: a dark grid, charcoal terrain with a cyan contour line, neon parabolas with tick marks, and a ring shockwave.
- `dir-c-tactical-2.png`: **Chosen reference.** Same clarity with more atmosphere: graphite terrain with glowing edges, team chevrons, bloomed neon arcs, a mid-air collision and a hot white impact.

### D — Painterly and industrial
- `dir-d-painterly-1.png`: Dieselpunk war painting with ochre/rust/umber tones, riveted machines, trench-scarred clay and a towering fire-and-smoke plume.
- `dir-d-painterly-2.png`: Golden-hour quarry with scaffolding, a mortar crawler, rail cannon and walker, and a blast shearing off a cliff.

## 2. Key moments (direction C)
- `moment-1-salvo-impact.png`: The "all shots land at once" moment, with eight converging arcs, mid-air shell collisions, a cluster burst and a chain reaction.
- `moment-2-collapse.png`: A hill hollowed out by tunnels collapses in glowing-edged slabs and takes three tanks down with it.
- `moment-3-aim-phase.png`: The quiet aim phase, with every player's faint dashed ghost arc and angle/power ring visible and wind streaks drifting across.
- `moment-4-team-split.png`: Cyan vs orange on a symmetrical split map, with arcs crossing over a central canyon and a rock bridge starting to crack.

## 3. Units
- `units-1-lineup.png`: Eight unit designs in side profile with neon team trim: mortar crawler, rail cannon, missile walker, wheeled howitzer, hover drone, double-barrel siege tank, mast catapult, six-wheel rocket buggy.
- `units-2-silhouettes.png`: Readability test with the same eight units as flat solid-color silhouettes (top) and at in-game scale on terrain with chevrons (bottom).

## 4. Weapons and effects
- `weapons-1-sheet.png`: Six panels showing trajectory, explosion and terrain result for cluster, drill (tunnel), napalm (pooling fire), gravity well (vortex cavity), terrain builder (rising wall) and airstrike (line of craters).
- `weapons-2-projectiles.png`: Eight projectile designs (HE, cluster, drill, napalm, gravity orb, builder, guided missile, bunker buster), each with its explosion signature below.

## 5. UI mocks
- `ui-1-aim-hud.png`: Aim-phase HUD with a 0:05 ring countdown, wind readout, an 8-player list with health bars and lock-in checks, a radial weapon wheel with ammo counts, an angle/power panel and a LOCK IN [SPACE] button.
- `ui-2-shop.png`: Between-round armory with credits, a next-round timer, 9 weapon cards with price and damage/radius/terrain bars, a DRILL detail panel with a trajectory preview, an inventory strip and a scoreboard. (Small AI-text flaws: the subtitle "Artillery for a brighter tomorrow" and the typo "UNKKERS".)

## Recommendation: direction C (tactical and clean)

C is the strongest direction for Salvo, specifically the more atmospheric version in `dir-c-tactical-2.png`.

- **It shows the core mechanic clearly.** The game's big moment is many shots in the air at once. Glowing team-colored arcs on a dark sky are the clearest way to show 12 trajectories, mid-air collisions and chain reactions without turning into noise. The aim phase (ghost lines) and the impact phase use the same visual language.
- **It reads at small sizes.** One dark terrain mass with a bright edge, team color only on units, arcs and effects, and chevrons over units means you can find any player in a small browser tab. The pixel (B) and painterly (D) directions look great at full size but lose units in the busy terrain.
- **It fits the audience.** It feels like a simulation or esports game, not a cartoon, which suits a software team. The UI mocks come out of it naturally.
- **It's cheap to build.** Flat dark terrain with an edge outline is easy to destroy using a bitmap mask in Canvas/WebGL. Bloomed lines and particles are cheap in the browser, and new team colors cost nothing.

Worth borrowing from the others: A's restrained palette and color blocking for menus and the shop, and D's terrain strata and smoke detail, used sparingly, for the "big moment" effects.
