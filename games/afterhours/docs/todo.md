# Afterhours: open items

## Player body (from Aiden, 2026-10-17): do after the current agents wrap up
- Hands look broken most of the time; arms and legs are janky; he doesn't walk or run like a normal person.
- Plan: build an interactive body lab (third-person orbit view, gait/IK/hand-pose knobs, slow-mo, side-by-side with mocap
  reference) so Aiden can iterate on the body with the coordinator directly. Consider the repo's
  `procedural-animation-iteration` skill and the shared rig docs (docs/animation.md, docs/human-rig.md).
- Don't delegate until Aiden says to start.

## Interior-side stair house overlaps (from facility audit, forward to kit agent when its audit round finishes)
1. core.ts stairWalls()/buildSlabs(), "interior:core" painted_wall: doubled linings at z=16.05 (1.99 m²), x=-43.25 (1.47 m²), back wall z=24.95 around x -43.25..-40.27; emit each face once.
2. core.ts: painted lining at z=16.2 (x -43.45..-40.25, y 18.85+) coplanar with facility tower north wall inner face: move to z=16.205 or drop.
3. lift.ts buildLift(), "interior:lift-shaft": doubled linings x=-36.15 and z=24.948/24.95 (2.7 m²); z=19.45 / x=-36.15 vs core concrete_wall (~2 m²): one owner.
4. core.ts hall()/lobby(): doubled faces x=-36.15 (z 16.05..19.45) and z=16.05 (2.5 m²).
5. core.ts flights()/step(): tread ends at x=-39.7 flush with stair wall (76 pairs): stop treads 5 mm short; treads/landings at y 15.36, z 20.62/18.94 coplanar with lining.
6. lift.ts "lift-counterweight": doubled frame faces at x=-38.7.
7. Lift shaft is visible from the roof stair house (Aiden): enclose the shaft (walls, machine room/headhouse top, lift doors at roof level or solid wall), make the core read as a proper stair + lift lobby, not an open shaft. Audit the whole lift: car, doors, shaft walls per storey, top/bottom, counterweight, cables.

## After all storey agents finish: integration audit (Aiden: "fell through most floors")
- Floor coverage test: sample every storey on a 0.5 m grid inside the shell; every point not inside a collider must have a walkable floor at storeyY(i)+0.16 (and stair/lift/core). Report holes per storey.
- Scripted walk: every corridor, every openable room, stair ground to roof, lift every storey, fire escape, roof.
- Doors check --all, overlap audit, flicker map per storey, boot profile, frame ms per storey.
8. Wall seams/gaps (Aiden screenshots): hairline vertical gaps between wall segments on room walls (light leaks through), and wall corners where two partitions meet leave a visible gap/notch with a lighter strip and a hole at the ceiling: partitions must overlap/butt fully, corners closed, tops meet the ceiling grid. (The 2 mm wall-end recess may be causing visible slits: replace with proper overlap.)
9. Core hall to lift (Aiden): the opening from the spine into the core hall/lift lobby is a narrow slot (~1 m) with walls that don't line up (tile band on one side, chair rail on the other, offset faces). Make it a proper wide lift lobby opening (≥ 2.4 m, cased, consistent finish turning the corner), lift call button on the lobby wall beside the lift doors.

## From storey 4 agent (forward when owners are free)
- Kit: `doorway()` option for barricaded/no-hardware locked doors (4-14 used door()+registerDoor() directly).
- Kit/lighting: corridor sconces light neighbouring room ceilings through the wall: point away from the wall / shorter range (lamps should be clipped by walls).
- Kit: hoarding with a door, plastic sheets along x, wall tarps on any wall; promote s4's milky plastic material to the kit.
- Documents: handwritten "DO NOT DISTURB — R.H." note; spray-paint "DO NOT DEMO — SEE DIRECTOR".
- Program conflict: W-1 riser is inside 4-11, not behind the 4-01 "DO NOT DEMO" panel: update building-program.md or move the vignette.
- Re-run s4 doors-check now that resetMotion is fixed (`--only s4: --at <x>,15.4,<z>`).

