# Afterhours: building program (main block, storeys 0–4)

The plan every interior agent builds to. It replaces the current "15 identical 5.4 × 19.9 m tubes per side, a
quarter of the doors openable" pattern (`storeys.ts` `roomsFor`) with a building that has a reason for every room.
Coordinates are world metres (`layout.ts`): +x east, +z south, shell inner faces x −54.65..34.65, z ±21.65; spine
corridor z ±1.6 (room faces at |z| = 1.75). Storey i finished floor `storeyY(i)`; ceiling 3.1 m above it.

Problems this fixes: rooms are all corridor-and-door; ~75% locked; every floor is the same double-loaded spine; lit
windows have no fixture; the storey-2 drench shower stands in a corridor. Rules from here on:

- **Fixtures live where the code puts them.** Eyewash/drench showers inside wet labs, ≤ 3 m from the lab exit, next
  to a sink; slop sinks in janitor closets; drinking fountains in the alcove by the toilets; extinguishers at stair
  doors, exits and lab doors; fire-alarm pulls by every exit.
- **Every lit room has a real fixture and a real `b.lamp`.** One registered lamp per lit troffer pair, per desk/banker
  lamp, per pendant, per hood light. No emissive "on" panel without a lamp within 2 m.
- **≥ 70% of doors openable on every storey.** Locked doors are rare, signposted and have a reason (key, keycard,
  barricaded from inside).

---

## 1. Building logic

**Pine Hollow Station** — Atmospheric Propagation Research Facility, operated since 1979 for the (fictional)
*Interagency Office of Propagation Studies* (IOPS). Public story: ionospheric and low-frequency radio propagation
research, weather data. The 25 m dish on the roof is the station's public face, but it is tilted to point **down at
the ground north of the building**. In 1981 a signal source was found under the north lot. The **Sublevel** (SL) was
dug to reach it, and since then the building's real work runs vertically:

```
roof dish ──feed──▶ 4 Receiver Room ──riser W-1──▶ 3 Listening Room + Computing Centre (logs, analysis)
                                                   │
SL (excavation) ──freight lift FL-1──▶ 0 Receiving + Decon ──▶ 2 Sample Sciences (cores, water, "specimens")
                                                   │
                     1 Program Administration (personnel "rotations", contracts, records of what happened)
```

**Signal comes down, samples come up.** Each floor sees a different part of that.

| Department | Staff (day) | Where | At 3 a.m. |
|---|---|---|---|
| Directorate (Director R. Halloran, deputy, 3 staff) | 5 | 4 east | Director barricaded in his office, lights on |
| Program Administration (contracts, personnel, payroll, records, word processing) | 46 | 1 | empty; one chief left with his coat on the chair |
| Protective Services (security) | 14 (3 at night) | 0 lobby, booth | lobby guard missing, booth guard outside |
| Facilities & Plant (incl. the night janitor, the player) | 12 (2 at night) | 0 west, annex | player's home base |
| Sample Sciences (geochemistry, microbiology, analytical) | 31 | 2 | an experiment still running |
| Instrumentation (sensors for SL arrays, electronics) | 9 | 2 south | bench lamp on |
| Computing & Signal Processing (operators 24/7, programmers, analysts) | 34 | 3 | operator missing, system logged an event at 03:04 |
| Field Operations / Sublevel Program | 16 | SL, ground decon | 6 names marked "SL" on the in/out board, none out |
| Food service, mail, PBX, library | 9 | 0, 1 | gone home |
| **Total** | **≈ 176** | | |

### Structure and circulation

- **Bay grid** (from the facade): the 5.4 m window module. Partitions sit on pier centres
  `G = −54.65 | −47.8 | −42.4 | −37.0 | −31.6 | −26.2 | −20.8 | −15.4 | −10.0 | −4.6 | 0.8 | 6.2 | 11.6 | 17.0 |
  22.4 | 27.8 | 34.65`. Bays B0..B15 lie between them, one window each (centres −50.5 + 5.4·i). Rooms are whole bays
  or half bays (2.7 m), never arbitrary widths.
- **Depth zones** (44 m deep block, so the plan is three zones, not two tubes): *interior zone* |z| 1.75..11.85
  (windowless rooms: WCs, stores, labs support, machine room, conference); *perimeter zone* |z| 12.0..21.61 (window
  rooms). The zone wall at |z| 11.85..12.0 is optional (open plan drops it).
- **Columns** (new, `kit.column`): 0.45 m square plastered concrete at x ∈ {−47.8, −37.0, −26.2, −15.4, −4.6, 6.2,
  17.0, 27.8}, |z| = 11.9. Hidden in partitions where there is one; freestanding in open plan (sightline breakers,
  hiding spots).
- **Fixed per storey (all five, built by the kit agent):** spine z ±1.6 (finish varies; walls can be solid, glazed,
  half-height or absent); core (hall x −42..−38.5 z 1.6..16.2, stair, lift); **service stack** south of the spine:

| Service stack (every storey) | x | z | Contents | Door |
|---|---|---|---|---|
| EL-n electrical | −47.8..−42.15 | 1.75..6.4 | 2 panelboards (`utility_box_b`), `utility_box`, conduit, breaker labels per room, fuse spares | janitor key |
| TC-n telecom | −47.8..−42.15 | 6.55..10.6 | 66-block punch-down board, relay rack, cable ladder | keycard *Comms* |
| WC-M | −36.0..−32.75 | 1.75..9.6 | 2 stalls, 2 urinals, 2 basins, mirror, towel dispenser, floor drain | open |
| JC-n janitor closet | −32.6..−29.4 | 1.75..5.0 | slop sink, mop bucket + wringer, shelves of chemicals, wet-floor signs, radio (r3-07) | janitor key |
| Store | −32.6..−29.4 | 5.15..9.6 | paper towel, toilet roll, spare tubes, ladder | janitor key |
| WC-W | −29.25..−26.2 | 1.75..9.6 | 3 stalls, 2 basins, sanitary bin | open |
| Fountain alcove | spine wall at x −30.9, z 1.6 | — | `drinking_fountain` between the WC doors | — |

  The ground floor's existing CLOSET (−32.6..−29.4, 1.75..5.0) is already JC-0, so the stack lines up.
