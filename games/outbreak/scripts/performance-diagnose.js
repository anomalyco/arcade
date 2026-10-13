// Run after performance-visible.js, on the same private, frozen preview.
return await page.evaluate(async () => {
  const h=window.__arcadeHarness
  h.setLab("timeScale",0);h.reset(7);h.pose(30,41,-Math.PI/2)
  const dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups
  const draw=GPURenderPassEncoder.prototype.draw
  const begin=GPUCommandEncoder.prototype.beginRenderPass
  let mode="full",passIndex=0
  GPUCommandEncoder.prototype.beginRenderPass=function(...args){if(args[0]?.colorAttachments?.[0]?.resolveTarget)passIndex=0;else passIndex++;return begin.apply(this,args)}
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...args){if(mode!=="cached-polar")return dispatch.apply(this,args)}
  GPURenderPassEncoder.prototype.draw=function(...args){if(mode!=="post-only"||passIndex>0)return draw.apply(this,args)}
  const reports=[]
  try {
    for(const next of ["full","cached-polar","full","post-only","full"]){
      mode=next
      const spans=[]
      for(let i=0;i<20;i++){const t=performance.now();await h.step(0);spans.push(performance.now()-t)}
      reports.push({mode,spans})
    }
    return {reports,canvas:[document.querySelector("canvas").width,document.querySelector("canvas").height]}
  } finally {GPUComputePassEncoder.prototype.dispatchWorkgroups=dispatch;GPURenderPassEncoder.prototype.draw=draw;GPUCommandEncoder.prototype.beginRenderPass=begin;await h.step(0)}
})
