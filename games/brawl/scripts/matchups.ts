/**
 * Deterministic bot matchup batch runner using World snapshots, `forkSnapshot`, and pure `step(state, inputs, dt)`.
 *
 *   bun scripts/matchups.ts
 */
import { ROSTER } from "../shared/characters"
import { COUNTDOWN_SECONDS, DT, ROUND_SECONDS } from "../shared/config"
import { World, forkSnapshot, step } from "../shared/world"

const SEEDS_PER_PAIR = 24
const MAX_TICKS = Math.ceil((COUNTDOWN_SECONDS + ROUND_SECONDS + 1) / DT)

type PairStats = {
  winsA: number
  winsB: number
  firstKoTimes: number[]
  matchTimes: number[]
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

const ids = ROSTER.map((c) => c.id)
const matrix: Record<string, Record<string, PairStats>> = {}
for (const a of ids) {
  matrix[a] = {}
  for (const b of ids) {
    matrix[a]![b] = { winsA: 0, winsB: 0, firstKoTimes: [], matchTimes: [] }
  }
}

const t0 = performance.now()
let totalMatches = 0
let totalTicks = 0

for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const charA = ids[i]!
    const charB = ids[j]!
    // Build a base 1v1 round snapshot and fork across SEEDS_PER_PAIR rollout seeds (swapping spawn order on odd seeds).
    for (let s = 0; s < SEEDS_PER_PAIR; s++) {
      const swap = s % 2 === 1
      const w = new World(1000 + s * 37)
      w.botFill = 2
      w.fill(2)
      const [f0, f1] = w.actors
      f0!.pick = f0!.char = swap ? charB : charA
      f1!.pick = f1!.char = swap ? charA : charB
      w.startRound()
      let state = forkSnapshot(w.toSnapshot(), { rolloutSeed: 5000 + i * 100 + j * 10 + s })

      let firstKoAt = 0
      while (state.phase === "play" && state.tick < MAX_TICKS) {
        state = step(state, undefined, DT)
        totalTicks++
        if (!firstKoAt && state.players.some((p) => p.stocks < 3)) {
          firstKoAt = Math.max(0, state.time - state.goAt)
        }
      }
      totalMatches++
      const playTime = Math.max(0, state.time - state.goAt)
      const pA = state.players.find((p) => p.char === charA)!
      const pB = state.players.find((p) => p.char === charB)!
      const aWon = state.winner === pA.id || (state.winner === "" && (pA.stocks > pB.stocks || (pA.stocks === pB.stocks && pA.damage <= pB.damage)))

      const ab = matrix[charA]![charB]!
      const ba = matrix[charB]![charA]!
      if (aWon) {
        ab.winsA++
        ba.winsB++
      } else {
        ab.winsB++
        ba.winsA++
      }
      if (firstKoAt > 0) {
        ab.firstKoTimes.push(firstKoAt)
        ba.firstKoTimes.push(firstKoAt)
      }
      ab.matchTimes.push(playTime)
      ba.matchTimes.push(playTime)
    }
  }
}

// Also run 4-bot FFA across all 15 4-character combinations × 6 seeds = 90 FFA rounds
const ffaWins: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
const ffaPlayed: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
const ffaKos: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
const ffaFirstKo: number[] = []
const ffaDuration: number[] = []

for (let a = 0; a < ids.length; a++) {
  for (let b = a + 1; b < ids.length; b++) {
    for (let c = b + 1; c < ids.length; c++) {
      for (let d = c + 1; d < ids.length; d++) {
        const quartet = [ids[a]!, ids[b]!, ids[c]!, ids[d]!]
        for (let s = 0; s < 6; s++) {
          const w = new World(2000 + s * 53 + a * 7 + b * 13 + c * 19 + d * 29)
          w.botFill = 4
          w.fill(4)
          w.actors.forEach((f, idx) => {
            const ch = quartet[(idx + s) % 4]!
            f.pick = f.char = ch
            ffaPlayed[ch]!++
          })
          w.startRound()
          let state = forkSnapshot(w.toSnapshot(), { rolloutSeed: 9000 + s })
          let firstKo = 0
          while (state.phase === "play" && state.tick < MAX_TICKS) {
            state = step(state, undefined, DT)
            totalTicks++
            if (!firstKo && state.players.some((p) => p.stocks < 3)) {
              firstKo = Math.max(0, state.time - state.goAt)
            }
          }
          totalMatches++
          if (firstKo > 0) ffaFirstKo.push(firstKo)
          ffaDuration.push(Math.max(0, state.time - state.goAt))
          for (const p of state.players) {
            ffaKos[p.char]! += p.kos
            if (p.id === state.winner) ffaWins[p.char]!++
          }
        }
      }
    }
  }
}

const elapsedMs = performance.now() - t0
console.log(`Ran ${totalMatches} matches (${totalTicks} ticks) in ${(elapsedMs / 1000).toFixed(2)}s (${((totalTicks / elapsedMs) * 1000).toFixed(0)} ticks/s)\n`)

console.log("=== 1v1 Win-Rate Matrix (Row vs Col %) ===")
const header = ["Hero".padEnd(8), ...ids.map((id) => id.padStart(7)), "1v1 Win%".padStart(9), "1st KO".padStart(8), "Round".padStart(8), "FFA Win%".padStart(9), "FFA KO/g".padStart(9)].join(" | ")
console.log(header)
console.log("-".repeat(header.length))

for (const a of ids) {
  let wins = 0
  let games = 0
  const koTimes: number[] = []
  const matchTimes: number[] = []
  const cols = ids.map((b) => {
    if (a === b) return "    —  "
    const st = matrix[a]![b]!
    const n = st.winsA + st.winsB
    wins += st.winsA
    games += n
    koTimes.push(...st.firstKoTimes)
    matchTimes.push(...st.matchTimes)
    return `${Math.round((st.winsA / n) * 100)}%`.padStart(7)
  })
  const winPct = `${((wins / games) * 100).toFixed(1)}%`.padStart(9)
  const koMed = `${median(koTimes).toFixed(1)}s`.padStart(8)
  const matchMed = `${median(matchTimes).toFixed(1)}s`.padStart(8)
  const ffaWinPct = `${((ffaWins[a]! / ffaPlayed[a]!) * 100).toFixed(1)}%`.padStart(9)
  const ffaKoAvg = `${(ffaKos[a]! / ffaPlayed[a]!).toFixed(2)}`.padStart(9)
  console.log([a.padEnd(8), ...cols, winPct, koMed, matchMed, ffaWinPct, ffaKoAvg].join(" | "))
}
console.log(`\nFFA (90 4-bot rounds): median 1st KO = ${median(ffaFirstKo).toFixed(2)}s (mean ${mean(ffaFirstKo).toFixed(2)}s), median round = ${median(ffaDuration).toFixed(2)}s (mean ${mean(ffaDuration).toFixed(2)}s)`)
