import { BLINDS } from "./world"

/** Shared by surface illumination and motes; footprint is explicit for each consumer. */
export const blindCookieWgsl = /* wgsl */ `
fn blindCookieAt(p: vec3f, lamp: vec3f, footprint: f32) -> f32 {
  let axis=select(vec3f(0.9,-0.5,-0.5),vec3f(0.6,-0.22,-0.72),lamp.z<0.0);
  let distance=max(0.0,p.x-(${BLINDS.x}));
  let q=p-axis*distance/axis.x;
  let centre=select(4.0,0.0,lamp.z<0.0);
  let pen=0.003+distance*O.lightShape.x+footprint*0.5;
  let aperture=smoothstep(0.90-pen,0.90+pen,q.y)*(1.0-smoothstep(2.55-pen,2.55+pen,q.y))*(1.0-smoothstep(1.14-pen,1.14+pen,abs(q.z-centre)));
  let phase=(q.y-${BLINDS.bottom})/${BLINDS.pitch};
  let width=max(0.002,pen/${BLINDS.pitch});
  let a=phase-width;let b=phase+width;
  let fa=floor(a)*0.40+clamp(fract(a)-0.60,0.0,0.40);
  let fb=floor(b)*0.40+clamp(fract(b)-0.60,0.0,0.40);
  return aperture*(fb-fa)/(2.0*width);
}`
