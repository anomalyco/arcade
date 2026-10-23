// The balance report: a readable text summary (stdout, summary.txt) and a small self-contained HTML page with charts.

import { TEAM_COLORS } from "../../shared/crew"
import { type Rate, type Stat, type Summary, KILL_WEAPONS, SHIP_SOURCES, UNIT_TYPES } from "./metrics"

const TEAM_NAMES = ["ORANGE", "CYAN", "PINK", "LIME"]
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "–")
const f0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toString() : "–")
const pc = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "–")
const min = (s: number) => (Number.isFinite(s) ? `${(s / 60).toFixed(1)} min` : "–")
/** "12.3 ± 1.2" (mean ± 95% half-interval). */
const ms = (s: Stat, fmt = f1) => (s.n ? `${fmt(s.mean)}${Number.isFinite(s.ci) ? ` ± ${fmt(s.ci)}` : ""}` : "–")
const mm = (s: Stat) => (s.n ? `${min(s.mean)}${Number.isFinite(s.ci) ? ` ± ${(s.ci / 60).toFixed(1)}` : ""}` : "–")
const rt = (r: Rate) => (r.n ? `${pc(r.p)} [${pc(r.lo)}–${pc(r.hi)}] (${r.k}/${r.n})` : "–")
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length))

/** The summary as plain text. */
export function textReport(s: Summary, notes: readonly string[] = []): string {
  const L: string[] = []
  const row = (k: string, v: string) => L.push(`  ${pad(k, 26)}${v}`)
  L.push(`== ${s.variant} — ${s.matches} matches, ${s.teams} carriers ==`)
  for (const n of notes) L.push(`  ${n}`)
  L.push("Match")
  row("finished", rt(s.ended))
  row("length (finished)", `${mm(s.length)}  (median ${min(s.length.median)}, ${min(s.length.min)}–${min(s.length.max)})`)
  s.wins.forEach((w, t) => row(`wins ${TEAM_NAMES[t] ?? t}`, rt(w)))
  L.push("Zones (s per match)")
  s.zoneHold.forEach((z, t) => row(`scoring ${TEAM_NAMES[t] ?? t}`, `${ms(z, f0)}   in a zone ${ms(s.zonePresent[t]!, f0)}`))
  row("contested zone-seconds", ms(s.contested, f0))
  row("captures", ms(s.captures))
  L.push("Carriers")
  row("sinks per match", ms(s.sinksPerMatch, (v) => v.toFixed(2)))
  row("time to sink", s.timeToSink.n ? `mean ${min(s.timeToSink.mean)}, median ${min(s.timeToSink.median)}, p10 ${min(s.timeToSink.p10)}, p90 ${min(s.timeToSink.p90)} (n ${s.timeToSink.n})` : "none sank")
  row("first sink at", mm(s.firstSink))
  row("sunk by (last hit)", Object.entries(s.sinkCause).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "–")
  L.push("  damage taken by source (hp per match, share):")
  for (const k of [...SHIP_SOURCES].sort((a, b) => s.shipDamageShare[b] - s.shipDamageShare[a])) if (s.shipDamage[k].mean > 0) row(`  ${k}`, `${pad(ms(s.shipDamage[k], f0), 14)} ${pc(s.shipDamageShare[k])}`)
  L.push("Air (per match)")
  row("kills by weapon", KILL_WEAPONS.filter((k) => s.kills[k].mean > 0).map((k) => `${k} ${f1(s.kills[k].mean)}`).join(", "))
  row("deaths by type", UNIT_TYPES.map((u) => `${u} ${f1(s.deaths[u].mean)}`).join(", "))
  for (const [k, v] of Object.entries(s.killMatrix)) {
    const tot = UNIT_TYPES.reduce((a, u) => a + v[u], 0)
    if (tot) row(`  ${k} killed`, UNIT_TYPES.map((u) => `${u} ${f1(v[u] / s.matches)}`).join(", "))
  }
  row("sorties", UNIT_TYPES.map((u) => `${u} ${f1(s.sorties[u].mean)}`).join(", "))
  row("landings", UNIT_TYPES.map((u) => `${u} ${f1(s.landings[u].mean)}`).join(", "))
  for (const u of UNIT_TYPES) row(`lost per sortie ${u}`, `${rt(s.attrition[u])}, ${f0(s.sortieLength[u])} s out`)
  row("AIM-9 hit", rt(s.missileHit))
  row("AIM-9 flared (of locked)", rt(s.missileDecoy))
  row("AIM-9 shot down", rt(s.missileIntercepted))
  row("SAM hit", rt(s.samHit))
  row("SAM flared", rt(s.samDecoy))
  row("5-inch hit (jet or ship)", rt(s.shellHit))
  row("bomb direct hit", rt(s.bombDirect))
  row("bomb near miss", rt(s.bombNear))
  row("bomb shot down", rt(s.bombIntercepted))
  row("parked jets destroyed", Object.entries(s.deckKills).map(([k, v]) => `${k} ${f1(v.mean)}`).join(", ") || "none")
  row("CIWS intercepts", ms(s.intercepts))
  row("boats", `launched ${f1(s.boats.launched.mean)}, sunk ${f1(s.boats.sunk.mean)}, recovered ${f1(s.boats.recovered.mean)}, kills ${f1(s.boats.kills.mean)}`)
  if (s.speed.n) row("sim speed", `${f0(s.speed.mean)}× real time per core`)
  return L.join("\n")
}