- **Vertical circulation:** core stair + passenger lift (0–4; lift panel gets a keyed "SL" button, later); west fire
  escape (door at spine west end, every upper storey); **freight lift FL-1, ground ↔ Sublevel only** (new, §0);
  riser **W-1** (x 5.4..6.6, z −4.6..−3.4) from the dish feed through 4 and 3 down to the SL, a locked cupboard on
  every floor stencilled "W-1 — SL TRUNK".
- **Circulation shapes differ by floor:** 0 spine + link + lobby + a decon sequence; 1 spine with open-plan edges
  (the corridor becomes an aisle) and a suite with internal doors; 2 lab suites (support room → lab, internal doors);
  3 glazed machine-room spine + a **racetrack** (second corridor parallel to the spine in the south wing); 4 stud-wall
  grid you can walk through, hoarding, then a carpeted executive corridor.

### Night state (3 a.m.)

| Storey | Spine lighting | Character |
|---|---|---|
| 0 | night circuit: every 2nd troffer, real lamp every 6 m | lived-in, warm accents (security desk, cafeteria vending) |
| 1 | every 3rd louvred troffer | dark open office, isolated desk lamps (concept 01, r2-07) |
| 2 | every 2nd (labs stay lit for safety), a few flicker | cold, clinical; hood light, UV cabinet, red safelight |
| 3 | fully lit beside the machine room, every 3rd elsewhere; cable tray | humming; green CRTs, halon beacons, blinking glass wall |
| 4 west | none: two clamp work lights | dark construction site, plastic sheeting |
| 4 east | wall sconces (incandescent, new fixture type) | warm wood panelling; the Director's door glowing |

Exit signs at every stair/exit door on every storey; twin-head emergency packs at the core and fire-escape doors
(fixture only, off: they light when power fails — gameplay).

---

## 2. Storey plans

Legend for doors: **O** open/ajar · **C** closed, unlocked · **J** janitor key (player starts with it) · **K:x**
keycard x (found in play) · **L** locked (story). Openable = O + C + J. "Lit" lists the real fixtures; anything not
listed is off. Models from `MODELS` in `src/render/models.ts` are in `code`; everything else is procedural (kit).

### Storey 0 — Front of house, security, receiving, food (y 0.15)

Existing and kept: lobby (−9..9, 9..21.65), link, west spine, LAB (becomes 0-17), CLOSET (JC-0). **New: east spine
x 1.6..34.65** (layout request §6). Ground windows east of the lobby currently show fake closed blinds; replace them
with the real rooms below.

