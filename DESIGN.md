# Wings — Design & Architecture

Live URL (planned): `https://anoma.ly/labs/wings/` (Cloudflare Worker `wings`).

## Overview
A high-performance, browser-based 3D multiplayer aerial combat game featuring planes and helicopters across up to **4 symmetrical teams**. Players launch from protected team runways/airbases and battle over a large island-and-canyon combat theater.

---

## Core Design Pillars
1. **Instant Load (< 200ms to interactive lobby):**
   - Pure HTML/CSS lobby & spawn overlay renders immediately while pre-exported Fiend `.glb` models load asynchronously.
   - Zero startup procedural mesh/navmesh baking on the main thread.
   - Time-sliced terrain/world LOD streaming (strict `≤ 2 ms/frame` CPU budget) + 2-triangle analytical ocean shader + logarithmic depth buffer for a **40 km × 40 km** theater at 60–144 FPS.
2. **100% Shared Deterministic TypeScript Simulation (`src/sim/`):**
   - Dependency-free physics, flight controls, turret aiming, projectile/missile ballistics, and collision math run at **60 Hz** on both the browser client (prediction/reconciliation) and the Cloudflare Durable Object (`Room`).
3. **Trackpad & Mouse Friendly Controls:**
   - **Mouse-Aim Virtual Cursor** (War Thunder / Freelancer style): move the cursor to point where you want to fly; a proportional-derivative autopilot smoothly banks, pitches, and yaws the aircraft toward your aim point.
   - **Direct Keyboard Overrides:** `W/S` throttle/collective, `A/D` roll/strafe, `Q/E` rudder/yaw, `Shift` afterburner/boost, `X` airbrake/hover-lock, `F` flares/countermeasures, `C` or `Right-Click` free-look / zoom (ADS), `1–4` hot-swap seats.
4. **Protected Airbase Runways:**
   - Up to 4 teams (Cobalt, Amber, Emerald, Crimson), each stationed at a cardinal Airbase (North, South, East, West) with a **2.2 km protected safe-zone dome**.
   - Aircraft on their home runway or inside their home safe zone **cannot take damage** while spawning, crewing up, or taking off.
   - Flying out of the safe zone enters the active Combat Theater.

---

## Technology Decisions (Locked)
- **Language: 100% TypeScript.** No Rust/WebAssembly for now.
  - The same simulation code runs in the browser (prediction) and in the Durable Object (authority) with no second toolchain.
  - Simulating ~40 aircraft, projectiles and missiles at 60 Hz costs well under 1 ms/tick in V8; the real cost is GPU rendering, which WASM does not help.
  - Three.js lives in JS, so WASM physics would add per-frame transform copies across the JS↔WASM boundary.
  - Revisit only if profiling shows a specific hot loop (e.g. terrain mesh generation) dominating; that loop could move to a Web Worker first, then WASM if still needed.
- **Rendering:** Three.js `WebGLRenderer` (universal support, no WebGPU crash risk), graphics presets, capped pixel ratio.
- **Assets:** Aircraft authored in Fiend, exported as `.glb` into `public/models/`, loaded lazily after the lobby is interactive.
- **Server:** Cloudflare Workers + SQLite-backed Durable Objects (`Room`, `RoomDirectory`), WebSocket JSON protocol first, binary snapshots later if bandwidth requires.

---

## Vehicle Roster (5 Classes)

| ID | Class Name | Inspiration | Seats | Speed (Cruise / Boost) | Hull HP | Primary Roles & Weapons |
| --- | --- | --- | :---: | :---: | :---: | --- |
For now **every aircraft has exactly 2 seats**: the pilot flies and fires the fixed forward weapon; seat 2 runs the aimed/guided weapons. The gunship (4 seats) is deferred to a later phase.