/** Several variants side by side (a sweep). */
export function compareReport(list: readonly Summary[]): string {
  const cols = list.map((s) => s.variant)
  const w = Math.max(14, ...cols.map((c) => c.length + 2))
  const rows: [string, (s: Summary) => string][] = [
    ["finished", (s) => pc(s.ended.p)],
    ["length", (s) => mm(s.length)],
    ["sinks/match", (s) => f1(s.sinksPerMatch.mean)],
    ["time to sink", (s) => min(s.timeToSink.mean)],
    ["contested s", (s) => f0(s.contested.mean)],
    ["top win rate", (s) => pc(Math.max(...s.wins.map((x) => x.p)))],
    ...SHIP_SOURCES.map((k): [string, (s: Summary) => string] => [`dmg ${k}`, (s) => f0(s.shipDamage[k].mean)]),
    ["AIM-9 hit", (s) => pc(s.missileHit.p)],
    ["bomb direct", (s) => pc(s.bombDirect.p)],
    ["jet deaths", (s) => f1(s.deaths.hornet.mean + s.deaths.f35.mean)],
  ]
  const L = [pad("", 16) + cols.map((c) => pad(c, w)).join("")]
  for (const [k, f] of rows) L.push(pad(k, 16) + list.map((s) => pad(f(s), w)).join(""))
  return L.join("\n")
}

// ---- HTML -------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

function lineChart(title: string, xs: readonly number[], series: readonly { name: string; color: string; ys: readonly number[] }[], xLabel: (x: number) => string): string {
  const W = 560
  const H = 220
  const P = 34
  const xmax = Math.max(1, ...xs)
  const ymax = Math.max(1, ...series.flatMap((s) => s.ys))
  const X = (x: number) => P + (x / xmax) * (W - P - 10)
  const Y = (y: number) => H - P + -(y / ymax) * (H - P - 14)
  const paths = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.ys.map((y, i) => `${X(xs[i]!).toFixed(1)},${Y(y).toFixed(1)}`).join(" ")}"/>`).join("")
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => `<text x="${X(k * xmax)}" y="${H - 14}" text-anchor="middle">${xLabel(k * xmax)}</text><text x="${P - 4}" y="${Y(k * ymax) + 4}" text-anchor="end">${Math.round(k * ymax)}</text>`).join("")
  const legend = series.map((s, i) => `<text x="${P + 8 + i * 90}" y="12" fill="${s.color}">■ ${esc(s.name)}</text>`).join("")
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}"><line x1="${P}" y1="${H - P}" x2="${W - 10}" y2="${H - P}" stroke="#555"/><line x1="${P}" y1="10" x2="${P}" y2="${H - P}" stroke="#555"/>${ticks}${legend}${paths}</svg></figure>`
}