| ID | Room | x | z | Fixtures / furniture | Lit at 3 a.m. | Doors |
|---|---|---|---|---|---|---|
| 0-01 | Lobby (exists) | −9..9 | 9..21.65 | reception + guard desk `crt_terminal`, `telephone`, sign-in book, shell chairs, `security_camera` | 1 warm troffer (exists) | entrance pair O; link pair O; W → 0-36 C (was L); E → 0-38 O (was L) |
| 0-02 | Junction landmark | x −1.6..1.6 on north spine wall | z −1.75 | 1979 dish dedication photo, bronze plaque, **floor directory board** (doubles as the in-game map) — the end of the sightline from the entrance | spot from the troffer above | — |
| 0-10 | Staff entrance + time clock | −54.65..−47.8 | −13.0..−1.75 | time clock, card racks, bench, bulletin, coat hooks, `fire_extinguisher` | emergency pack lit (incandescent) | west exterior door C (panic); spine x −52.2 O |
| 0-11 | Health unit | −54.65..−47.8 | −21.65..−13.15 | exam couch, cot, sink + eyewash, scale, cabinet | — | from 0-10 C |
| 0-12/13 | Change rooms M / W | −47.8..−42.4 / −42.4..−37.0 | −14.0..−1.75 | lockers, benches, basins, mirror; yellow coveralls | W: one troffer flickering | spine x −46, −40 C; north to 0-14 C |
| 0-14 | Decon showers (r4-04) | −47.8..−40.0 | −21.65..−14.15 | 4 shower stalls, drench head, floor drains, curb, boot rack, hose reel | 1 troffer (cold) | from 0-12/13 C; east to 0-15 C |
| 0-15 | Clean side / FL-1 lobby | −40.0..−37.0 | −21.65..−14.15 | bench, rubber matting, "SUBLEVEL — DOSIMETER REQUIRED" board, dosimeter rack (2 badges missing) | caged bulkhead (incandescent) | gate to FL-1 **K:sublevel** |
| 0-16 | Receiving & Stores | −37.0..−25.65 (+ −25.65..−20.8 for z < −9.75) | −21.65..−1.75 | dock roll-ups, FL-1 car (x −36.85..−33.25, z −20.5..−15.5; collapsible gate both sides, signposted), `pallet`, `hand_truck`, `steel_shelves`, `cardboard_box`, `drum_steel`, platform scale, foreman's desk + clipboard | 1 troffer + dock sodium through the open roll-up | spine double x −28 O (wedge); FL-1 south gate **K:sublevel** |
| 0-17 | Sample intake lab (existing LAB) + core store | −25.5..−17.0 / −25.5..−15.4 | −9.6..−1.75 / −21.65..−9.75 | lab as built; core store: core trays on `steel_shelves`, sample fridge, intake ledger | lab panel (exists) | lab x −21 O (exists); lab → core store C |
| 0-18 | Reprographics & supply | −15.4..−4.6 | −21.65..−1.75 | 2 copiers, offset duplicator, paper on `pallet`, supply shelving, guillotine | copier ready glow only | spine x −14 C |
| 0-19 | Mail & messenger | −4.6..6.2 | −21.65..−1.75 | pigeonholes, sorting table, mail carts, Dutch door; parcel cage at the window end | — | Dutch door x 3.5 C |
| 0-20 | PBX switchboard | 6.2..11.6 | −21.65..−1.75 | cord board, operator chair, headset, `desk_lamp` | `desk_lamp` (incandescent) + one line lamp blinking (warning, amber) | spine C |
| 0-21 | Building control | 11.6..22.4 | −21.65..−1.75 | fire-alarm annunciator, HVAC panel with chart recorders, master clock, exterior-lighting contactors | panel glow | spine **J** |
| 0-22 | Dry stores + walk-in freezer | 22.4..34.65 | −21.65..−1.75 | can shelving, sacks on `pallet`; freezer box (insulated door, inside bulkhead lamp) | freezer lamp on (seen when opened) | spine C; freezer C |
| 0-30 | Facilities office (player base) | −54.65..−47.8 | 1.75..10.6 | supervisor desk, **key cabinet**, work-order clipboard, radio chargers, `telephone`, `coat_rack` | `desk_lamp` | spine O |
| 0-31 | Facilities workshop | −54.65..−47.8 | 10.75..21.65 | workbench + vise, pegboard, step ladders, spare tubes, fuse stock | 1 troffer | from 0-30 C |
| 0-32 | Service stack | see §1 | | | | EL J, TC K:comms, WCs O, JC J |
| 0-35 | Briefing auditorium + foyer | −36.0..−20.8 / foyer −26.2..−20.8 | 9.75..21.65 / 1.75..9.6 | 40 `stack_chair` in rows, lectern, pull-down screen, slide projector on cart, blackout blinds | **projector beam** (incandescent spot, shadow) on a slide of the north lot with a red circle | foyer double x −23.5 O; foyer → hall pair C |
| 0-36 | Personnel & badge office | −20.8..−9.15 | 1.75..21.65 | counter to the lobby, badge camera on tripod, laminator, ID files, 4 `office_desk` | — | lobby W C; spine x −17 C |
| 0-37 | Guard ready room + armory | 1.75..17.0 | 1.75..8.85 | lockers, `television`, coffee, cot; armory cage at the east end | `television` glow | spine x 5 C; armory **L** (signposted) |
| 0-38 | Security office (r4-08) | 9.15..17.0 | 9.0..21.65 | CCTV wall (6 `television`), desk, logbook, key box, radio base, alarm panel, `security_camera` feed of the dock | `desk_lamp` + monitor glow | from lobby O |
| 0-39 | Cafeteria (r4-03): servery + dining | 17.0..34.65 | 1.75..9.6 / 9.75..21.65 | steam table, tray rail, range + hood, dish pit; tables, `stack_chair`, 3 `vending_machine`, `water_cooler`, `trash_can` | 2 night-circuit troffers + vending glow (3 small lamps) | spine double x 19 O; kitchen x 30 C; annex door (east wall z −8, request) **K:plant** |

Doors ≈ 44; K/L: FL-1 ×2, TC, armory, annex = 5 → **≈ 89% openable**.

Vignettes:
- **Security office**: the guard's chair pushed back, a cigarette burnt to the filter in the ashtray, logbook last
  entry `01:40 — SL freight lift called. No one on camera.` The dock monitor shows the FL-1 gate open.
- **Time clock**: six cards punched IN at 22:58, never out; their slots labelled "SL".
- **Auditorium**: projector fan still running on the slide nobody turned off.

### Storey 1 — Program Administration (y 3.95)

Carpet tiles, beige vinyl wallcovering, veneer doors, louvred troffers (existing `STYLES[1]`). Two open-plan areas
with different furniture eras, a suite with internal doors, glass rooms.

