import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"
import type { Building, Town } from "../shared/map"
import { supportHeight } from "../shared/terrain"

const rgb = (v:number):Rgb => [(v>>16&255)/255,(v>>8&255)/255,(v&255)/255]
type Point = [number,number,number]

/** Weathered clapboard garden shed with hipped shingle roof in the north-west side yard by the picket fence. */
function gardenShed(m:Mesh,x0:number,z0:number,x1:number,z1:number,ground:number) {
  const y=ground, wallCol=rgb(0x6c7582), trimCol=rgb(0x9ca3ad), roofCol=rgb(0x384252), ridgeCol=rgb(0x4b5668)
  const mx=(x0+x1)/2, mz=(z0+z1)/2, eave=y+1.52, peak=y+2.08
  m.box(x0,y+.02,z0,x1,eave,z1,wallCol,MAT.lit)
  for(const px of [x0,x1-.06])for(const pz of [z0,z1-.06])m.box(px,y+.02,pz,px+.06,eave,pz+.06,trimCol,MAT.lit)
  // Double shed doors on the south face (+z)
  m.box(mx-.42,y+.06,z1+.002,mx-.02,eave-.12,z1+.03,rgb(0x525a66),MAT.lit)
  m.box(mx+.02,y+.06,z1+.002,mx+.42,eave-.12,z1+.03,rgb(0x525a66),MAT.lit)
  // Four-sided hipped shingle roof (MAT.lit so it stays in the fast opaque pipeline)
  const ox0=x0-.12,ox1=x1+.12,oz0=z0-.12,oz1=z1+.12,top:Point=[mx,peak,mz]
  m.facet([ox0,eave,oz1],[ox1,eave,oz1],top,roofCol,MAT.lit)
  m.facet([ox1,eave,oz0],[ox0,eave,oz0],top,roofCol,MAT.lit)
  m.facet([ox0,eave,oz0],[ox0,eave,oz1],top,ridgeCol,MAT.lit)
  m.facet([ox1,eave,oz1],[ox1,eave,oz0],top,ridgeCol,MAT.lit)
}
function parkedSedan(m:Mesh,cx:number,cz:number,ground:number) {
  const y=ground, from=m.length
  // Soft contact shadow under chassis
  m.quad([-.92,y+.004,2.14],[.92,y+.004,2.14],[.92,y+.004,-2.14],[-.92,y+.004,-2.14],[0,1,0],rgb(0x111419),MAT.lit)
  const paintSide=rgb(0x636f80),paintTop=rgb(0x7c899c),paintRoof=rgb(0x8a98ad),trim=rgb(0x232830),glass=rgb(0x25303f),pillar=rgb(0x94a2b6)
  // Four wheels with dark tires and alloy rims
  for(const sx of [-.78,.78])for(const sz of [-1.28,1.22]){
    m.box(sx-.11,y+.01,sz-.31,sx+.11,y+.56,sz+.31,rgb(0x17191d),MAT.lit)
    m.box(sx+(sx<0?-.12:.09),y+.14,sz-.19,sx+(sx<0?-.09:.12),y+.43,sz+.19,rgb(0x78808e),MAT.shiny)
  }
  // Lower body hull: long hood at north (-z), trunk deck at south (+z)
  m.bevelBox(-.84,y+.22,-2.04,.84,y+.76,2.02,.055,paintSide,paintTop,MAT.lit,MAT.lit)
  // Front (-z) & rear (+z) wrap-around dark bumpers + side rub strips
  m.box(-.86,y+.20,1.86,.86,y+.43,2.09,trim,MAT.lit)
  m.box(-.86,y+.20,-2.09,.86,y+.43,-1.86,trim,MAT.lit)
  m.box(-.86,y+.35,-1.86,.86,y+.41,1.86,trim,MAT.lit)
  // Hood creases (-z) and trunk lid seam (+z)
  for(const sx of [-.56,.56])m.box(sx-.022,y+.76,-1.94,sx+.022,y+.778,-.74,rgb(0x687486),MAT.lit)
  m.box(-.015,y+.76,-1.96,.015,y+.778,-.74,rgb(0x8e9cb2),MAT.lit)
  m.box(-.68,y+.755,-.74,.68,y+.772,-.62,trim,MAT.lit)
  for(const sx of [-.72,.72])m.box(sx-.015,y+.758,1.08,sx+.015,y+.772,1.94,rgb(0x525c6b),MAT.lit)
  // Tapered cabin greenhouse: windshield at -z, roof in center, rear window at +z facing the street camera
  const bL=-.78,bR=.78,tL=-.65,tR=.65,y0=y+.75,y1=y+1.26
  const zRearBot=1.12,zRearTop=.48,zFrontTop=-.34,zFrontBot=-.76
  // Solid greenhouse hull (brighter C/A pillars and roof)
  m.quadAuto([tL,y1,zRearTop],[tR,y1,zRearTop],[tR,y1,zFrontTop],[tL,y1,zFrontTop],paintRoof,MAT.lit)
  m.quadAuto([bL,y0,zRearBot],[bR,y0,zRearBot],[tR,y1,zRearTop],[tL,y1,zRearTop],pillar,MAT.lit)
  m.quadAuto([tL,y1,zFrontTop],[tR,y1,zFrontTop],[bR,y0,zFrontBot],[bL,y0,zFrontBot],pillar,MAT.lit)
  m.quadAuto([bL,y0,zFrontBot],[bL,y0,zRearBot],[tL,y1,zRearTop],[tL,y1,zFrontTop],paintSide,MAT.lit)
  m.quadAuto([bR,y0,zRearBot],[bR,y0,zFrontBot],[tR,y1,zFrontTop],[tR,y1,zRearTop],paintSide,MAT.lit)
  // Inset rear window (+z, facing camera) & front windshield (-z) with crisp dark glass + thin silver trim
  m.quadAuto([bL+.09,y0+.03,zRearBot+.006],[bR-.09,y0+.03,zRearBot+.006],[tR-.08,y1-.03,zRearTop+.006],[tL+.08,y1-.03,zRearTop+.006],glass,MAT.shiny)
  m.quadAuto([tL+.08,y1-.03,zFrontTop-.006],[tR-.08,y1-.03,zFrontTop-.006],[bR-.09,y0+.03,zFrontBot-.006],[bL+.09,y0+.03,zFrontBot-.006],glass,MAT.shiny)
  // Inset side door windows separated by B-pillar, plus front side mirrors near A-pillar (-z)
  for(const [za,zb,ta,tb] of [[.10,zRearBot-.10,.08,zRearTop-.06],[zFrontBot+.10,.03,zFrontTop+.06,.03]] as const){
    m.quadAuto([bL-.005,y0+.03,za],[bL-.005,y0+.03,zb],[tL-.005,y1-.03,tb],[tL-.005,y1-.03,ta],glass,MAT.shiny)
    m.quadAuto([bR+.005,y0+.03,zb],[bR+.005,y0+.03,za],[tR+.005,y1-.03,ta],[tR+.005,y1-.03,tb],glass,MAT.shiny)
  }
  for(const s of [-1,1])m.box(s*.84,y+.74,-.52,s*.97,y+.84,-.38,paintTop,MAT.lit)
  // Rear (+z, facing camera): tail-light clusters, amber turn strips, trunk garnish & recessed license plate
  m.box(-.22,y+.47,2.00,.22,y+.63,2.04,rgb(0x3a414d),MAT.lit)
  m.box(-.16,y+.49,2.01,.16,y+.60,2.05,rgb(0xc8c5ba),MAT.lit)
  for(const sx of [-.56,.56]){
    m.box(sx-.22,y+.48,2.00,sx+.22,y+.65,2.04,rgb(0x8e2c28),MAT.shiny)
    m.box(sx-.22,y+.58,2.005,sx+.22,y+.65,2.045,rgb(0xb56c28),MAT.shiny)
    m.box(sx-.18,y+.48,-2.05,sx+.18,y+.66,-2.00,rgb(0xc2cbd8),MAT.shiny)
  }
  m.box(-.42,y+.47,-2.05,.42,y+.65,-2.00,rgb(0x1c2026),MAT.lit)
  // Slight natural parking yaw (~3 deg) and translate to driveway
  const yaw=-.055, c=Math.cos(yaw), s=Math.sin(yaw)
  for(let i=from;i<m.v.length;i+=11){
    const vx=m.v[i]!,vz=m.v[i+2]!,nx=m.v[i+3]!,nz=m.v[i+5]!
    m.v[i]=vx*c-vz*s+cx; m.v[i+2]=vx*s+vz*c+cz
    m.v[i+3]=nx*c-nz*s; m.v[i+5]=nx*s+nz*c
  }
}

