/** Give each exported two-triangle pane face affine 0..1 UVs for the shared thin-glass frame. */
export function paneUvs(vertices: ArrayBuffer): ArrayBuffer {
  const data = new DataView(vertices)
  for (let start=0;start<vertices.byteLength;start+=6*32) {
    const end=Math.min(start+6*32,vertices.byteLength)
    const nx=data.getInt8(start+12)/127, ny=data.getInt8(start+13)/127, nz=data.getInt8(start+14)/127
    const horizontal=Math.abs(ny)>0.9
    const points:number[][]=[]
    for(let i=start;i<end;i+=32) {
      const x=data.getFloat32(i,true), y=data.getFloat32(i+4,true), z=data.getFloat32(i+8,true)
      points.push(horizontal?[x,z]:[x*nz-z*nx,y])
    }
    const lo=[0,1].map(k=>Math.min(...points.map(p=>p[k]!)))
    const hi=[0,1].map(k=>Math.max(...points.map(p=>p[k]!)))
    points.forEach((p,j)=>{
      for(const k of [0,1]) data.setFloat32(start+j*32+24+k*4,(p[k]!-lo[k]!)/Math.max(hi[k]!-lo[k]!,1e-8),true)
    })
  }
  return vertices
}