function barChart(title: string, bars: readonly { label: string; value: number; note?: string; color?: string }[]): string {
  const W = 560
  const row = 20
  const H = bars.length * row + 10
  const max = Math.max(1e-9, ...bars.map((b) => b.value))
  const L = 120
  const body = bars
    .map((b, i) => {
      const w = (b.value / max) * (W - L - 90)
      return `<text x="${L - 6}" y="${i * row + 15}" text-anchor="end">${esc(b.label)}</text><rect x="${L}" y="${i * row + 4}" width="${w.toFixed(1)}" height="${row - 6}" fill="${b.color ?? "#5ab0ff"}"/><text x="${L + w + 6}" y="${i * row + 15}">${esc(b.note ?? f1(b.value))}</text>`
    })
    .join("")
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}">${body}</svg></figure>`
}

/** A one-page HTML report (inline SVG, no scripts) for every variant. */
export function htmlReport(list: readonly Summary[], notes: readonly string[]): string {
  const sections = list.map((s) => {
    const charts = [
      lineChart(
        "Mean score over time",
        s.scoreTimeline.t,
        s.scoreTimeline.mean.map((ys, t) => ({ name: TEAM_NAMES[t] ?? `${t}`, color: TEAM_COLORS[t] ?? "#fff", ys })),
        (x) => `${Math.round(x / 60)}m`,
      ),
      barChart(
        "Carrier damage by source (hp per match)",
        [...SHIP_SOURCES].sort((a, b) => s.shipDamage[b].mean - s.shipDamage[a].mean).map((k) => ({ label: k, value: s.shipDamage[k].mean, note: `${f0(s.shipDamage[k].mean)} (${pc(s.shipDamageShare[k])})` })),
      ),
      barChart(
        "Time to sink (carriers per minute of life)",
        s.timeToSink.histogram.map((v, i) => ({ label: `${i}–${i + 1} min`, value: v, note: `${v}` })).filter((_, i, a) => i <= Math.max(5, a.findLastIndex((b) => b.value > 0))),
      ),
      barChart(
        "Jets and boats destroyed by weapon (per match)",
        KILL_WEAPONS.map((k) => ({ label: k, value: s.kills[k].mean })),
      ),
      barChart(
        "Win rate",
        s.wins.map((w, t) => ({ label: TEAM_NAMES[t] ?? `${t}`, value: w.p, note: `${pc(w.p)} (${w.k}/${w.n})`, color: TEAM_COLORS[t] })),
      ),
    ]
    return `<section><h2>${esc(s.variant)}</h2><pre>${esc(textReport(s))}</pre><div class="charts">${charts.join("")}</div></section>`
  })
  const compare = list.length > 1 ? `<section><h2>Comparison</h2><pre>${esc(compareReport(list))}</pre></section>` : ""
  return `<!doctype html><meta charset="utf-8"><title>Carrier balance</title><style>
body{background:#0e1116;color:#d7dde6;font:13px/1.4 ui-monospace,monospace;margin:24px}h1,h2{font-weight:600}
pre{background:#161b22;padding:12px;overflow:auto}figure{margin:12px 0}figcaption{margin-bottom:4px;color:#9aa7b4}
svg{width:560px;max-width:100%;background:#161b22}svg text{fill:#c9d1d9;font-size:11px}.charts{display:flex;flex-wrap:wrap;gap:16px}
</style><h1>Carrier balance</h1><pre>${esc(notes.join("\n"))}</pre>${compare}${sections.join("")}`
}