function branch(m:Mesh,a:Point,b:Point,r:number) {
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],len=Math.hypot(dx,dy,dz)
  const axis=[dx/len,dy/len,dz/len],side=Math.hypot(dx,dz)
  const u=side<.001?[1,0,0]:[-dz/side,0,dx/side]
  const v=[axis[1]!*u[2]!-axis[2]!*u[1]!,axis[2]!*u[0]!-axis[0]!*u[2]!,axis[0]!*u[1]!-axis[1]!*u[0]!]
  const p=(end:number,i:number)=>{const q=end?b:a,s=r*(end?.4:1),c=Math.cos(i*6.283/5),n=Math.sin(i*6.283/5);return q.map((x,j)=>x+s*(u[j]!*c+v[j]!*n))}
  for(let i=0;i<5;i++)m.quadAuto(p(0,i),p(1,i),p(1,i+1),p(0,i+1),rgb(0x484332),MAT.timber)
}

/** Shadowed inner foliage core + peripheral ruffled leaf rosettes for fine organic silhouettes. */
function leafRosette(m:Mesh,px:number,py:number,pz:number,size:number,tiltX:number,tiltZ:number,rng:Rng,tone:Rgb) {
  const a=rng.next()*6.283,w=size*(.76+rng.next()*.22)
  const f=[Math.cos(a)*size,Math.sin(a)*size],side=[-Math.sin(a)*w,Math.cos(a)*w]
  const dome=size*.34,droop=size*.18
  const center:Point=[px+tiltX*.05,py+dome,pz+tiltZ*.05]
  const a0:Point=[px-f[0]!,py-droop*.5-tiltX*f[0]!*.22,pz-f[1]!]
  const a1:Point=[px+side[0]!,py-droop-tiltZ*side[1]!*.22,pz+side[1]!]
  const a2:Point=[px+f[0]!,py-droop*.7+tiltX*f[0]!*.22,pz+f[1]!]
  const a3:Point=[px-side[0]!,py-droop+tiltZ*side[1]!*.22,pz-side[1]!]
  const k=.88+rng.next()*.26,col:Rgb=[tone[0]*k,tone[1]*k,tone[2]*k]
  for(const [p0,p1] of [[a0,a1],[a1,a2],[a2,a3],[a3,a0]])m.facet(center,p0!,p1!,col,MAT.foliage)
}

