/** Textureless, bounded quad effects. World units, Y up, linear HDR output. */
export const fireWaterShader=/* wgsl */`
struct Frame {vp:mat4x4f,eye:vec4f,clock:vec4f,lights:array<vec4f,16>}
@group(0) @binding(0) var<uniform> F:Frame;
struct Out {
 @builtin(position) p:vec4f,@location(0) uv:vec2f,@location(1) world:vec3f,
 @location(2) color:vec4f,@location(3) @interpolate(flat) info:vec4f,
 @location(4) @interpolate(flat) tuning:vec4f
}
fn hash(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn noise(p:vec2f)->f32 {
 let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2f(1,0)),u.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),u.x),u.y);
}
fn fbm(p:vec2f)->f32 {return noise(p)*.57+noise(p*2.03+17.1)*.29+noise(p*4.07-9.2)*.14;}
@vertex fn vs(@builtin(vertex_index) v:u32,@location(0) pos:vec4f,@location(1) axis:vec4f,
 @location(2) color:vec4f,@location(3) info:vec4f,@location(4) tuning:vec4f)->Out {
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let q=corners[v];
 let view=normalize(F.eye.xyz-pos.xyz);var right=normalize(cross(vec3f(0,1,0),view));var up=cross(view,right);
 let kind=i32(info.x);
 if(kind==0||kind==1||kind==4){up=vec3f(0,1,0);}
 if(kind==3||kind==5){up=normalize(axis.xyz+vec3f(0,.0001,0));right=normalize(cross(up,view));}
 if(kind==6||kind==7){right=vec3f(1,0,0);up=vec3f(0,0,1);}
 let world=pos.xyz+q.x*right*pos.w+q.y*up*axis.w;
 var o:Out;o.p=F.vp*vec4f(world,1);o.uv=q;o.world=world;o.color=color;o.info=info;o.tuning=tuning;return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let kind=i32(o.info.x);let seed=o.info.y;let age=o.info.z;let style=o.info.w;
 let uv=o.uv;let aa=max(length(fwidth(uv))*.4,.008);let t=F.eye.w;var rgb=o.color.rgb;var alpha=o.color.a;
 if(kind==0||kind==1){
   let h=uv.y*.5+.5;let flow=t*o.tuning.x;
   let coarse=fbm(vec2f(uv.x*2.5+seed,h*3.3-flow));
   let fine=noise(vec2f(uv.x*7.0+seed*3.0,h*6.0-flow*1.7));
   let bend=sin(h*7.0-flow*2.2+seed)*h*.13+(coarse-.5)*h*.4;
   let x=uv.x+bend;
   let taper=pow(max(0.0,1.0-h),.7);
   let tongue=.12*sin(x*11.0+seed+flow*.7)+.085*sin(x*19.0-flow*.8);
   let density=(.80-abs(x))*taper-h*.40+(coarse-.5)*o.tuning.y+tongue*h+fine*.075;
   let silhouette=smoothstep(.025-aa,.025+aa,density)*smoothstep(0.0,.065,h);
   let core=smoothstep(.17,.46,density)*(1.0-h*.6);
   let middle=smoothstep(.03,.20,density);
   rgb=mix(vec3f(.95,.055,.004),vec3f(2.0,.44,.025),middle);
   rgb=mix(rgb,vec3f(2.7,1.8,.40),core);
   if(style==2.0){rgb=mix(vec3f(.7,.022,.002),vec3f(2.4,.6,.035),smoothstep(.02,.11,density));rgb=mix(rgb,vec3f(3.1,2.1,.7),step(.28,density));}
   alpha*=silhouette;
   if(kind==1){rgb=vec3f(1.4,.62,.11);alpha*=core*.28;}
 }else if(kind==2){
   let r=length(uv);let n=fbm(uv*2.4+vec2f(seed,t*.19));
   alpha*=smoothstep(1.0,.2,r)*smoothstep(.20,.7,n);
   rgb*=.65+n*.55;
 }else if(kind==3){
   alpha*=smoothstep(1.0,.3,abs(uv.x))*smoothstep(1.0,.1,abs(uv.y));
 }else if(kind==4){
   let h=uv.y*.5+.5;let n=fbm(vec2f(uv.x*5.0+seed,h*9.0-t*o.tuning.x));
   let bend=sin(h*6.0-t*3.0+seed)*h*.14;
   let width=.19+.43*h*h;
   let ribbon=1.0-smoothstep(width-.09,width+.08,abs(uv.x+bend));
   let breakup=1.0-smoothstep(.62,.98,h+(.5-n)*.4);
   let streak=noise(vec2f(uv.x*23.0+seed,h*2.0-t*4.0));
   alpha*=ribbon*breakup*smoothstep(0.0,.06,h)*(.38+n*.6);
   rgb=mix(vec3f(.10,.36,.48),vec3f(.8,1.05,1.1),smoothstep(.35,.7,streak));
   if(style==2.0){alpha*=1.25;rgb=mix(vec3f(.12,.4,.55),vec3f(.9,1.15,1.2),step(.54,streak));}
 }else if(kind==5){
   let r=length(vec2f(uv.x,uv.y*.6));
   alpha*=smoothstep(1.0,.25,r)*smoothstep(1.0,.65,abs(uv.y));
   rgb=mix(rgb,vec3f(.9,1.15,1.25),pow(max(0.0,1.0-abs(uv.x+.25)),5.0));
 }else if(kind==6){
   let r=length(uv);let angle=atan2(uv.y,uv.x);
   let boundary=.86+.055*sin(angle*5.0+seed)+.04*sin(angle*9.0-seed)+.03*sin(angle*13.0);
   let edge=1.0-smoothstep(boundary-.025,boundary+.025,r);
   let wave=sin(r*46.0-t*9.0+noise(uv*6.0)*2.0);
   let fine=(noise(o.world.xz*3.4+vec2f(t*.35,-t*.22))-.5)*2.0;
   let crossWave=(noise(o.world.zx*4.1+vec2f(-t*.28,t*.31)+13.0)-.5)*2.0;
   let radial=normalize(uv+vec2f(.001));
   let n=normalize(vec3f(radial.x*wave*.028+fine*.07,1.0,radial.y*wave*.028+crossWave*.07));
   let v=normalize(F.eye.xyz-o.world);let fresnel=.035+.965*pow(1.0-max(0.0,dot(n,v)),5.0);
   rgb=vec3f(.022,.070,.09)+vec3f(.10,.20,.27)*fresnel;
   for(var i=0;i<min(8,i32(F.clock.x));i++){
     let p=F.lights[i*2];let c=F.lights[i*2+1];let delta=p.xyz-o.world;let distance=length(delta);let l=delta/max(.001,distance);
     let halfVector=normalize(l+v);let falloff=pow(max(0.0,1.0-distance/p.w),2.0);
     let spec=pow(max(0.0,dot(n,halfVector)),mix(160.0,65.0,o.tuning.y));
     rgb+=c.rgb*c.w*falloff*(spec*o.tuning.x*.23+.012);
   }
   let ring=pow(max(0.0,wave),24.0)*smoothstep(.55,.1,r)*.03;
   let foam=smoothstep(.69,.82,r)*(1.0-smoothstep(.82,.87,r))*smoothstep(.52,.75,noise(uv*19.0+seed));
   rgb+=vec3f(.5,.75,.78)*(ring+foam*o.tuning.z*.24);
   alpha*=edge*(.72+fresnel*.2);
 }else if(kind==7){
   let r=length(uv);let n=noise(uv*9.0+seed);
   alpha*= (1.0-smoothstep(.018,.055,abs(r-.8)))*(.4+.6*n);
 }else if(kind==8){
   let r=length(uv);let n=fbm(uv*3.4+vec2f(seed,t*-.7));
   let edge=1.0-smoothstep(.65,.97,r+(n-.5)*.3);
   let hot=smoothstep(.25,.7,n)*(1.0-r*.6);
   rgb=mix(vec3f(.7,.035,.002),vec3f(2.6,.6,.025),smoothstep(.15,.5,n));
   rgb=mix(rgb,vec3f(3.2,2.3,.9),hot*.85);alpha*=edge;
 }
 if(alpha<.003){discard;}return vec4f(rgb,alpha);
}`

