# Monster sourcing: Wendigo, Shapeshifter, Banshee

Researched 2026-10-19. I'm not a lawyer, and this is not legal advice. Prices and licences change, so recheck each
listing before buying. Nothing was bought and no accounts were created.

Each monster needs a realistic, rigged, animated character that fits the existing pipeline: Mixamo bone names, rest
poses re-aimed offline by `scripts/playerb/mixamo.py`, clips baked to `anims.glb`, and WebP textures of at most 2K. The
runtime plays any clip on any character that uses the shared skeleton, scaling only the hip translation. A monster
that ends up on the Mixamo skeleton therefore gets every Mixamo clip and every clip we have already retargeted (UAL,
CMU) for free.

## TL;DR: recommended plan

| Monster | Final asset (recommended) | Fallback that needs no new account | Stand-in for gameplay work today |
| --- | --- | --- | --- |
| **Wendigo** (3 m) | Image-to-3D (Meshy) from `concept/monsters/wendigo-apose.png`, then clean up in Blender, auto-rig with Mixamo and run it through our pipeline | Kitbash CC BY models from Objaverse: the *Man Hybrid* or *Until Dawn*-style body, a photoscanned deer skull and antlers, stretched to 3 m | Mixamo **Parasite** or **Vampire** scaled 1.6×, with an antler mesh parented to `Head` |
| **Shapeshifter** | Image-to-3D (Meshy) from `shapeshifter-apose.png`, then Mixamo rig with the "raised heel" leg mapping and an offline heel-lift correction | Kitbash: *Man Hybrid* body, a canine skull, fur cards and a tail | Mixamo **Vampire** or **Parasite** using crouched and crawl clips |
| **Banshee** | Image-to-3D body (Meshy) from `banshee-apose.png`; shroud and hair as separate meshes animated procedurally; an added jaw bone for the over-wide mouth | CC BY *Ghost Woman A-Pose* (fluxium3d) as the body, plus our own shroud and hair | Mixamo **Zombiegirl** or **Nightshade** with float bob and cloth in a shader |

Why this plan:

- None of the free models on Sketchfab or Objaverse matches our concepts at the realism bar. The good ones are
  unrigged statues. The rigged ones are low-poly or stylised.
- The hosted image-to-3D we can call with our own keys (NVIDIA TRELLIS) cannot take our images (tested below).
- That leaves Meshy, which costs $20 for one month of Pro, gives full ownership and API access, and has a free tier
  whose output is CC BY 4.0 with commercial use allowed. It is the cheapest way to get meshes that actually look like
  the concept art. After that comes one known-good path: Blender cleanup, Mixamo auto-rig, then `mixamo.py`.
- Kit needs to make the Meshy account, and approve the spend if he wants Pro.

Before running image-to-3D, I made A-pose, plain-background reference sheets from the concepts. Image-to-3D needs an
isolated, symmetrical figure: `games/afterhours/concept/monsters/{wendigo,shapeshifter,banshee}-apose.png`. The
`concept/` folder is gitignored.

All three sheets came out clean: full body, flat grey background, limbs clear of the body. The front view hides the
Shapeshifter's backward knee. Before running image-to-3D, add a side view so the generator gets the leg shape right;
Meshy Pro accepts multi-view input.

---

## 1. Mixamo creature characters and clips

Licensing is the same as for our players (`docs/mixamo-licensing.md`): fine in-game, but keep the converted files out
of the public repo.

All of these characters come pre-rigged on the standard Mixamo skeleton, so `mixamo.py character …` converts them
unchanged. They date from Mixamo's 2012–2015 catalogue: roughly 10–40k triangles with 2K diffuse, normal and specular
maps. They are game-ready but noticeably dated next to current realistic work. Use them as **stand-ins and greybox
monsters**, not as the final look.