## From storey 1 agent
- Kit: officeSet desk orientation wrong (office_desk drawer side is -Z front; person should sit on the front side).
- Kit: cubiclePod option to leave chairs out / lighter chair (chair cap 40).
- Kit: Builder path to put procedural props on the small-prop layer (b.small).
- Kit: export a carpet variant; PGlazed.blinds draws nothing; option to drop padlock on locked doors (vault, 4-14).
- Kit rules: the "10 rules" live in the kit agent's report, not in kit.ts: add them to the kit.ts header.
- Re-shoot s1 bullpen/fishbowl (shots predate a grid-index fix); re-run s1 doors-check now that resetMotion is fixed.

## From storey 2 agent
- Kit: plan.ts windows straddle the zone line (west face z -12.45..-9.15, east z 9.15..12.45): add a note/helper (s1 and s2 both had to shift walls).
- Kit: spine bulletin() only correct on south-facing walls (north side ends up inside the wall).
- Kit: settle the chair-facing convention (model notes -Z, officeSet +Z, conferenceTable -Z); export chairYaw.
- Kit nice-to-have: pedestal eyewash, freestanding drench shower, softer closed blinds, less boxy fume hood.
- Gameplay: sub-room ids (2-02b, 2-07b, 2-10b) need to be in the room registry.
- Re-capture s2 microbiology UV and containment isolator after brightening.

## From storey 3 agent
- Kit: services.ts chase wall east face (x -36.075) has toilet tile to z 16.05; north of toilets (z > 9.6) should be room finish.
- Kit: room() should pass troffers.perLamp.
- Assets: screen rectangle metadata for crt_terminal/television so "on" screens can overlay.
- Kit: officeSet chair faces away from desk (also reported by s1/s2).
- Doors-check: "E closes it" flaky under load.
- s3: landmark (machine-room glass wall from stair hall) reads dimly; terminal pool sparse; re-capture machine room/spine/pool after late changes.

## From storey 0 agent
- Kit: room() extra openings in facade lining (doors/dock openings).
- Kit: bulletin() only faces -z (spine bulletins wrong on north wall): also from s2.
- Doors: pair-door focus picks the far leaf (0-35f, 0-35, 0-39 far side).
- Kit: shared bulkhead fixture; screen variant taking custom node materials (CCTV, slide, TV static); lift-gate primitive registering real leaves for FL-1; FL-1 moving car (later: Sublevel).
- Kit: retire lobby.ts/corridor.ts/rooms.ts/placeProps/storeys.ts/furnish.ts once kit no longer imports from them.
- s0: time-clock and FL-1 areas too dark to read vignettes; emergency pack by core door.

## For the integration audit
- FL-1 gates now unblocked on the facility side but untested (locked → skipped): test them unlocked via a temporary unlock in the check.
- Behind the shut roll-up: floor drops from dock height 1.25 m to receiving 0.15 m with no ramp/leveller: interior s0 should add a dock leveller/steps.
- Re-run the overlap audit on the stair-tower slot.

