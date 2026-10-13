/** World XYZ, Y up. Triangles are the visible receiver mesh, not gameplay collision boxes. */
export type SplatterMaterial = 0 | 1 | 2 | 3 // sealed, absorbent, slick, blocking/non-receiving
export type SurfaceHit={triangle:number;t:number;x:number;y:number;z:number;nx:number;ny:number;nz:number}
export const newSurfaceHit=():SurfaceHit=>({triangle:-1,t:1,x:0,y:0,z:0,nx:0,ny:1,nz:0})
const CELL=2,STRIDE=16

/** Immutable triangle grid. Allocates only on scene load; queries reuse caller storage. */
export class SplatterSurfaces {
  readonly triangles:Float32Array
  readonly count:number
  private readonly cells=new Map<string,number[]>()
  private readonly grid:number[][]
  private readonly stamps:Uint32Array
  private stamp=0
  private x0=0;private z0=0;private width=0;private depth=0
  /** Source stride: A.xyz, B.xyz, C.xyz, material. */
  constructor(source:readonly number[]){
    this.count=Math.floor(source.length/10);this.triangles=new Float32Array(this.count*STRIDE);this.stamps=new Uint32Array(this.count)
    let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity
    for(let i=0;i<this.count;i++){
      const k=i*10,o=i*STRIDE,p=this.triangles
      const ax=source[k],ay=source[k+1],az=source[k+2],ex=source[k+3]-ax,ey=source[k+4]-ay,ez=source[k+5]-az,fx=source[k+6]-ax,fy=source[k+7]-ay,fz=source[k+8]-az
      const nx=ey*fz-ez*fy,ny=ez*fx-ex*fz,nz=ex*fy-ey*fx,l=Math.hypot(nx,ny,nz)||1
      p.set([ax,ay,az,source[k+9],ex,ey,ez,0,fx,fy,fz,0,nx/l,ny/l,nz/l,0],o)
      const minX=Math.floor(Math.min(ax,ax+ex,ax+fx)/CELL),maxX=Math.floor(Math.max(ax,ax+ex,ax+fx)/CELL),minZ=Math.floor(Math.min(az,az+ez,az+fz)/CELL),maxZ=Math.floor(Math.max(az,az+ez,az+fz)/CELL)
      x0=Math.min(x0,minX);z0=Math.min(z0,minZ);x1=Math.max(x1,maxX);z1=Math.max(z1,maxZ)
      for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++){const key=`${x},${z}`;let ids=this.cells.get(key);if(!ids)this.cells.set(key,ids=[]);ids.push(i)}
    }
    this.x0=Number.isFinite(x0)?x0:0;this.z0=Number.isFinite(z0)?z0:0
    this.width=this.count?x1-x0+1:0;this.depth=this.count?z1-z0+1:0
    this.grid=Array.from({length:this.width*this.depth},(_,i)=>this.cells.get(`${this.x0+i%this.width},${this.z0+Math.floor(i/this.width)}`)??[])
    this.cells.clear()
  }
  private begin(){if(++this.stamp===0xffffffff){this.stamps.fill(0);this.stamp=1}}
  /** Nearest swept-point hit; large motion is still a segment, never an end-position overlap. */
  sweep(x:number,y:number,z:number,dx:number,dy:number,dz:number,hit:SurfaceHit){
    this.begin();hit.triangle=-1;hit.t=1
    const xa=Math.max(this.x0,Math.floor(Math.min(x,x+dx)/CELL)),xb=Math.min(this.x0+this.width-1,Math.floor(Math.max(x,x+dx)/CELL)),za=Math.max(this.z0,Math.floor(Math.min(z,z+dz)/CELL)),zb=Math.min(this.z0+this.depth-1,Math.floor(Math.max(z,z+dz)/CELL)),p=this.triangles
    for(let gz=za;gz<=zb;gz++)for(let gx=xa;gx<=xb;gx++){
      const ids=this.grid[(gz-this.z0)*this.width+gx-this.x0]
      for(let j=0;j<ids.length;j++){
        const id=ids[j];if(this.stamps[id]===this.stamp)continue;this.stamps[id]=this.stamp
        const o=id*STRIDE,hx=dy*p[o+10]-dz*p[o+9],hy=dz*p[o+8]-dx*p[o+10],hz=dx*p[o+9]-dy*p[o+8],det=p[o+4]*hx+p[o+5]*hy+p[o+6]*hz
        if(Math.abs(det)<1e-10)continue
        const inv=1/det,sx=x-p[o],sy=y-p[o+1],sz=z-p[o+2],u=(sx*hx+sy*hy+sz*hz)*inv
        if(u<-.00001||u>1.00001)continue
        const qx=sy*p[o+6]-sz*p[o+5],qy=sz*p[o+4]-sx*p[o+6],qz=sx*p[o+5]-sy*p[o+4],v=(dx*qx+dy*qy+dz*qz)*inv
        if(v<-.00001||u+v>1.00001)continue
        const t=(p[o+8]*qx+p[o+9]*qy+p[o+10]*qz)*inv
        if(t<0||t>hit.t)continue
        const side=dx*p[o+12]+dy*p[o+13]+dz*p[o+14]>0?-1:1
        hit.triangle=id;hit.t=t;hit.x=x+dx*t;hit.y=y+dy*t;hit.z=z+dz*t;hit.nx=p[o+12]*side;hit.ny=p[o+13]*side;hit.nz=p[o+14]*side
      }
    }
    return hit.triangle>=0
  }
  /** Clip a deposit to nearby coplanar receiving triangles, never onto a perpendicular wall or across a gap. */
  receivers(hit:SurfaceHit,radius:number,out:Int32Array,offset:number,cap:number){
    this.begin();const p=this.triangles,material=p[hit.triangle*STRIDE+3];let n=0
    // Keep the actual hit triangle even if a dense mesh exhausts the bounded neighbor list.
    out[offset+n++]=hit.triangle;this.stamps[hit.triangle]=this.stamp
    const xa=Math.max(this.x0,Math.floor((hit.x-radius)/CELL)),xb=Math.min(this.x0+this.width-1,Math.floor((hit.x+radius)/CELL)),za=Math.max(this.z0,Math.floor((hit.z-radius)/CELL)),zb=Math.min(this.z0+this.depth-1,Math.floor((hit.z+radius)/CELL))
    for(let z=za;z<=zb;z++)for(let x=xa;x<=xb;x++)for(const id of this.grid[(z-this.z0)*this.width+x-this.x0]){
      if(this.stamps[id]===this.stamp)continue;this.stamps[id]=this.stamp
      const o=id*STRIDE,dot=p[o+12]*hit.nx+p[o+13]*hit.ny+p[o+14]*hit.nz
      if(p[o+3]!==material||Math.abs(dot)<.999||Math.abs((hit.x-p[o])*hit.nx+(hit.y-p[o+1])*hit.ny+(hit.z-p[o+2])*hit.nz)>.001)continue
      if(n<cap)out[offset+n++]=id
    }
    return n
  }
}
