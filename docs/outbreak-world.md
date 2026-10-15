# Outbreak World Generation & Chunk Streaming

Design note and Phase 1 architecture for scaling Outbreak from a single $96 \times 96\text{ m}$ (`3 × 3` chunk) block to a large or effectively infinite procedural world with multiple districts, landmark POIs, incremental bakes, persistent deltas, and wide-area co-op.

---

## 1. How Comparable Games Build Large or Infinite Worlds

| Game | World Scale & Structure | Generation Strategy | Streaming, AI LOD & Persistence |
| --- | --- | --- | --- |
| **Project Zomboid** | Fixed $15 \times 15\text{ km}$ Knox Country (`300 × 300` tile Cells $\to$ `10 × 10` tile Chunks) | Hand-authored road network and building shells; **procedural room loot, vehicle spawns, survivor-house stories (barricaded/ransacked), and zone vignettes** | Streams a local chunk window around each player. Unloaded chunks run a **coarse meta-map zombie population heatmap** (`ZombiePopulationManager`) that migrates virtual hordes toward gunshots/helicopters and materializes agents only near players. |
| **Cataclysm: DDA** | Infinite 2-tier hierarchy (`180 × 180` Overmap $\to$ `24 × 24` tile Submaps) | **Hierarchical top-down:** Overmap lays out inter-city highways first, grows radial city districts (`commercial` core $\to$ `residential` ring $\to$ `industrial` / `forest`), and places unique `overmap_special` POIs with road-socket rules. | **Reality Bubble** (`60 × 60` tiles) around the player ticks local AI/physics. Submaps generate lazily on first entry and persist when modified. |
| **7 Days to Die (RWG)** | $4\text{–}10\text{ km}$ seeded county | **Road graph + Socketed District Lots:** Generates highway splines between town hubs, partitions towns into district tiles (`downtown`, `commercial`, `industrial`, `residential`, `rural`), and stamps socketed POI prefabs onto lots without adjacent duplicates. | Chunk-streamed meshes; distant POIs render as low-poly impostors; sleeper volumes spawn zombies only when a survivor enters a POI's trigger bounds. |
| **Minecraft** | Infinite $16 \times 16$ block chunks | **Stateless coordinate hashing** `f(seed, cx, cz)` in deterministic passes (noise $\to$ biomes $\to$ structure grid starts $\to$ pieces $\to$ decoration). | Separate `renderDistance` vs `simulationDistance` windows; unmodified chunks need zero storage; modified chunks save in `32 × 32` region files. |
| **State of Decay 2** | $2 \times 2\text{ km}$ rural county hubs | Distinct readable districts (strip mall, suburban cul-de-sac, warehouse rail yard, clinic/police landmarks, farmland) with procedural loot, plague hearts, and infestation overlays. | Landmark POIs telegraph loot categories from street silhouettes (gas canopy, pharmacy cross, warehouse bays, police cruisers). |
| **Townscaper / WFC** | Arbitrary grid | **Edge socket contracts:** Adjacent cells agree on shared boundary sockets (`road`, `sidewalk`, `fence`, `yard`) so geometry stitches seamlessly without cross-chunk state. | Local boundary changes only rebuild the affected chunk and its immediate 1-ring neighbours. |
| **Caves of Qud** | Overworld Parasangs $\to$ $3 \times 3$ Zones | Top-down biome + historical site assignment per Parasang; each Zone reads its 8 neighbour tags to blend border roads and flora. | Active zone simulation; frozen off-screen zones with delta thaw on return. |
| **No Man's Sky** | Planetary / infinite | **Purely functional generation:** Base world is never stored on disk or sent over the network; only a sparse **delta table** of player edits is kept. | Deterministic regeneration from `(seed, coords)` + sparse delta overlay on load. |
| **Dwarf Fortress** | Regional world $\to$ local embark | Low-frequency elevation, drainage, and vegetation fields drive where roads, forests, and settlements form so geography feels causal. | Off-site populations are tracked as abstract cohorts until entered. |
| **Factorio** | Infinite $32 \times 32$ tile chunks | Deterministic per-chunk generation on discovery; active chunk list restricted to player proximity and active pollution/radar. | Distant enemy groups aggregate into expansion timers and unit counts outside active chunks. |

