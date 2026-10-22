import {expect,test} from "bun:test"
import {Opening,OPENING,cordLimit,CORD_REACH} from "../src/opening"
import {Elevator} from "../src/elevator"
import {newCall,stepCall,interact,subtitle,CALL_DURATION} from "../shared/call"
import cues from "../shared/kit-call.json"

test("opening pauses, whips with bounded overshoot, settles before seated handoff across frame rates",()=>{
  for(const hz of [30,60,120,144])for(const reduced of [false,true]){
    const o=new Opening();o.start();let minYaw=0,lastYaw=0,maxStep=0
    for(let i=0;i<hz*18;i++){
      o.step(1/hz,true,reduced)
      if(o.time>OPENING.ring&&o.time<OPENING.drift)minYaw=Math.min(minYaw,o.yaw.x)
      maxStep=Math.max(maxStep,Math.abs(o.yaw.x-lastYaw));lastYaw=o.yaw.x
    }
    expect(o.complete).toBe(true);expect(o.standing).toBe(false)
    expect(o.height.x).toBeCloseTo(OPENING.across.height,5)
    expect(o.yaw.x).toBeCloseTo(OPENING.across.yaw,5)
    expect(maxStep*hz).toBeLessThan(reduced?2.1:6)
    expect(minYaw).toBeGreaterThan(-.84)
    if(!reduced)expect(minYaw).toBeLessThan(-.805)
    const before=JSON.stringify(o);o.step(1,false,reduced);expect(JSON.stringify(o)).toBe(before)
    o.stand();o.step(1/hz,true,reduced);expect(o.height.x).toBeLessThan(1.45)
    for(let i=0;i<hz*2;i++)o.step(1/hz,true,reduced)
    expect(o.height.x).toBeCloseTo(1.65,5)
  }
})
// Playtest Oct 21 (02:47): "Why do I have to listen to this dialogue? I want to explore."
test("the opening hands over within 8.5 s, and Space skips it on a repeat view without jumping the pose",()=>{
  const o=new Opening();o.start();let t=0
  while(!o.complete&&t<20){o.step(1/60,true,false);t+=1/60}
  expect(t).toBeLessThan(8.5)
  const s=new Opening();s.start();s.step(.05,true,false)
  s.skip(false);expect(s.skipping).toBe(false)
  const pose=[s.yaw.x,s.pitch.x,s.height.x];s.skip(true);expect(s.skipping).toBe(true);expect([s.yaw.x,s.pitch.x,s.height.x]).toEqual(pose)
  for(let i=0;i<150;i++)s.step(1/60,true,false)
  expect(s.complete).toBe(true)
  const n=new Opening();n.skip(true);expect(n.skipping).toBe(false)
})
test("on the call the cord holds you within reach of the phone, sliding round the edge",()=>{
  const phone={x:0,z:0},inside=[CORD_REACH-.05,0] as const
  const b={x:CORD_REACH+.1,y:.1};expect(cordLimit(b,inside,phone,CORD_REACH)).toBe(true)
  expect(Math.hypot(b.x,b.y)).toBeLessThanOrEqual(CORD_REACH+1e-9);expect(b.y).toBeCloseTo(.1,5)
  const free={x:.5,y:.5};expect(cordLimit(free,[.4,.4],phone,CORD_REACH)).toBe(false);expect(free).toEqual({x:.5,y:.5})
})
test("all ten cues occur before automatic hangup, then the elevator closes before fading",()=>{
  const c=newCall();interact(c,true);for(let i=0;i<40;i++)stepCall(c,1/60,.65)
  for(const cue of cues.cues){c.elapsed=(cue.start+cue.end)/2;expect(subtitle(c)).toContain(cue.text)}
  c.elapsed=CALL_DURATION;stepCall(c,0,.65);expect(c.phase).toBe("hangup")
  for(let i=0;i<40;i++)stepCall(c,1/60,.65);expect(c.phase).toBe("ended")
  const e=new Elevator();e.step(.05,false,0,10);expect(e.closing).toBe(false)
  e.step(.05,true,0,9);expect(e.closing).toBe(false)
  e.step(.05,true,0,10);expect(e.closing).toBe(true)
  for(let i=0;i<150;i++)e.step(1/60,true,0,10)
  expect(e.closure).toBe(1);expect(e.fade).toBe(0)
  for(let i=0;i<100;i++)e.step(1/60,true,0,10)
  expect(e.done).toBe(true);expect(e.fade).toBe(1)
})
