# Mixamo licensing for Afterhours

Researched 2026-10-18. I'm not a lawyer, and this is not legal advice. Everything below comes from Adobe's published
terms and public Adobe forum answers. If we need certainty, ask Adobe in writing (see the end).

**Question.** Can we use Mixamo stock characters (Remy, Louise, James, Megan, Kate) and Mixamo animations in
Afterhours when the source is a public GitHub repo (`anomalyco/arcade`) and the game is a public website, so the
browser downloads the assets? The original plan keeps raw FBX files out of git and commits converted `.glb` files
(mesh and baked clips) to `games/afterhours/public/models/player/`.

**Short answer.**

- Using the characters and animations in a free or commercial web game is clearly allowed. No royalties and no
  attribution are required.
- Committing the converted GLBs to a public repo is a grey area that leans toward not allowed. Adobe permits
  distribution only "in connection with" the game, never "on a stand-alone basis". A public repo puts each file
  online for anyone to download, apart from the game.
- Recommendation: keep Mixamo-derived files out of the public repo, store them privately, add them at build time,
  and serve them only as part of the game (option b).

## 1. The authoritative terms

### 1.1 Adobe General Terms of Use (this is the contract)

<https://www.adobe.com/legal/terms.html>. Published October 3, 2025. Effective October 3, 2025. The current text
was fetched from <https://www.adobe.com/cc-shared/fragments/legal/terms-existing> on 2026-10-18.

Mixamo content counts as "Content Files", meaning Adobe assets provided as part of the Services. The key clause is
§3.6:

> **3.6 Content Files.** "Content Files" means Adobe assets provided as part of the Services and Software. Unless
> documentation or specific licenses (including but not limited to Product Specific Terms) state otherwise, we grant
> you a personal, non-exclusive, non-sublicensable (except if you are a Business, then sublicensable only to your
> Business Users), and non-transferable license to use the Content Files to create your end use (i.e., the
> derivative application or product authored by you) into which the Content Files, or derivations thereof, are
> embedded for your use ("End Use"). You may modify the Content Files prior to embedding them in the End Use. You may
> reproduce and distribute Content Files only in connection with your End Use, however, under no circumstances can
> you distribute the Content Files on a stand-alone basis, outside of the End Use.

The terms' own plain-language summary of §3.6 says: *"You have the right to use the content or assets that we make
available to you. You can even change or modify this content in your work."*

Other clauses that apply:

- **§3.2:** *"We (and our licensors, as applicable) remain the sole owner of all right, title, and interest in the
  Services and Software. ... We reserve all rights not granted under the Terms."* Adobe keeps ownership of the
  converted GLB, because a GLB made from Adobe files is a derivation and does not become ours.
- **§3.5 Sample Files.** This clause covers tutorial or demo files, which is not how Mixamo labels its content. Its
  wording shows how Adobe thinks about "stand-alone": *"You cannot distribute Sample Files in any way that allows a
  third party to use, download, extract, or access the Sample Files as a stand-alone file."*
- **§6.5:** Don't *"construct a database or dataset using, including, or comprised of the Adobe Content Files for
  the purpose of reverse engineering"*.
- **§6.18:** No *"data mining or similar data gathering and extraction methods ... including data scraping for
  machine learning"*.
- **§17(C):** Don't *"use the Services or Software, or any content, data, output, or other information received or
  derived from the Services or Software, to directly or indirectly create, train, test, or otherwise improve any
  machine learning algorithms or artificial intelligence system"*.
- **§1.2:** Product Specific Terms override the General Terms when they conflict. The current §1.2 list includes
  Fuse but not Mixamo. The standalone Mixamo Additional Terms below are still published.

### 1.2 Mixamo Additional Terms (Mixamo-specific contract)

<https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf>. "Effective as
of June 23, 2021. Replaces all prior versions." The whole document is one clause:

> 1. Restriction on AI/ML. You will not, and will not instruct or allow third parties to, use the Services or
> Software (or any content, data, output, or other information received or derived from the Services or Software) to
> directly or indirectly create, train, test, or otherwise improve any machine learning algorithms or artificial
> intelligence systems, including, but not limited to, any architectures, models, or weights.

It says nothing about redistribution, so §3.6 of the General Terms decides that question.

### 1.3 Adobe Help Center: "Mixamo | Common questions"

<https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html>. The page says "Last updated on Sep 14, 2021". The live
page returns 403 to scripts, so the quotes come from the Wayback snapshot of 2026-01-05:
<https://web.archive.org/web/20260105134624/https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html>

> Mixamo is available free for anyone with an Adobe ID and does not require a subscription to Creative Cloud.
> Mixamo is not available for Enterprise and Federated IDs.
>
> You can use both characters and animations royalty free for personal, commercial, and non-profit projects
> including: Incorporate characters into illustrations and graphic art. 3D print characters. Create films.
> **Create video games.**

This is the official FAQ. It treats stock characters and animations the same way, and it doesn't mention
redistribution, open source or the web.

### 1.4 "Mixamo FAQ - Licensing, Royalties, Ownership, EULA and TOS" (Adobe Community, pinned)

<https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400>. Posted
September 29, 2022 by **TylerG 3D**. This account answers as Mixamo ("we certainly wouldn't turn it down") and wrote
the pinned FAQ. The forum no longer shows an "Adobe Employee" badge on it, so treat this post as Adobe's stated
intent, not as contract text.

> Mixamo online animation services are currently in a limited duration technology preview, and during that preview
> they are available for free, with no licensing or royalty fees, for unlimited commercial or non commercial use. You
> can use the auto-rigger, characters and animations in any type of creative project. Adobe retains the rights to
> our software and content, you retain the rights to your designs and creations and how the content is used.

| **YES, you can create...** | **NO, you cannot create...** |
| --- | --- |
| Video Games | Blueprints, templates, or asset packages for video game engines which redistribute character or animation raw files as the product |
| DLC or Addon Content for Games | Packages for 3D stock or asset store websites where character or animation raw files will be sold or distrubuted |
| Movies/Videos, Illustrations and Prints, 3D Prints, Merchandise | **Any type of free distribution of character or animation raw files** |

> **Distribution of Files.** As you can see above, really the only thing you can't do is distribute the raw
> character and animation files. To be clear this does not include collaborating on team-based projects. If you
> download an asset for a team then all members of that project team may access and use the file. You may not
> distribute the files to customers or non-team members however.

> **Can I use Fuse and Mixamo for non-profit, commercial, research, or school projects?** Yes to all. ... The only
> research application Mixamo content can't be used in is training machine-learning models.

> **Do I have to give Adobe, Mixamo, or Fuse credit in my project?** No. ... you're certainly welcome to, but are
> not required to.

> **If I use Mixamo animations and characters for free now then they become paid will I have any costs?** No. Your
> use of Mixamo and its content is covered under the terms at the time you use it.

### 1.5 Other answers from the same Adobe representative

- 2021-02-09, <https://community.adobe.com/questions-696/mixamo-characters-for-commercial-games-589934>: *"you can use
  the characters and animations in any commercial project, as long as they are embedded and you are not selling only
  the characters or animation data."* This was in reply to a question about using the ready-made stock characters.
- 2021-07-19, <https://community.adobe.com/questions-696/mixamo-character-and-animation-use-590037>: *"Mixamo
  characters and animations can be used completely royalty-free in any commercial project (especially games!), the
  only thing that is not allowed is re-selling Mixamo assets, or bulk downloading all Mixamo content to use for
  machine learning applications."*
- 2022-09-28, <https://community.adobe.com/questions-696/the-license-to-use-mixamo-589394>: *"as long as you're not
  selling the character or animation data exclusively ... A good question to ask is 'Is this competing with
  Mixamo'."*

