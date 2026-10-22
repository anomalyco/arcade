import {test,expect} from "bun:test"
import {Descent,descentDefaults,BASEMENT_X} from "../src/descent/state"
import {stepBody} from "@arcade/kit/sim/move"
import {buildBasement} from "../src/descent/room"
import {descentLines} from "../shared/descent-lines"
import recordings from "../shared/descent-recordings.json"

test("car reopens for someone leaving; closed transfer is once and dialogue never holds arrival",()=>{
  for(const hz of [30,60,144]){
    const d=new Descent(),s=descentDefaults(),b={x:0,y:9.8}
    for(let i=0;i<hz*.8;i++)d.step(1/hz,b,true,-1,s,true)
    expect(d.phase).toBe("closing");expect(d.closure).toBeLessThan(1)
    b.y=9.3;for(let i=0;i<hz;i++)d.step(1/hz,b,true,-1,s,true)
    expect(d.phase).toBe("floor");expect(d.downstairs).toBe(false)
    b.y=9.8;for(let i=0;i<hz*(s.rideSeconds+6);i++)d.step(1/hz,b,true,-1,s,true)
    expect(d.phase).toBe("basement");expect(b.x).toBe(BASEMENT_X);expect(d.closure).toBe(0);expect(d.line).toBe(null)
    for(let i=0;i<hz*5;i++)d.step(1/hz,b,true,-1,s,true)
    expect(b.x).toBe(BASEMENT_X)
    const state=JSON.stringify(d);d.step(1,b,false,-1,s,true);expect(JSON.stringify(d)).toBe(state)
    b.y=-15.7;for(let i=0;i<hz*2;i++)d.step(1/hz,b,true,-1,s,true)
    expect(d.done).toBe(true)
  }
})
test("door collisions retain a movable car and a complete path to the far door",()=>{
  const {walls}=buildBasement(),d=new Descent(),s=descentDefaults(),b={x:0,y:9.8,vx:0,vy:0}
  for(let i=0;i<150;i++)d.step(1/60,b,true,-1,s,true)
  expect(d.riding).toBe(true)
  for(let i=0;i<100;i++)stepBody(b,0,-1,2.1,[...walls,...d.collisions(true)],1/60,.28,18)
  expect(b.y).toBeGreaterThan(9.3)
  const x=b.x;for(let i=0;i<10;i++)stepBody(b,1,0,2.1,[...walls,...d.collisions(true)],1/60,.28,18)
  expect(b.x).toBeGreaterThan(x+.1)
  for(let i=0;i<60*(s.rideSeconds+3);i++)d.step(1/60,b,true,-1,s,true)
  expect(d.phase).toBe("basement")
  b.x=BASEMENT_X
  for(let i=0;i<900;i++){stepBody(b,0,-1,2.1,[...walls,...d.collisions(true)],1/60,.28,18);d.step(1/60,b,true,-1,s,true)}
  expect(b.y).toBeLessThan(-15.5);expect(d.done).toBe(true)
})
test("optional floor lines require sustained gaze and distinct screens; no repeat or overlap",()=>{
  const d=new Descent(),s=descentDefaults(),b={x:0,y:0}
  for(let i=0;i<80;i++){d.step(.05,b,true,i%2,s,true)}expect(d.line).toBe(null)
  for(let i=0;i<30;i++)d.step(.05,b,true,0,s,true)
  expect(d.line).toBe("floor-private")
  for(let i=0;i<150;i++)d.step(.05,b,true,0,s,true)
  expect(d.line).toBe(null)
  for(let i=0;i<30;i++)d.step(.05,b,true,1,s,true)
  expect(d.line).toBe("floor-apologise")
  expect(descentLines).toHaveLength(11)
  for(const line of descentLines){expect(recordings[line.id].duration).toBeGreaterThan(recordings[line.id].speechEnd);expect(recordings[line.id].peakDbFS).toBeLessThan(-6)}
  expect(d.sway(1,true,s)).toBe(0)
})

test("an unfinished call blocks boarding physically and cannot trigger closure even from inside",()=>{
  const d=new Descent(),s=descentDefaults(),b={x:0,y:8,vx:0,vy:0}
  for(let i=0;i<180;i++){stepBody(b,0,1,2.1,d.collisions(false),1/60,.28,18);d.step(1/60,b,true,-1,s,false)}
  expect(b.y).toBeLessThan(8.8);expect(d.phase).toBe("floor")
  b.y=9.8
  for(let i=0;i<180;i++)d.step(1/60,b,true,-1,s,false)
  expect(d.phase).toBe("floor");expect(d.closure).toBe(0)
  b.y=8
  for(let i=0;i<180;i++){stepBody(b,0,1,2.1,d.collisions(true),1/60,.28,18);d.step(1/60,b,true,-1,s,true)}
  expect(b.y).toBeGreaterThan(9.65);expect(d.phase).not.toBe("floor")
})

test("without any audio, every subtitle progresses and elevator speech finishes before doors open",()=>{
  const d=new Descent(),s=descentDefaults(),b={x:0,y:9.8},seen=new Set<string>()
  let lastSpeechPhase=""
  for(let i=0;i<60*60;i++){
    if(d.phase==="basement")b.y=6
    d.step(1/60,b,true,-1,s,true)
    if(d.subtitle){seen.add(d.line!);if(d.line==="lift-read")lastSpeechPhase=d.phase}
  }
  expect([...seen]).toEqual(descentLines.filter(l=>l.room!=="floor").map(l=>l.id))
  expect(lastSpeechPhase).toBe("ride");expect(d.line).toBe(null)
})
