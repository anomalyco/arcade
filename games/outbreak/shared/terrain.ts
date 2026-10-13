import { frontageEnd, type Town } from "./map"

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (x: number) => { x = clamp(x); return x * x * (3 - 2 * x) }
const distance = (x: number, z: number, a: number, b: number, c: number, d: number) => Math.hypot(Math.max(a-x, 0, x-c), Math.max(b-z, 0, z-d))

/** Heights at integer terrain vertices. Roads, foundations and entrance walks remain flat. */
export function terrainVertex(town: Town, x: number, z: number): number {
  let free = Math.min(distance(x,z,38,0,50,96), distance(x,z,0,38,96,50))
  for (const b of town.buildings) free = Math.min(free, distance(x,z,...b.rect), distance(x,z,b.rect[0]+4.5,b.rect[3],b.rect[0]+7,frontageEnd(b)+2),distance(x,z,b.rect[0]-3,b.rect[1],b.rect[0]-.35,frontageEnd(b)+2))
  const s = town.seed * .37
  return smooth(free / 2) * town.terrain * (.55 + .25 * Math.sin(x*.41+s)*Math.cos(z*.32-s) + .2*Math.sin(x*.17-z*.23+s))
}

/** Exact barycentric interpolation of the two triangles emitted for each metre cell. */
export function groundHeight(town: Town, x: number, z: number): number {
  const ix=Math.floor(x), iz=Math.floor(z), u=x-ix, v=z-iz
  const a=terrainVertex(town,ix,iz), b=terrainVertex(town,ix+1,iz), c=terrainVertex(town,ix+1,iz+1), d=terrainVertex(town,ix,iz+1)
  return v <= u ? a+(b-a)*u+(c-b)*v : a+(c-d)*u+(d-a)*v
}

/** Rendered walking surfaces, including the shallow curb ramp and the level thresholds. */
export function supportHeight(town: Town, x: number, z: number): number {
  let height=groundHeight(town,x,z)
  for (const b of town.buildings) {
    const [a,c,r,e]=b.rect
    if (x>=a && x<=r && z>=c && z<=e) return .13
    if (x>=a+5 && x<=a+6.4 && z>=e && z<=frontageEnd(b)+2) return .13
    if (x>=a+4.5 && x<=a+7 && z>=e && z<=e+1.3) return .13
    if (x>=a-3 && x<=a-.35 && z>=c && z<=frontageEnd(b)+2) height=Math.max(.035,height)
  }
  if ((x>=40 && x<=48) || (z>=40 && z<=48)) return .014
  const curb = (v: number) => v>=38 && v<=40 ? .014+.086 * Math.min(1,(40-v)/.25) : v>=48 && v<=50 ? .014+.086 * Math.min(1,(v-48)/.25) : 0
  if ((x>=38 && x<=50) || (z>=38 && z<=50)) return Math.max(height,.014,curb(x),curb(z))
  return height
}
