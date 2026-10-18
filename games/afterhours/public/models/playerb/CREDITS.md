# Body B (bake-off candidate)

`janitor_b.glb` is built by `bun scripts/playerb/build.ts`, which runs `scripts/playerb/build.py` and
`scripts/playerb/mocap.py` in Blender.

- **Mesh, clothes, skin, hair, eyes and brows:** MakeHuman via MPFB 2.0.18, **CC0 1.0**. The MPFB code is GPL, but
  the meshes, weights and system assets it outputs are CC0. Clothes are `male_casualsuit01`, re-tinted to a
  grey-green work shirt and charcoal trousers. Shoes are `shoes03`, re-tinted brown.
- **Skeleton:** MPFB's `game_engine` rig (UE-style bone names), CC0, kept in the man's own bind pose.
- **Crouch idle, crouch walk, interact:** Quaternius, Universal Animation Library 1 (Standard), **CC0 1.0**,
  retargeted offline (world-space rest deltas, scripts/playerb/rt.py).
- **Flashlight carry poses (Carry_*):** authored in scripts/playerb/carry.py (no third-party data).
- **The M_* clips** (walk, brisk walk, jog, run, backpedal, sidesteps left and right, idle, jump start/air/land): CMU
  Graphics Lab Motion Capture Database, http://mocap.cs.cmu.edu (takes 07_01, 07_12, 16_02, 16_35, 127_06,
  143_39 and 143_40). They were retargeted offline onto the UAL skeleton.
  CMU licence: "free for all uses", and you may include the data in commercially sold products. Credit requested:
  "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF
  EIA-0196217."