The answer marked correct in the 2021-07 thread is from a volunteer ("Legend" badge, not Adobe). It explains the
extraction question well, but it is only an opinion: *"if you allow people to download the assets from this game
i.e, just the models or animations then yes that does violate the licence ... while its true skilled coders can
still extract models from your game but that is not a violation because its not designed to allow that so as long as
you don't make it easy (press here to get the model in Obj etc) then you are covered"*.

### 1.6 How the terms apply to each question

| Topic | What the terms say | Status |
| --- | --- | --- |
| Royalty-free use in a free or commercial game | FAQ: "Create video games"; §3.6 End Use | **Clearly allowed** |
| Attribution | Not required (community FAQ) | Optional, but recommended |
| Modification (retarget, trim, bake, meshopt, re-texture) | §3.6: "You may modify the Content Files prior to embedding them in the End Use" | **Clearly allowed** |
| Web delivery: the browser downloads the GLB to run the game | Distribution "in connection with your End Use". Every web game must send its assets to the client | **Allowed** in my reading. No published Adobe text addresses the web specifically |
| Players extracting assets with devtools | Not addressed in the contract. The forum says it's fine if we don't help them | Allowed. Don't add download or export buttons |
| Standalone distribution: an asset pack, a "download model" link, raw FBX or GLB for others to reuse | §3.6: "under no circumstances ... on a stand-alone basis"; community FAQ: "any type of free distribution of ... raw files" | **Clearly not allowed** |
| Committing converted GLBs to a public, unlicensed GitHub repo | The files can be downloaded, cloned and forked apart from the game. A GLB with skin and clips can be reimported, so it is close to a "raw file" | **Grey, leaning not allowed** |
| Sharing raw files within the team | Allowed: "all members of that project team may access" | Allowed (private storage) |
| Any AI/ML training, testing or evaluation with the clips | Mixamo Additional Terms §1; General Terms §17(C) | **Clearly not allowed** |
| Stock characters vs. animations vs. our own auto-rigged characters | The official FAQ treats stock characters and animations the same. For an uploaded character, the mesh stays ours, but the rig and weights are service output and every animation clip is still an Adobe Content File | Same rules for stock characters and clips. Lower risk for our own meshes |
| Terms changing later | "covered under the terms at the time you use it" (forum) | Record the download date and the account used |

## 2. What other projects do

| Project | What it ships | How it handles licensing | Status |
| --- | --- | --- | --- |
| **three.js** (`mrdoob/three.js`, MIT, very widely used) | Mixamo-derived files committed in `examples/models/gltf/` (`Xbot.glb`, `Xbot.blend`, `Soldier.glb`, `Michelle.glb`) and `examples/models/fbx/` (`mixamo.fbx`, `Samba Dancing.fbx`), served on threejs.org/examples | No licence file for them. `examples/models/fbx/README.md` only lists `nurbs.fbx`. The example pages credit the source: "Soldier model from mixamo.com", "(model from mixamo.com)", "Character and animation from Mixamo". | Has shipped them for years with no known action |
| **Babylon.js Assets** (`BabylonJS/Assets`) | A whole `mixamo/` folder: standalone character GLBs (`Big Vegas.glb`, `Ch14_nonPBR.glb`, ...) and animation GLBs (`Walking.glb`, `Hip Hop Dancing.glb`, ...), plus `meshes/Xbot.glb`. It is an asset CDN | `mixamo/license.txt` says only: "All files in this directory and sub-directories are coming from https://www.mixamo.com/." | This is closer to the "free distribution of raw files" Adobe prohibits. No known action |
| **Unity-Technologies/VisualEffectGraph-Samples** | Mixamo animations in a public sample repo | `LICENSE-3rdParty.md` reproduces the Mixamo Additional Terms (AI/ML clause) | No known action |
| **gridaco/grida** | `samba.glb`, converted from the three.js `Samba Dancing.fbx` | `SAMBA-LICENSE.md` cites General Terms §3.6, the AI/ML terms, says the project's own licence "do[es] not relicense this content", and bans standalone downloads and use in AI datasets | This is the most careful notice found. Its approach is the model for ours |
| **Eelta/FreeClimb** (Skyrim mod, GPL) | Converted HKX clips only in the release archive | `docs/MIXAMO-LICENSE.md`: the GPL covers the code only, and "Original FBX files, character meshes ... are excluded from the release archives. The source archive contains code and documentation rather than animation data." | This is the pattern recommended in option (b) |
| armory3d examples, norrischiu/DEngine and many Unity or Godot hobby repos | Committed Mixamo FBX or GLB files | At most a one-line credit ("Using YBot rig by mixamo.com", "Characters from Adobe Mixamo") | Common practice; no known action |

