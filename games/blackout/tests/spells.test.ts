import { describe, expect, mock, test } from "bun:test"
import { BUILD } from "../shared/build.gen"
import { DT } from "../shared/config"
import { NO_INTENT, World, type Intent } from "../shared/sim/world"
import { buildSnapshot } from "../shared/sim/view"
import { orbitPoint, skeletonTarget } from "../shared/sim/spells"
import { spellDefaults, type SpellId } from "../shared/sim/spell-config"
import { decodeClient, encodeClient, encodeServer, decodeServer } from "../shared/protocol"
import { RUNES, recognize, resample } from "../src/game/runes"
import { Rng } from "../shared/rng"

const config=spellDefaults()
const world=()=>{const w=new World(17,null,"wizards");w.addHuman("caster","Caster");w.addHuman("other","Other");return w}
const tick=(w:World,n:number)=>{for(let i=0;i<n;i++)w.step()}
function intent(w:World,i:Partial<Intent>,id="caster") {const p=w.players.get(id)!;w.push(id,p.ack+1,{...NO_INTENT,...i});w.step()}
function cast(w:World,spell:SpellId,quality=1,x=12,y=11) {intent(w,{cast:{spell,quality,x,y}})}

describe("rune recognition",()=>{
  for(const spell of ["moon","necromancy"] as const) {
    test(`${spell}: translation, scale, sampling and bounded noise`,()=>{
      const rng=new Rng(91)
      for(let sample=0;sample<30;sample++) {
        const points=resample(RUNES[spell],80+sample).map(p=>({x:450+(p.x+(rng.next()-0.5)*0.07)*75,y:300+(p.y+(rng.next()-0.5)*0.07)*75}))
        const result=recognize(points,config)
        expect(result.spell).toBe(spell);expect(result.quality).toBe(1)
      }
    })
  }
  test("clockwise and counterclockwise circles can start anywhere",()=>{
    for(let i=0;i<12;i++) {
      const a=i*Math.PI/6
      expect(recognize(RUNES.moon.map(p=>({x:p.x*Math.cos(a)-p.y*Math.sin(a),y:-(p.x*Math.sin(a)+p.y*Math.cos(a))})),config).spell).toBe("moon")
    }
  })
  test("sloppy but recognizable casts degrade; dots, lines and plain rings fizzle",()=>{
    const sloppy=resample(RUNES.moon).map((p,i)=>({x:p.x+Math.sin(i*0.7)*0.23,y:p.y+Math.cos(i*0.6)*0.17}))
    const r=recognize(sloppy,config)
    expect(r.spell).toBe("moon");expect(r.quality).toBeLessThan(1)
    for(const stroke of [[],[{x:1,y:1}],Array.from({length:40},(_,i)=>({x:i,y:0})),RUNES.moon.slice(0,49)]) expect(recognize(stroke,config).spell).toBeNull()
  })
})