function foliageCluster(m:Mesh,cx:number,cy:number,cz:number,rx:number,ry:number,rng:Rng,base:Rgb,rosettes:number) {
  // Compact dark inner shadow core so the cluster has volume without looking like a balloon.
  const segs=5,top:Point=[cx,cy+ry*.55,cz],ring:Point[]=[]
  const dark:Rgb=[base[0]*.52,base[1]*.55,base[2]*.48]
  for(let i=0;i<segs;i++){
    const a=(i/segs)*6.283+(rng.next()-.5)*.28,r=rx*(.52+rng.next()*.18)
    ring.push([cx+Math.cos(a)*r,cy-ry*.18,cz+Math.sin(a)*r])
  }
  for(let i=0;i<segs;i++)m.facet(top,ring[i]!,ring[(i+1)%segs]!,dark,MAT.foliage)
  // Peripheral overlapping leaf rosettes break the silhouette into crisp leafy lobes.
  for(let s=0;s<rosettes;s++){
    const a=s*(6.283/rosettes)+(rng.next()-.5)*.55
    const radial=rx*(s===0?.18:.48+rng.next()*.44)
    const ox=Math.cos(a)*radial,oz=Math.sin(a)*radial
    const oy=s===0?ry*.48:ry*(.24-(radial/rx)*.36+(rng.next()-.5)*.22)
    const sz=rx*(s===0?.46:.34+rng.next()*.22)
    const lift=s===0?1.12:.86+(1-radial/rx)*.28
    const tone:Rgb=[Math.min(1,base[0]*lift),Math.min(1,base[1]*lift),Math.min(1,base[2]*lift)]
    leafRosette(m,cx+ox,cy+oy,cz+oz,sz,Math.cos(a),Math.sin(a),rng,tone)
  }
}

