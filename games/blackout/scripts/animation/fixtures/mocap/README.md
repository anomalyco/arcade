# Mocap reference clips

`pose-diff.ts` and `gait-metrics.ts` compare our rig against two motion-capture clips. `common.ts` downloads
them into this folder on first use and checks each file against a pinned SHA-256, so the tools work without
`--bvh-dir`. The `.bvh` files are ignored by git.

| Clip | Use | Frames used | SHA-256 |
| --- | --- | --- | --- |
| `dataset-1_walk_normal_001.bvh` | walk reference, 1.4 m/s comparisons | 35–131 (3 cycles) | `5764cebc…a8032` |
| `dataset-2_run_normal_001.bvh` | run reference, 4.2 m/s comparisons | 10–66 for pose diff, 4–64 for gait curves | `3efb502e…7f423` |

Both are 30 fps BVH with a `Hips`/`Spine`/`Chest`/`Foot_L`/`Hand_L` skeleton in centimetres.

## Source and licence

These clips come from the Bandai Namco Research Motion Dataset, pinned at commit `74ead3b`:
<https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset>.

> Kobayashi, M., Liao, C.-C., Inoue, K., Yojima, S. and Takahashi, M. *Motion Capture Dataset for Practical
> Use of AI-based Motion Editing and Stylization*. arXiv:2306.08861, 2023. © 2022 Bandai Namco Research Inc.

The dataset is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). We use it only as
a local measurement reference: no clip, curve or derived pose ships in a game build. Because the licence is
non-commercial, the files are fetched rather than committed to this public repository.

Earlier notes called these "CMU mocap". That was wrong: the joint names, 30 fps timing and file names match the
Bandai Namco dataset byte for byte. If we ever need a reference that can be committed, the CMU Graphics Lab
Motion Capture Database (<http://mocap.cs.cmu.edu/>) allows free use with attribution, but its skeleton would
need a new retarget in `packages/kit/pose-diff.ts` (`retargetBvhFrame` expects these joint names).

## Offline use

Copy both files into any folder and pass `--bvh-dir <folder>`. The hash check still applies.