| Mixamo character | What it is | Use for us |
| --- | --- | --- |
| **Parasite** (L. Starkie) | Gaunt infected humanoid, exposed flesh | Best Wendigo body stand-in (stretch, add antlers) |
| **Vampire** (A. Lusth) | Pale, bald, long-fingered Nosferatu type | Shapeshifter or Wendigo stand-in; long hands read well |
| **Mutant** | Hulking muscular brute | Wrong silhouette (too bulky) for all three |
| **Warrok** (W. Kurniawan) | Large troll or orc | Too bulky |
| **Maw** (J. Laygo) | Big-mouthed stylised troll | Too stylised |
| **Nightshade** (J. Friedrich) | Female dark-fantasy creature | Possible Banshee stand-in (check in the viewer) |
| **Zombiegirl** (W. Kurniawan), **Copzombie**, **Warzombie**, **Skeletonzombie** | Zombies | Zombiegirl is a Banshee body stand-in; Skeletonzombie is a ribcage reference |
| **Pumpkinhulk**, **Demon** (T. Wiezzorek), **Goblin**, **Ganfaul**, **Mremireh**, **Brute** | Fantasy | Not useful |

Mixamo creature clips worth pulling. Search names vary; confirm each in Mixamo search when downloading:

- Mutant set: *Mutant Walking*, *Mutant Run*, *Mutant Idle* / *Breathing Idle*, *Mutant Roaring*, *Mutant Swiping*,
  *Mutant Jumping*, *Mutant Dying*. These are heavy, wide-stanced and hunched, and suit the Wendigo.
- Zombie set: *Zombie Walk*, *Zombie Running*, *Zombie Crawl*, *Running Crawl*, *Zombie Scream*, *Zombie Attack*,
  *Zombie Idle*, *Zombie Stand Up*, *Zombie Neck Bite*. The crawls suit the Shapeshifter's all-fours dash, and the
  scream suits the Banshee.
- Stealth set: *Crouched Walking*, *Sneak Walk*, *Crouch Idle*, *Injured Walk*. These give the Shapeshifter its
  "almost human" stalk.
- Reaches and grabs: *Zombie Attack*, *Reaching Out*, *Standing Arguing*-style arm gestures. These give the Banshee's
  long-arm reaches.

All of them retarget through the existing `anims` mode of `mixamo.py`: loops have their travel removed and their
speed measured. The clips are humanoid mocap. Monster-specific motion (antler sway, head snaps, jaw, floating, cloth)
must be layered procedurally at runtime.

## 2. Mixamo auto-rigger on our own mesh

You upload an FBX, OBJ or zipped OBJ with textures. Mixamo asks you to place markers on the chin, wrists, elbows,
knees and groin, then returns our mesh skinned to the standard skeleton. That skeleton is exactly what `mixamo.py`
expects, so every clip works.

Limits and how to handle each:

- **Humanoid biped only.** It needs distinct head, arms and legs. All three monsters qualify.
- **Pose.** It needs a symmetrical T-pose or A-pose with limbs clear of the body. Generate (or re-pose) in an A-pose.
  The A-pose sheets above exist for this.
- **Size.** Uploads above roughly 50 MB or a few hundred thousand triangles commonly fail or stall. Decimate to
  50–100k triangles first, then decimate again to about 30–40k for the runtime GLB.
- **One mesh works best.** Join the parts. Rig hair, shroud and antlers separately in Blender afterwards if needed.
- **Long limbs and a 3 m height are fine.** Bones go where the markers are. Normalise the height before upload, and
  scale up in Blender or at runtime, because our clips are hip-scaled anyway. Long fingers and claws get the standard
  3-joint fingers; weight claws to the last phalanx.
- **Antlers** get weighted to `Head`, sometimes bleeding into `Neck` or the shoulders. Fix: skin the antlers 100% to
  `Head` in Blender, or keep them as a separate rigid mesh parented to the `Head` bone.
- **Digitigrade (coyote) legs.** The skeleton has no extra leg segment (UpLeg → Leg → Foot → ToeBase). Mapping:
  - Mixamo knee = the true knee, Mixamo ankle = the hock (the raised heel), and `Foot` = the long metatarsal.
  - Human clips try to keep the foot flat, which lays the metatarsal on the ground and kills the backward-bent look.
  - Fix, offline in Blender: after the retarget (`rt.py`), add a constant heel-up pitch to `Foot`, then re-solve the
    leg with IK so the toes stay planted. It is one more pass in the build script.
  - Crouched, sneak and crawl clips already bend the ankle a lot, so they look best.
