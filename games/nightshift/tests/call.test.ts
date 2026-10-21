import { test, expect } from "bun:test"
import { newCall, interact, stepCall, subtitle, ringEnvelope } from "../shared/call"
test("call cannot be answered remotely; pickup and hangup preserve one handset",()=>{
  const c=newCall();interact(c,false);expect(c.phase).toBe("ringing")
  interact(c,true);let last=0
  for(let i=0;i<40;i++){stepCall(c,1/60,0.65);expect(c.lift).toBeGreaterThanOrEqual(last);last=c.lift}
  expect(c.phase).toBe("call");expect(c.lift).toBe(1)
  stepCall(c,2,0.65);expect(subtitle(c)).toContain("still here")
  interact(c,false)
  for(let i=0;i<40;i++){stepCall(c,1/60,0.65);expect(c.lift).toBeLessThanOrEqual(last);last=c.lift}
  expect(c.phase).toBe("ended");expect(c.lift).toBe(0)
  interact(c,true);expect(c.phase).toBe("ended")
})
test("ring cadence has a quiet interval and smooth ends",()=>{
  expect(ringEnvelope(0)).toBe(0);expect(ringEnvelope(0.4)).toBe(1)
  expect(ringEnvelope(2)).toBe(0);expect(ringEnvelope(5.4)).toBe(0)
})
