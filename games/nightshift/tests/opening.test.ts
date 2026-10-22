import {expect,test} from "bun:test"
import {Opening,OPENING} from "../src/opening"
import {Elevator} from "../src/elevator"
import {newCall,stepCall,interact,subtitle,CALL_DURATION} from "../shared/call"
import cues from "../shared/kit-call.json"

test("opening pauses, whips with bounded overshoot, settles before seated handoff across frame rates",()=>{
  for(const hz of [30,60,120,144])for(const reduced of [false,true]){
    const o=new Opening();o.start();let minYaw=0,lastYaw=0,maxStep=0
    for(let i=0;i<hz*18;i++){
      o.step(1/hz,true,reduced)
      if(o.time>6.2&&o.time<8.5)minYaw=Math.min(minYaw,o.yaw.x)
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
test("skip requires prior viewing and changes the target without changing the current pose",()=>{
  const o=new Opening();o.start();o.step(.05,true,false);o.skip(false);expect(o.time).toBe(.05)
  const pose=[o.yaw.x,o.pitch.x,o.height.x];o.skip(true);expect([o.yaw.x,o.pitch.x,o.height.x]).toEqual(pose)
  for(let i=0;i<180;i++)o.step(1/60,true,false)
  expect(o.complete).toBe(true)
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
