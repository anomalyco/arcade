---
name: arcade-lookdev
description: Look development for arcade, from target to Kit's pick. Use when a scene, creature, room, light or look needs a reference target, concept art or a paint-over, when a visual round is about to be captured or shown to Kit, or when Kit says something looks fake, flat, dark, washed out or wrong.
---

# Arcade lookdev

Every look round is judged against a **target**: a real reference or a paint-over of a real capture. Build to the
target, check it before Kit sees it, then put Today and the candidate side by side.

## Target

1. **Direction unknown?** Run the global `concept-art` skill: a contact sheet of distinct directions, Kit picks one.
   Done when Kit has named a pick.
2. **Paint-over.** Run the global `paint-over` skill on a real screenshot from the game's hero camera. Done when the
   paint-over is saved with the work and you have written down, in a few lines, what differs between it and the
   capture (shape, material, light, atmosphere).
3. A real reference Kit names (Ashwood for the Lot, Darkwood for Outbreak, period hardware) is a target too; it
   outranks invention ([Kit's taste](../../../docs/realism.md#what-looks-best-kits-taste-so-far)).

## Build and pre-flight

4. Build with `arcade-quality` (and `arcade-props` for models). Tune values through typed Lab settings so each
   round is reproducible ([docs/lab.md](../../../docs/lab.md)).
5. Capture headless and muted inside the browser budget, at the target's camera and exposure. Run the quality
   checklist's pre-flight gates (step 5): legible subject, no crushed or clipped frame, nothing at the lens, stable
   in motion. Automated gates are landing on `quality-gates`; that branch updates this step when it merges. Done
   when every gate passes or its failure is written down for Kit.

## Show Kit

6. **One comparison.** Today and the candidate at the same moment, beside the target: paired stills on a board
   decision, or a Lab station if he will come back to it (`bun run arcade station <id>`). Clips only for motion,
   and the global `kit-motion` skill for anything that moves. Register gallery captures with
   `bun scripts/agent-ops.ts gallery-link` before sharing a link.
7. **Record.** Kit's pick becomes the default with Today one setting away; add or update the
   [docs/realism.md](../../../docs/realism.md) entry with its cost and decision, and put the evidence in
   `docs/research/`.