- **No jaw or face bones.** For the Banshee's mouth, add a `Jaw` bone under `Head` in Blender, or a blend shape, and
  drive it procedurally.
- **Skirts and shrouds.** Auto-weights glue the cloth between the legs. Keep the shroud as a separate mesh, weighted
  to the hips and spine only, and animate the hem in a vertex shader.
- **Licence.** Our mesh stays ours, or keeps its CC BY terms. The rig and any clips we download are Adobe Content
  Files, so the same rule applies: ship them only inside the game build. Uploading AI-generated or CC BY meshes is
  allowed. The Mixamo AI term only forbids using Mixamo to *train* AI.

A free alternative if Mixamo struggles: Reallusion **AccuRIG** (free, desktop, commercial use allowed). It produces a
humanoid rig that we would rename to Mixamo bones in Blender.

## 3. Image-to-3D generation

### What I tested with our keys

**NVIDIA build.nvidia.com: Microsoft TRELLIS (v1, `NVIDIA_API_KEY`).** Endpoint
`https://ai.api.nvidia.com/v1/genai/microsoft/trellis`, licensed under MIT plus the NVIDIA Community Model License,
and marked ready for commercial use.

- **Text-to-3D works.** The prompt "tall emaciated wendigo, deer skull face, antlers, grey skin, long clawed arms,
  T-pose" returned a 1.8 MB GLB in about a minute.
  - Geometry: 7,400 triangles and 6,721 vertices, with no normals, normalised to a 1 m box.
  - Texture: a single baked base-colour texture, with lighting baked in.
  - The result was a bulky, stylised orc with moose antlers, nothing like the concept, and well below the realism bar.
- **Image-to-3D does not work for our images.** The hosted endpoint accepts only its built-in sample pictures. Both a
  base64 data URI and an uploaded NVCF asset returned `422 "Expected: example_id"`.
- Conclusion: it is free, but unusable for this job.

**DeepInfra, Together, Novita and Fireworks** (keys present). None of their model lists has an image-to-3D or 3D
model. `ALIBABA_API_KEY` is DashScope, which has no 3D model. Hunyuan3D is Tencent's and is not hosted on Alibaba.

**Figma Weave** (MCP is connected) can run hosted models, but the Figma account is not linked to Weave. Linking it is
an account action for Kit.

### Services we would need an account for

| Service | Output quality | Cost | Output licence for a commercial web game |
| --- | --- | --- | --- |
| **Meshy** (Meshy 6/7) | Best of the commercial tools for creatures; PBR textures; built-in remesh to quads or a target poly count; built-in humanoid auto-rig and animation library | Free: 100 credits/month (about 3–5 image-to-3D runs with texture), web only, no API. Pro: **$20/month** for 1,000 credits, API access, 10 parallel jobs. An image-to-3D run costs about 20–30 credits | **Free plan: CC BY 4.0, commercial use OK with credit to Meshy.** Paid: private, full commercial rights |
| **Tripo** (v2.x/3.0) | Comparable; good topology option; auto-rig | Free: 200–300 credits/month. Pro: $20/month. API about $0.01/credit, 40–50 credits per model | Free output is public and CC BY; sources disagree on whether commercial use is allowed, so use a paid plan for shipping. Paid: commercial |
| **Hunyuan3D 3.x** (Tencent; via fal, WaveSpeed, Atlas, 3D AI Studio) | Very strong geometry; PBR | About $0.30–$0.80 per generation | Hosted v3 follows each host's terms. **Open v2.1 weights: the Tencent Community Licence excludes the EU, UK and South Korea** and requires a separate licence above 1M monthly active users. A public web game reaches the EU and UK, so avoid the open weights |
| **TRELLIS.2** (Microsoft, 4B, Dec 2025) | Big step over v1: 1536³ resolution, full PBR including opacity, handles thin parts better | Free weights, but needs a CUDA GPU with about 24 GB or more. Our Macs can't run it. We could run it on a rented GPU (a DigitalOcean GPU droplet or a Baseten deployment; we have keys for both) at about $2–4/hour | **MIT**, the cleanest licence. Costs setup time |
| Stable Fast 3D (Stability) | Fast, low detail, stylised | Free weights | Stability Community Licence (free under $1M revenue). Not realistic enough |

