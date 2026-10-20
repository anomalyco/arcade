# Outbreak: co-op strategy

Kit, after playing co-op with four teammates: "It doesn't feel like there's enough strategizing you could do with your
teammates. It's pretty cool, but... how can you make the game feel even more realistic and fun and dynamic?"

The playtest (AR-92, AR-93): the squad died repeatedly in the opening, split up and lost each other ("Where'd you guys
go?"), drove a van, found hold-E door locking late, and loved the flashlight and the dog. Card AR-99, decision D-45.

## The gap

Outbreak has the pieces of a team game (doors, locks, barricades, breaches, traps, throwables, a stash and bench in
every house, down and revive, a night ramp, The Way Out), but nothing asks a squad to plan:

- **No reason to choose a place.** Each night comes to wherever each survivor happens to be.
- **No reason to stay together.** Splitting up costs nothing until someone is down (bleed-out is 6 s alone).
- **No reason to split jobs.** The four lobby kits (`shared/loadout.ts`) differ by one starting item.

## Mechanisms from other games

| Mechanism | Where it comes from | What it makes a team do |
| --- | --- | --- |
| A place the night comes to | Darkwood's hideout nights, Valheim raids, L4D crescendos, GTFO alarm doors | Choose where to fight, prepare it, assign posts; the day becomes errands for the night |
| Threats you cannot escape alone | L4D Smoker, Hunter, Jockey, Charger | Stay in pairs; the paired player's job is to cover |
| Asymmetric verbs that combine | Deep Rock Galactic classes, GTFO tools, Zomboid occupations | Decide who goes where by who is fast at what |
| Split information | Lethal Company's terminal operator, GTFO bio tracker, Phasmophobia's van | One player sees what others can't and calls it |
| Player-timed danger | L4D crescendo buttons, Payday going loud, Zomboid's helicopter | Pick the moment, prep first |
| Noise as a spendable resource | Project Zomboid, Hunt: Showdown sound traps | One player loud, the others quiet |
| A shared scarce economy | GTFO resource packs, State of Decay base materials | Sharing and trading are decisions |
| Bodies that wear out | Zomboid injuries and infection, Phasmophobia sanity, Valheim rested | Errands for teammates (bandage me, carry me) |

L4D's director (Booth, GDC 2009) adds the pacing lesson: tension needs troughs the team can plan in, and specials
spawn where the squad is weakest.

## Six systems, ranked

Ranked by fun per effort, then by fit with the Darkwood look and "discovered, not told". Each is a shared feature
folder with a Lab group, Today one setting away, and a station; none edits `coop-sim.ts` or `main.ts`.

| # | System | The team plans | Effort (agent-days) |
| --- | --- | --- | --- |
| 1 | Hold the House | Where to spend the night, who holds which door, what to gather by dusk | 2.5 |
| 2 | Don't Go Alone | Pairs; who covers whom in the dark | 1.5 |
| 3 | Role Verbs | Who boards, revives, drives, scouts | 1.5–2 |
| 4 | Supply Drop | When to go loud, who opens and who covers | 2 |
| 5 | Signals | Typed pings, flare colours, walkie static by range | 1 |
| 6 | Wounds and Infection | Who carries antibiotics, who bandages | 2 |

### 1. Hold the House

- **Claim.** `E` at any house's workbench offers "Hole up here": one claimed house per squad in a shared ledger
  counters store (house, who, nights held). The claim moves only by day. Radio lines and notes hint that the dead
  come to where people hole up.
- **The night aims at it.** From 21:00 the night's extra population arrives as visits: a wave every ~90 s from one or
  two seeded sides, walking to the house's doors and windows (spawn ring shared with the Way Out's `siegeWave`).
  The world heralds each one (a dog barking on that side, a scream, a car alarm a street over), so posts rotate by
  ear. Wanderers elsewhere thin out. With no claim the night is exactly Today.
- **Posts.** Every door and window is an entry, made readable and holdable by AR-97 (breach wear and warning beats)
  and AR-96 (hold-B boarding, braced furniture), plus bear traps, tripwires and molotovs. A wired generator lights
  the house, but its hum draws visits.
- **Dawn.** If no entry was breached in the last game hour, everyone inside heals to 70 and flashlights charge on a
  wired generator; nights held go on the death and escape cards. Later nights come from more sides.
- **Tests.** Claim parity through the real room; visits target only the claimed house's entries; no claim gives
  identical `SimState` hashes; the dawn reward only when held; difficulty bands unchanged without a claim.

### 2. Don't Go Alone

- A seventh special, the Snatcher (seed kind 7). Night only. It lies low in unlit yards and rooms, targets the
  survivor farthest from any teammate (at least 14 m), pins them and drags them toward the dark at 1.2 m/s for 5 HP/s.
- A teammate frees you with one shove, hit or shot, or a second of torchlight in its face. Alone, a struggle frees
  you in about 6 s. Solo play gets a rarer, slower Snatcher.
- It reads in the world: a long arm, a scrape when it moves, dogs barking at it. No HUD.
- **Tests.** Isolated target choice; pinned survivors cannot act; every way of being freed; solo struggle; kind and pin
  parity through the room; specials rarity bands.

### 3. Role Verbs

- **Breacher:** boards, locks and pries 3× faster; 4 more planks. **Medic:** revives in 1.5 s (others 4 s), bandages
  teammates, carries the downed at a walk. **Mechanic:** hotwires in 2 s and quietly, pours fuel faster, wires a
  generator from scrap. **Scout:** sound-cue reach ×1.4; pings last 20 s and show through walls to the squad.
- Everyone can still do everything, slowly. Standard is Today.

### 4. Supply Drop

- From Day 2, a plane drops a crate on a seeded crossroads 200–500 m out, under red smoke visible above the roofs for
  an hour. The best loot of the run. Opening it (hold E, 8 s) sets off a beacon every horde in earshot hears; or leave
  it shut and let it draw the dead away from your house.

### 5 and 6

- **Signals:** cheap, but AR-93 adds teammate markers and most squads talk on voice chat, so it adds the least
  strategy.
- **Wounds and Infection:** bites carry a seeded infection (fever the next night, cured with antibiotics from the
  pharmacy or police), deep cuts slow you until bandaged (twice as fast by a teammate). Best after Role Verbs gives
  the Medic a job; risks turning into chores.

## Suggested

Hold the House first, then Don't Go Alone. Together they answer both halves of the playtest: a place to plan around
and a rule that keeps pairs together in the dark. Role Verbs is the natural third once the house gives each role a
post.

## Foundation

No foundation was built before the pick. Every option already has what it needs: `Q` pings are shared, AR-93 is
adding teammate markers and spectate fixes, and every house has a stash and bench. A claim store would pre-empt Hold
the House and an isolation helper would pre-empt Don't Go Alone.
