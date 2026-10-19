# Character roster assets: format and clip metadata

Built by `bun scripts/playerb/characters.ts` (Blender: `scripts/playerb/mixamo.py`; gltf-transform meshopt) from the
gitignored Mixamo sources in `mixamo-src/`. Verify with `bun scripts/playerb/compare.ts bind|mosaic` (raw FBX vs
converted, `scripts/playerb/compare.html`) and `/roster.html`.

## Files (`public/models/characters/`)

- `<id>.glb` for `remy`, `james`, `kate`, `louise`, `megan`: one skinned character. The skeleton is shared:
  - Bone names are the Mixamo ones without the `mixamorigN:` prefix (`Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`,
    `Head`, `HeadTop_End`, `Left/RightShoulder|Arm|ForeArm|Hand`, `Left/RightHand{Thumb,Index,Middle,Ring,Pinky}{1..4}`,
    `Left/RightUpLeg|Leg|Foot|ToeBase|Toe_End`).
  - Remy alone also has `LeftEye`/`RightEye`.
  - Every bone's rest orientation equals the animation skeleton's (limbs re-aimed offline; the trunk keeps its
    shape).
  - Units are metres and Y is up, with the armature node at identity (no rotation or scale) and the feet at y = 0.
  - Materials: base colour (alpha only on hair and lashes), normal map, and an ORM map (roughness = 1 − gloss,
    metalness 0).
  - Textures are WebP, at most 2048 px (hair at most 1024).
- `anims.glb`: Remy's skeleton (no mesh) with all 31 clips as glTF animations named by clip id.
  - Each clip has quaternion tracks for every bone plus a `Hips` translation track.
  - Keys run at 30 fps from t = 0. A loop's last key equals its first, so duration = (frames − 1) / 30.
- `roster.json` (also written to `src/playerb/roster.json`): the metadata below.

**To play a clip on a character:** use the rotation tracks as they are, plus `Hips.position × characters[id].hipRatio`.
Ignore the other translation tracks, which hold Remy's bone lengths.

**Distances in the clip metadata are at Remy's size** (hips 0.98 m). For another character, multiply them by
`characters[id].hips / anims.refHips`. This applies to speed, rise, root and travel.

## `roster.json`

- `characters[id]` fields:
  - `name`
  - `height`: m, including hair
  - `hips`: bind hip height, m
  - `hipRatio`: hips / 0.98
  - `head`, `headTop`: m
  - `meshes`: name, verts, tris, materials
  - `bones`
  - `bytes`
- `anims.refHips` is 0.98, and `anims.fps` is 30.
- `anims.clips[clip]` fields:
  - `kind`:
    - `loop`: cyclic locomotion
    - `idle`
    - `climb`: loop with its linear rise removed
    - `jump`
    - `one`: one-shot
    - `mantle` / `vault`: one-shot with root motion; see the mantle fields below
    - `broken`: unusable source, see below
  - `loop`: true when the clip wraps seamlessly.
  - `inPlace`: always true. All travel has been taken out of the glb and is reported in the fields below.
  - `duration` (s) and `frames`.
  - `speed` and `velocity` (loops): ground speed in m/s and direction `[x, z]`. In the clip's frame +Z is forward
    and +X is the character's left. The speed is the planted foot's speed with the clip's own drift removed.
  - `rise` (`climb` only): vertical speed in m/s that the controller must supply; `rise × duration` is the drop or
    climb per cycle (two steps). Ladder: 0.71 m/s, measured from the gripping foot.
  - `contacts` (loops): stance intervals per foot, `{l: [[start, end]], r: [...]}`, as phase fractions 0–1 of the
    clip; an `end` above 1 wraps into the next cycle. A foot counts as planted when it moves with the ground (or
    rungs) to within 0.35 m/s and sits within 4 cm of its lowest height.
  - `root` (one-shots): the root path that was removed, one entry per frame: `[x, z, yaw, y]` relative to frame 0,
    in metres and radians, same axes as above. `y` is always 0. The climb onto the top keeps its 1.52 m rise in the
    Hips track.
  - `yawTotal` (deg) and `travel` (the source's Blender-axis root travel, for reference).
  - `takeoff` / `land` (`jump`): seconds at which the feet leave the floor and land again. The clip's own leap
    height is removed; the dip before take-off and on landing is kept.
  - `seamFixed`: degrees of end-vs-start mismatch that was spread over the loop.
  - `centred`: the constant offset (m) that was removed to put the clip over the origin.

## Mantles and vaults

These clips are `mantle-step-up`, `mantle-hop-up`, `mantle-run-jump-high`, `mantle-hang-to-crouch`, `vault-one-hand`
and `vault-two-hand`. Their extra fields:

- `root`: one entry per frame, `[x, z, yaw, y]` relative to frame 0, at Remy's size (+z forward, +x the character's
  left; the floor is at y = 0).
  - Forward and sideways come from the hips path smoothed over ±5 frames, so the in-clip bob stays in the hips.
  - `y` (mantles only) is the hips' climb made monotonic and scaled to end exactly at `ledge`.
  - Vaults have `y` = 0: their jump arc stays in the hips.
- The glb's hips keep only the motion relative to that path. To play a clip, place the body at `root[f]`; to match a
  different ledge height, stretch `y`.
- `ledge`: the height the clip implies (m). For mantles it's the floor the feet end on; for vaults it's the hand-plant
  height minus 3 cm.
- `start`: `"stand"`, or `"hang"` for `mantle-hang-to-crouch`, which starts hanging with its feet 0.24 m up.
- `hands`: `{l, r}`, a list of contacts each `{start, end, palm}`.
  - `start` and `end` are clip times (s).
  - `palm` is `[x, y, z]` at the first contact frame: y above the floor, x and z relative to the frame-0 root.
  - A contact is a palm that is nearly still (under 0.9 m/s) and on the ledge, meaning −15 to +12 cm of `ledge` and
    ahead of the hips, or on the obstacle for vaults.
  - Use these intervals to pin the palm onto the real edge.
- `feetLand`: `{l, r}`, the clip time at which each foot first rests on its final floor after a hand contact, or
  null.

## Known source problems

- Mixamo's stair-descent takes (`descending-stairs`, `-rootmotion`, `-run`) are shorter than one stride, and their
  swing foot never goes below the floor it left, so the legs fold into a squat. The build repairs them from one step
  (`HALF_STEP` in mixamo.py):
  1. The stepping leg is re-solved onto the steps above and below.
  2. The hips are lifted back to a walking stance, with both legs re-solved.
  3. The stride is completed by mirroring the step, then the linear drop is removed like any climb.

  Measured against the staircase each clip implies, the walk-down's planted foot sits within about 3 cm of the
  tread. The run-down is rougher: its planted foot sits up to 13 cm into the tread.
- `descending-stairs-rootmotion` is the same take as `descending-stairs`; after conversion the two are identical.
- `right-turn-90` turns 102.6°, not 90°; scale its `root` yaw if an exact 90° is needed.
- The torch clips hold the torch in the left hand.
