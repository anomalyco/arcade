import { expect, test } from 'bun:test'
import { PreviousTransforms } from '@arcade/kit/gpu/motion-blur'
import { migrateGetawayPreset } from '../src/ui/debug-overlay'

test('motion histories follow identity across batching and reject missing frames and teleports',()=>{
  const history=new PreviousTransforms(4,10),out=new Float32Array(8)
  const a=new Float32Array([1,2,3,4]),b=new Float32Array([5,6,7,8])
  history.begin();history.write('a',a,0,out,0);history.write('b',b,0,out,4)
  expect([...out]).toEqual([1,2,3,4,5,6,7,8])
  a[0]=2;b[0]=6;history.begin();history.write('b',b,0,out,0);history.write('a',a,0,out,4)
  expect([...out]).toEqual([5,6,7,8,1,2,3,4])
  history.begin();history.write('b',b,0,out,0)
  a[0]=3;history.begin();history.write('a',a,0,out,0);expect(out[0]).toBe(3)
  a[0]=100;history.begin();history.write('a',a,0,out,0);expect(out[0]).toBe(100)
  history.reset();a[0]=101;history.begin();history.write('a',a,0,out,0);expect(out[0]).toBe(101)
})

test('migrateGetawayPreset migrates v1 flat settings into subsystem namespaces', () => {
  const res = migrateGetawayPreset({
    version: 1,
    settings: { clutter: false, beamLength: 22, emissions: true, coldExhaust: false, strength: 0.8, proceduralAudio: true },
  })
  expect(res.ok).toBe(true)
  if (res.ok) {
    expect(res.migratedFrom).toBe(1)
    expect(res.preset.subsystems.juice?.clutter).toBe(false)
    expect(res.preset.subsystems.lights?.beamLength).toBe(22)
    expect(res.preset.subsystems.emissions).toEqual({ emissions: true, coldExhaust: false })
    expect(res.preset.subsystems.motion?.strength).toBe(0.8)
    expect(res.preset.subsystems.audio?.proceduralAudio).toBe(true)
  }
})
