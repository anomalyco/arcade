import { expect, test } from 'bun:test'
import { PreviousTransforms } from '@arcade/kit/gpu/motion-blur'

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