/** Broadleaf scaffold: layered bough clusters, dark inner cores, ruffled peripheral leaf sprays and crown gaps. */
export function plant(m:Mesh,x:number,z:number,h:number,radius:number,seed:number,ground:number) {
  const rng=new Rng(seed),tree=h>2.1,boughs=tree?6:4,gapAngle=rng.next()*6.283
  const leanX=(rng.next()-.5)*(tree?.22:.04),leanZ=(rng.next()-.5)*(tree?.22:.04)
  if(tree)branch(m,[x,ground,z],[x+leanX,ground+h*.72,z+leanZ],.16)
  // sRGB palette: rich olive, warm autumn-ochre green, deep forest green, and sunlit sage.
  const palette:Rgb[]=[[0.36,0.44,0.24],[0.44,0.48,0.26],[0.28,0.37,0.19],[0.49,0.50,0.27],[0.32,0.41,0.22]]
  for(let b=0;b<boughs;b++){
    const baseAngle=b*6.283/boughs+(rng.next()-.5)*.45
    const gapDelta=Math.abs(Math.atan2(Math.sin(baseAngle-gapAngle),Math.cos(baseAngle-gapAngle)))
    const inGap=gapDelta<.55
    const tierFrac=b/(boughs-1)
    const reach=radius*(inGap?.36:.52+(1-tierFrac*.25)*(.30+rng.next()*.26))
    const startH=ground+h*(tree?.28+tierFrac*.22:.10+tierFrac*.12)
    const tipH=ground+h*(tree?.50+tierFrac*.34+(rng.next()-.4)*.08:.42+tierFrac*.36)
    const start:Point=[x+leanX*.35,startH,z+leanZ*.35]
    const tip:Point=[x+Math.cos(baseAngle)*reach,tipH,z+Math.sin(baseAngle)*reach]
    if(tree)branch(m,start,tip,.068*(1-tierFrac*.28))
    const clusterTone=palette[(b+Math.floor(rng.next()*2))%palette.length]!
    const rx=radius*(tree?(inGap?.34:.46+rng.next()*.16):.46+rng.next()*.16)
    const ry=h*(tree?.16+rng.next()*.06:.28+rng.next()*.10)
    foliageCluster(m,tip[0],tip[1],tip[2],rx,ry,rng,clusterTone,tree?5:4)
    if(tree&&!inGap&&b%2===0){
      const subA=baseAngle+(rng.next()-.5)*.65,subR=reach*.58
      const sx=x+Math.cos(subA)*subR,sz=z+Math.sin(subA)*subR,sy=tip[1]+h*.12
      foliageCluster(m,sx,sy,sz,rx*.76,ry*.85,rng,palette[(b+3)%palette.length]!,4)
    }
  }
  const crownTone=palette[seed%palette.length]!
  foliageCluster(m,x+leanX*.45,ground+h*(tree?.84:.68),z+leanZ*.45,radius*(tree?.44:.48),h*(tree?.15:.24),rng,crownTone,tree?5:4)
  const coverCount=tree?4:2
  for(let c=0;c<coverCount;c++){
    const a=gapAngle+1.2+c*1.45+(rng.next()-.5)*.35,d=radius*(tree?.26:.42)*(0.65+rng.next()*.45)
    const gx=x+Math.cos(a)*d,gz=z+Math.sin(a)*d,sz=(tree?.24:.15)+rng.next()*.09,gh=(tree?.16:.11)+rng.next()*.06
    const col:Rgb=[.30+.08*rng.next(),.38+.08*rng.next(),.19+.05*rng.next()]
    const top=[gx,ground+gh,gz]
    for(let k=0;k<3;k++){
      const ka=a+k*2.09,ka2=ka+1.15
      m.facet(top,[gx+Math.cos(ka)*sz,ground+.01,gz+Math.sin(ka)*sz],[gx+Math.cos(ka2)*sz,ground+.01,gz+Math.sin(ka2)*sz],col,MAT.foliage)
    }
  }
}

