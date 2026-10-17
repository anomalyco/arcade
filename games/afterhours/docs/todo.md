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
