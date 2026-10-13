import { DT } from "../config"
import { clearLine, pushOut, raycast, type Rect } from "../geom"
import type { MapDef } from "../maps"
import type { Intent, Player, World } from "./world"
import { spellDefaults, type SpellConfig, type SpellId } from "./spell-config"

export type Orbiter = { kind: "player" | "skeleton" | "prop"; id: string; phase: number }
export type Moon = { id: number; by: string; x: number; y: number; born: number; end: number; vx: number; vy: number; radius: number; tiny: boolean; orbiters: Orbiter[] }
export type Skeleton = { id: number; by: string; x: number; y: number; vx: number; vy: number; aim: number; born: number; end: number; health: number; crawl: boolean; target: string; aggro: string; aggroUntil: number; attackAt: number; readyAt: number }
export type Scroll = { id: number; spell: SpellId; x: number; y: number; h: number; prop?: number; reader: string; end: number }
export type SpellProp = { id: number; x: number; y: number; h: number; angle: number }
export type SpellFlash = { id: number; kind: "cast" | "fizzle" | "pop" | "burn"; spell: SpellId | null; x: number; y: number; by: string; at: number; quality: number }
export type SpellView = { moons: Moon[]; skeletons: Skeleton[]; scrolls: Scroll[]; props: SpellProp[]; flashes: SpellFlash[]; learned: Record<string, SpellId[]>; config: SpellConfig; forced: string[] }
type Kick = Orbiter & { vx: number; vy: number; until: number }

/** Fixed angular speed, radial growth and tangent velocity, independent of render frame rate. */
export function orbitPoint(moon: Pick<Moon, "x" | "y" | "radius" | "born">, phase: number, time: number) {
  const a = phase + (time - moon.born) * 2.4, r = moon.radius + 0.65
  return { x: moon.x + Math.cos(a) * r, y: moon.y + Math.sin(a) * r, vx: -Math.sin(a) * r * 2.4, vy: Math.cos(a) * r * 2.4 }
}

export function skeletonTarget(s: Skeleton, players: Iterable<Player>, now: number): Player | null {
  let best: Player | null = null, distance = Infinity
  for (const p of players) {
    if (!p.alive || (s.crawl && p.id !== s.by)) continue
    if (s.aggro === p.id && now < s.aggroUntil) return p
    const d = Math.hypot(p.x - s.x, p.y - s.y)
    if (d < distance) { best = p; distance = d }
  }
  return best
}