### Key Takeaways for Outbreak
1. **Generate roads and districts top-down, then lots and rooms bottom-up:** A world feels repetitive if every chunk independently rolls random houses. Generating a **connected road network first** and assigning **Districts** (`suburb`, `commercial`, `civic`, `industrial`, `woodland`) at the block scale gives players clear spatial landmarks and navigation routes.
2. **Enforce deterministic edge sockets at chunk borders:** When road centerlines and sidewalk/curb profiles are a pure function of world coordinates along shared chunk edges ($32\text{ m}$ boundaries), any two adjacent chunks `(cx, cy)` and `(cx + 1, cy)` stitch asphalt, curbs, sidewalks, and lane markings without seams.
3. **Never scale global textures or global nav grids with world size:** Keep GPU floor/moon/bounce/fog textures and detailed CPU `GridNav` scoped to a **sliding local window** around active survivors, and bake per-chunk tiles incrementally so frame time stays flat whether the player walks $100\text{ m}$ or $10\text{ km}$.
4. **Store only sparse `ChunkDelta`s on the server:** Because both client and server run the same `shared/` code (verified by `BUILD` hash), both sides generate identical chunks from `(seed, cx, cy)`. The server only stores and replicates **deltas** (toggled/locked/broken doors, windows, barricade planks, searched containers, dead/aggroed zombies).

---

## 2. Recommended Architecture for Outbreak

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 1. HIERARCHICAL DETERMINISTIC GENERATOR  shared/world.ts  f(seed, cx, cy)        │
│                                                                                  │
│   Region Noise (low-freq) ──▶ Macro-Block (3×3 chunks = 96×96 m)                 │
│     ├─ Arterial & Collector Road Graph (seamless across 32 m chunk borders)      │
│     ├─ District Zoning: Suburb · Commercial Strip · Civic POI · Industrial · Wood│
│     └─ Chunk (cx, cy) [32×32 m]: Lot ──▶ Building / POI Archetype ──▶ Rooms/Props│
└───────────────────┬──────────────────────────────────────────┬───────────────────┘
                    │                                          │
                    ▼                                          ▼
