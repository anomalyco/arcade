# Fast Interceptor Boat (`boat`) — Concept Brief

## Overview & Role

The **Mk VII Fast Interceptor** is a 18 m enclosed stealth patrol, light-attack, and utility craft carried aboard the fleet aircraft carrier. Launched either down the stern well-deck ramp or lowered from the port deck-edge elevator, it gives a carrier crew a fast surface element for:

- **Scouting & screening:** racing ahead of the carrier through shallow island channels and reefs to spot enemy ships and torpedoes.
- **Harassing & light attack:** engaging enemy small craft, shore batteries, and low-flying helicopters with its stabilized foredeck autocannon turret.
- **Search, rescue & utility:** recovering downed Hornet and F-35C pilots from the water and capturing coastal objectives.

The vessel is **100% enclosed** with no open cockpit, exposed seats, or visible crew: all sensors and weapons are operated from inside the armored, climate-controlled stealth wheelhouse behind opaque gold-tinted ballistic glass.

## Dimensions & Scale

- **Length overall (LOA):** 18.0 m (hull 17.4 m + 0.6 m stern waterjet nozzles; `z = −9.0 m … +9.0 m`)
- **Maximum beam:** 4.8 m across the midships chine (`x = −2.4 m … +2.4 m`)
- **Draft (below waterline):** 0.9 m (`y = −0.9 m … 0.0 m`)
- **Air draft (above waterline):**
  - Foredeck sheer: 1.55 m (`y = +1.55 m`)
  - Aft working deck: 1.25 m (`y = +1.25 m`)
  - Enclosed wheelhouse roof: 2.65 m (`y = +2.65 m`)
  - Mast & compact surface-search radar top: 3.90 m (`y = +3.90 m`)
- **Carrier compatibility:** At 18.0 m × 4.8 m, two interceptors fit side-by-side in the carrier's stern well deck or on the 30 m × 15.8 m port deck-edge elevator (`shared/carrier-spec.ts`).

## Key Visual & Functional Features

1. **Faceted Deep-V Stealth Hull (`BOAT_hull`):**
   - Sharp wave-piercing bow with flared upper chines, a recessed dark non-skid foredeck and aft deck, and a clean stepped transom.
   - Dark charcoal rub-strake / waterline boot-top with an anti-fouling red lower hull matching `carrier.glb`.
   - Bold **orange team-accent band (`BOAT_accent`, `#ff9a2e`)** along the forward hull sheer/chine and mast cap so team allegiance is readable at a glance from both sea and air.
2. **Enclosed Stealth Wheelhouse (`BOAT_cabin` & `BOAT_glass`):**
   - Low-profile, tumblehome-faceted deckhouse set amidships (`z = −3.2 m … +3.2 m`).
   - Wraparound five-panel **gold-tinted armored glass** windshield and side windows (`BOAT_glass`) set in a dark recessed frame (`BOAT_frame`), matching the gold canopies of the Hornet and F-35C. No interior or crew is visible.
3. **Foredeck Remote Weapon Station (`BOAT_turret` & `BOAT_turret_gun`):**
   - Faceted low-RCS cupola mounted on the raised foredeck (`z = +5.0 m`), with a single long-barrel 25 mm autocannon (`BOAT_turret_gun`) that yaws with the turret and elevates independently.
4. **Raked Sensor Mast (`BOAT_mast`):**
   - Swept-back faceted mast rising from the aft cabin roof with a compact horizontal radar bar and navigation head, capped with team orange.
5. **Twin Vectoring Waterjets (`BOAT_waterjet_L` & `BOAT_waterjet_R`):**
   - Dual heavy-duty waterjet steering nozzles mounted symmetrically at the base of the stern transom (`x = ±1.05 m`), giving high sprint speed and tight turns without exposed propellers.

## Reference Sheets

- `games/carrier/concept/boat-1-hero.png` — 3/4 front view (~25° down) cutting through sunny faceted low-poly turquoise water with a crisp white bow wave and wake.
- `games/carrier/concept/boat-2-turnaround.png` — Orthographic `TOP`, `SIDE` (port), `FRONT`, and `REAR` views on a neutral light-grey studio background at matching scale.
- `games/carrier/concept/boat-3-yaw-strip.png` — 8-angle yaw turnaround (`0°` through `315°` in `45°` steps) in a 4×2 grid at ~25° elevation on small tiles of low-poly water.
- `games/carrier/concept/boat-4-on-carrier.png` — Scale & context shot showing the interceptor launching beside the aircraft carrier.