/** Authoritative, bounded spell state. Random choices use only the World's seeded RNG. */
export class SpellState {
  config = spellDefaults()
  moons: Moon[] = []
  skeletons: Skeleton[] = []
  scrolls: Scroll[] = []
  props: SpellProp[]
  flashes: SpellFlash[] = []
  learned: Record<string, SpellId[]> = {}
  private next = 0
  private ready: Record<string, number> = {}
  private kicks: Kick[] = []
  private corpses: { x: number; y: number; at: number }[] = []
  constructor(private map: MapDef) {
    this.props = map.props.map((p, id) => ({ id, x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2, h: 0, angle: 0 }))
    map.props.forEach((p, i) => { if (p.kind === "table") this.scrolls.push({ id: ++this.next, spell: this.scrolls.length % 2 ? "necromancy" : "moon", x: this.props[i]!.x, y: this.props[i]!.y, h: 0.82, prop: i, reader: "", end: 0 }) })
  }
  snapshot(): SpellView {
    return structuredClone({ moons: this.moons, skeletons: this.skeletons, scrolls: this.scrolls, props: this.props, flashes: this.flashes, learned: this.learned, config: this.config, forced: [...new Set([...this.moons.flatMap(m => m.orbiters), ...this.kicks].filter(o => o.kind === "player").map(o => o.id))] })
  }
  remove(id: string) {
    delete this.learned[id]; delete this.ready[id]
    for (const m of this.moons) m.orbiters = m.orbiters.filter(o => o.kind !== "player" || o.id !== id)
    this.kicks = this.kicks.filter(o => o.kind !== "player" || o.id !== id)
  }
  spawn(p: Player) { this.remove(p.id); this.learned[p.id] = []; this.ready[p.id] = 0 }
  death(w: World, p: Player) {
    const known = this.learned[p.id] ?? []
    if (known.length && this.scrolls.length < 64) this.scrolls.push({ id: ++this.next, spell: known[w.rng.int(known.length)]!, x: p.x, y: p.y, h: 0.04, reader: "", end: 0 })
    this.learned[p.id] = []
    this.corpses.push({ x: p.x, y: p.y, at: w.time })
  }
  private flash(w: World, kind: SpellFlash["kind"], by: Player, spell: SpellId | null, quality = 1, x = by.x, y = by.y) {
    this.flashes.push({ id: ++this.next, kind, by: by.id, spell, quality, x, y, at: w.time })
  }
  intent(w: World, p: Player, i: Intent) {
    if (i.enter) {
      const scroll = this.scrolls.find(s => !s.reader && Math.hypot(p.x - s.x, p.y - s.y) < 2.4 && clearLine(p.x, p.y, s.x, s.y, w.blockers))
      if (scroll && !this.scrolls.some(s => s.reader === p.id)) { scroll.reader = p.id; scroll.end = w.time + 2 }
    }
    if (i.cast && w.time >= (this.ready[p.id] ?? 0)) {
      this.ready[p.id] = w.time + 1.1
      const c = i.cast, spell = c.spell
      if (!spell || !(this.learned[p.id] ?? []).includes(spell)) this.flash(w, "fizzle", p, null, 0)
      else {
        const quality = Math.max(0, Math.min(1, c.quality)), tiny = quality < 0.999
        this.flash(w, "cast", p, spell, quality)
        const aim = Math.atan2(c.y - p.y, c.x - p.x)
        if (spell === "moon" && this.moons.length < 8) {
          const a = aim + (tiny ? Math.PI / 2 : 0), speed = this.config.moonSpeed * (tiny ? 0.4 : 1)
          const offset=Math.min(1.1,Math.max(0,raycast(p.x,p.y,Math.cos(a),Math.sin(a),w.blockers,1.35)-0.25))
          this.moons.push({ id: ++this.next, by: p.id, x: p.x + Math.cos(a) * offset, y: p.y + Math.sin(a) * offset, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, born: w.time, end: w.time + this.config.moonLife, radius: this.config.moonSize * (tiny ? 0.35 : 1), tiny, orbiters: [] })
        } else if (spell === "necromancy" && this.skeletons.length < 12) {
          const d = Math.min(6, Math.hypot(c.x - p.x, c.y - p.y), Math.max(0.5, raycast(p.x, p.y, Math.cos(aim), Math.sin(aim), w.blockers, 6) - 0.5))
          let x = p.x + Math.cos(aim) * d, y = p.y + Math.sin(aim) * d
          const corpse = this.corpses.find(c => Math.hypot(c.x - x, c.y - y) < 2 && clearLine(p.x,p.y,c.x,c.y,w.blockers))
          if (corpse) { x = corpse.x; y = corpse.y; this.corpses.splice(this.corpses.indexOf(corpse),1) }
          const s: Skeleton = { id: ++this.next, by: p.id, x, y, vx: 0, vy: 0, aim, born: w.time, end: w.time + this.config.skeletonLife, health: this.config.skeletonHealth, crawl: tiny, target: "", aggro: "", aggroUntil: 0, attackAt: 0, readyAt: 0 }
          pushOut(s, 0.3, w.solids)
          this.skeletons.push(s)
        }
      }
    }
    return { ...i, enter: false, equip: false }
  }
  bonk(w: World, p: Player): void {
    let nearest: Skeleton | undefined, distance = 1.65
    for (const s of this.skeletons) {
      const d = Math.hypot(s.x-p.x,s.y-p.y)
      if (d < distance && Math.cos(Math.atan2(s.y-p.y,s.x-p.x)-p.aim) > 0.45 && clearLine(p.x,p.y,s.x,s.y,w.blockers)) { nearest=s; distance=d }
    }
    if (nearest) this.hurtSkeleton(w, nearest, 18, p.id)
  }
  private hurtSkeleton(w: World, s: Skeleton, damage: number, by: string) { s.health -= damage; s.aggro = by; s.aggroUntil = w.time + 4 }
  private entity(w: World, o: Orbiter): { x: number; y: number } | undefined {
    if (o.kind === "player") { const p = w.players.get(o.id); return p?.alive ? p : undefined }
    if (o.kind === "skeleton") return this.skeletons.find(s => s.id === Number(o.id) && s.health > 0)
    return this.props[Number(o.id)]
  }
  private occupied(kind: Orbiter["kind"], id: string) { return this.moons.some(m => m.orbiters.some(o => o.kind === kind && o.id === id)) }
  step(w: World) {
    this.flashes = this.flashes.filter(f => w.time - f.at < 1.1)
    this.corpses = this.corpses.filter(c => w.time - c.at < 20).slice(-32)
    for (const s of this.scrolls) {
      if (s.prop !== undefined) { const p = this.props[s.prop]!; s.x = p.x; s.y = p.y; s.h = p.h + 0.82 }
      const p = w.players.get(s.reader)
      if (s.reader && (!p?.alive || Math.hypot(p.x-s.x,p.y-s.y) > 3)) { s.reader=""; s.end=0 }
      if (p?.alive && s.reader && w.time >= s.end) {
        const known = this.learned[p.id] ?? (this.learned[p.id] = [])
        if (!known.includes(s.spell)) known.push(s.spell)
        this.flash(w, "burn", p, s.spell, 1, s.x, s.y)
      }
    }
    this.scrolls = this.scrolls.filter(s => !s.reader || w.time < s.end)
    for (const s of this.skeletons) {
      s.vx=s.vy=0
      if (s.health <= 0 || w.time >= s.end) continue
      if (w.time - s.born < this.config.skeletonRise || this.occupied("skeleton",String(s.id))) continue
      const p = skeletonTarget(s,w.players.values(),w.time)
      s.target = p?.id ?? ""
      if (!p) continue
      const d = Math.hypot(p.x-s.x,p.y-s.y)
      s.aim = Math.atan2(p.y-s.y,p.x-s.x)
      if (s.attackAt && w.time >= s.attackAt) {
        if (d < 1.45 && clearLine(s.x,s.y,p.x,p.y,w.blockers)) w.damage(p,this.config.skeletonDamage,w.players.get(s.by) ?? p,"melee",s.x,s.y)
        s.attackAt=0
      }
      if (d < 1.25 && w.time >= s.readyAt) { s.attackAt=w.time+0.35; s.readyAt=w.time+1.3 }
      else if (d > 1 && !s.attackAt) {
        const speed = this.config.skeletonSpeed * (s.crawl ? 0.45 : 1) * (0.8 + 0.2 * Math.sin(w.time*5+s.id))
        let steer=s.aim
        if (raycast(s.x,s.y,Math.cos(steer),Math.sin(steer),w.solids,0.9)<0.6) {
          const choices=[0.65,-0.65,1.3,-1.3,1.8,-1.8].map(a=>s.aim+a)
          steer=choices.find(a=>raycast(s.x,s.y,Math.cos(a),Math.sin(a),w.solids,0.9)>0.65)??s.aim
        }
        s.vx=Math.cos(steer)*speed; s.vy=Math.sin(steer)*speed
        s.x+=s.vx*DT; s.y+=s.vy*DT; pushOut(s,0.3,w.solids)
      }
    }
    for (const m of this.moons) {
      const speed=Math.hypot(m.vx,m.vy), reach=raycast(m.x,m.y,m.vx/speed,m.vy/speed,w.blockers,speed*DT+0.2)
      if (reach < speed*DT+0.2) { m.vx=-m.vx; m.vy=-m.vy }
      m.x+=m.vx*DT; m.y+=m.vy*DT
      m.radius=(this.config.moonSize+(w.time-m.born)*this.config.moonGrowth)*(m.tiny ? 0.35 : 1)
      const collect = (kind: Orbiter["kind"], id: string, p: {x:number;y:number}) => {
        if (m.tiny || this.occupied(kind,id) || kind === "player" && id === m.by && w.time-m.born < 0.65) return
        const rect=kind==="prop"?this.map.props[Number(id)]?.rect:undefined
        const dx=Math.max(0,Math.abs(p.x-m.x)-(rect?(rect[2]-rect[0])/2:0))
        const dy=Math.max(0,Math.abs(p.y-m.y)-(rect?(rect[3]-rect[1])/2:0))
        if (Math.hypot(dx,dy) > m.radius+this.config.moonPull || !clearLine(m.x,m.y,p.x,p.y,w.blockers)) return
        m.orbiters.push({ kind,id,phase: Math.atan2(p.y-m.y,p.x-m.x)-(w.time-m.born)*2.4 })
      }
      for (const p of w.players.values()) if(p.alive) collect("player",p.id,p)
      for (const s of this.skeletons) collect("skeleton",String(s.id),s)
      for (const p of this.props) collect("prop",String(p.id),p)
      for (const o of m.orbiters) {
        const p=this.entity(w,o); if (!p) continue
        const at=orbitPoint(m,o.phase,w.time); Object.assign(p,at); pushOut(p,0.32,w.blockers)
        if(o.kind === "prop") Object.assign(p,{h:0.7,angle:(w.time-m.born)*2.4})
      }
      if (w.time >= m.end) {
        this.flashes.push({id:++this.next,kind:"pop",by:m.by,spell:"moon",x:m.x,y:m.y,at:w.time,quality:m.tiny?0.3:1})
        for (const o of m.orbiters) {
          const p=this.entity(w,o); if (!p) continue
          const a=Math.atan2(p.y-m.y,p.x-m.x)
          this.kicks.push({...o,vx:Math.cos(a)*this.config.moonFling,vy:Math.sin(a)*this.config.moonFling,until:w.time+0.6})
          if(o.kind==="player") { const q=w.players.get(o.id)!; w.damage(q,this.config.moonDamage,w.players.get(m.by)??q,"melee",m.x,m.y) }
          if(o.kind==="skeleton") this.hurtSkeleton(w,p as Skeleton,this.config.moonDamage,m.by)
        }
      }
    }
    this.moons=this.moons.filter(m=>w.time<m.end)
    this.skeletons=this.skeletons.filter(s=>s.health>0 && w.time<s.end)
    for(const k of this.kicks) {
      const p=this.entity(w,k); if(!p) continue
      p.x+=k.vx*DT; p.y+=k.vy*DT; k.vx*=0.9; k.vy*=0.9; pushOut(p,0.32,w.blockers)
      if(k.kind==="prop") Object.assign(p,{h:Math.max(0,(k.until-w.time)*1.1)})
    }
    this.kicks=this.kicks.filter(k=>w.time<k.until)
    const props: Rect[] = []
    for (const p of this.props) {
      const base=this.map.props[p.id]!; if(!base.solid || p.h>0.2) continue
      const hw=(base.rect[2]-base.rect[0])/2, hd=(base.rect[3]-base.rect[1])/2
      props.push([p.x-hw,p.y-hd,p.x+hw,p.y+hd])
    }
    w.solids=[...w.blockers,...props]
  }
}
