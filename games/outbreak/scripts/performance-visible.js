// Run through browser-control execute --session outbreak-performance --file this-file.
const out = process.env.PERF_OUT ?? path.join(process.env.HOME, "code/home/artifacts/2026-10-13-outbreak-performance")
await fsp.mkdir(out, { recursive: true })
let variant = "before"
const originals = {}
for(const name of ["main","level","shaders"]) originals[name]=await (await context.request.get(`http://arcade-review-outbreak.localhost:1355/src/${name}.ts`)).text()
const rootOf=code=>code.match(/\/@fs(.*?)\/packages\/kit\//)[1]
const oldRoot=rootOf(originals.main)
const newRoot=rootOf(await (await context.request.get("http://outbreak-performance-followup.localhost:1355/src/main.ts")).text())
const pattern=/\/src\/(main|level|shaders)\.ts/
await page.route(pattern, async route => {
  const response = await route.fetch()
  const name=new URL(route.request().url()).pathname.split("/").pop().split(".")[0]
  let body = variant === "before" ? originals[name].replaceAll(oldRoot,newRoot) : await response.text()
  body = body.replace("const harness = {", "const harness = { renderer, render, getVision: () => vision,")
  await route.fulfill({ response, body })
})
const reports = []
try {
  for (let pair = 0; pair < 8; pair++) for (const name of pair % 2 ? ["after", "before"] : ["before", "after"]) {
    variant = name
    await page.goto("http://outbreak-performance-followup.localhost:1355/?seed=7&bench")
    await page.waitForFunction(() => window.__arcadeHarness?.ready)
    for (const scene of [{name:"street",x:30,y:41,zoom:46,hour:18},{name:"interior",x:27.7,y:31,zoom:34,hour:19}]) {
      const report = await page.evaluate(async scene => {
        const h = window.__arcadeHarness
        h.reset(7);h.setLab("timeScale",0);h.setLab("zoom",scene.zoom);h.setLab("hour",scene.hour);h.pose(scene.x,scene.y,-Math.PI/2)
        const cpu=[],vision=[],spans=[],poses=[]
        const v=h.getVision(),update=v.update.bind(v),render=h.renderer.render.bind(h.renderer)
        let start=0
        v.update=(...args)=>{let t=performance.now();let r=update(...args);vision.push(performance.now()-t);return r}
        h.renderer.render=(...args)=>{cpu.push(performance.now()-start);return render(...args)}
        for(let i=0;i<16;i++){start=performance.now();await h.step(1/60,{mx:i<8?1:-1});spans.push(performance.now()-start);poses.push({...h.state().player})}
        return {cpu,vision,spans,poses,occluders:h.render.occluderCount,lightCount:h.render.lightCount,adapter:h.adapterInfo,canvas:[document.querySelector("canvas").width,document.querySelector("canvas").height]}
      },scene)
      reports.push({pair,variant:name,scene:scene.name,...report})
      if(pair===1)await page.screenshot({path:`${out}/visible-${name}-${scene.name}.png`,scale:"css"})
    }
  }
  await fsp.writeFile(`${out}/opaque-visible-paired.json`,JSON.stringify(reports,null,2))
  const median=xs=>{xs.sort((a,b)=>a-b);return(xs[Math.floor((xs.length-1)/2)]+xs[Math.floor(xs.length/2)])/2}
  return ["street","interior"].flatMap(scene=>["before","after"].map(variant=>{const runs=reports.filter(r=>r.pair>0&&r.scene===scene&&r.variant===variant);return{scene,variant,queueMedian:median(runs.map(r=>median(r.spans.slice(4)))),runs:runs.map(r=>median(r.spans.slice(4))),cpuMedian:median(runs.flatMap(r=>r.cpu)),visionMedian:median(runs.flatMap(r=>r.vision))}}))
} finally { await page.unroute(pattern); await page.goto("http://outbreak-performance-followup.localhost:1355/?seed=7&bench") }