**Enforcement record.** On 2026-10-18 I cloned GitHub's public DMCA notice archive (`github/dmca`, 22,380 files). Not
one notice mentions Mixamo. The Adobe notices there concern software and fonts. I found no reports of Adobe takedowns
over Mixamo assets in public repos or web games, and no Adobe staff answer about public source repos specifically.

**Conclusion.** Public repos with committed Mixamo assets are common, including the biggest web-3D projects, and
Adobe does not appear to act against them. That shows low enforcement risk. It does not show that the use is
licensed, and the contract text has not changed to allow it.

## 3. Options and risk

### (a) Commit converted GLBs to the public repo and serve them on the site

- **Contract compliance: grey, leaning not allowed.** Each GLB would be downloadable from GitHub with no connection
  to the game, by anyone, forever. The GitHub raw URL, `git clone` and forks all work. A GLB with the mesh, skin and
  named clips is directly reusable. That is the "stand-alone basis" §3.6 forbids, and the community FAQ's "any type
  of free distribution of ... raw files". Converting from FBX to GLB doesn't change this, because §3.6 covers
  "derivations thereof".
- **Enforcement risk: low.** three.js and Babylon.js already do this, and there are no takedowns on record.
- **Practical risk: high and can't be reversed.** Removing the files later means rewriting git history, and forks or
  clones keep copies anyway. The repo has no LICENSE, so it grants nobody any rights. Even so, a later open-source
  licence would wrongly appear to cover these files.
- **AI/ML:** a public repo invites scrapers. The terms make us responsible for not allowing third parties to use the
  content for ML. That is a thin argument, but it counts against (a).

### (b) Keep converted assets out of the public repo, store them privately, inject them at build, and serve them only from the game (recommended)

- **Contract compliance: allowed** in my reading. The files are copied and distributed only as part of the running
  game, which is exactly the End Use in §3.6. Raw FBX and source GLBs stay with the team, which the FAQ allows.
- **Enforcement risk: very low.** This is the same as any shipped game. Players can still pull the GLB out with
  devtools, as they can from any web, Unity or Unreal game. Adobe's forum answers treat that as acceptable.
- **How to do it**, following the existing `bun scripts/fetch-models.ts` pattern:
  - Put the optimised GLBs (and raw FBX, in a separate prefix) in a **private** R2 bucket, or a private repo or
    submodule.
  - Commit only a manifest (file names and SHA-256 hashes) and the conversion script. Add
    `games/afterhours/public/models/player/mixamo/` to `.gitignore`.
  - In CI, before `build`, run a fetch step with a read-only token stored as a GitHub Actions secret. Locally, use
    the same script with a developer token.
  - The game must still run without the files: fall back to the CC0 `janitor.glb` body when the Mixamo assets are
    missing. Contributors and forks without access get a working build, and `bun run verify` and smoke tests on
    machines without the token don't break.
  - Serve the files from the game's own asset path (`/arcade/afterhours/...`). Don't add a directory listing, a
    model viewer with "download" or "export", or open CORS headers. Lab stations may display the characters but must
    not offer export.
  - Use one Adobe ID (a personal one, since Mixamo excludes Enterprise and Federated IDs) to download for the team.
    Record the account, the date and the asset list in the private bucket's README.
