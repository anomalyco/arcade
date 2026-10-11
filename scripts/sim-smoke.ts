import { World, type Participant } from "../shared/sim/world"
const ps: Participant[] = [{ id: "me", name: "Dax", human: false, picks: { robber: "muscle", cop: "cruiser" } }]
for (let k = 0; k < 4; k++) ps.push({ id: "bot" + k, name: "Bot " + k, human: false, picks: { robber: "compact", cop: k % 2 ? "interceptor" : "cruiser" } })
const w = new World(1234, ps)
let last = ""
for (let i = 0; i < 30 * 1200 && w.round < 6; i++) {
  w.step(1 / 30)
  if (w.phase !== last) { last = w.phase; if (last === "end") console.log(`round ${w.round} t=${w.t.toFixed(1)} ${w.escaped ? "ESCAPED" : "BUSTED"} stars=${w.stars}`) }
  for (const e of w.drainEvents()) if (e.kind !== "near") console.log("   ", e.kind, e.text)
}
console.log([...w.standings.values()].map((s) => `${s.name}:${Math.round(s.score)}`).join(" "))