describe("shared wizard simulation",()=>{
  test("two room connections receive click casts, server cooldowns and host-only tuning",async()=>{
    mock.module("cloudflare:workers",()=>({DurableObject:class{}}))
    const {RoomCore}=await import("../server/room"),core=new RoomCore("rune","wizards")
    const join=(name:string)=>{
      const sent:string[]=[],conn={send:(s:string)=>sent.push(s),close(){}}
      core.message(conn,encodeClient({type:"hello",name,gun:"rifle",equip:"frag",build:BUILD}))
      const welcome=sent.map(decodeServer).find(m=>m?.type==="welcome")!
      if(welcome.type!=="welcome")throw Error("welcome missing")
      return {id:welcome.id,conn,sent}
    }
    const a=join("reader"),b=join("observer")
    core.message(b.conn,encodeClient({type:"spells",config:{...config,moonSpeed:4}}))
    expect(core.world.spells!.config.moonSpeed).toBe(config.moonSpeed)
    core.message(a.conn,encodeClient({type:"spells",config:{...config,moonSpeed:4}}))
    expect(core.world.spells!.config.moonSpeed).toBe(4)
    expect(core.world.spells!.learned[a.id]).toEqual(["moon","necromancy"])
    core.message(a.conn,encodeClient({type:"intent",seq:1,i:{...NO_INTENT,fire:true,cast:{spell:"moon",quality:0,x:12,y:11}}}))
    for(let i=0;i<4;i++)core.step()
    const snap=b.sent.map(decodeServer).filter(m=>m?.type==="snap").at(-1)!
    expect(snap.spells!.moons[0]!.by).toBe(a.id)
    expect(snap.spells!.config.moonSpeed).toBe(4)
    expect(snap.spells!.flashes.some(f=>f.kind==="cast")).toBe(true)
    expect(snap.spells!.moons[0]!.tiny).toBe(false)
    expect(snap.spells!.ready[a.id]!.moon).toBeGreaterThan(snap.t)
    expect(core.world.players.get(a.id)!.meleeReadyAt).toBe(0)
    for(let seq=2;seq<8;seq++) core.message(a.conn,encodeClient({type:"intent",seq,i:{...NO_INTENT,cast:{spell:"moon",quality:1,x:12,y:11}}}))
    for(let i=0;i<8;i++)core.step()
    expect(core.world.spells!.moons).toHaveLength(1)
  })
  test("both spells are ready every life, with no scroll gate or drops",()=>{
    const w=world(),p=w.players.get("caster")!,s=w.spells!
    expect(s.learned.caster).toEqual(["moon","necromancy"])
    cast(w,"moon");expect(s.moons).toHaveLength(1)
    w.damage(p,200,w.players.get("other")!,"melee",p.x+1,p.y)
    expect(s.scrolls).toHaveLength(0)
    w.spawn(p);expect(s.learned.caster).toEqual(["moon","necromancy"])
    expect(s.snapshot().ready.caster).toEqual({moon:0,necromancy:0})
  })
  test("rapid requests respect independent cooldowns and do not queue delayed casts",()=>{
    const w=world(),s=w.spells!
    cast(w,"moon");const x=s.moons[0]!.x
    tick(w,2);expect(s.moons[0]!.x).toBe(x)
    cast(w,"moon");expect(s.moons).toHaveLength(1)
    cast(w,"necromancy",1,6,8);expect(s.skeletons).toHaveLength(1)
    tick(w,Math.ceil(config.moonCooldown/DT));expect(s.moons).toHaveLength(1)
    cast(w,"moon");expect(s.moons).toHaveLength(2)
    tick(w,Math.ceil(config.moonCooldown/DT));cast(w,"moon");expect(s.moons).toHaveLength(2)
  })
  test("summons are separated, stay away from caster and reject blocked close placement",()=>{
    const w=world(),s=w.spells!,p=w.players.get("caster")!
    cast(w,"necromancy",1,p.x,p.y-0.01);expect(s.skeletons).toHaveLength(1)
    expect(Math.hypot(s.skeletons[0]!.x-p.x,s.skeletons[0]!.y-p.y)).toBeGreaterThanOrEqual(2.5)
    p.x=0.7;p.y=12
    tick(w,Math.ceil(config.skeletonCooldown/DT));cast(w,"necromancy",1,-10,12)
    expect(s.skeletons).toHaveLength(1)
  })
  test("a summon can reach over furniture; attacks stop on death or end phase",()=>{
    const w=world(),s=w.spells!,p=w.players.get("caster")!
    cast(w,"necromancy",1,11,11);expect(s.skeletons).toHaveLength(1)
    p.alive=false;s.intent(w,p,{...NO_INTENT,cast:{spell:"moon",quality:1,x:12,y:11}})
    expect(s.moons).toHaveLength(0)
    p.alive=true;w.phase="end";s.intent(w,p,{...NO_INTENT,cast:{spell:"moon",quality:1,x:12,y:11}})
    expect(s.moons).toHaveLength(0)
  })
  test("hitting a skeleton interrupts its wind-up and overrides a nearer target",()=>{
    const w=world(),p=w.players.get("caster")!,q=w.players.get("other")!
    cast(w,"necromancy",1,6,8);const sk=w.spells!.skeletons[0]!
    Object.assign(p,{x:sk.x+0.4,y:sk.y});Object.assign(q,{x:sk.x-0.8,y:sk.y,aim:0})
    tick(w,Math.ceil(config.skeletonRise/DT)+1)
    expect(sk.target).toBe(p.id);expect(sk.attackAt).toBeGreaterThan(w.time)
    w.spells!.bonk(w,q);expect(sk.attackAt).toBe(0)
    tick(w,1);expect(sk.target).toBe(q.id);expect(p.health).toBe(100)
  })
  test("per-caster and room-wide caps hold even with repeated lives and minimum cooldown",()=>{
    const w=world(),s=w.spells!
    s.config.moonLife=8;s.config.skeletonLife=40;s.config.skeletonRise=3
    for(let i=0;i<8;i++) {
      const p=w.addHuman(`p${i}`,`P${i}`)
      for(let n=0;n<4;n++) {
        w.spawn(p);Object.assign(p,{x:5+n*4,y:3+i*1.5})
        intent(w,{cast:{spell:"moon",quality:1,x:p.x+6,y:p.y}},p.id)
        intent(w,{cast:{spell:"necromancy",quality:1,x:p.x+3,y:p.y}},p.id)
      }
    }
    expect(s.moons).toHaveLength(8)
    expect(s.skeletons).toHaveLength(12)
    for(const p of w.players.values()) {
      expect(s.moons.filter(m=>m.by===p.id).length).toBeLessThanOrEqual(2)
      expect(s.skeletons.filter(m=>m.by===p.id).length).toBeLessThanOrEqual(3)
    }
  })
  test("orbit radius, tangent and full turn",()=>{
    const m={x:10,y:12,radius:1,born:3},a=orbitPoint(m,0,3),b=orbitPoint(m,0,3+Math.PI*2/2.4)
    expect(a.x).toBeCloseTo(11.65);expect(a.y).toBe(12);expect(a.vx).toBeCloseTo(0);expect(a.vy).toBeCloseTo(3.96)
    expect(b.x).toBeCloseTo(a.x);expect(b.y).toBeCloseTo(a.y)
  })
  test("moon captures people, props and skeletons; pop damages and flings",()=>{
    const w=world(),s=w.spells!,q=w.players.get("other")!
    cast(w,"necromancy",1,6,8);tick(w,25);cast(w,"moon")
    const m=s.moons[0]!,sk=s.skeletons[0]!,prop=s.props[5]!
    Object.assign(q,{x:m.x+0.5,y:m.y});Object.assign(sk,{x:m.x+0.5,y:m.y});Object.assign(prop,{x:m.x+0.5,y:m.y})
    tick(w,7);expect(m.orbiters.map(o=>o.kind)).toEqual(expect.arrayContaining(["player","prop","skeleton"]))
    tick(w,Math.ceil(config.moonLife/DT));expect(s.moons).toHaveLength(0);expect(q.health).toBeLessThan(100)
    expect(s.flashes.some(f=>f.kind==="pop")).toBe(true)
    expect(s.snapshot().forced).toContain(q.id)
    const x=q.x;tick(w,4);expect(q.x).not.toBe(x)
  })
  test("skeleton chooses nearest including caster, winds up, hits hard and responds to aggro",()=>{
    const w=world(),p=w.players.get("caster")!,q=w.players.get("other")!
    cast(w,"necromancy",1,6,8)
    const s=w.spells!.skeletons[0]!
    expect(skeletonTarget(s,w.players.values(),w.time)?.id).toBe(p.id)
    const initial=s.y;tick(w,8);expect(s.y).toBe(initial)
    s.aggro=q.id;s.aggroUntil=w.time+4;expect(skeletonTarget(s,w.players.values(),w.time)?.id).toBe(q.id)
    s.aggroUntil=0;tick(w,100);expect(p.health).toBeLessThan(100)
    s.x=p.x+0.8;s.y=p.y;p.aim=0
    w.spells!.bonk(w,p);expect(s.health).toBe(config.skeletonHealth-18);expect(s.aggro).toBe(p.id)
    expect(s.hitAt).toBe(w.time)
    tick(w,1);expect(s.target).toBe(p.id)
    tick(w,Math.ceil(config.skeletonLife/DT));expect(w.spells!.skeletons).toHaveLength(0)
  })
  test("legacy quality claims never change click spell power or unlocks",()=>{
    const w=world();cast(w,"moon",0.7)
    expect(w.spells!.moons[0]!.tiny).toBe(false);expect(w.spells!.moons[0]!.vy).toBeCloseTo(0)
    cast(w,"necromancy",0.7,6,8)
    const s=w.spells!.skeletons[0]!,q=w.players.get("other")!;Object.assign(q,{x:s.x,y:s.y})
    expect(s.crawl).toBe(false);expect(skeletonTarget(s,w.players.values(),w.time)?.id).toBe("other")
  })
  test("cast protocol rejects nonfinite values; snapshots detach and two decoded runs agree",()=>{
    const a=world(),b=world()
    for(const w of [a,b]) {
      w.spells!.learned.caster=["moon","necromancy"]
      for(let i=0;i<480;i++) {
        const msg=decodeClient(encodeClient({type:"intent",seq:i+1,i:{...NO_INTENT,...(i===0 || i===90?{cast:{spell:i===0?"moon" as const:"necromancy" as const,quality:1,x:10,y:10}}:{})}}))!
        if(msg.type==="intent")w.push("caster",msg.seq,msg.i)
        w.step()
      }
    }
    expect(buildSnapshot(a,"caster")).toEqual(buildSnapshot(b,"caster"))
    const snap=buildSnapshot(a,"caster"),copy=JSON.stringify(snap);tick(a,2);expect(JSON.stringify(snap)).toBe(copy)
    expect(decodeServer(encodeServer(snap))?.type).toBe("snap")
    const bad=decodeClient('{"type":"intent","seq":1,"i":{"cast":{"spell":"moon","quality":1,"x":null,"y":0}}}')
    expect(bad?.type==="intent"&&bad.i.cast).toBeUndefined()
  })
  test("mode switching clears spell state and restores the normal map and kit",()=>{
    const w=world();cast(w,"moon");w.restart("ffa",false)
    expect(w.spells).toBeNull();expect(w.map.id).not.toBe("castle-hall");expect(w.players.get("caster")!.kit.gun).toBe("rifle")
  })
  test("a wall-adjacent cast stays inside the hall and fresh lives leave old orbits",()=>{
    const w=world(),p=w.players.get("caster")!;p.x=0.7;p.y=12
    cast(w,"moon",1,-10,12)
    tick(w,20)
    const m=w.spells!.moons[0]!;expect(m.x).toBeGreaterThan(0.35)
    m.orbiters.push({kind:"player",id:p.id,phase:0})
    w.spawn(p);expect(m.orbiters.some(o=>o.id===p.id)).toBe(false)
  })
})