### Expected quality, and what cleanup the output always needs

Current generators (Meshy 6, Hunyuan 3, TRELLIS.2) produce convincing creature silhouettes and skin from a good
single front view. What they produce:

- Geometry: dense, uneven triangle soup of 300k–2M faces.
- Texture: one baked albedo with some baked lighting. Thin parts fail: antler tips, claws, finger gaps, hair strands
  and shroud tatters melt together or break. The back is invented.

The fix is about 2–6 hours of Blender per monster:

1. Decimate, or remesh (QuadriFlow or Instant Meshes), to about 40k triangles.
2. Separate the antlers or rebuild them from a CC BY antler scan.
3. Re-sculpt the claws, and split the fingers so the rig can bend them.
4. Bake the high-poly normals onto the low-poly mesh.
5. Neutralise the baked lighting in the albedo.
6. Pack a 2K atlas.

A-pose generations auto-rig with Mixamo well. That is why the A-pose reference sheets matter.

A copyright note: purely AI-generated output may not be copyrightable in the US. That does not stop us using it, but
others could copy it. Our manual cleanup adds authorship.

## 4. Sketchfab, Objaverse and paid marketplaces

### Free CC BY models

Searched through the Sketchfab API and screened by rendering in Blender. The models marked **Objaverse** are mirrored
on the `allenai/objaverse` Hugging Face dataset. That is the same route `scripts/fetch-models.ts` already uses, so
they **download with no Sketchfab account**. CC BY requires a credit line in `public/models/CREDITS.md`, which we
already ship.

