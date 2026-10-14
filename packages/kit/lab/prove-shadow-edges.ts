/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.SHADOW_EDGES_OUT ?? resolve(root, "captures/shadow-edges"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium required")

// Exact 806d4f5 BEFORE stage-shader.ts and volume-shader.ts and game-sprites.ts for matched single-machine A/B & paired GPU timing
const legacyStageShaderModule = `
export const frameShader = \`
struct Frame {
  inverse:mat4x4f, vp:mat4x4f, eye:vec4f,
  options:vec4f, moon:vec4f, grade:vec4f, ambient:vec4f,
  lights:array<vec4f,24>
}
@group(0) @binding(0) var<uniform> F:Frame;
\`
const common = frameShader + \`
struct Box { lo:vec3f, hi:vec3f }
const fixtures=array<Box,9>(
  Box(vec3f(-6,0,-4),vec3f(6,2.2,-3.6)),Box(vec3f(-6,0,-4),vec3f(-5.6,2.2,5)),
  Box(vec3f(5.6,0,-4),vec3f(6,2.2,-1)),Box(vec3f(5.6,0,1),vec3f(6,2.2,5)),Box(vec3f(-6,0,4.6),vec3f(6,0.65,5)),
  Box(vec3f(-3.5,0.2,-0.8),vec3f(-0.5,0.85,0.8)),Box(vec3f(-2.7,0.85,-0.65),vec3f(-1.1,1.4,0.65)),
  Box(vec3f(2.5,0,0.7),vec3f(3,1.3,1.2)),Box(vec3f(2.55,1.3,0.75),vec3f(2.95,1.7,1.15)));
const yardBoxes=array<Box,9>(
  Box(vec3f(-36,0,-42),vec3f(36,2.2,-41)),Box(vec3f(-36,0,-42),vec3f(-35,2.2,34)),
  Box(vec3f(35,0,-42),vec3f(36,2.2,34)),Box(vec3f(-36,0,33),vec3f(36,2.2,34)),
  Box(vec3f(-22,0,-14),vec3f(-10,2.4,-13.4)),Box(vec3f(-22,0,-14),vec3f(-21.4,2.4,-4)),
  Box(vec3f(-22,0,-4.6),vec3f(-16.5,2.4,-4)),Box(vec3f(-6.5,0,-24),vec3f(-5.7,1.6,-20)),
  Box(vec3f(-6.5,0,2),vec3f(-5.7,1.6,6)));
fn boxAt(i:u32)->Box {
  if(F.options.w>=4.0){return Box(vec3f(1000),vec3f(1000.01));}
  if(F.options.w<3.0){return fixtures[i];}
  return yardBoxes[i];
}
fn intersect(origin:vec3f,ray:vec3f,b:Box)->f32 {
  let safe=select(vec3f(0.000001),ray,abs(ray)>vec3f(0.000001));
  let a=(b.lo-origin)/safe;let c=(b.hi-origin)/safe;let lo=min(a,c);let hi=max(a,c);
  let near=max(max(lo.x,lo.y),lo.z);let far=min(min(hi.x,hi.y),hi.z);
  return select(10000.0,max(near,0.0),near<far&&far>0.0);
}
fn sphere(origin:vec3f,ray:vec3f,centre:vec3f,radius:f32)->f32 {
  let oc=origin-centre;let b=dot(oc,ray);let d=b*b-dot(oc,oc)+radius*radius;
  if(d<0.0){return 10000.0;}let t=-b-sqrt(d);return select(10000.0,t,t>0.0);
}
\`
export const polarShader = common + \`
@group(0) @binding(1) var<storage,read_write> polar:array<vec4f>;
@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid:vec3u){
  let light=gid.x/256u;let bin=gid.x%256u;
  if(light>=min(8u,u32(F.options.x))){return;}
  let angle=(f32(bin)+0.5)/256.0*6.2831853;
  let direction=vec2f(cos(angle),sin(angle));let safe=select(vec2f(0.000001),direction,abs(direction)>vec2f(0.000001));
  let origin=F.lights[light*3u].xz;
  for(var b=0u;b<9u;b++){
    let box=boxAt(b);let a=(box.lo.xz-origin)/safe;let c=(box.hi.xz-origin)/safe;
    let lo=min(a,c);let hi=max(a,c);let near=max(0.0,max(lo.x,lo.y));let far=min(hi.x,hi.y);
    polar[(light*256u+bin)*9u+b]=select(vec4f(10000,10000,0,0),vec4f(near,far,box.lo.y,box.hi.y),near<far&&far>0.0);
  }
}
\`
export const stageShader = common + \`
@group(0) @binding(1) var<storage,read> polar:array<vec4f>;
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->Out {let c=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(c[i],0,1);o.uv=c[i]*vec2f(0.5,-0.5)+0.5;return o;}
fn visibility(p:vec3f,l:i32,surface:i32)->f32 {
  if(F.options.y<0.5){return 1.0;}
  let source=F.lights[l*3];let delta=p-source.xyz;let distance=max(0.001,length(delta.xz));
  let angle=atan2(delta.z,delta.x);let bin=i32(fract(angle/6.2831853+1.0)*256.0);
  var sum=0.0;
  for(var tap=-1;tap<=1;tap++){
    let at=(bin+tap+256)%256;var lit=1.0;
    for(var b=0;b<9;b++){
      if(b==surface){continue;}
      let interval=polar[(l*256+at)*9+b];let end=min(interval.y,distance-0.06);
      if(interval.x>=end){continue;}
      let h0=source.y+delta.y*interval.x/distance;let h1=source.y+delta.y*end/distance;
      if(min(h0,h1)<interval.w-0.015&&max(h0,h1)>interval.z+0.015){lit=0.06;break;}
    }
    sum+=lit;
  }
  return sum/3.0;
}
struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fs(o:Out)->Pixel {
  if(F.options.w==5.0){var out:Pixel;out.color=vec4f(.025,.03,.04,1);out.depth=1.0;return out;}
  let q=F.inverse*vec4f(o.uv*vec2f(2,-2)+vec2f(-1,1),1,1);let ray=normalize(q.xyz/q.w-F.eye.xyz);
  var hit=-F.eye.y/ray.y;var index=-1;
  for(var i=0;i<9;i++){let d=intersect(F.eye.xyz,ray,boxAt(u32(i)));if(d<hit){hit=d;index=i;}}
  if(F.options.w==1.0||F.options.w==2.0){let d=sphere(F.eye.xyz,ray,vec3f(1.3,0.85,-1.8),0.85);if(d<hit){hit=d;index=9;}}
  let p=F.eye.xyz+ray*hit;var normal=vec3f(0,1,0);var albedo=vec3f(0.18,0.21,0.26);
  if(index>=0&&index<9){let b=boxAt(u32(index));let mid=(b.lo+b.hi)*0.5;let r=(p-mid)/((b.hi-b.lo)*0.5);let m=max(max(abs(r.x),abs(r.y)),abs(r.z));normal=normalize(select(vec3f(0),sign(r),abs(r)>=vec3f(m-0.002)));albedo=vec3f(0.3,0.34,0.38);if(index==5){albedo=vec3f(0.06,0.22,0.26);}if(index==6){albedo=vec3f(0.035,0.08,0.11);}if(index>=7){albedo=vec3f(0.42,0.32,0.17);}}
  if(index==9){normal=normalize(p-vec3f(1.3,0.85,-1.8));albedo=vec3f(0.5);}
  var light=F.ambient.rgb*(0.5+0.5*max(normal.y,0.0));
  var specular=vec3f(0);
  let moon=normalize(F.moon.xyz);var moonVisibility=1.0;
  if(F.options.y>0.5){for(var b=0;b<9;b++){if(intersect(p+normal*0.04,moon,boxAt(u32(b)))<1000.0){moonVisibility=0.1;break;}}}
  light+=vec3f(0.48,0.61,0.9)*F.moon.w*max(0.0,dot(normal,moon))*moonVisibility;
  for(var l=0;l<min(8,i32(F.options.x));l++){
    let pos=F.lights[l*3];let color=F.lights[l*3+1];let cone=F.lights[l*3+2];
    let delta=pos.xyz-p;let distance=length(delta);if(distance>=pos.w||color.w==0.0){continue;}
    let direction=delta/max(distance,0.001);var atten=pow(max(0.0,1.0-distance/pos.w),2.0)*color.w;
    if(cone.w>-1.0){atten*=smoothstep(cone.w,min(1.0,cone.w+0.08),dot(-direction,cone.xyz));}
    atten*=visibility(p+normal*0.04,l,index);
    light+=color.rgb*atten*max(0.0,dot(normal,direction));
    let halfway=normalize(direction-ray);specular+=color.rgb*atten*pow(max(0.0,dot(normal,halfway)),48.0)*select(0.06,0.3,index==9);
  }
  let cell=abs(fract(p.xz+0.5)-0.5);let aa=max(fwidth(p.xz),vec2f(0.001));
  let lines=1.0-smoothstep(vec2f(0.015),vec2f(0.015)+aa,cell);
  let grid=select(1.0,1.0-0.28*max(lines.x,lines.y),index<0);
  var rgb=albedo*light*grid+specular;
  if(F.options.w<2.0){
    for(var l=0;l<min(8,i32(F.options.x));l++){
      let pos=F.lights[l*3];let color=F.lights[l*3+1];let lamp=sphere(F.eye.xyz,ray,pos.xyz,0.12);
      if(lamp<hit){rgb=color.rgb*color.w;hit=lamp;normal=normalize(F.eye.xyz+ray*hit-pos.xyz);}
    }
  }
  if(F.options.z==3.0){rgb=light;}
  if(F.options.z==5.0){rgb=normal*0.5+0.5;}
  let clip=F.vp*vec4f(F.eye.xyz+ray*hit,1);var out:Pixel;out.color=vec4f(rgb,1);out.depth=clip.z/clip.w;return out;
}
@group(1) @binding(0) var hdr:texture_2d<f32>;
@fragment fn post(o:Out)->@location(0) vec4f {
  let p=vec2i(o.uv*vec2f(textureDimensions(hdr)));var c=textureLoad(hdr,p,0).rgb;
  if(F.options.z==5.0){return vec4f(c,1);}
  c*=exp2(F.grade.x)*vec3f(1.0+F.grade.w*0.22,1.0,1.0-F.grade.w*0.22);
  c=mix(vec3f(dot(c,vec3f(0.2126,0.7152,0.0722))),c,F.grade.z);
  if(F.grade.y==0.0){c=c/(c+0.8);}
  if(F.grade.y==1.0){c=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),vec3f(0),vec3f(1));}
  return vec4f(pow(max(c,vec3f(0)),vec3f(1.0/2.2)),1);
}
\`
`

const legacyVolumeShaderModule = `
export const volumeShader = \`
struct Frame { inverse: mat4x4f, eye: vec4f, screen: vec4f, ambient: vec4f, boxes: array<vec4f, 8>, lights: array<vec4f, 16> }
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var field: texture_2d_array<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var depth: texture_depth_multisampled_2d;
@group(0) @binding(4) var noise: texture_3d<f32>;
@group(0) @binding(5) var repeat: sampler;
@group(0) @binding(6) var jitter: texture_2d<f32>;
@group(0) @binding(7) var cloud: texture_2d<f32>;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var o: Out; o.position = vec4f(p[i],0,1); o.uv = p[i] * vec2f(0.5,-0.5) + 0.5; return o;
}
fn unproject(uv: vec2f, d: f32) -> vec3f { let p = F.inverse * vec4f(uv * vec2f(2,-2) + vec2f(-1,1),d,1); return p.xyz / p.w; }
fn sceneDepth(uv: vec2f) -> f32 {
  let p = clamp(vec2i(uv * F.screen.xy),vec2i(0),vec2i(F.screen.xy)-1);
  return min(min(textureLoad(depth,p,0),textureLoad(depth,p,1)),min(textureLoad(depth,p,2),textureLoad(depth,p,3)));
}
fn density(p: vec3f) -> vec2f {
  var sum = vec2f(0);
  for (var s = 0; s < 4; s++) {
    let b = F.boxes[s*2]; let uv = (p.xz-b.xy)/b.z;
    if (any(uv <= vec2f(0)) || any(uv >= vec2f(1))) { continue; }
    let cell = clamp(vec2i(uv*48.0),vec2i(0),vec2i(47));
    if (textureLoad(field,cell,s,0).r == 0.0) { continue; }
    let d = textureSampleLevel(field,linear,uv,s,0.0).r;
    let ceiling = 2.65 + 0.55*sin(p.x*1.5-F.eye.w*0.3)*sin(p.z*1.2+F.eye.w*0.2);
    let y = p.y / ceiling;
    let amount = d * smoothstep(0.0,0.13,y) * (1.0-smoothstep(0.32,1.0,y));
    sum += vec2f(amount,amount*F.boxes[s*2+1].z);
  }
  return sum;
}
fn billow(p: vec3f) -> f32 {
  let q = p * 0.035 + vec3f(-F.eye.w*0.009,-F.eye.w*0.012,F.eye.w*0.005);
  let warp = vec3f(sin(q.z*8.0),cos(q.x*7.0),sin(q.y*9.0))*0.035;
  return textureSampleLevel(noise,repeat,q+warp,0.0).r*0.65 + textureSampleLevel(noise,repeat,q*2.13-warp,0.0).r*0.35;
}
@fragment fn march(o: Out) -> @location(0) vec4f {
  let surface = unproject(o.uv,sceneDepth(o.uv)); let ray = normalize(surface-F.eye.xyz);
  let near = max(0.0,(3.8-F.eye.y)/min(-0.0001,ray.y));
  let far = min(distance(surface,F.eye.xyz),(0.015-F.eye.y)/min(-0.0001,ray.y));
  if (far <= near) { return vec4f(0); }
  let stepSize = (far-near)/24.0;
  let j = textureLoad(jitter,vec2i(o.position.xy)%32,0).r;
  var trans = 1.0; var rgb = vec3f(0); var optical = 0.0;
  for (var i = 0; i < 24; i++) {
    let p = F.eye.xyz + ray*(near+(f32(i)+j)*stepSize);
    let sample = density(p); let base = sample.x;
    if (base < 0.002) { continue; }
    let d = base * smoothstep(0.22,0.72,billow(p)) * 2.8;
    let a = 1.0-exp(-d*stepSize); optical += d*stepSize;
    let sun = exp(-density(p+vec3f(0,0.65,0)).x*1.7);
    var light = F.ambient.rgb + vec3f(0.38,0.43,0.51)*sun;
    for (var l = 0; l < min(8,i32(F.screen.z)); l++) {
      let pos = F.lights[l*2]; let color = F.lights[l*2+1]; let delta = pos.xyz-p;
      let d2 = dot(delta,delta);
      if (d2 >= pos.w*pos.w) { continue; }
      let dist = sqrt(max(0.001,d2));
      let shade = exp(-density(p+delta/dist*0.65).x*0.75);
      light += color.rgb*color.w*pow(1.0-dist/pos.w,2.0)*shade;
    }
    light *= mix(1.0,0.14,clamp(sample.y/max(base,0.001),0.0,1.0));
    if (F.screen.w == 1.0) { light = vec3f(base,base*0.4,1.0-base); }
    if (F.screen.w == 2.0) { light = vec3f(optical*0.16,0.12,1.0-optical*0.12); }
    if (F.screen.w == 3.0) { light = light / max(0.01,d); }
    rgb += trans*a*light; trans *= 1.0-a;
    if (trans < 0.015) { break; }
  }
  return vec4f(rgb,1.0-trans);
}
@fragment fn upsample(o: Out) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(cloud)); let pixel = o.uv*size-0.5; let base = floor(pixel); let frac = fract(pixel);
  let centre = unproject(o.uv,sceneDepth(o.uv));
  var sum = vec4f(0); var weight = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let at = clamp(vec2i(base)+vec2i(x,y),vec2i(0),vec2i(size)-1); let uv = (vec2f(at)+0.5)/size;
    let neighbor = unproject(uv,sceneDepth(uv));
    let bilinear = select(1.0-frac.x,frac.x,x==1)*select(1.0-frac.y,frac.y,y==1);
    let w = max(0.00001,bilinear*exp(-abs(neighbor.y-centre.y)*12.0));
    sum += textureLoad(cloud,at,0)*w; weight += w;
  }}
  return sum/weight;
}
\`
`

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const dir = resolve(root, "games/getaway")
const server = await createServer({
  root: dir,
  configFile: resolve(dir, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No fixture port")
const url = `http://127.0.0.1:${addr.port}`

const errors: string[] = []
const report: Record<string, unknown> = {}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!)
}
function mad(xs: number[], med = median(xs)): number {
  return median(xs.map(x => Math.abs(x - med)))
}

try {
  // 1. Capture matched BEFORE vs AFTER stills across all diagnostic scenes
  for (const variant of ["before", "after"] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(`${variant}: ${e.message}`))
    page.on("console", m => {
      if (m.type() === "error" && !m.text().includes("404")) errors.push(`${variant}: ${m.text()}`)
    })
    if (variant === "before") {
      await page.route("**/packages/kit/lab/stage-shader.ts*", route =>
        route.fulfill({ status: 200, contentType: "application/javascript", body: legacyStageShaderModule }),
      )
    }

    await page.goto(`${url}/lab.html?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })
    const adapter = await page.evaluate(() => {
      const a = (window as any).lab.adapter
      return { vendor: a.vendor, architecture: a.architecture }
    })
    assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")
    report.adapter = adapter

    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await page.evaluate(async () => {
          ;(window as any).lab.advance(1 / 60)
          await (window as any).lab.render()
        })
      }
    }

    // Scene A: Room with smoke & shadows (seed 7, f35)
    await page.evaluate(() => (window as any).lab.workbench.frame())
    await step(35)
    await page.screenshot({ path: resolve(out, `${variant}-room-smoke-1280x800.png`) })

    // Scene B: Clean Room Lighting & Shadows (no smoke, so desk + cabinet + wall shadows are 100% unobstructed)
    await page.evaluate(async () => {
      const l = (window as any).lab
      l.context.volume.reset()
      l.context.particles.reset()
      l.context.stage.frameTarget(-0.3, 0.4, 0.2, 14.5)
      await l.render()
    })
    await page.screenshot({ path: resolve(out, `${variant}-room-clean-1280x800.png`) })

    // Scene C: Blackout Meeting Room with Glass (seed 7, sceneMode 4)
    await page.getByRole("searchbox", { name: "Search library" }).fill("Glass shards")
    await page.keyboard.press("Enter")
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-control="library-search"]')!
      input.value = ""
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("meeting")
    await page.evaluate(() => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "blackout-effects")
      s.settings.targetX = 8.5
      s.settings.targetZ = 9
      l.context.sync()
    })
    await page.locator("canvas").focus()
    await page.keyboard.press("f")
    await page.keyboard.press(" ")
    await step(14)
    await page.screenshot({ path: resolve(out, `${variant}-blackout-room-1280x800.png`) })

    // Scene D: Proving Yard Car + Cones + Alcove Wall + Explosion Ring
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await step(2)
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    await step(38)
    await page.keyboard.up("Shift")
    await page.keyboard.down("a")
    await page.keyboard.down("Space")
    await step(34)
    await page.keyboard.up("Space")
    await page.keyboard.up("a")
    await page.keyboard.down("d")
    await page.keyboard.down("s")
    await step(22)
    await page.keyboard.up("s")
    await page.keyboard.up("d")
    await page.keyboard.up("w")
    await page.keyboard.press("Escape")
    await step(2)
    await page.evaluate(async () => {
      const l = (window as any).lab
      const ch = l.spawn.inspect().character
      l.context.stage.frameTarget(ch.x + 1.5, 0.3, ch.z + 4.5, 19)
      await l.render()
    })
    await page.screenshot({ path: resolve(out, `${variant}-car-yard-1280x800.png`) })

    // Scene E: Getaway Street Environment (sceneMode 4)
    const envPicker = page.getByRole("combobox", { name: "Scene environment", exact: true })
    await envPicker.selectOption("street")
    await step(5)
    await page.locator("canvas").focus()
    await page.keyboard.press("p")
    await page.keyboard.down("Shift")
    await page.keyboard.down("w")
    await step(25)
    await page.keyboard.down("Space")
    await step(20)
    await page.keyboard.up("Space")
    await page.keyboard.up("w")
    await page.keyboard.up("Shift")
    await page.keyboard.press("Escape")
    await step(2)
    await page.screenshot({ path: resolve(out, `${variant}-street-env-1280x800.png`) })

    // Scene F: Car Close-ups in Proving Yard
    await envPicker.selectOption("yard")
    await step(2)
    await page.evaluate(() => {
      const s = (window as any).lab.sections.find((x: any) => x.id === "spawn")
      s.moveObject("character:active", -12, 14, Math.PI)
      s.controls.find((c: any) => c.key === "clearSkids").run()
    })
    await step(5)
    await page.locator("canvas").focus()
    await page.keyboard.press("Backquote")
    await page.evaluate(async () => {
      const l = (window as any).lab
      const ch = l.spawn.inspect().character
      const st = l.context.stage
      st.frameTarget(ch.x, 0.5, ch.z, 6.2)
      st.orbit(2.25, -0.22)
      await l.render()
    })
    await page.screenshot({ path: resolve(out, `${variant}-closeup-front-1280x800.png`) })
    await page.evaluate(async () => {
      const l = (window as any).lab
      const ch = l.spawn.inspect().character
      const st = l.context.stage
      st.frameTarget(ch.x, 0.5, ch.z, 6.2)
      st.camYaw = 0.65
      st.camPitch = 0.45
      await l.render()
    })
    await page.screenshot({ path: resolve(out, `${variant}-closeup-rear-1280x800.png`) })
    await page.close()
  }

  // 2. Verify Lab Panel Tunables (Edge AA + Shadow Softness) & Temporal Stability + Video
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    await page.goto(`${url}/lab.html?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })

    // Select Stage Lighting & Grade to inspect Scene -> Edge AA and Shadows -> Softness
    await page.getByRole("button", { name: "Category Lighting", exact: true }).click()
    await page.locator('[data-catalog-id="section:lighting"]').click()
    await page.evaluate(async () => {
      const l = (window as any).lab
      l.context.volume.reset()
      l.context.stage.frameTarget(-0.3, 0.4, 0.2, 14.5)
      await l.render()
    })

    const lightingControlsAudit = await page.evaluate(() => {
      const root = document.querySelector("[data-lab]")!.shadowRoot!
      const keys = [...root.querySelectorAll("[data-controls] [data-key]")].map(el => el.getAttribute("data-key"))
      const st = (window as any).lab.context.stage.lighting
      return { keys, edgeAA: st.edgeAA, shadowSoftness: st.shadowSoftness }
    })
    assert(lightingControlsAudit.keys.includes("edgeAA"), "Edge AA control exposed in Lighting Inspector")
    assert(lightingControlsAudit.keys.includes("shadowSoftness"), "Shadow Softness slider exposed in Lighting Inspector")
    assert.equal(lightingControlsAudit.edgeAA, true, "Edge AA defaults to true")
    assert.equal(lightingControlsAudit.shadowSoftness, 0.45, "Shadow Softness defaults to 0.45")

    // Verify Static Temporal Stability: 30 consecutive frames with static scene have 0 pixel difference
    const staticStability = await page.evaluate(async () => {
      const l = (window as any).lab
      const c = document.querySelector("canvas")!
      const readPixels = async () => {
        await l.render()
        const bmp = await createImageBitmap(c)
        const off = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = off.getContext("2d")!
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data
      }
      const ref = await readPixels()
      let maxDiff = 0
      let changedPixels = 0
      for (let f = 0; f < 30; f++) {
        const cur = await readPixels()
        for (let i = 0; i < ref.length; i += 4) {
          const d = Math.max(Math.abs(cur[i]! - ref[i]!), Math.abs(cur[i + 1]! - ref[i + 1]!), Math.abs(cur[i + 2]! - ref[i + 2]!))
          if (d > 0) changedPixels++
          if (d > maxDiff) maxDiff = d
        }
      }
      return { framesChecked: 30, maxDiff, changedPixels }
    })
    assert.equal(staticStability.maxDiff, 0, "Zero temporal shimmer on stationary camera")
    assert.equal(staticStability.changedPixels, 0, "Zero changed pixels across 30 stationary frames")
    report.staticStability = staticStability

    // Record 90-frame slow orbit sequence in Room + 90-frame slow orbit in Car Yard for temporal stability video
    const framesDir = resolve(tmpdir(), `shadow-edges-frames-${process.pid}`)
    mkdirSync(framesDir, { recursive: true })
    await page.locator("canvas").focus()
    await page.keyboard.press("Backquote")
    for (let f = 0; f < 60; f++) {
      await page.evaluate(async i => {
        const l = (window as any).lab
        const st = l.context.stage
        st.frameTarget(-0.3, 0.4, 0.2, 14.5)
        st.camYaw = -0.35 + (i / 60) * 0.7
        st.camPitch = 0.72
        await l.render()
      }, f)
      await page.screenshot({ path: resolve(framesDir, `frame-${String(f).padStart(4, "0")}.png`) })
    }
    await page.keyboard.press("Backquote")
    await page.getByRole("button", { name: "Category Effects", exact: true }).click()
    await page.locator('[data-catalog-id="fixture:car-cones"]').click()
    await page.locator("canvas").focus()
    await page.keyboard.press("Backquote")
    for (let f = 0; f < 60; f++) {
      await page.evaluate(async i => {
        const l = (window as any).lab
        const ch = l.spawn.inspect().character
        const st = l.context.stage
        st.frameTarget(ch.x, 0.45, ch.z, 8.5)
        st.camYaw = 1.85 + (i / 60) * 0.8
        st.camPitch = 0.48
        await l.render()
      }, f)
      await page.screenshot({ path: resolve(framesDir, `frame-${String(60 + f).padStart(4, "0")}.png`) })
    }
    execFileSync("ffmpeg", [
      "-y",
      "-framerate", "60",
      "-i", resolve(framesDir, "frame-%04d.png"),
      "-c:v", "h264_videotoolbox",
      "-profile:v", "high",
      "-q:v", "75",
      "-pix_fmt", "yuv420p",
      resolve(out, "temporal-stability.mp4"),
    ], { stdio: "ignore" })
    rmSync(framesDir, { recursive: true, force: true })
    await page.close()
  }

  // 3. Paired Metal GPU Frame Cost Benchmark (1 warmup + 9 alternating BEFORE/AFTER pairs)
  const roomPairs: { beforeMs: number; afterMs: number; deltaMs: number }[] = []
  const yardPairs: { beforeMs: number; afterMs: number; deltaMs: number }[] = []

  const pageBefore = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  await pageBefore.route("**/packages/kit/lab/stage-shader.ts*", route =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: legacyStageShaderModule }),
  )
  await pageBefore.goto(`${url}/lab.html?bench`)
  await pageBefore.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })

  const pageAfter = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  await pageAfter.goto(`${url}/lab.html?bench`)
  await pageAfter.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })

  const setupScene = async (p: typeof pageBefore, kind: "room" | "yard") => {
    if (kind === "room") {
      await p.locator('[data-catalog-id="fixture:smoke-room"]').click()
      for (let i = 0; i < 35; i++) {
        await p.evaluate(async () => {
          ;(window as any).lab.advance(1 / 60)
          await (window as any).lab.render()
        })
      }
    } else {
      await p.locator('[data-catalog-id="fixture:car-cones"]').click()
      for (let i = 0; i < 10; i++) {
        await p.evaluate(async () => {
          ;(window as any).lab.advance(1 / 60)
          await (window as any).lab.render()
        })
      }
    }
  }

  const measureBatch = (p: typeof pageBefore) =>
    p.evaluate(async () => {
      const l = (window as any).lab
      const samples: number[] = []
      for (let i = 0; i < 25; i++) {
        const ms = await l.render(true)
        if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) samples.push(ms)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length / 2)]!
    })

  for (const [sceneKind, targetArr] of [["room", roomPairs], ["yard", yardPairs]] as const) {
    await setupScene(pageBefore, sceneKind)
    await setupScene(pageAfter, sceneKind)
    // 1 warmup + 9 measured alternating pairs
    for (let run = 0; run < 10; run++) {
      let bMs = 0
      let aMs = 0
      if (run % 2 === 0) {
        bMs = await measureBatch(pageBefore)
        aMs = await measureBatch(pageAfter)
      } else {
        aMs = await measureBatch(pageAfter)
        bMs = await measureBatch(pageBefore)
      }
      if (run > 0) {
        targetArr.push({ beforeMs: +bMs.toFixed(4), afterMs: +aMs.toFixed(4), deltaMs: +(aMs - bMs).toFixed(4) })
      }
    }
  }
  await pageBefore.close()
  await pageAfter.close()

  const summarizePairs = (pairs: { beforeMs: number; afterMs: number; deltaMs: number }[]) => {
    const befores = pairs.map(p => p.beforeMs)
    const afters = pairs.map(p => p.afterMs)
    const deltas = pairs.map(p => p.deltaMs)
    return {
      pairsCount: pairs.length,
      beforeMedianMs: +median(befores).toFixed(4),
      afterMedianMs: +median(afters).toFixed(4),
      deltaMedianMs: +median(deltas).toFixed(4),
      deltaMadMs: +mad(deltas).toFixed(4),
      rawPairs: pairs,
    }
  }

  report.gpuBenchmark = {
    viewport: "1280x800 (canvas 740x722)",
    interval: "polar compute start through post composite end (hardware timestamp-query)",
    warmupPairs: 1,
    measuredPairs: 9,
    framesPerSample: 25,
    room: summarizePairs(roomPairs),
    yard: summarizePairs(yardPairs),
  }

  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(resolve(out, "shadow-edges-proof.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await server.close()
}