- **One caveat:** whatever the build emits ends up in `dist/` and in the deployed Worker assets. That is fine, as long
  as nothing containing these files is committed. As of 2026-10-18, `.gitignore` already ignores `dist` and
  `games/afterhours/captures/`.

### (c) Avoid Mixamo stock characters

- **(c1) Our own CC0 MakeHuman or MPFB character plus Mixamo animations.** The character is clean. Every Mixamo
  **clip** is still an Adobe Content File under the same §3.6 rule. Committing baked clips to the public repo is the
  same grey area as (a), only smaller. Use the (b) pipeline for the clips. It's lower risk than stock characters
  (less recognisable, no Adobe-authored art), but not risk-free if committed.
- **(c2) Our own mesh uploaded to Mixamo's auto-rigger.** We keep the mesh ("you retain the rights to your designs").
  The skeleton and skin weights are service output that Adobe hasn't clearly addressed, and the animations still fall
  under §3.6. Same verdict as (c1).
- **(c3) No Mixamo at all.** Today's body uses MakeHuman CC0, Quaternius UAL CC0 and 100STYLE CC BY 4.0. That is the
  only option with zero Adobe constraints, and it's the only one where committing everything to the public repo is
  clearly fine.

### Summary

| Option | Contract | Enforcement | Reversible? |
| --- | --- | --- | --- |
| (a) commit GLBs, serve | Grey, leaning not allowed | Low | No (git history and forks) |
| (b) private storage, build-time inject, serve | Allowed | Very low | Yes |
| (c1/c2) own character, Mixamo clips committed | Grey (clips only) | Low | No |
| (c1/c2) own character, Mixamo clips via (b) | Allowed | Very low | Yes |
| (c3) no Mixamo | Clean | None | — |

## 4. What to add whatever we choose

1. **A notice next to the assets.** Add to `games/afterhours/public/models/player/CREDITS.md`, and to the private
   bucket's README, something like:

   > Characters (Remy, Louise, James, Megan, Kate) and animation clips in `mixamo/` are © Adobe, from
   > https://www.mixamo.com, used under the Adobe General Terms of Use §3.6 (Content Files, effective 2025-10-03) and
   > the Mixamo Additional Terms (2021-06-23). They are embedded in Afterhours only. They are not covered by any
   > licence of this repository and may not be extracted, redistributed standalone, or used to create, train, test
   > or improve any AI/ML system. Downloaded <date> by <account>.

2. **An in-game or landing credit line** (optional, but Adobe welcomes it): "Characters and animations: Adobe Mixamo".
   The existing 100STYLE CC BY credit is still required.
3. **AI/ML hygiene.** Never feed Mixamo clips into learned models. That includes pose-estimation evaluations, motion
   matching with learned features, and the "pose-diff against mocap" benchmarks if those ever involve ML. Keep Mixamo
   files out of `notes/` and any dataset exports. The deterministic animation scripts in
   `games/blackout/scripts/animation/` aren't ML, but keep Mixamo clips out of anything published from them.
4. **A repo LICENSE carve-out.** If `anomalyco/arcade` ever gets an open-source licence, exclude third-party assets
   explicitly ("Assets under `**/public/models/**` are licensed per their CREDITS.md and are not covered by this
   licence").
5. **No standalone download surfaces.** No asset browser export, no `?download` links, and no publishing a GLB pack
   alongside the game.

## 5. If we need certainty

Neither the official FAQ nor the forum FAQ mentions public source repositories. For a definitive answer, post a
specific question on the Mixamo community board (<https://community.adobe.com/mixamo-694>) or ask Adobe Legal:
"Converted GLBs of stock characters plus clips committed to a public GitHub repo and served by a free web game: does
this count as distribution in connection with the End Use under §3.6?" Until we get a written yes, option (b) is
compliant on any reading of the terms.
