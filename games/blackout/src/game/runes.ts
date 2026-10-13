import type { SpellConfig, SpellId } from "../../shared/sim/spell-config"

export type Point = { x: number; y: number }
export const RUNES: Record<SpellId, Point[]> = {
  // One held stroke: close the circle, move inward, finish with the dot.
  moon: [...Array.from({ length: 49 }, (_, i) => ({ x: Math.cos(i / 48 * Math.PI * 2 - Math.PI / 2), y: Math.sin(i / 48 * Math.PI * 2 - Math.PI / 2) })), { x: 0, y: 0 }, { x: 0.03, y: 0.02 }, { x: -0.02, y: 0.02 }],
  necromancy: [{ x: -0.8, y: -1 }, { x: 0.7, y: -0.55 }, { x: -0.65, y: 0 }, { x: 0.65, y: 0.5 }, { x: 0.45, y: 0.9 }, { x: 0, y: 1 }, { x: -0.35, y: 0.75 }],
}

/** $1-style arc-length resampling. Never mutates a captured stroke. */
export function resample(points: readonly Point[], count = 64): Point[] {
  if (points.length < 2) return []
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i-1]! + Math.hypot(points[i]!.x-points[i-1]!.x,points[i]!.y-points[i-1]!.y))
  const total = lengths.at(-1)!
  if (total < 0.001) return []
  const out: Point[] = []
  let j = 1
  for (let i=0;i<count;i++) {
    const d = total*i/(count-1)
    while(j<points.length-1 && lengths[j]!<d) j++
    const a=points[j-1]!, b=points[j]!, u=(d-lengths[j-1]!)/Math.max(0.000001,lengths[j]!-lengths[j-1]!)
    out.push({x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u})
  }
  return out
}
function normalize(points: readonly Point[]) {
  const p=resample(points)
  if(!p.length) return p
  const x=p.reduce((s,p)=>s+p.x,0)/p.length, y=p.reduce((s,p)=>s+p.y,0)/p.length
  const size=Math.max(Math.max(...p.map(p=>p.x))-Math.min(...p.map(p=>p.x)), Math.max(...p.map(p=>p.y))-Math.min(...p.map(p=>p.y)))
  return p.map(p=>({x:(p.x-x)/size,y:(p.y-y)/size}))
}
const templates: { spell: SpellId; points: Point[] }[] = []
for(let start=0;start<16;start++) for(const direction of [-1,1]) {
  const a=start*Math.PI/8, c=Math.cos(a), s=Math.sin(a)
  templates.push({spell:"moon",points:normalize(RUNES.moon.map(p=>({x:p.x*c-p.y*s,y:(p.x*s+p.y*c)*direction})))})
}
for(const reversed of [false,true]) for(const angle of [-0.2,0,0.2]) {
  const points=RUNES.necromancy.map(p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle)}))
  templates.push({spell:"necromancy",points:normalize(reversed?points.reverse():points)})
}
export function recognize(points: readonly Point[], config: Pick<SpellConfig,"matchThreshold"|"cleanThreshold">): { spell: SpellId | null; confidence: number; quality: number } {
  if(points.length<5 || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) return {spell:null,confidence:0,quality:0}
  const p=normalize(points)
  if(!p.length) return {spell:null,confidence:0,quality:0}
  let distance=Infinity, spell: SpellId|null=null
  for(const t of templates) {
    const d=p.reduce((sum,v,i)=>sum+Math.hypot(v.x-t.points[i]!.x,v.y-t.points[i]!.y),0)/p.length
    if(d<distance) {distance=d;spell=t.spell}
  }
  let confidence=Math.max(0,1-distance*3.5)
  // A plain ring is not Moon Ball: its last point must be inside, near the dot.
  if(spell==="moon") {
    const xs=points.map(p=>p.x), ys=points.map(p=>p.y), x=(Math.max(...xs)+Math.min(...xs))/2, y=(Math.max(...ys)+Math.min(...ys))/2
    const size=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)), end=points.at(-1)!
    if(Math.hypot(end.x-x,end.y-y)>size*0.3) confidence*=0.5
  }
  return {spell:confidence>=config.matchThreshold?spell:null,confidence,quality:confidence>=config.cleanThreshold?1:Math.max(0.15,confidence)}
}
