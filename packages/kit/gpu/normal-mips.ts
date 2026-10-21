/** Box-filter decoded normal vectors, preserving their length: lost length encodes unresolved normal variance.
 * Never renormalize lower levels, or minification turns a rough normal field back into a perfect mirror. */
export function normalMipChain(width: number, height: number, rgba: Uint8ClampedArray) {
  const levels: { width:number; height:number; data:Uint8Array<ArrayBuffer> }[]=[]
  let vectors=new Float32Array(width*height*3)
  for(let i=0;i<width*height;i++) {
    const x=rgba[i*4]!/127.5-1,y=rgba[i*4+1]!/127.5-1,z=rgba[i*4+2]!/127.5-1
    const length=Math.hypot(x,y,z)||1
    vectors.set([x/length,y/length,z/length],i*3)
  }
  for(;;) {
    const data=new Uint8Array(width*height*4)
    for(let i=0;i<width*height;i++) { for(let c=0;c<3;c++) data[i*4+c]=Math.round((vectors[i*3+c]!*.5+.5)*255);data[i*4+3]=255 }
    levels.push({width,height,data})
    if(width===1&&height===1)return levels
    const w=Math.max(1,width>>1),h=Math.max(1,height>>1),next=new Float32Array(w*h*3)
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const x0=Math.floor(x*width/w),x1=Math.floor((x+1)*width/w),y0=Math.floor(y*height/h),y1=Math.floor((y+1)*height/h),count=(x1-x0)*(y1-y0)
      for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)for(let c=0;c<3;c++)next[(y*w+x)*3+c]!+=vectors[(yy*width+xx)*3+c]!/count
    }
    vectors=next;width=w;height=h
  }
}
