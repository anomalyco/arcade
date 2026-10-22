/** Authored render triangles queried vertically for feet and pop attribution. */
type Triangle = { name: string; ax:number; az:number; ay:number; bx:number; bz:number; by:number; cx:number; cz:number; cy:number; inv:number; uv:number[] }
export class SurfaceQuery {
  private cells = new Map<string, Triangle[]>()
  private large: Triangle[] = []
  constructor(surfaces: readonly { name:string; vertices: readonly ArrayBuffer[] }[]) {
    for (const surface of surfaces) for (const bytes of surface.vertices) {
      const f = new Float32Array(bytes), n = new Int8Array(bytes)
      for (let i=0;i<f.length;i+=24) {
        if (n[i*4+13]! < 64) continue
        const [ax,ay,az,bx,by,bz,cx,cy,cz] = [f[i]!,f[i+1]!,f[i+2]!,f[i+8]!,f[i+9]!,f[i+10]!,f[i+16]!,f[i+17]!,f[i+18]!]
        const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz)
        if (Math.abs(det)<1e-9) continue
        const t={name:surface.name,ax,ay,az,bx,by,bz,cx,cy,cz,inv:1/det,uv:[f[i+6]!,f[i+7]!,f[i+14]!,f[i+15]!,f[i+22]!,f[i+23]!]}
        const x0=Math.floor(Math.min(ax,bx,cx)/4),x1=Math.floor(Math.max(ax,bx,cx)/4),z0=Math.floor(Math.min(az,bz,cz)/4),z1=Math.floor(Math.max(az,bz,cz)/4)
        if ((x1-x0+1)*(z1-z0+1)>256) { this.large.push(t); continue }
        for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){
          const key=`${x}:${z}`,list=this.cells.get(key)
          if(list)list.push(t);else this.cells.set(key,[t])
        }
      }
    }
  }
  at(x:number,z:number,ceiling=1) {
    let height=-Infinity,name="unknown",u=0,v=0
    const visit=(t:Triangle)=>{
      const a=((t.bz-t.cz)*(x-t.cx)+(t.cx-t.bx)*(z-t.cz))*t.inv
      const b=((t.cz-t.az)*(x-t.cx)+(t.ax-t.cx)*(z-t.cz))*t.inv,c=1-a-b
      if(a< -1e-5||b< -1e-5||c< -1e-5)return
      const y=a*t.ay+b*t.by+c*t.cy
      if(y<=ceiling&&y>height){height=y;name=t.name;u=a*t.uv[0]!+b*t.uv[2]!+c*t.uv[4]!;v=a*t.uv[1]!+b*t.uv[3]!+c*t.uv[5]!}
    }
    this.cells.get(`${Math.floor(x/4)}:${Math.floor(z/4)}`)?.forEach(visit)
    this.large.forEach(visit)
    return {name,height,u,v}
  }
  /** A depth point identifies floors, not the material of a halo/window in front of them. */
  region(x:number,y:number,z:number) {
    if(y>1) return z<26 ? "facade/interior" : "props/foliage/air"
    const s=this.at(x,z,y+.12)
    return Math.abs(s.height-y)<.15 ? s.name : "other geometry/air"
  }
}
