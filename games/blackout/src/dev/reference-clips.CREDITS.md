# Reference clips (Characters page, Lab only)

`reference-clips.json` holds one retargeted gait cycle per clip, written by
`bun games/blackout/scripts/animation/reference-clips.ts --bake`. It is shown only as the grey reference ghost in the
Characters page's Lab (Reference group, off by default).

- **100STYLE** (`style-*` clips): Ian Mason, Sebastian Starke, Taku Komura, *Real-Time Style Modelling of Human
  Locomotion via Feature-Wise Transformations and Local Motion Phases*, 2022. **CC BY 4.0**,
  https://zenodo.org/records/8127870. Changes: one gait cycle cut from the Neutral, Zombie, DragLeftLeg, Crouched and
  Swat forward-walk takes and the Neutral side-step walk, side-step run and backward-walk takes (SW, SR, BW), retargeted onto the arcade rig's link lengths and resampled to 32 frames.
- **Universal Animation Library 1 and 2** (`ual-*` clips) by Quaternius, **CC0 1.0**,
  https://quaternius.com/packs/universalanimationlibrary.html. Same changes.

Do not add Mixamo (Adobe terms forbid redistribution and ML use) or Bandai Namco Research clips (CC BY-NC) here.