/** Procedural bungalow over authoritative room and opening boundaries. */
export function house(m:Mesh,b:Building,id:number,town:Town) {
  const [x,z,r,e]=b.rect,mid=(z+e)/2,ridge=4.35+(town.houseSeed%3)*.12
  const trim=rgb(0xd4d2c8),roof=rgb(0x3d4758),brick=rgb(0x684339)
  if(b.kind!=="house"){m.box(x-.15,2.8,z-.15,r+.15,2.94,e+.15,rgb(0x555a54),MAT.roof,id);return}
  const slopeY = (pz: number) => 2.88 + (ridge - 2.88) * (1 - Math.abs(pz - mid) / (mid - (z - .42)))
  // Front roof slope (mid .. e+.42) spans full width; north slope steps in at x+9.5 and r-1.6 to match the L-shaped plan.
  const xCutsFront = [x - .42, x + .36, r - .36, r + .42]
  for (const [z0, z1] of [[e + .42, e - .36], [e - .36, mid]] as const) {
    const y0 = slopeY(z0), y1 = slopeY(z1)
    for (let xi = 0; xi < 3; xi++) {
      const x0 = xCutsFront[xi]!, x1 = xCutsFront[xi + 1]!
      m.quadAuto([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], roof, MAT.roof, id)
    }
  }
  const xCutsBack = [x + 1.85, x + 2.35, x + 9.15, x + 9.75]
  for (const [z0, z1] of [[mid, z + .36], [z + .36, z - .42]] as const) {
    const y0 = slopeY(z0), y1 = slopeY(z1)
    for (let xi = 0; xi < 3; xi++) {
      const x0 = xCutsBack[xi]!, x1 = xCutsBack[xi + 1]!
      m.quadAuto([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], roof, MAT.roof, id)
    }
  }
  // Left roof wing alongside the west bedroom wall (x-.42 .. x+2.05, z+1.2 .. z+5.55), meeting the living room north wall cleanly
  m.quadAuto([x-.42, 2.84, z+1.2], [x-.42, 2.84, z+5.55], [x+2.05, 3.48, z+5.55], [x+2.05, 3.48, z+1.2], roof, MAT.roof, id)
  m.box(x-.45, 2.70, z+1.15, x+2.05, 2.85, z+1.26, trim, MAT.roof, id)
  // Stepped north-east shingle roof wing (x+9.45 .. r-1.55, z+1.45 .. z+5.55) and kitchen north eave (r-1.60 .. r+.42, z+5.12 .. mid)
  m.quadAuto([x+9.45, 3.46, z+5.55], [r-1.55, 3.46, z+5.55], [r-1.55, 2.84, z+1.45], [x+9.45, 2.84, z+1.45], roof, MAT.roof, id)
  m.quadAuto([r-1.55, 3.46, z+5.55], [r-1.55, 2.84, z+5.15], [r-1.55, 2.84, z+1.45], [r-1.55, 3.46, z+5.55], roof, MAT.roof, id)
  m.quadAuto([r-1.60, slopeY(mid), mid], [r+.42, slopeY(mid), mid], [r+.42, 2.84, z+5.12], [r-1.60, 2.84, z+5.12], roof, MAT.roof, id)
  m.box(x+9.45, 2.70, z+1.38, r-1.50, 2.85, z+1.50, trim, MAT.roof, id)
  m.box(r-1.62, 2.70, z+1.38, r-1.50, 2.85, z+5.18, trim, MAT.roof, id)
  m.box(r-1.55, 2.70, z+5.08, r+.45, 2.85, z+5.20, trim, MAT.roof, id)
  for(const px of [x-.01,r+.01])m.facet([px,2.8,z+5.5],[px,ridge,mid],[px,2.8,e],rgb(b.color),MAT.roof,id)
  m.box(x+1.75,2.68,z-.42,x+9.78,2.86,z-.31,trim,MAT.roof,id)
  m.box(x-.45,2.72,e+.34,r+.45,2.87,e+.44,trim,MAT.roof,id)
  // Dark soffit and half-round gutter read as a crisp eave border with trim fascia.
  m.box(x-.42,2.63,e+.02,r+.42,2.71,e+.40,rgb(0x282e38),MAT.roof,id)
  m.box(x-.48,2.76,e+.43,r+.48,2.83,e+.50,rgb(0x9da4b0),MAT.roof,id)
  for (let xi = 0; xi < 3; xi++) {
    m.box(xCutsFront[xi]!, ridge - .04, mid - .1, xCutsFront[xi + 1]!, ridge + .04, mid + .1, rgb(0x4b5668), MAT.roof, id)
  }
  // Brick chimney on upper-right slope with stone cap, dark flue, and east-eave downspout.
  m.box(r-2.08,3.18,mid+.82,r-1.12,4.82,mid+1.78,rgb(0x7c483a),MAT.brick)
  m.box(r-2.16,4.76,mid+.74,r-1.04,4.88,mid+1.86,rgb(0x8e9196))
  m.box(r-1.88,4.88,mid+1.02,r-1.32,4.91,mid+1.58,rgb(0x181c22))
  m.box(r+.02,.15,e-.12,r+.10,2.76,e-.04,rgb(0x7d8490),MAT.lit)
  const cx=x+5.7
  parkedSedan(m,x-1.68,e-1.35,.035)
  gardenShed(m,x-2.85,z+.55,x-1.15,z+2.25,.035)
  // Gabled porch canopy aligned over the columns (e+1.28) so the street camera sees the front door, sconce bulb, and full doormat.
  m.quadAuto([cx-1.56,2.48,e+1.28],[cx,3.04,e+1.28],[cx,3.04,e-.12],[cx-1.56,2.48,e-.12],roof,MAT.roof,id)
  m.quadAuto([cx,3.04,e+1.28],[cx+1.56,2.48,e+1.28],[cx+1.56,2.48,e-.12],[cx,3.04,e-.12],roof,MAT.roof,id)
  m.facet([cx-1.46,2.48,e+1.18],[cx,2.98,e+1.18],[cx+1.46,2.48,e+1.18],rgb(0x3a352e),MAT.roof,id)
  m.quadAuto([cx-1.58,2.44,e+1.30],[cx,3.01,e+1.30],[cx,3.08,e+1.26],[cx-1.58,2.51,e+1.26],trim,MAT.roof,id)
  m.quadAuto([cx,3.01,e+1.30],[cx+1.58,2.44,e+1.30],[cx+1.58,2.51,e+1.26],[cx,3.08,e+1.26],trim,MAT.roof,id)
  m.box(cx-1.52,2.40,e+1.08,cx+1.52,2.48,e+1.24,trim,MAT.roof,id)
  for(const px of [cx-1.32,cx+1.32]){
    m.box(px-.09,.34,e+1.06,px+.09,2.42,e+1.24,rgb(0xeae4d7),MAT.wall)
    m.box(px-.14,.13,e+1.01,px+.14,.34,e+1.29,rgb(0xd8d2c5),MAT.wall)
  }
  // Porch steps leading to the front walkway, plus wall mailbox next to the door.
  m.box(cx-1.28,.08,e+1.28,cx+1.28,.132,e+1.46,rgb(0xc6bfb0),MAT.wall)
  m.box(cx+1.02,1.22,e+.01,cx+1.22,1.44,e+.10,rgb(0x2b3036),MAT.wall)
  // Door casing, lintel, sill and supported coir mat share the real 1.4m opening.
  for(const px of [x+4.92,x+6.40]){
    m.box(px,.13,e-.24,px+.09,2.38,e+.07,rgb(0xeae4d7),MAT.wall)
    m.box(px,.13,z+5.48,px+.08,2.34,z+5.72,rgb(0xc8bfae),MAT.wall)
  }
  m.box(x+4.92,2.30,e-.24,x+6.49,2.42,e+.07,rgb(0xeae4d7),MAT.wall)
  m.box(x+5,.13,e-.28,x+6.4,.15,e+.18,rgb(0x9a9382))
  m.box(cx-.52,.132,e+.20,cx+.52,.155,e+.74,rgb(0x523f2c),MAT.timber)
  // Grouped foundation planting: natural soil bed without toothed brick edging, boxwood pair by porch, corner shrubs and hydrangea.
  const rng=new Rng(town.houseSeed+id*71)
  for(const [a,d] of [[x+.15,x+4.35],[x+7.15,r-.15]]){
    m.quad([a!,.022,e+.92],[d!,.022,e+.92],[d!,.022,e+.05],[a!,.022,e+.05],[0,1,0],rgb(0x28291f),MAT.ground,5)
  }
  // Left corner shrub cluster + low under-window shrubs
  for(const [px,pz,ph,pr] of [
    [x+.45,e+.48,1.08,.74],
    [x-.28,e-.35,1.18,.78],
    [x+1.35,e+.44,.68,.48],
    [x+2.45,e+.46,.52,.42],
    [x+3.65,e+.38,.58,.44],
    // Two distinct rounded boxwood shrubs right of the porch column
    [x+7.55,e+.48,.88,.58],
    [x+8.62,e+.50,.84,.56],
    // Low border shrubs under the right window
    [x+10.1,e+.42,.52,.42],
    [x+11.4,e+.44,.56,.44],
    // Hydrangea bush at the front-right corner
    [r-1.05,e+.58,.96,.76],
  ])plant(m,px!,pz!,ph!,pr!,Math.floor(rng.next()*1e6),supportHeight(town,px!,pz!))
  // Creamy-white hydrangea flower clusters on the front-right corner bush
  for(let i=0;i<14;i++){
    const a=i*2.399,dist=.12+(i%4)*.15,px=r-1.05+Math.cos(a)*dist,pz=e+.58+Math.sin(a)*dist*.82
    const py=.48+(1-(i%4)*.18)*.42+(i%2)*.05
    m.prism(px,pz,.075,.055,py,py+.09,6,rgb(i%3===0?0xdde3d5:0xc5cebc))
  }
  for(const px of [x+.08,r-.14]){
    m.box(px,.12,e+.1,px+.07,2.77,e+.17,trim,MAT.timber)
    m.box(px,.1,e+.15,px+.07,.17,e+.5,trim,MAT.timber)
  }
  for(const px of [x,r-.10])m.box(px,.28,e-.015,px+.10,2.68,e+.025,trim,MAT.wall)
  // Framing side-yard trees and border hedges along the driveway and east side of the house.
  for(const [px,pz,ph,pr] of [
    [x-3.55,e-.4,1.35,.78],
    [x-3.65,e-2.8,1.28,.72],
    [x-3.60,z+3.2,1.35,.74],
    [r+1.05,z+1.8,4.4,1.25],
    [r+1.15,z+5.8,4.8,1.35],
    [r+1.05,e-2.6,4.2,1.22],
    [r+.55,e+.35,1.38,.82],
  ])plant(m,px!,pz!,ph!,pr!,town.houseSeed+Math.floor(pz!*43+px!*17),supportHeight(town,px!,pz!))
  // Patterned Persian/Oriental area rugs in the living room and bedroom, plus a woven kitchen runner.
  // Living room Oriental rug with cream border, slate-sage field, terracotta frame, and central medallion
  {
    const rx0=x+1.55,rz0=e-4.35,rx1=x+4.65,rz1=e-.85,rmx=(rx0+rx1)/2,rmz=(rz0+rz1)/2
    m.box(rx0,.132,rz0,rx1,.138,rz1,rgb(0xc2b498))
    m.box(rx0+.11,.1385,rz0+.11,rx1-.11,.141,rz1-.11,rgb(0x46585a))
    m.box(rx0+.23,.1415,rz0+.23,rx1-.23,.144,rz1-.23,rgb(0x985b46))
    m.box(rx0+.34,.1445,rz0+.34,rx1-.34,.147,rz1-.34,rgb(0x5c6d66))
    m.box(rmx-.52,.1475,rmz-.72,rmx+.52,.150,rmz+.72,rgb(0xa26048))
    m.box(rmx-.30,.1505,rmz-.45,rmx+.30,.152,rmz+.45,rgb(0xc4a274))
  }
  // Bedroom burgundy Persian rug placed beside the bed in the open bedroom floor
  {
    const bx0=x+5.02,bz0=z+1.35,bx1=x+6.88,bz1=z+4.25,bmx=(bx0+bx1)/2,bmz=(bz0+bz1)/2
    m.box(bx0,.132,bz0,bx1,.138,bz1,rgb(0xb8a07e))
    m.box(bx0+.09,.1385,bz0+.09,bx1-.09,.141,bz1-.09,rgb(0x363e4a))
    m.box(bx0+.18,.1415,bz0+.18,bx1-.18,.145,bz1-.18,rgb(0x884235))
    m.box(bmx-.38,.1455,bmz-.62,bmx+.38,.148,bmz+.62,rgb(0xa86848))
    m.box(bmx-.20,.1485,bmz-.32,bmx+.20,.151,bmz+.32,rgb(0xc8a472))
  }
  // Kitchen woven runner mat in front of the north sink/stove run
  m.box(r-4.95,.132,z+6.45,r-2.25,.139,z+7.22,rgb(0xa49b86))
  m.box(r-4.86,.1395,z+6.53,r-2.34,.144,z+7.14,rgb(0x4c564e))
  // Living room east media console, flatscreen TV, partition stub, and flanking potted houseplants
  m.box(x+4.86,.13,e-3.62,x+5.06,2.78,e-1.38,rgb(b.color),MAT.wall,20,rgb(0x303744))
  m.box(x+4.89,2.78,e-3.59,x+5.03,2.80,e-1.41,rgb(0xb8b0a0),MAT.lit)
  m.bevelBox(x+4.44,.13,e-3.55,x+4.85,.62,e-1.45,.03,rgb(0x6e533a),rgb(0x856648),MAT.timber,MAT.timber)
  m.box(x+4.58,.62,e-2.85,x+4.72,.70,e-2.15,rgb(0x22262b))
  m.box(x+4.61,.70,e-3.20,x+4.70,1.38,e-1.80,rgb(0x181c22),MAT.shiny)
  for(const pz of [e-3.88,e-1.12]){
    m.prism(x+4.68,pz,.16,.12,.13,.42,7,rgb(0x8c543a))
    plant(m,x+4.68,pz,.55,.32,town.houseSeed+Math.floor(pz*31),.38)
  }
  // North-wall kitchen run: cream refrigerator, base cabinets, stainless double sink, 4-burner stove & upper cabinets
  const kz=z+5.72
  // Cream-white refrigerator on left of kitchen run
  m.bevelBox(r-5.95,.13,kz,r-5.05,1.88,kz+.72,.03,rgb(0xc6c2b4),rgb(0xd4d0c2))
  m.box(r-5.96,1.32,kz+.71,r-5.04,1.35,kz+.74,rgb(0x5a5850))
  m.box(r-5.16,.82,kz+.72,r-5.12,1.24,kz+.76,rgb(0x7a786e))
  m.box(r-5.16,1.40,kz+.72,r-5.12,1.72,kz+.76,rgb(0x7a786e))
  // Base cabinets & warm butcher/stone countertop with stainless double sink
  m.box(r-5.00,.13,kz,r-2.25,.90,kz+.64,rgb(0x6e5840),MAT.timber)
  m.box(r-5.02,.90,kz-.01,r-2.23,.96,kz+.67,rgb(0xb8b2a2))
  for(let i=0;i<4;i++)m.box(r-4.92+i*.66,.20,kz+.64,r-4.34+i*.66,.84,kz+.66,rgb(0x856c50),MAT.timber)
  m.box(r-4.18,.961,kz+.10,r-3.12,.972,kz+.54,rgb(0x8c9698),MAT.shiny)
  for(const sx of [r-4.10,r-3.60])m.box(sx,.973,kz+.15,sx+.42,.982,kz+.48,rgb(0x3a4446),MAT.shiny)
  m.box(r-3.67,.97,kz+.05,r-3.61,1.18,kz+.12,rgb(0xb0b8ba),MAT.shiny)
  // White 4-burner range stove on right of north counter
  m.box(r-2.22,.13,kz,r-1.38,.94,kz+.68,rgb(0xc2beb0))
  m.box(r-2.23,.94,kz-.01,r-1.37,.965,kz+.69,rgb(0x323838))
  for(const dx of [-.22,.22])for(const dz of [.18,.48])m.prism(r-1.80+dx,kz+dz,.11,.11,.966,.982,8,rgb(0x1b2022))
  m.box(r-2.12,.26,kz+.68,r-1.48,.76,kz+.70,rgb(0x282e30),MAT.shiny)
  // Warm tiled backsplash, under-cabinet warm light strip & upper wall cupboards above north kitchen run
  const kLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x+7&&l.x<r&&l.y>z+5.5&&l.y<e))
  const lLamp=Math.max(0,town.lamps.findIndex(l=>l.kind==="room"&&l.x>x&&l.x<x+5&&l.y>z+5.5&&l.y<e))
  m.box(r-5.00,.96,kz,r-1.38,1.68,kz+.04,rgb(0x9e8c6c),MAT.wall)
  m.box(r-4.92,1.69,kz+.06,r-2.32,1.72,kz+.24,rgb(0xffd896),MAT.lamp,kLamp)
  m.box(r-5.00,1.72,kz,r-2.25,2.38,kz+.38,rgb(0x7c664c),MAT.timber)
  for(let i=0;i<4;i++)m.box(r-4.94+i*.67,1.76,kz+.38,r-4.35+i*.67,2.32,kz+.40,rgb(0x947b5c),MAT.timber)
  // Living room corner table lamp on the sofa end table (x+1.1, e-.62)
  m.prism(x+1.10,e-.62,.03,.025,.66,.92,6,rgb(0x5a4b35))
  m.prism(x+1.10,e-.62,.21,.12,.90,1.16,9,rgb(0xe8b86b),MAT.lamp,lLamp)
  m.prism(x+1.10,e-.62,.17,.17,.89,.90,9,rgb(0xffdca0),MAT.lamp,lLamp)
  // Potted plant in bedroom top-right corner beside the dresser
  m.prism(x+8.95,z+.85,.17,.13,.13,.44,7,rgb(0x885238))
  plant(m,x+8.95,z+.85,.62,.36,town.houseSeed+91,.40)
  // East-wall upper cupboards and framed art prints (within the L-shaped bedroom & kitchen walls)
  m.box(r-.245,1.02,e-3.2,r-.23,1.67,e-.85,rgb(0x727d70),MAT.wall)
  m.box(r-.60,1.78,e-3.2,r-.25,2.37,e-1.2,rgb(0x7c664c),MAT.timber)
  for(let i=0;i<3;i++)m.box(r-.62,1.82,e-3.15+i*.64,r-.60,2.33,e-2.56+i*.64,rgb(0x947b5c),MAT.timber)
  // Framed paintings on bedroom north wall (x+2..x+9.5), living room west wall, and kitchen south wall
  for(let i=0;i<6;i++)m.box(x+5.4+i*.13,.3,z+.25,x+5.48+i*.13,.85,z+.42,rgb(0x87877a),MAT.wall)
  for(const [px,pz] of [[x+3.85,z+.23],[x+7.85,z+.23],[r-3,e-.27]]){
    m.box(px!-.52,1.28,pz!,px!+.52,1.98,pz!+.055,rgb(0x4e3d2c),MAT.wall)
    m.box(px!-.43,1.37,pz!+.056,px!+.43,1.89,pz!+.062,rgb(0x8c8872),MAT.wall)
  }
  for(const [py,pz] of [[1.32,e-2.6],[1.32,e-1.2]]){
    m.box(x+.22,py!,pz!-.44,x+.27,py!+.64,pz!+.44,rgb(0x4e3d2c),MAT.wall)
    m.box(x+.271,py!+.08,pz!-.36,x+.28,py!+.56,pz!+.36,rgb(0x8e8670),MAT.wall)
  }
  for(const barrier of town.barriers){
    const [a,c,d,f]=barrier.rect
    if(a<x||d>r||c<z||f>e||barrier.kind==="fence")continue
    m.box(a-.032,.025,c-.032,d+.032,.33,f+.032,rgb(0x74463a),MAT.brick)
    m.box(a-.036,.33,c-.036,d+.036,.37,f+.036,trim,MAT.wall)
  }
}
