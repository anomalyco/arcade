import { DT } from "../config"
import { clearLine, pushOut, raycast, type Rect } from "../geom"
import type { MapDef } from "../maps"
import type { Intent, Player, World } from "./world"
import { SPELL_IDS, SPELL_LIMITS, spellDefaults, type SpellConfig, type SpellId } from "./spell-config"

export type Orbiter = { kind: "player" | "skeleton" | "prop"; id: string; phase: number }
export type Moon = { id: number; by: string; x: number; y: number; born: number; end: number; vx: number; vy: number; radius: number; tiny: boolean; orbiters: Orbiter[] }
export type Skeleton = { id: number; by: string; x: number; y: number; vx: number; vy: number; aim: number; born: number; end: number; health: number; crawl: boolean; target: string; aggro: string; aggroUntil: number; attackAt: number; readyAt: number; struckAt: number; hitAt: number }
export type Scroll = { id: number; spell: SpellId; x: number; y: number; h: number; prop?: number; reader: string; end: number }
export type SpellProp = { id: number; x: number; y: number; h: number; angle: number }
export type SpellFlash = { id: number; kind: "cast" | "fizzle" | "pop" | "burn"; spell: SpellId | null; x: number; y: number; by: string; at: number; quality: number }
export type SpellView = { moons: Moon[]; skeletons: Skeleton[]; scrolls: Scroll[]; props: SpellProp[]; flashes: SpellFlash[]; learned: Record<string, SpellId[]>; ready: Record<string, Record<SpellId, number>>; config: SpellConfig; forced: string[] }
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
  private ready: Record<string, Record<SpellId, number>> = {}
  private kicks: Kick[] = []
  constructor(private map: MapDef) {
    this.props = map.props.map((p, id) => ({ id, x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2, h: 0, angle: 0 }))
  }
  snapshot(): SpellView {
    return structuredClone({ moons: this.moons, skeletons: this.skeletons, scrolls: this.scrolls, props: this.props, flashes: this.flashes, learned: this.learned, ready: this.ready, config: this.config, forced: [...new Set([...this.moons.flatMap(m => m.orbiters), ...this.kicks].filter(o => o.kind === "player").map(o => o.id))] })
  }
  remove(id: string) {
    delete this.learned[id]; delete this.ready[id]
    for (const m of this.moons) m.orbiters = m.orbiters.filter(o => o.kind !== "player" || o.id !== id)
    this.kicks = this.kicks.filter(o => o.kind !== "player" || o.id !== id)
  }
  spawn(p: Player) { this.remove(p.id); this.learned[p.id] = [...SPELL_IDS]; this.ready[p.id] = { moon: 0, necromancy: 0 } }
  private flash(w: World, kind: SpellFlash["kind"], by: Player, spell: SpellId | null, quality = 1, x = by.x, y = by.y) {
    this.flashes.push({ id: ++this.next, kind, by: by.id, spell, quality, x, y, at: w.time })
  }
  intent(w: World, p: Player, i: Intent) {
    if (p.alive && w.phase === "play" && i.cast) this.cast(w, p, i.cast)
    // Legacy/hostile clients cannot turn left click into the bare-kit melee trigger.
    return { ...i, fire: false, enter: false, equip: false, use: false }
  }
  private cast(w: World, p: Player, c: NonNullable<Intent["cast"]>) {
    const spell = c.spell, ready = this.ready[p.id]
    if (!spell || !SPELL_IDS.includes(spell) || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !ready || w.time < ready[spell]) return
    // All unlocks, quality, cooldowns and limits come from the authoritative rules.
    const aim = Math.atan2(c.y - p.y, c.x - p.x), dx = Math.cos(aim), dy = Math.sin(aim)
    if (spell === "moon") {
      if (this.moons.length >= SPELL_LIMITS.moons || this.moons.filter(m => m.by === p.id).length >= SPELL_LIMITS.moon) return
      const offset = Math.min(1.1, Math.max(0, raycast(p.x,p.y,dx,dy,w.blockers,1.35)-0.25))
      this.moons.push({ id: ++this.next, by: p.id, x: p.x+dx*offset, y: p.y+dy*offset, vx: dx*this.config.moonSpeed, vy: dy*this.config.moonSpeed, born: w.time, end: w.time+this.config.moonLife, radius: this.config.moonSize, tiny: false, orbiters: [] })
      ready.moon = w.time + this.config.moonCooldown
    } else {
      if (this.skeletons.length >= SPELL_LIMITS.skeletons || this.skeletons.filter(s => s.by === p.id).length >= SPELL_LIMITS.necromancy) return
      const d = Math.min(6, Math.max(3, Math.hypot(c.x-p.x,c.y-p.y)), raycast(p.x,p.y,dx,dy,w.blockers,6.5)-0.5)
      if (d < 2.5) return
      const s: Skeleton = { id: ++this.next, by: p.id, x: p.x+dx*d, y: p.y+dy*d, vx: 0, vy: 0, aim, born: w.time, end: w.time+this.config.skeletonLife, health: this.config.skeletonHealth, crawl: false, target: "", aggro: "", aggroUntil: 0, attackAt: 0, readyAt: 0, struckAt: -10, hitAt: -10 }
      pushOut(s,0.3,w.solids)
      if (Math.hypot(s.x-p.x,s.y-p.y)<2.5 || !clearLine(p.x,p.y,s.x,s.y,w.blockers) || this.skeletons.some(q=>Math.hypot(q.x-s.x,q.y-s.y)<0.8)) return
      this.skeletons.push(s)
      ready.necromancy = w.time + this.config.skeletonCooldown
    }
    this.flash(w,"cast",p,spell)
  }
  bonk(w: World, p: Player): void {
    let nearest: Skeleton | undefined, distance = 1.65
    for (const s of this.skeletons) {
      const d = Math.hypot(s.x-p.x,s.y-p.y)
      if (d < distance && Math.cos(Math.atan2(s.y-p.y,s.x-p.x)-p.aim) > 0.45 && clearLine(p.x,p.y,s.x,s.y,w.blockers)) { nearest=s; distance=d }
    }
    if (nearest) this.hurtSkeleton(w, nearest, 18, p.id)
  }
  private hurtSkeleton(w: World, s: Skeleton, damage: number, by: string) {
    s.health -= damage; s.aggro = by; s.aggroUntil = w.time + 4; s.hitAt = w.time
    s.attackAt = 0; s.readyAt = w.time + 0.4
  }
  private entity(w: World, o: Orbiter): { x: number; y: number } | undefined {
    if (o.kind === "player") { const p = w.players.get(o.id); return p?.alive ? p : undefined }
    if (o.kind === "skeleton") return this.skeletons.find(s => s.id === Number(o.id) && s.health > 0)
    return this.props[Number(o.id)]
  }
  private occupied(kind: Orbiter["kind"], id: string) { return this.moons.some(m => m.orbiters.some(o => o.kind === kind && o.id === id)) }
  step(w: World) {
    this.flashes = this.flashes.filter(f => w.time - f.at < 1.1)
    for (const s of this.skeletons) {
      s.vx=s.vy=0
      if (s.health <= 0 || w.time >= s.end) continue
      if (w.time - s.born < this.config.skeletonRise || this.occupied("skeleton",String(s.id))) continue
      const p = skeletonTarget(s,w.players.values(),w.time)
      if (s.attackAt && s.target !== p?.id) s.attackAt = 0
      s.target = p?.id ?? ""
      if (!p) continue
      const d = Math.hypot(p.x-s.x,p.y-s.y)
      s.aim = Math.atan2(p.y-s.y,p.x-s.x)
      if (s.attackAt && w.time >= s.attackAt) {
        if (d < 1.45 && clearLine(s.x,s.y,p.x,p.y,w.blockers)) w.damage(p,this.config.skeletonDamage,w.players.get(s.by) ?? p,"melee",s.x,s.y)
        s.attackAt=0; s.struckAt=w.time
      }
      if (d < 1.25 && w.time >= s.readyAt) { s.attackAt=w.time+0.35; s.readyAt=w.time+1.3 }
      else if (d > 1 && !s.attackAt && w.time-s.struckAt>0.25 && w.time-s.hitAt>0.25) {
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
      if (w.time-m.born < this.config.moonAnticipation) continue
      const speed=Math.hypot(m.vx,m.vy), reach=raycast(m.x,m.y,m.vx/speed,m.vy/speed,w.blockers,speed*DT+0.2)
      if (reach < speed*DT+0.2) { m.vx=-m.vx; m.vy=-m.vy }
      m.x+=m.vx*DT; m.y+=m.vy*DT
      m.radius=(this.config.moonSize+(w.time-m.born)*this.config.moonGrowth)*(m.tiny ? 0.35 : 1)
      const collect = (kind: Orbiter["kind"], id: string, p: {x:number;y:number}) => {
        if (m.tiny || this.occupied(kind,id) || kind === "player" && id === m.by && w.time-m.born < 1.1) return
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
