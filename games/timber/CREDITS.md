# TIMBER credits

## Sound

All of TIMBER's recorded sounds are CC0 (public domain) field recordings from Freesound, cut, levelled and
encoded by `scripts/sounds.ts` into `public/sfx/*.ogg`. `public/sfx/sources.json` is the manifest: each source's
page, licence and the SHA-256 of the file we downloaded, plus which clip came from which seconds of it. Credit is
not required for CC0; we give it anyway.

| Source | Author | Licence | Clips | SHA-256 |
| --- | --- | --- | --- | --- |
| [Chainsaw idle and revving, Husqvarna 445](https://freesound.org/people/ElSchorscho/sounds/871135/) | ElSchorscho | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `saw-cutout`, `saw-idle`, `saw-rev` | `d28d5d6cc91ec92b…` |
| [Chainsaw starting, idling, stopping Husqvarna 445](https://freesound.org/people/ElSchorscho/sounds/871136/) | ElSchorscho | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `saw-pull.1`, `saw-pull.2`, `saw-start` | `b2d84f68c627ca29…` |
| [Chainsaw - Start Cut and Idle.wav](https://freesound.org/people/Stefan021/sounds/431741/) | Stefan021 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `saw-cut` | `b73ed568f0abefb4…` |
| [snowmobile won't start false starts lawnmower pull cord](https://freesound.org/people/kyles/sounds/450951/) | kyles | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `saw-flood` | `0e53879beae09dc6…` |
| [Big Tree Fall in Forest](https://freesound.org/people/Kinoton/sounds/494071/) | Kinoton | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `tree-crash.1`, `tree-groan` | `29223f960142cc24…` |
| [timber tree falling 2](https://freesound.org/people/matt_beer/sounds/515312/) | matt_beer | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `tree-crash.2` | `8ab41af3a2abe57b…` |
| [Wood Crack 5](https://freesound.org/people/utsuru/sounds/183450/) | utsuru | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `tree-crack.1`, `tree-crack.2` | `33d4f2ac8613be95…` |
| [tree wind creaking.wav](https://freesound.org/people/HMTSCCSound/sounds/554651/) | HMTSCCSound | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `tree-creak.1`, `tree-creak.2`, `tree-creak.3` | `2474f300475c570e…` |
| [Running, on path through forest, dirt ground, leaves, footsteps, NOTL, 2011.flac](https://freesound.org/people/TRP/sounds/577313/) | TRP | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `foot-run.1`, `foot-run.2`, `foot-run.3`, `foot-run.4`, `foot-run.5`, `foot-run.6` | `05fec80b6e7ded69…` |
| [Scared Male Heavy Breathing](https://freesound.org/people/casiba842/sounds/554307/) | casiba842 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `breath` | `9a952363c63de075…` |
| [Single Heartbeat Clean HQ_BeatSmith.wav](https://freesound.org/people/Lunardrive/sounds/22440/) | Lunardrive | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `heart` | `918d435b41ed4786…` |

## People

The lumberjack and the survivors are Microsoft Rocketbox avatars (MIT), built for the kit by
`scripts/people/build-rocketbox.ts`; see `docs/people.md`. The lumberjack, `public/people/lumberjack.glb`, is m05
(`Male_Adult_05`) with its outfit texture repainted by `scripts/lumberjack.ts` (a buffalo-check flannel shirt, a black
canvas vest, dark trousers and boots); SHA-256 `79b1f6d62a4d3545493ee15a6aaf10ac7763daabf9107c4da3750460aa0ed011`.

## Chainsaw

`public/saw/saw.glb` (the first-person saw and the lumberjack's) is built from
["Chainsaw"](https://sketchfab.com/3d-models/052d0c1d5e6f48358dc89d6cefe45a38) by
[Lassi Kaukonen](https://sketchfab.com/thesidekick), a photogrammetry scan licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), fetched from the Objaverse mirror (SHA-256
`97ef54ae82919d698d9b8be9b55a733d8bb2bf3356676d09da22cc264f0de294`, in `public/saw/sources.json`).
Changes (`scripts/saw/build-saw.py`): the powerhead decimated to two levels of detail with its maps re-baked from the
full scan, labels and stickers painted out, a new 18" bar, chain, starter grip and cord, and modelled leather work
gloves (their leather baked into the bar's maps) and sleeves.