| Model | Licence | Tris | Rigged? | Verdict |
| --- | --- | --- | --- | --- |
| [Wendigo – inspired by "Until Dawn"](https://sketchfab.com/3d-models/d46093a707a24444af1ed7d10aa7198f) (marc3_C) **Objaverse** `000-057` | CC BY | 188k | No (T-pose) | Realistic emaciated grey body with long limbs. **Good Wendigo body base.** The head is an Until Dawn-style human face; replacing it with a deer skull also removes the resemblance to Sony's design |
| [Man Hybrid](https://sketchfab.com/3d-models/5941dd1ea0354978a57249fb0606f7a9) (Robin.Mikalsen) **Objaverse** `000-093` | CC BY | 84k | No (A-pose) | Realistic: visible ribs, very long stilt-like shins. Described by the author as "skin walker like". **Body base for the Wendigo or Shapeshifter** |
| [Hybrid](https://sketchfab.com/3d-models/39c8e26e9a9d4fca92d2dbaa1f671c81) (Robin.Mikalsen) **Objaverse** `000-141` | CC BY | 81k | No | Dark, veined, animal-headed humanoid, tagged skinwalker. Usable, but darker and wetter than our patchy-hide concept |
| [Wendigo](https://sketchfab.com/3d-models/28dea1b1f0eb4e348ab8a8afeae1b5ab) (DannyAg) **Objaverse** `000-002` | CC BY | 15k | No | Popular, but semi-stylised; its deer skull is too cartoony |
| [Wendigo – Antlered Famine Horror Creature](https://sketchfab.com/3d-models/3511c530080240dfa1b5882ff38ee8ea) (s8819296, Aug 2026) | CC BY | 1.96M | No | **Closest match to our Wendigo concept** (grey skin over ribs, deer skull, antlers, long claws). The author says it is AI-assisted. Not in Objaverse, so it needs a Sketchfab login. Needs heavy decimation |
| [Drowned Hag](https://sketchfab.com/3d-models/9a4cc20c82b84c3989f5b63576eddb19) (same author) | CC BY | 1.98M | No | A gaunt, wet hag. A possible Banshee body after recolouring (black hair → white). AI-assisted, needs a Sketchfab login |
| [The Human Deer](https://sketchfab.com/3d-models/7644694337404bb18eb68e6b637740a1) (ceeleste) | CC BY | 86k | Animated (1 clip) | Strong quadruped-ish Wendigo variant, but its own design. Better as reference than as our monster |
| [Ghost Woman A-Pose](https://sketchfab.com/3d-models/f4f4f2f59f124f54a787438bb3ed9ab0) (fluxium3d) | CC BY | 50k | No (A-pose) | Clean, realistic female ghost body in a dress. **Banshee body base** (lengthen the arms, add white hair and a shroud). Needs a Sketchfab login |
| [Banshee](https://sketchfab.com/3d-models/16b79d30461543f7bb852463ab0df511) (Bapts) **Objaverse** `000-061` | CC BY | 470k | No (posed) | A ZBrush sculpt with swords in its back, frozen in a hunched pose. Only the head and face are useful |
| [White-Tailed Deer Skull With Antlers](https://sketchfab.com/3d-models/29bccce82a184e93bea39933d33b4760) **Objaverse** `000-152`; [Deer Skull – Photoscan](https://sketchfab.com/3d-models/ebd6e5b589cf41929f4748cdd27c5129) **Objaverse** `000-061` | CC BY | 450k / 37k | — | **Wendigo head kitbash parts** (real scans) |
| Rigged but low-poly or stylised: [Wendigo Rig](https://sketchfab.com/3d-models/bb4430604bad46799a1a8698fc19b47b) (51k, 15 clips), [The Rake](https://sketchfab.com/3d-models/92898b04b24e4315b0673fcfe307f64e) (8k, 11 clips), [SCP-096 Reanimated](https://sketchfab.com/3d-models/9e0b35c9485d4b51864a232e9653cc3a) (6k, 37 clips), the Banshee entries by Vasian-Digital3D | CC BY | — | Yes | Below the realism bar |

Avoid entries marked CC BY-NC (for example *Wendigo Project*, ENOMIC's *Night Creature*). Our game is commercial.

### Paid options

| Listing | Price | What you get | Catch |
| --- | --- | --- | --- |
| [ArtStation: Wendigo, Roger Kint](https://www.artstation.com/marketplace/p/1Ldev/wendigo) | $39.99 Standard | 23k-polygon realistic Wendigo, 4K PBR, 3 skins, rigged, 35 clips (idle, crawl, scream, attack, move ×11) | The **Standard licence covers one project up to 2,000 sales or 20,000 views**, which a public web game can exceed; it needs the Extended licence. It is a ram-skull or beast design, not ours |
| [Fab: Wendigo Horror Creature, Byuuru](https://www.fab.com/listings/b5cb0a1d-e641-4e43-807a-f13c20356efa) | not shown without login | Realistic, 4K, 42 clips, plus SFX | Ships as an Unreal project (we would export FBX from UE). The design has arm blades. Check whether the listing is restricted to Unreal Engine |
| [Fab: Wendigo Creature Character](https://www.fab.com/listings/25939997-e0fd-4150-b47d-21add39db152), [Fab: Wendigo monster](https://www.fab.com/listings/c07c84a6-edff-4acd-965f-56894f3283a3) | not shown without login | Realistic and rigged; the first is MetaHuman-compatible | Same Unreal-export overhead |
| [CGTrader: The Skinwalker](https://www.cgtrader.com/3d-models/character/other/the-skinwalker) | listed (page blocked to scripts) | 57k polygons, rigged, textured | CGTrader's Royalty Free licence is fine for games. Check the design against our concept |
| [Fab: Classic Female Ghost, RamsterZ](https://www.fab.com/listings/47293559-fdee-4fa5-ae60-12246a8c63b1) | not shown without login | **112 ghost animations** (13 crawls, 31 idles, 12 jumpscares, 19 moves), no mesh | The best ready-made *motion* for the Banshee. It is on the Unreal mannequin skeleton, so it needs a UE export and our offline retarget. Mocap-quality ghost motion is otherwise hard to get |

## 5. Sculpting or modifying in Blender from an existing base

This is the no-spend fallback, and the cleanup stage of every other route. It is realistic in quality only if the
base is realistic, so start from the CC BY scans and sculpts above rather than from Mixamo's dated characters.

- **Wendigo**, about 1–2 days:
  1. Take the *Until Dawn*-style or *Man Hybrid* body and scale it to 3 m: legs ×1.15, forearms ×1.3, fingers ×1.5.
  2. Sculpt claws.
  3. Swap the head for the photoscanned deer skull, with antlers from the antler scan.
  4. Retexture with grey skin, darker ribs and hair cards hanging off the skull.
- **Shapeshifter**, about 2 days:
  1. Start from the *Man Hybrid* body. Re-pose the shins to a digitigrade bend in A-pose, so the auto-rig sees long
     feet.
  2. Add a canine skull: a CC BY coyote or wolf skull scan, with the skin wrapped over it.
  3. Add hide patches as an alpha-cut layer with fur cards, plus a tail on two or three added bones.
- **Banshee**, about 2 days:
  1. Start from the *Ghost Woman* body. Lengthen the arms ×1.3 and thin the limbs.
  2. Add a jaw bone with sculpted inner-mouth geometry so the mouth can open too wide.
  3. Add white hair cards and a tattered shroud mesh (alpha-cut texture).

Mixamo characters as a base: easy to rig (they already are), but their 2013 textures and topology cap the realism.
Use them only for the stand-ins.

---

## Animation plan per monster

All three go through the same backbone:

1. Mixamo auto-rig gives the standard skeleton.
2. `bun scripts/playerb/characters.ts` with `mixamo.py` re-aims the rest poses and outputs a GLB with WebP textures.
3. Clips come from the shared `anims.glb` (Mixamo, UAL and CMU, retargeted offline).
4. Monster motion is layered procedurally at runtime.

| Monster | Clips (Mixamo unless noted) | Procedural layers |
| --- | --- | --- |
| Wendigo | *Mutant Walking*/*Run*/*Idle*/*Roaring*/*Swiping*, *Zombie Walk*. Slow playback (0.6–0.8×) for weight at 3 m | Foot IK to the ground; head tilt and slow look-at toward the player; antler sway (rigid on `Head`, so free); hip-ratio scaling already handles the height; breath swell on the ribcage via a blend shape |
| Shapeshifter | *Sneak Walk*, *Crouched Walking*, *Crouch Idle* (human phase); *Running Crawl*, *Zombie Crawl* (all-fours dash); *Zombie Scream*. Optional CMU dog-like crawls | Offline heel-lift and IK correction for the digitigrade legs; twitchy head snaps (per-bone noise on `Neck`/`Head`); tail spring bones; an "almost human" mode that blends from upright to hunched |
| Banshee | Idles and reaches (*Zombie Idle*, *Zombie Attack*, *Reaching*), *Zombie Scream*; optionally the Fab *Classic Female Ghost* pack (112 clips) retargeted | Floating: lift the root, add a slow bob, damp leg motion toward a dangling pose; shroud and hair in a vertex shader (noise wind plus velocity drag) or verlet strands; jaw bone opening past its natural limit on scream; arm IK reaching for the player |

## Next steps (in order)

1. **Today, no spend.** Convert Mixamo Parasite, Vampire and Zombiegirl stand-ins plus the creature clips with the
   existing pipeline, so AI, behaviour and audio work can start. Add a temporary antler mesh to the Wendigo stand-in.
2. **Kit:** create a Meshy account. The free plan gives CC BY output, which is fine because we credit it. A month of
   Pro ($20) gives private output and API access. Run each `*-apose.png` 2–3 times and keep the best result.
3. Blender cleanup per monster, as described in §3 and §5. Write it as a script next to `scripts/playerb/` so it is
   reproducible.
4. Mixamo auto-rig each cleaned mesh. Add the Wendigo's antlers, the Shapeshifter's heel-lift pass and tail bones, and
   the Banshee's jaw bone and separate shroud. Run the meshes through `mixamo.py`.
5. Fallback if image-to-3D disappoints: fetch the Objaverse CC BY bases with `fetch-models.ts`-style code and kitbash
   them (§5). Record the credits in `CREDITS.md`.
6. Optional: buy the Fab *Classic Female Ghost* animation pack if the Banshee's motion needs mocap quality.