## Dock / receiving bay (Aiden, facility owner: send after the hygiene round)
- Opening the roll-up: a pale flat panel still fills the opening (curtain visual or a fake emissive "bay glow" card) while the player can walk through it. Open = see into the bay; closed = opaque curtain, can't see in. Curtain mesh must follow the door state exactly; remove any fake glow card in the opening.
- Inside the bay: a random free-standing glowing slab (the emissive orange "self-glow" panel added to fake bay light) and a black post; no proper door into the building. Rebuild the bay as a real receiving bay: block walls, real lamps (no emissive cards), a proper steel personnel door + the interior's dock leveller/steps into s0 receiving (0-16), coherent with s0's receiving room. Remove the self-glow hack now that real lights work.
- Dock man door (Aiden screenshot): door leaf/opening shows a flat translucent grey-green plane filling the doorway (looks like fog/glass card), with a sliver of orange bay visible above it at an angle: leftover fake "bay glow"/glass card or wrong leaf material/transparency; the leaf must be opaque painted steel, and the opening shows the real space behind.
- Dock steps (Aiden: "stairway's all fucked up"): the 3 concrete steps up to the dock are floating slabs: risers don't reach the tread below / ground (stepped gaps, slabs overhanging), handrail post goes through the top tread edge, rail ends in mid-air and kinks oddly, posts don't land on treads. Rebuild as solid cast-in-place concrete steps (solid mass to the ground, consistent rise ~0.17 and going ~0.28 to the dock's 1.25 m: ~7 risers, or a ramp), with a code-compliant pipe handrail (posts on treads, continuous rail, returns at ends).

## Ownership decision (coordinator): receiving bay
- Interior (s0 receiving 0-16) owns everything inside the main-block shell, including the space behind the roll-up doors: walls, floor at dock height + leveller/steps, lights, the personnel door into receiving. Facility drops its own bay (walls, floor, roof slab, lamps, glow cards) and keeps only exterior: dock platform, roll-up door assemblies (curtain follows state, no fake cards), exterior personnel doors, steps, canopy.
- Interior follow-ups (after hygiene round): build the receiving bay behind both roll-ups at dock height 1.25 with leveller/steps down to 0.15; fix wall faces at z=-21.65 (s1 vs bay roof slab: moot once facility drops it); offset lift shaft/core walls 5 mm off tower walls at x -43.1/-36.3, z 24.85; door-main-west--10 stalls 1.1 m inside (interior collider); apply text-stand-ins.md.
- Interior: s0/west.ts:277 board_dosimeter normal should be [0,0,-1] at z≈-14.152 (sign faces wrong side). Audit all document placements: any sheet showing blank (back face) from the room it belongs to has a wrong normal; hygiene gate should flag documents whose front faces into a wall/void.
- decalBias: replace hard-coded negative polygonOffset with `decalBias(material)` (materials.ts) in: facility/windows.ts:103–105 (facility, after dock round); interior/props.ts:16–18, finishes.ts:41–43, washroom.ts:58–60 (interior, after hygiene round). roads/util.ts optional.

## Integration audit results (docs/integration-audit.md): dispatch
- CRITICAL interior: kit wall() gives no collider to the strip above a door opening; storey-4 shaft walls continue past the roof → walk into the lift shaft from the roof lift lobby (-37.9, 19.15, 17.5) and fall. Fix wall() (collider over door heads) + lift.ts.
- HIGH interior: roof stair landing open edge (west half south of z 18.66 drops 3.3 m): balustrade + collider (core.ts landing()/railings()).
- HIGH facility: fire-escape flights 0.63 m between guard colliders vs 0.60 m body → can't descend. Widen flights (≥ 0.9 m clear) / FIRE_ESCAPE.depth (coordinator owns layout: ask).
- MEDIUM dock: s0 receiving steps climb into facility bay wall (moot once facility drops the bay); leveller behind shut roll-up 1.1 m deep ends at FL-1 car wall: FREIGHT (x -36.85..-33.25, z -20.5..-15.5) overlaps the west roll-up span: interior to propose a new FL-1 position (coordinator edits layout).
- MEDIUM: west façade door z≈-10 one-sided; roof floor gap 0.13 m² near lift lobby (interior/facility).
- Overlaps: s4 corridor linoleum laid twice; fire-escape treads vs nosings; 2 door frames flush with reveals; s3 poster in wall plane; W-1 riser floor/ceiling.
- Perf: outdoor draws 1190–1370 (was 475); s0 52 lamps, s3 51 (budget 48); boot 7.0 s normal, 24–30 s at 4×.
- Interior (dock): build a dock-height (1.25 m) platform/leveller inside the north wall x -37..-23.2, ~1.5 m deep, behind all three dock doors, with steps/ramp down to receiving 0.15; resolve FL-1 overlap (propose new FREIGHT position). A bright flat panel fills the dock man-door opening from the interior side: find and remove.
- Doors: fully open roll-up (bottom edge ~3.55 m) can't be targeted from inside to close: doorway-plane targeting for slides should cover it (doors agent), else facility lowers open height.
- Facility: duplicate 'facility-details:pine_needles' ground in src/world/facility/grounds.ts (drawn twice): remove; also switch windows.ts:103–105 to decalBias.