┌─────────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ 2. AUTHORITATIVE ROOM DO  (CoopSim)     │  │ 3. CLIENT RENDERER & STREAMER       │
│                                         │  │                                     │
│ • Active Chunk Set = union of 3×3       │  │ • Sliding 3×3 chunk window (96×96 m)│
│   windows around all 1..4 survivors     │  │   centred on local survivor         │
│ • Per-chunk 64×64 (0.5 m) nav tiles     │  │ • LRU cache of compiled chunk meshes│
│   stitched for cross-border AI pathing  │  │   + 128² floor / 256² moon / 64² GI │
│ • Sparse ChunkDelta store (doors,       │  │ • Time-sliced bake queue (≤ 1 chunk │
│   windows, planks, loot, zombie state)  │  │   per frame, 0 frame hitches)       │
│ • Far chunks hibernate as aggregate     │  │ • Per-chunk 64² fog/scenery memory  │
│   zombie counts; thaw on re-entry       │  │   composited into 192² exploredTex  │
└─────────────────────────────────────────┘  └─────────────────────────────────────┘
```

### 2.1 Coordinate Space, Chunks & Seamless Road Network
- **Chunk unit:** Each chunk `(cx, cy)` with $cx, cy \in \mathbb{Z}$ spans $[cx \cdot 32, (cx + 1) \cdot 32] \times [cy \cdot 32, (cy + 1) \cdot 32]\text{ m}$ (`CHUNK = 32`).
- **Macro-blocks (`3 × 3` chunks = $96 \times 96\text{ m}$):**
  - Macro-block `(bx, by) = (floor(cx / 3), floor(cy / 3))` has local chunk indices `(lx, ly) ∈ {0, 1, 2}²`.
  - **Primary arterial roads** run through the middle chunk of each macro-block (`lx = 1` at local offset $x \in [8, 16]\text{ m}$, i.e. $40..48\text{ m}$ in block space, and `ly = 1` at $z \in [8, 16]\text{ m}$), with $2\text{ m}$ concrete sidewalks and sloped curbs on both sides ($[6, 8]\text{ m}$ and $[16, 18]\text{ m}$).
  - **Why this matters:** In macro-block `(0, 0)` (`cx, cy ∈ 0..2`), the arterial crossroads sit at $x \in [40, 48], z \in [40, 48]$ — **matching Outbreak's existing Classic $96\text{ m}$ town to the millimetre**. Walking North ($z < 0$), South ($z > 96$), West ($x < 0$), or East ($x > 96$) along the street continues seamlessly into neighbouring macro-blocks without a single curb or asphalt discontinuity.
  - **Secondary collector streets & cul-de-sacs:** Deterministic edge predicates `hasNorthRoad(seed, bx, by)` and `hasWestRoad(seed, bx, by)` vary block connectivity so some macro-blocks form 4-way crossroads, T-junctions, straight commercial avenues, or wooded cul-de-sacs.

### 2.2 Districts, Building Archetypes & POIs
Each macro-block and lot is assigned a **District** and **Building / POI Archetype** from `(seed, bx, by, lx, ly)` with minimum-spacing rules so high-value POIs never cluster back-to-back:

1. **Suburban Residential (`suburb`):**
   - **Craftsman Bungalow (`house`):** L-shaped 3-room plan (bedroom, living room, kitchen/dining), front gable porch, driveway sedan, backyard shed, picket fences.
   - **Suburban Ranch (`ranch`):** Wide single-storey layout with garage/workshop wing, central hallway, living room, and kitchen (planks + tools in workshop, food/ammo in bedrooms).
   - **Corner Cottage (`cottage`):** Compact 2-room house with wrap-around garden fence, dense hydrangea/tree cover, and bedroom/kitchen loot.
2. **Commercial Strip (`commercial`):**
   - **Hardware Store (`hardware`):** Parapet storefront with pegboard signage, long supply aisles, workbench counters, high plank & tool yield.
   - **Pharmacy (`pharmacy`):** Teal-trimmed corner storefront with illuminated cross sign, prescription counter, medicine shelves.
   - **Corner Grocery / Bodega (`grocery`):** Checkout counter, cold drink fridges, stocked dry-goods aisles, back storage room.
   - **Roadside Diner (`diner`):** Long window frontage, booth tables and chairs, service counter, kitchen stove/fridge line.
   - **Gas Station (`gas_station`):** Forecourt island with fuel pumps and overhead canopy, convenience kiosk, service garage bay, parked vehicles.
3. **Civic & Emergency Landmarks (`civic`):**
   - **Police Station (`police`):** Reinforced masonry façade, cruiser parking, front desk, evidence/armory room with locked door and high 9mm ammo yield.
   - **Medical Clinic (`clinic`):** Triage waiting room, examination beds, pharmacy supply cabinets, ambulance bay.
   - **Parish Church (`church`):** Steep gabled nave, rows of timber pews, vestibule, churchyard fence and monument trees.
4. **Industrial Yard (`industrial`):**
   - **Lumber & Freight Warehouse (`warehouse`):** High corrugated-wall industrial bay, wide loading doors, stacked timber plank pallets, shelving racks, perimeter security fence.
5. **Woodland & Park (`woodland`):**
   - **Ranger Cabin / Park Shelter (`cabin`):** Timber shelter surrounded by dense broadleaf canopy clusters, picnic tables, gravel paths, and abandoned vehicles.

### 2.3 Incremental Client Streaming & Zero-Hitch Baking
- **Sliding `3 × 3` Chunk Render Window ($96 \times 96\text{ m}$):**
  - The client tracks the local survivor's chunk `(playerCx, playerCy)` with a $4\text{ m}$ hysteresis band so oscillating on a chunk border never thrash-shifts the window.
  - The active render window covers `cx ∈ [winCx - 1 .. winCx + 1]`, `cy ∈ [winCy - 1 .. winCy + 1]`, with world origin `(originX, originZ) = ((winCx - 1) * 32, (winCy - 1) * 32)`.
  - `OutbreakLightingUniforms` (`OL` at `@binding(13)`) passes `OL.win = vec4f(originX, originZ, isStreaming, bldCount)` and the active window's building rectangles `OL.bldRects[0..8]`.
  - In WGSL, `floorData(p)`, `bounceAt(p)`, and `exploredTex` sample at `(p - OL.win.xy) * F.map.xy` (`F.map.xy = 1 / 96`). When `origin = (0, 0)` in the starting block, the math is bit-identical to `p * F.map.xy`.
- **Per-Chunk Tile Baking & Time-Sliced Queue (`src/world-streamer.ts`):**
  - Instead of baking a monolithic $384 \times 384$ floor map and $768 \times 768$ moon mask from scratch when the window moves, each chunk `(cx, cy)` independently bakes and caches its own:
    - Static opaque & cutaway `LevelChunk[]` and glass `LevelChunk[]`
    - `128 × 128` (`0.25 m/texel`) floor contact AO & indoor sky mask tile
    - `256 × 256` (`0.125 m/texel`) directional moon & tree-canopy shadow tile
    - `64 × 64` (`0.5 m/texel`) Dijkstra indirect lamp bounce tile
  - **Background Web Worker compilation, template banks & pooled buffers (`src/world-streamer.ts`, `src/world-worker.ts`):**
    - Pre-packs 32 tree archetypes, 16 grass-cluster templates, and 11 interior furniture templates at startup (`ensurePropTemplates`), and recycles per-chunk `floorTile` (`128² RG8`), `moonTile` (`256² R8`), `bounceTile` (`64² RGBA8`), and `768 KB` `opaqueBuf` (`LevelChunk.byteLength`) buffers through `tilePool` across chunk evictions, cutting `compileSingleWorldChunk` CPU median from `8.28 ms` (`108.97 ms` max) to `0.90 ms` and reducing main-thread heap allocations across the 240-step walk by **95.5%** (`3,338.2 MB → 150.2 MB`).
    - Spawns two background module Web Workers (`src/world-worker.ts`) that compile directional lookahead chunks off-thread and return transferable `ArrayBuffer`s (`postMessage(..., transfer)`), while `Renderer.setLevel` partitions its static level vertex buffer into 9 toroidal `768 KB` slots (`streamSlot = (cy % 3) * 3 + (cx % 3)`) with stable building indices (`0..7`) so the 6 surviving chunks in each `3 × 3` window shift stay resident on the GPU with zero CPU copy or `writeBuffer` upload.
    - When the `3 × 3` window shifts by one chunk, all 9 chunks are pre-warmed in the 24-slot LRU cache (`0` synchronous transition-frame bakes), and stitching the 9 cached tiles into the $384^2$ / $768^2$ / $192^2$ textures uses zero-allocation `Float64Array` row copies (`< 0.05 ms`).
    - On the 1,152 m scripted walk (`scripts/prove-world.ts`, Metal `1280 × 800`), frame times drop from **`p50 11.5 ms / p95 16.3 ms / transition p95 22.2 ms / worst 25.3 ms`** to **`p50 8.0 ms / p95 11.9 ms / transition p95 13.7 ms / worst 14.0 ms`**, and across three 2.3 km back-and-forth round-trip walks (`6.9 km`, `208` chunk transitions), JS heap stays flat (`101.83 → 104.03 MB` on the 1.15 km walk; `103.67 → 104.26 MB` across Walk 1 → Walk 3, `+0.59 MB` retained delta vs `+22.8 MB` before).
- **Origin chunks and dressed lots (`src/world-streamer.ts`, `src/architecture.ts`, `src/yard.ts`):**
  - The nine origin chunks are not re-emitted: `compileOriginChunk` cuts them from the authored origin build
    (`buildLevel`, tagged per source mesh and split role) together with its floor, moon and bounce maps, so the
    streamed window and the origin build draw the same triangles there (`scripts/origin-switch-proof.ts`).
  - Every other lot is dressed by the origin's rules: L-plan bungalows get the porch, shutters, shed and foundation
    shrubs (`houseFrontage`, `housePlanting`), other houses the shrubs and framing trees, and every lot the lawn
    patches, walkway and driveway tufts and gravel; trees get root collars and east–west streets get verge rosettes.
    Seeded per chunk; plants are copied from templates (`yardPlantTemplate`). Driveway cars stay the real parked
    vehicles from `generateChunkVehicleSpawns`.
  - Cost on 216 non-origin chunks around the origin (`scripts/bench-chunk-compile.ts`, M2 Max): compile median
    `0.63 → 0.81 ms`, p95 `2.4 → 3.0 ms`, a dressed bungalow chunk `~3 → ~5 ms`; opaque bytes median
    `380 → 489 KB`, p95 `684 → 1,595 KB`. Stream slots grow in 768 KB steps to the densest chunk, and opaque
    buffers above 768 KB are pooled per size class. On `scripts/prove-world.ts` (studio, two runs each) the 1.15 km
    walk's transition p95 goes `6.6 / 5.1 → 7.7 / 6.0 ms` and worst frame `8.7 / 9.6 → 8.3 / 12.9 ms`, inside its
    17 ms and 20 ms budgets, and retained heap over three round trips stays flat (`−0.9 / −0.3 MB`).
- **Per-Chunk Fog & Scenery Memory:**
  - `WorldFogMemory` stores a persistent `64 × 64` (`0.5 m` cell) exploration and room-discovery mask per visited chunk key `"cx,cy"`.
  - Moving 1 km away and returning restores every previously explored street and room into the active `192 × 192` `exploredTex`.

### 2.4 Authoritative Room Streaming, Deltas, Cross-Chunk Nav & Co-op Bandwidth
- **Union of Survivor Windows (`shared/world.ts`):**
  - In `CoopSim`, each connected survivor $i$ defines an active `3 × 3` chunk bubble around `(slot.survivor.x, slot.survivor.y)`.
  - The room's active chunk set is $C_{\text{active}} = \bigcup_{i=1}^{N} \text{Window}_{3\times 3}(s_i)$ (9 chunks for 1 player, or up to 36 chunks if 4 players split up across the county).
- **Persistent `ChunkDelta`s:**
  - Unmodified chunks require **0 bytes** of room storage.
  - When a survivor or zombie modifies a chunk (opens/locks/breaks a door, opens/climbs a window, adds/bashes barricade planks, searches a loot container, or damages/kills a zombie), `StreamingWorld` writes to `deltas.get("cx,cy")`:
    - `doors: Record<doorId, { open: boolean; locked?: boolean; integrity?: number; planks?: number; plankHp?: number }>`
    - `windows: Record<winId, { open: boolean; openable: boolean; planks?: number; plankHp?: number }>`
    - `searched: Set<containerId>`
    - `zombies: SavedZombie[]` & `clearedCount: number` (when a chunk unloads, its remaining live zombies are dehydrated into compact records or aggregate counts; when reloaded, those exact zombies re-materialize without respawning killed ones).
- **Cross-Chunk Navigation & Hordes:**
  - `GridNav` / `FlowFieldNav` operates over the active chunk bounding box (or per-chunk `64 × 64` walkability tiles), with world-coordinate `(x, y)` indexing `(x - navOriginX, y - navOriginY)`. Zombies chase, pathfind, and bash doors seamlessly across chunk boundaries ($x = 32, 64, 96, -32, \dots$).
- **Co-op Wire Protocol & Interest Management (`shared/net-protocol.ts`):**
  - World coordinates in binary snapshots use `i32` centimetres (`±21,474 km` range at `1 cm` precision, replacing `i16` which overflowed at `±327.67 m`).
  - Portal states (`doors`, `windows`, `planks`), `searched` containers, and `zombies` are keyed by stable IDs / chunk coordinates so two co-op clients 1+ km apart each apply deltas to their loaded chunks and reconcile local prediction with zero drift.

---

## 3. World Scale Options (Board Decision `AR-22`)

1. **Classic Block (`classic`):** Fixed $96 \times 96\text{ m}$ (`3 × 3` chunk) neighbourhood. Preserved as `"classic"` mode so every existing M1/Look/Perf proof and screenshot target stays bit-identical.
2. **Streaming Infinite World (`streaming` — Recommended):** Deterministic `(seed, cx, cy)` chunks stream dynamically in a sliding window around every survivor. Macro-block `(0, 0)` anchors the familiar starting street while arterial roads extend infinitely into procedural Suburb, Commercial, Civic POI, Industrial, and Woodland districts.
3. **Large Fixed County (`county`):** A bounded $1 \times 1\text{ km}$ (`30 × 30` chunk) town with a finite perimeter ring road, using the same chunk streamer and delta store.
4. **Authored District Hubs (`hubs`):** Hand-designed $96 \times 96\text{ m}$ landmark blocks placed on a grid and linked by procedural connector streets.

Phase 1 implements the shared foundation required by options 2, 3, and 4 (`shared/world.ts` and `src/world-streamer.ts`) while keeping `classic` mode reproducible.