| ID | Class Name | Inspiration | Seats | Speed (Cruise / Boost) | Hull HP | Primary Roles & Weapons |
| --- | --- | --- | :---: | :---: | :---: | --- |
| `fighter` | **F/A-18F Super Hornet** | Two-Seat Strike Fighter | **2** | `135 / 185 m/s` | `450` | **Seat 1 (Pilot):** 20mm Vulcan rotary cannon + heat-seeking air-to-air missiles + Flares.<br>**Seat 2 (WSO):** Belly targeting pod — steers TV-guided missiles and marks targets for the team. |
| `apache` | **AH-64 Apache** | Attack Helicopter | **2** | `75 / 98 m/s` | `550` | **Seat 1 (Pilot, rear):** VTOL flight + Hydra 70 unguided rocket pods + Flares.<br>**Seat 2 (Gunner, front):** Stabilized 30mm M230 chin chain gun + guided Hellfire missiles. |
| `warthog` | **A-10 Warthog (YA-10B two-seat)** | Armored Close-Air-Support | **2** | `105 / 135 m/s` | `850` | **Seat 1 (Pilot):** 30mm GAU-8 Avenger 7-barrel cannon ("BRRRRT") + rocket salvos + Flares.<br>**Seat 2 (Weapons):** Targeting pod — guided Maverick missiles. |
| `blackbird` | **YF-12 Blackbird** | Skunk Works Recon / Interceptor | **2** | `190 / 260 m/s` | `380` | **Seat 1 (Pilot):** Fastest aircraft in the sky + **Long-Range Lock-On Interceptor Missiles**.<br>**Seat 2 (RSO):** **Radar/Thermal Recon Pulse** (spots & paints enemies for the team, lead-pip indicators, +20% damage taken) + long-range lock painting. |
| `gunship` | **AC-130 Spooky** *(deferred)* | Heavy Turboprop Gunship | **4** | `82 / 102 m/s` | `1,600` | Later phase: pilot + side-firing 105mm howitzer, 40mm Bofors, 25mm gatling gunners. Current Fiend draft (`2dfd2f8f-…`) was rejected; rebuild from scratch to STYLE.md when this phase starts. |

---

## Multiplayer, Lobbies & Lifecycle
- **Cloudflare Workers + SQLite Durable Objects:**
  - `RoomDirectory`: Tracks active public lobbies for the Room Browser & Quick Play.
  - `Room`: Owns authoritative 60 Hz simulation (stepped every 50 ms / 20 Hz snapshot broadcast), team scores, vehicle seats, projectiles, missiles, radar paint state, and AI bots.
- **Lobby Configuration:**
  - **Team Count:** 2, 3, or 4 teams.
  - **AI Bots:** Configurable bot count per team (pilots + automatic turret gunners) for solo play or filling open seats.
  - **Offline / Loopback Fallback:** Works identically offline in the browser if running Vite without Wrangler.
- **1-Minute Empty-Lobby Auto-Deletion:**
  - When the last human WebSocket disconnects from a `Room`, a `60_000 ms` expiry timer starts (and `durableObjectState.storage.setAlarm` backs it up).
  - If no human joins within 60 seconds, the room stops its simulation timer, clears all state, and unregisters itself from `RoomDirectory`.

---

## Directory Layout
```txt
plane-game/
├── DESIGN.md
├── index.html
├── package.json
├── server.ts                # Cloudflare Worker + Room & RoomDirectory Durable Objects
├── wrangler.jsonc
├── public/
│   └── models/              # Fiend-authored GLB models for all 5 aircraft
└── src/
    ├── main.ts              # Client entry, instant lobby, HUD, render loop
    ├── style.css            # Clean tactical HUD & lobby styling
    ├── net.ts               # WebSocket client + local loopback server for offline dev
    ├── audio.ts             # Procedural Web Audio engine (jet turbine, rotor chop, GAU-8 brrrt, flak, lock-on)
    ├── render/
    │   ├── scene.ts         # Three.js WebGLRenderer, graphics presets, aircraft mesh & turret rigs
    │   ├── world-view.ts    # Streaming terrain LODs, 4 airbase runways, analytical water & sky
    │   └── effects.ts       # Tracers, flak bursts, missile smoke trails, explosions, radar paint HUD
    └── sim/                 # 100% pure TS shared between Client & Cloudflare Worker
        ├── types.ts         # Vehicle classes, weapon specs, messages, snapshot types
        ├── geography.ts     # 40x40km island/canyon heightfield + 4 cardinal airbase runways & safe zones
        ├── flight.ts        # Mouse-aim autopilot + Fixed-Wing & Helicopter physics + runway gear/takeoff
        ├── combat.ts        # Turret hemisphere math, ballistics, guided/long-range missiles, proximity flak, radar pulse
        ├── bots.ts          # AI pilot dogfighting/orbiting + AI turret gunners
        └── room-engine.ts   # Shared authoritative 60Hz game loop used by both DO Room and local offline mode
```