| ID | Room | x | z | Fixtures / furniture | Lit | Doors |
|---|---|---|---|---|---|---|
| 1-01 | Records Center (concept 02) | −54.65..−37.0 | −21.65..−1.75 | 8 rows of `steel_shelves` (N–S aisles), 20 `filing_cabinet`, 2 `filing_cabinet_open`, card catalogue, sorting table, book trucks, counter with Dutch door | one aisle: 3 troffers (2 lamps) | Dutch door x −46 C |
| 1-01v | Classified vault | −54.65..−49.25 | −21.65..−15.5 | combination vault door, steel cabinets | — | **L** "VAULT — TWO-PERSON RULE" |
| 1-02 | Conference A (r2-07) | −37.0..−26.2 | −11.85..−1.75 | glazed corridor wall + vertical blinds, table for 14, `office_chair`, overhead projector, chalkboard, `wall_clock` | — (corridor spill) | glazed O |
| 1-03 | Contracts suite: reception | −26.2..−15.4 | −11.85..−1.75 | 2 secretary desks + typewriters, `coat_rack`, `filing_cabinet` ×4, `telephone` | 1 troffer | spine C; internal doors to 1-05, 1-06 C |
| 1-04..07 | Contracts private offices | 5.4 m bays −37.0..−15.4 | −21.65..−12.0 | each: `office_desk`, `office_chair`, 2 `stack_chair`, `filing_cabinet`, bookcase, `coat_rack`, `telephone`, `desk_lamp`, `radiator`, blinds; 1-04 reached through 1-05 (interconnecting door) | 1-07 Chief: `desk_lamp` | 1-04 C, 1-05 C, 1-06 C, 1-07 O |
| 1-08 | Coffee & copy | −15.4..−10.0 | −11.85..−1.75 | counter + sink, coffee maker (red pilot), fridge, copier, `trash_can` | under-cabinet tube (fluorescent, short range) | cased opening |
| 1-09 | Personnel & Payroll bullpen | −10.0..11.6 (+ −15.4..−10.0 for z < −12; + 11.6..17.0 for z > −14) | −21.65..−1.75 | 24 `office_desk` in 6 × 4 rows facing east, typewriters, card files, magnetic in/out board; corridor wall 1.0 m solid + glazed clerestory to 2.1 m; columns freestanding | — | spine pair x 0 O |
| 1-09f | Supervisor's fishbowl | 11.6..17.0 | −21.65..−14.0 | glass partition, desk, `filing_cabinet`, blinds | `desk_lamp` | glazed C |
| 1-10 | Technical library | 17.0..34.65 | −21.65..−1.75 | 6 `steel_shelves` stacks, reading tables with banker's lamps, card catalogue, microfiche reader, periodicals rack, librarian desk | 1 banker's lamp + fiche reader glow | glass x 19 C |
| 1-20 | Word processing centre | −54.65..−47.8 | 1.75..21.65 | 4 `crt_terminal` stations, daisy-wheel printer under an acoustic hood, `filing_cabinet` | one CRT on (screen lamp) | spine C |
| 1-22 | Supply store | −47.8..−42.15 | 10.75..21.65 | metal shelving, toner, paper | — | J |
| 1-24 | Program Office (cubicle sea, concept 01) | −36.0..22.4 (z > 9.75) and −26.2..22.4 (z 1.75..9.6) | 1.75..21.65 | 9 pods of 4 cubicles (1.55 m fabric panels, L worksurface, overhead bin with task tube, `office_chair`, `telephone`, every 3rd a `crt_terminal`), pods at x −31.0 (z 16.6 only), −21.1, −10.0, 0.8, 11.6 × z 6.2, 16.6; the south spine wall is **removed** from x −26.2 to 22.4: a 1.2 m panel run with planters and a carpet colour change makes the edge | 2 under-bin task tubes + 1 `desk_lamp` | (open) |
| 1-25 | Conference B (SE corner) | 22.4..34.65 | 9.75..21.65 | glazed to the open office, 12-seat table, flip chart, slide carousel, ashtrays | 4 troffers (2 lamps) — keeps the lit SE corner on the facade | glazed O |
| 1-26 | AV store + kitchenette | 22.4..34.65 | 1.75..9.6 | AV carts, `television`, sink counter, fridge | — | C |

Doors ≈ 26 (open-plan has none); K/L: vault only → **≈ 96%**.

Vignettes:
- **1-07**: the Chief's coat still on his chair, briefcase open, phone off the hook on the blotter; a memo:
  "Re: SL rotation — next of kin letters (6)".
- **1-09**: on the in/out board every name is OUT except six on the SL line; a Selectric with a half-typed letter
  "…regret to inform you that…". One chair, of 24, is turned to face the windows.
- **1-01**: one mobile shelving aisle cranked open, step stool, a box "PERSONNEL — SL ROTATION 1981–84" pulled and
  spilt; a roster on the counter with names crossed out in red.

### Storey 2 — Sample Sciences (y 7.75)

Sheet vinyl, epoxy-painted block, steel doors with wire-glass vision panels (existing `STYLES[2]`). Labs are **suites**:
a support room on the spine, the lab behind it, joined by an internal door. Remove both corridor drench showers and
the cross corridor; every eyewash/drench shower is listed below, inside its lab.