export const heatShader=/* wgsl */`
struct Frame {vp:mat4x4f,eye:vec4f,source:vec4f,screen:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_multisampled_2d;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) pixel:vec4f)->@location(0) vec4f {
 let center=F.vp*vec4f(F.source.xyz,1);let top=F.vp*vec4f(F.source.xyz+vec3f(0,4.0,0),1);
 let origin=(center.xy/center.w*vec2f(.5,-.5)+.5)*F.screen.xy;
 let peak=(top.xy/top.w*vec2f(.5,-.5)+.5)*F.screen.xy;
 let height=max(1.0,origin.y-peak.y);let uv=vec2f((pixel.x-origin.x)/(height*.48),(origin.y-pixel.y)/height);
 let mask=smoothstep(0.0,.35,uv.y)*(1.0-smoothstep(.65,1.2,uv.y))*exp(-uv.x*uv.x*3.5);
 let d=textureLoad(depth,vec2i(pixel.xy),0);let behind=step(center.z/center.w-.001,d);
 let wave=sin(uv.y*28.0-F.eye.w*7.0+sin(uv.x*12.0))*sin(uv.y*13.0-F.eye.w*4.0);
 let offset=vec2f(wave,sin(uv.x*9.0+F.eye.w*4.0)*.35)*mask*F.source.w*behind;
 let at=clamp(vec2i(pixel.xy+offset),vec2i(0),vec2i(F.screen.xy)-1);
 return textureLoad(scene,at,0);
}`