| ID | Room | x | z | Fixtures / furniture | Lit | Doors |
|---|---|---|---|---|---|---|
| 2-01 | Chemical store | −54.65..−47.8 | −11.85..−1.75 | flammables cabinets, acid cabinet, ventilated shelving, spill kit, hazard diamond placard at the door, eyewash inside door | — | **K:chemkey** (key in 2-08 lab manager's cabinet) |
| 2-02 | Geochem Lab 1 | −54.65..−42.4 | −21.65..−12.0 | 2 peninsula benches ⟂ windows (`benchRun`), wall bench with sinks, 2 fume hoods on the south wall, `glassware`, `lab_stool`; **eyewash + drench at the internal door** | — | from 2-03 C |
| 2-03 | Instrument room (GC / AA) | −47.8..−42.4 | −11.85..−1.75 | instrument benches, gas cylinders chained, chart recorder spooling paper onto the floor, `crt_terminal` | 1 troffer + recorder lamp | spine O; → 2-02 C |
| 2-04 | Geochem Lab 2 | −42.4..−31.6 | −21.65..−1.75 | glass partition at z −11.9: write-up desks south, 3 peninsulas north; 3 fume hoods; `chemistry_set` ×1; **eyewash + drench inside the spine door** | **one fume hood's light on** (fluorescent inside the hood) | spine x −40 C |
| 2-05 | Microbiology suite | −31.6..−20.8 | gowning/media prep −11.85..−1.75; lab −21.65..−12.0 | gowning bench, coat hooks, small autoclave; lab: biosafety cabinet, CO₂ incubators, 2 `microscope`, centrifuge, sink + **eyewash** | **BSC UV lamp** (violet, warning kind) | spine C; internal C |
| 2-06 | Cold room (4 °C) + freezer alcove | −20.8..−15.4 | −11.85..−1.75 | insulated walk-in, latch handle, sample racks, dial thermometer; −80 °C chest freezers outside it | bulkhead lamp inside (incandescent) | spine C; walk-in C (no inside release knob — horror beat) |
| 2-07 | Specimen archive (r4-02) | −15.4..−4.6 (+ −20.8..−15.4 for z < −12) | −21.65..−1.75 | long aisles of `steel_shelves`: jars in fluid (merged procedural), core boxes, labels by SL depth | one aisle troffer, flickering | spine x −10 C |
| 2-08 | Lab manager + safety office / write-up | −4.6..6.2 | perimeter 2 offices; interior bullpen | lab manager: **key cabinet** (chem store key), MSDS binders; 6 write-up desks | — | spine O; offices C |
| 2-09 | Darkroom + EM room | 6.2..17.0 | darkroom interior; EM perimeter | darkroom: light-trap labyrinth entry, enlarger, trays, prints drying on a line; EM: microscope column, console, chilled-water lines | **red safelight** (incandescent, red) | spine C; EM C |
| 2-10 | Containment lab (r3-04) | airlock 17.0..22.4 / lab 22.4..34.65 | −11.85..−1.75 / −21.65..−1.75 | airlock with decon shower + eyewash; glovebox isolator, pass box; **observation window to the spine x 24..32**; biohazard placard, intercom | isolator lamp (fluorescent) seen through the window | **K:containment** (signposted) |
| 2-20 | Lab safety office | −54.65..−47.8 | 1.75..21.65 | respirators, spill kits, first aid, shower test log, `filing_cabinet` | — | C |
| 2-22 | Gas cylinder store | −47.8..−42.15 | 10.75..21.65 | cylinders chained to the wall, regulator bench | — | J |
| 2-24 | Biochem teaching lab + PPE foyer | −36.0..−20.8 / foyer −26.2..−20.8 | 9.75..21.65 / 1.75..9.6 | 4 island benches, `lab_stool`, sinks; **eyewash at the foyer-side sink, drench by the exit**; foyer: coat hooks, goggles cabinet | — | spine C; foyer → lab O |
| 2-25 | Electronics & sensor lab | −20.8..−4.6 | 1.75..21.65 | instrument benches, scopes, soldering stations, parts drawers, cable reels, a rack of sensor heads tagged "SL-ARRAY 2" | `desk_lamp` on one bench | spine O |
| 2-26 | Lab break room | −4.6..6.2 | 1.75..21.65 | kitchenette open to the spine (cased opening); `vending_machine`, tables, `lounge_chair` ×2, `water_cooler`, ashtrays | vending glow + 1 troffer | (open) |
| 2-27 | Analytical Lab 4 | 6.2..22.4 | 1.75..21.65 | 4 peninsulas, perimeter benches, 2 fume hoods, marble balance tables, glass partition at z 15.6 with write-up desks at the windows, `chemistry_set`, `microscope`; **eyewash + drench at both doors** | 4 troffers south half (2 lamps) + hot-plate glow | spine x 8 O; x 20 C |
| 2-28 | Glasswash & autoclave | 22.4..34.65 | 1.75..9.6 | glasswasher, drying racks, large autoclave, DI water system, floor drain, wet floor | 1 troffer | spine O (propped by a cart) |
| 2-29 | Balance & media prep | 22.4..34.65 | 9.75..21.65 | balance tables, media fridge, pH meters | — | from 2-28 C |

Doors ≈ 30; K: chem store, containment → **≈ 93%**.

Vignettes:
- **2-27**: a hot plate still on under a beaker boiled dry to a brown crust; a kitchen timer stopped at 01:12; note
  "back in 5 — R."
- **2-10**: one isolator glove torn and hanging inside out; tray "SL-14" empty, its lid on the floor.
- **2-20**: the weekly safety-shower test log, signed every week until 3 October, then blank.

### Storey 3 — Computing & Signal Processing Centre (y 11.55)

Anti-static grey vinyl, blue band, raised floor beside the machine room, cable tray in the spine (existing `STYLES[3]`).
The spine's north wall is glass for 24 m (the machine room); the south wing has a second corridor (racetrack).

| ID | Room | x | z | Fixtures / furniture | Lit | Doors |
|---|---|---|---|---|---|---|
| 3-01 | Data control / I/O counter | −54.65..−47.8 | −21.65..−1.75 | job-submission counter + Dutch door, printout pigeonholes with names, card decks, decollator | — | Dutch door C |
| 3-02 | Keypunch room | −47.8..−37.0 | −21.65..−1.75 | 12 keypunches in rows, card-stock boxes, card sorter | — | C |
| 3-03 | UPS & power distribution | −37.0..−31.6 | −21.65..−1.75 | UPS cabinets, battery racks, transfer switch, PDU, **breaker panels for the machine room** (fuse gameplay) | panel lamps | **K:server** "HIGH VOLTAGE" |
| 3-04 | Machine room | −31.6..−4.6 | −11.85..−1.75 | raised floor; glazed spine wall x −30..−6 (existing `machineGlazing`); mainframe row, disk drives, 6 tape drives (reels turning), console, line printer, 2 CRAC units, halon bottles + beacons | **fully lit** (4 lamps) + equipment glow — the floor's landmark through the glass | spine pair x −18 **K:server**; internal to 3-05/3-06 C |
| 3-05 | Tape library | −31.6..−15.4 | −21.65..−12.0 | reel racks (`steel_shelves` + reel cans), tape cleaner, carts | 1 troffer | inside secure zone C |
| 3-06 | Operations console | −15.4..−4.6 | −21.65..−12.0 | consoles facing an internal window into 3-04, schedule board, logbook, coffee, `office_chair` pushed back | console CRT + `desk_lamp` | inside secure zone C |
| 3-07 | Plotter & map room | −4.6..0.8 | −21.65..−1.75 | pen plotter mid-plot, flat-file map cabinets, light table | light table (fluorescent, cool) | spine C |
| 3-08 | **Listening room** (r3-03), under the dish | 0.8..11.6 | −21.65..−1.75 | riser W-1 drops through the ceiling (coax bundle labelled "SL"); reel-to-reel racks, spectrum analysers, strip-chart recorders spilling paper, scopes, headphones, teletype; listening booth 6.2..11.6 × −21.65..−15.0 with an observation window | **single pendant** (incandescent, shadow) + scope glows | spine **O** (propped with a chair) |
| 3-09 | Data analysis bullpen | 11.6..34.65 | −21.65..−1.75 | desk clusters with `crt_terminal`, wall plots and maps, big chalkboard of equations; corridor edge open with half-height file cabinets x 13..33 | 2 `desk_lamp` + 3 CRTs | (open) |
| 3-20 | Operators' rest room | −54.65..−47.8 | 1.75..21.65 | cot, lockers, `television`, coffee | `television` static glow | C |
| 3-22 | Manager, Computing | −47.8..−42.15 | 10.75..21.65 | desk, `desk_lamp`, wall chart | — | C |
| 3-24 | Terminal pool | −36.0..−4.6 (z > 9.75), −26.2..−4.6 (z 1.75..9.6) | 1.75..21.65 | 24 carrels with `crt_terminal`, printing terminals, acoustic couplers; spine edge: 1.1 m wall + glazing | 6 CRTs on (2 screen lamps) | spine x −20, −8 O |
| 3-25 | Programmers' wing (racetrack) | −4.6..34.65 | 1.75..21.65 | cross corridor x 0.8..2.6 (z 1.75..10.45) → inner corridor z 10.45..12.0; perimeter offices on bays −4.6..0.8 … 22.4..27.8 + corner 27.8..34.65 (2 desks each, `crt_terminal`, `filing_cabinet`); interior: forms & tape store −4.6..0.8 (J), print room (line printers) 2.75..11.6, documentation library + help desk 11.75..22.4, supplies 22.55..34.65 | SE corner office: `desk_lamp` + 1 troffer | offices C (two O); print room O; supplies J |

Doors ≈ 30; K: UPS, machine room → **≈ 93%** (the secure zone's internal doors only open once you're inside).

Vignettes:
- **3-06**: operations log `03:02 SL link up` · `03:04 — ???` in a shaking hand; the operator's chair pushed back,
  headset dangling.
- **3-08**: chart paper on the floor in a heap; the last metre shows a regular, heartbeat-like trace.
- **3-01**: one pigeonhole stuffed with months of uncollected printouts: "HALVERSON, D. — SL".

### Storey 4 — Directorate / refurbishment (y 15.35)

Two halves divided by a plywood hoarding with a contractor door at x −4.6 across the spine (move the current hoarding
from x 22). West: the former Atmospheric Modelling Division, stripped to studs. East: the Directorate, carpeted,
panelled, incandescent sconces.

| ID | Room | x | z | Fixtures / furniture | Lit | Doors |
|---|---|---|---|---|---|---|
| 4-01 | Gutted floor plate (north) | −54.65..−4.6 | −21.65..−1.75 | steel-stud outlines of the old offices (no board: see-through), bare grid, 70% tiles missing, slab with carpet adhesive, drywall stacks, ceiling tiles, `pallet`, `drum_steel`, `cardboard_box`, cable reels, sawhorses, step ladders, plastic sheeting curtains, `traffic_cone` | **2 clamp work lights on stands** (incandescent, one shadow) | stud doorways (no leaves) |
| 4-02 | Gutted south + contractor site office | −36.0..−4.6 / site office −26.2..−15.4 | 9.75..21.65 / 1.75..9.6 | same strip-out; site office: plywood desk on sawhorses, drawings pinned, hard hats, lunch box, `telephone` on the floor | — | site office C |
| 4-03 | Services (kept running during refurb) | §1 | | WCs taped "OUT OF ORDER", EL-4 has a temporary distribution board feeding the work lights | — | as §1 |
| 4-04 | West end | −54.65..−47.8 | 1.75..21.65 | skip of rubble, tarps, `wet_floor_sign` under a roof leak (existing puddles/stains) | — | (open) |
| 4-10 | Directorate reception | 0.8..11.6 | 1.75..21.65 | reception desk, waiting area at the windows with 2 `lounge_chair`, `coat_rack`, table lamp, framed construction photos | table lamp (incandescent) | spine glass pair O |
| 4-17 | Executive kitchenette + washroom | 11.6..22.4 | 1.75..12.0 | panelled pantry, sink, coffee service, private WC | — | from 4-10 C |
| 4-11 | Receiver & feed room | 0.8..11.6 | −21.65..−1.75 | dish feed waveguide through the ceiling at x 6, z −4 (riser W-1 continues down), LNA cryo dewar (frosted), receiver racks, rubidium frequency standard, spectrum display | **RF hazard beacon** (warning, red) + rack glow | **K:signal** "RF HAZARD — AUTHORIZED" |
| 4-12 | Executive conference | 11.6..34.65 | −21.65..−1.75 | 20-seat table, panelled walls, map wall, projector, credenza with decanter | — | spine pair C |
| 4-13 | Deputy Director | 11.6..22.4 | 12.15..21.65 | desk, `office_chair`, bookcase, `desk_lamp` | — | from 4-10 C |
| 4-14 | **Director's office** (SE corner) | 22.4..34.65 | 9.75..21.65 (+ washroom 1.75..9.6) | windows papered over with chart paper, cot, hot plate, stacked cans, map with the station ringed in pins, chair facing north | **`desk_lamp` + floor lamp** (light under the door and through the transom; the only lit window on storey 4 seen from the lot) | **L** — barricaded from inside, handwritten "DO NOT DISTURB — R.H." |
| 4-15 | Executive secretary | −4.6..0.8 | 1.75..21.65 | desk, Selectric with a list, intercom box to the Director (crackling) | — | C |
| 4-16 | Director's files | −4.6..0.8 | −21.65..−1.75 | safe, `filing_cabinet` ×6, shredder full | — | C (one cabinet K) |

Doors ≈ 18 + stud openings; K/L: receiver, Director → **≈ 89%**.

Vignettes:
- **4-01**: a rectangle sprayed on the north wall "DO NOT DEMO — SEE DIRECTOR" around a panel the contractors were told
  to leave; behind it, the W-1 riser cupboard.
- **4-12**: 12 name cards on the table, every chair shoved back as if everyone stood at once; one card face down.
- **4-02**: the site-office phone off the hook on the floor, a work order "Halt all work 4th floor — by order of the
  Director" dated three weeks ago.

---

## 3. Exploration path and gameplay hooks

**Landmarks** (one per floor, each visible from the spine or the stair door):

| Storey | Landmark | Seen from |
|---|---|---|
| 0 | dedication photo + directory at the junction; cafeteria vending glow; auditorium projector beam | entrance (straight up the link), east spine |
| 1 | the dark cubicle sea with two task lights; glass Conference A with blinds | core hall (the open office begins 15 m east) |
| 2 | blue-white containment window at the east end; violet UV in microbiology | spine axis (east window behind it) |
| 3 | 24 m glass wall of blinking machines with amber halon beacons | stair door: you step into its light |
| 4 | plastic sheeting lit by work lights; then the glowing Director's door | hoarding door frames the warm east corridor |

**Sightlines.** Open-plan edges (1-24, 1-09 clerestory, 3-09, 3-24), glazed rooms (1-02, 1-25, 2-10, 3-04) and the
see-through stud grid on 4 mean the spine is never a tube of doors. Cross-views: 3-04's glass toward 3-24's CRTs
across the spine; the 3-25 racetrack loops so the player can be followed or circled.

**Reasons to visit each floor (night cleaning shift → story):**

| Order | Storey | Task | Unlocks / finds |
|---|---|---|---|
| 1 | 0 | read the work orders in 0-30, take the key ring, stock the cart from JC-0 | janitor key (all J doors), map (0-02 directory) |
| 2 | 1 | empty bins in the cubicle sea and offices, vacuum Conference A | 1-07 memo, in/out board clue |
| 3 | 2 | mop the glasswash floor, turn off the hot plate in 2-27 | chem-store key in 2-08 → 2-01; containment keycard on the safety officer's desk |
| 4 | 3 | lights trip on storey 3: reset breakers in EL-3, then the machine-room breakers in 3-03 | server keycard from the operators' rest room locker; listening-room tape |
| 5 | 4 | "do not enter" on the work order; follow the sound | signal keycard (Director's files, 4-16) → 4-11; Director's note |
| 6 | 0 → SL | FL-1 freight lift / lift SL button | sublevel key (from 4-11 or the Director) |

**Systems that need this plan:** per-floor EL rooms drive lighting zones (fuses, blackouts, emergency packs);
keycards are door `locked` flags flipped at runtime (`ctx.doors`); escape routes on every floor = core stair + west
fire escape (+ ground: lobby, staff entrance 0-10, dock 0-16, cafeteria/annex); hiding places = cubicles, stacks,
tape library aisles, studs; cleaning anchors (bins, floor decals, spills) registered per room (see §4 room registry).

**Facade lit-window pattern** (keep consistent with `facility/windows.ts`): south — 0-38 (x 14.3), 1-24 (−1.9),
1-25 (25.1, 30.5), 2-27 (8.9, 14.3), 3-24 faint CRT (−12.7), 3-25 corner (30.5), 4-14 (30.5, only lit window on 4);
north — 0-16 dock, 3-08 (3.5, 8.9 warm), 4-11 red beacon (3.5), 2-04 hood glow (−39.7), 4-01 work lights (−28.9).

---

## 4. Implementation split

### Kit agent (one owner; starts first)

Owns `interior/kit.ts`, `styles.ts`, `core.ts`, `lift.ts`, `interior.ts` and the new files below; retires
`storeys.ts`/`furnish.ts` once the storey modules replace them (moving reusable pieces such as `windowDressing`,
`benchRun`, `machineGlazing`, `hangingTroffer`, decals and blinds into the kit).

| Phase | File | API | Needed by |
|---|---|---|---|
| K1 (first hours, signatures + constants only) | `interior/plan.ts` | `G` grid, `BAY(i)`, `ZONE` (interior/perimeter), `COLUMNS`, `WINDOWS(storey, face)` (facade bays per storey incl. ground skips and the annex), `SERVICE` rects, `RISER_W1`, `FL1`; types `RoomSpec`, `DoorState = "open"\|"closed"\|"janitor"\|`keycard:${string}`\|"locked"` | all |
| K2 | `interior/partition.ts` | `partition(b, {axis, at, from, to, finish: [sideA, sideB], height?: "full"\|number, openings: (Door\|Glazed\|Cased\|Clerestory)[]})`; `studWall(...)` (storey 4); `column(b, x, z)` | all |
| K2 | `interior/doorway.ts` | `doorway(b, {x, z, rot, id, state: DoorState, sign?: {number, label}, leaf, glass, width, double, dutch?, insulated?})` → wraps `door()`/`ctx.doors`, adds number plate + sign, keycard reader or key cylinder by state | all |
| K2 | `interior/room.ts` | `room(b, spec)` → floor, ceiling (grid, missing %, height), exterior lining + windows/blinds/radiators from `WINDOWS`, columns inside, troffer grid from `lit` (set of fittings) **registering a lamp per lit pair**; returns `RoomHandle` (rect, `at(u,v)`) and adds to the room registry | all |
| K2 | `interior/lights.ts` | `troffers`, `deskLamp(pos, yaw, on)` (`desk_lamp` + incandescent spot), `bankerLamp`, `pendant`, `sconce`, `clampWorkLight`, `underBinTube`, `screen(pos, colour, lamp?)` (emissive + optional tiny lamp), `emergencyPack`, `exitSign`, `beacon` | all |
| K2 | `interior/spine.ts` | `spine(b, storey, {edges: per-side segments "wall"\|"glazed"\|"half"\|"open", finish, nightCircuit, raised?, tray?, sconces?})` + dressing (extinguishers at stair/exits/lab doors, fountain in the WC alcove, bulletins) that keeps clear of openings | all |
| K3 | `interior/services.ts` | `serviceStack(b, storey, overrides)` (EL, TC, WC-M, JC, store, WC-W, fountain alcove) | all (built by kit) |
| K3 | `interior/fixtures.ts` | `eyewashStation`, `drenchShower`, `labBench`/`peninsula`, `fumeHood(light?)`, `sinkCounter`, `cubiclePod`, `officeSet`, `conferenceTable`, `shelvingRows`, `lockers`, `wcFixtures`, `slopSink`, `kitchenette`, `rackRow`, `tapeDrive`, `cot`, `whiteboard/chalkboard`, `wallPapers` | 1, 2, 3 |
| K3 | `interior.ts` | dispatch `storeys/s{i}.ts`, keep the per-storey culling; room registry export `interiorRooms` (`{id, storey, name, rect, lit, doors, anchors}`) for gameplay and `doors-check` | — |

Until K2/K3 land, storey agents code against the K1 signatures (stubs that throw or draw a placeholder box).

### Storey agents (one file each, parallel)

| Agent | Owns | Builds |
|---|---|---|
| S0 | `interior/storeys/s0.ts` + existing `lobby.ts`, `corridor.ts` (west spine), `rooms.ts`, `props.ts` `placeProps` | §2 storey 0 table: east spine (after layout request), 0-02 landmark, 0-10..0-22, 0-30, 0-31, 0-35..0-39; FL-1 car + gates; retire `groundWindows` fake blinds where real rooms now stand; door positions of the existing spine re-mapped to this plan |
| S1 | `interior/storeys/s1.ts` | 1-01..1-26: records stacks, glazed conference rooms, contracts suite with internal doors, payroll bullpen (rows), cubicle sea (pods), library |
| S2 | `interior/storeys/s2.ts` | 2-01..2-29 lab suites, every eyewash/drench inside its lab, cold room, specimen archive, containment observation window, darkroom safelight |
| S3 | `interior/storeys/s3.ts` | 3-01..3-25: glazed machine room + secure zone, tape library, listening room with W-1 riser, terminal pool, racetrack programmers' wing, open analysis bullpen |
| S4 | `interior/storeys/s4.ts` | 4-01..4-16: stud-wall strip-out (reuse decay pieces), hoarding at x −4.6, work lights, directorate with sconces, receiver room, Director's lit barricaded office |

Rules for storey agents: use `plan.ts` coordinates, never re-derive them; one storey file, no edits to kit files
(request additions; a helper used by one storey stays local); all models through `placeModels` (one batch per model
per storey); `await pause()` between rooms; vignettes as small props in `b.small`.

### Layout / facility requests (owner of `layout.ts` and `facility/`)

1. Ground east spine: `INTERIOR.corridorEast = { min: [1.6, −1.6], max: [34.65, 1.6] }` (or reuse `UPPER.corridor` on
   storey 0).
2. `FREIGHT = { car: { min: [−36.85, −20.5], max: [−33.25, −15.5] }, stops: ["SL", 0] }` and a `SUBLEVEL` y
   placeholder.
3. `RISER = { min: [5.4, −4.6], max: [6.6, −3.4] }` (under the dish feed at x 6, z −4).
4. Ground door in the main east wall at z ≈ −8 into the annex (facility shell hole).
5. Facility `windows.ts` lit-window silhouettes should follow the §3 pattern.

---

## 5. Performance budget (per storey)

Current scene: corridor view 250–280 draws, GPU 7.2 ms; whole road view 475 draws, 185 lights, 2.9 M tris
(`docs/perf-audit.md`). Culling: indoors the camera storey ± 1 static groups draw, furniture only on the camera
storey, lamps on the camera storey + neighbour lamps within 10 m. Small InstancedMeshes are the main boot cost (node
builds per mesh), so merge.

| Budget, per storey | Limit | Notes |
|---|---|---|
| Registered lamps | ≤ 48 (incl. exits, warnings, screens) | lights are clustered and unshadowed; storey 3 is the busiest (machine room 4 + CRTs) |
| Lit lamps in any one room | ≤ 6 | one lamp per troffer pair |
| `shadow: true` hints | ≤ 3 | pool default 2 for the whole scene: projector (0), work light (4), listening-room pendant (3), Director's lamp (4) |
| Static draws (merged by material) | ≤ 55 | material palette ≤ 40 per storey, shared from the kit; no per-room materials |
| Furniture/model draws (camera storey) | ≤ 70 | one merged batch per model per storey via `placeModels`/`bakeModels`; no InstancedMesh per room |
| Small-prop draws (camera storey) | ≤ 25 | merged in `b.small` |
| Static triangles | ≤ 350 k | partitions are boxes; bevels only at eye level |
| Model triangles, LOD0 | ≤ 700 k | caps: `chemistry_set` (30 k) ≤ 2; `microscope` (16.6 k) ≤ 4; `security_camera` (13.6 k) ≤ 2; `milk_crate` (12.7 k) avoid; `desk_lamp` (12.4 k) ≤ 10; `office_chair` (9.5 k) ≤ 40, use `stack_chair` (5 k) in conference rooms and auditorium |
| Model triangles, LOD1 (other storeys, outside) | ≤ 150 k | |
| Glow sprites | ≤ 60 | CRTs and equipment LEDs are emissive material, not lamps (only "hero" screens get a lamp) |
| Build time | ≤ 120 ms main thread per storey, `pause()` per room | first view is storey 0; others stream |

Resulting worst case indoors: 3 × 55 static + 70 + 25 ≈ 260 interior draws (today's corridor view is 250–280 for the
whole scene, so storey agents must hit the static target, not exceed it). Measure each storey with
`bun scripts/shot.ts` on an `icam` inside it and `only=interior,facility`; report frame/GPU ms in the storey report.
