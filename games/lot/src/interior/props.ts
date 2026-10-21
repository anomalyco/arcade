import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"

/** Authored replacements for the reference's non-CC0 reception props. Metres, +Z facing. */
export function receptionProps() {
  const m = new Mesh(), cream: [number,number,number] = [0.59,0.58,0.47], dark: [number,number,number] = [0.09,0.12,0.1]
  // CRT case, bezel, inset phosphor screen, foot and separate keyboard.
  m.box(4.96,0.95,13.77,5.44,1.31,14.16,cream)
  m.box(5,0.99,14.16,5.4,1.27,14.18,dark)
  m.box(5.02,1.01,14.18,5.38,1.25,14.185,[0.09,0.2,0.13],MAT.glow,0.3)
  m.box(5.1,0.947,13.88,5.3,0.98,14.12,dark)
  m.box(4.95,0.948,14.23,5.45,0.978,14.4,cream)
  for (let row=0;row<4;row++) for(let col=0;col<12;col++) m.box(4.97+col*0.038,0.978,14.24+row*0.035,5+col*0.038,0.982,14.267+row*0.035,dark)
  // Desk telephone, receiver, keypad.
  m.box(5.92,0.95,13.96,6.18,1.015,14.19,dark)
  m.box(5.9,1.015,13.96,6.2,1.06,14.03,dark)
  for(let row=0;row<4;row++) for(let col=0;col<3;col++) m.box(5.98+col*0.04,1.015,14.055+row*0.027,6.005+col*0.04,1.021,14.072+row*0.027,cream)
  // Pushed-back office chair, steel stem and five feet.
  m.box(4.75,0.58,12.7,5.25,0.66,13.2,dark)
  m.box(4.75,0.66,12.67,5.25,1.14,12.74,dark)
  m.box(4.97,0.23,12.92,5.03,0.58,12.98,cream)
  m.box(4.69,0.2,12.92,5.31,0.25,12.98,dark)
  m.box(4.97,0.2,12.64,5.03,0.25,13.26,dark)
  // Filing drawers beside the desk, with recessed labels and metal pulls.
  for (const z of [13.4,13.86]) {
    m.box(8.44,0.16,z-0.21,8.98,1.35,z+0.21,[0.31,0.34,0.28])
    for(let row=0;row<4;row++) {
      const y=0.2+row*0.28
      m.box(8.425,y,z-0.19,8.44,y+0.26,z+0.19,[0.39,0.41,0.34])
      m.box(8.41,y+0.16,z-0.06,8.425,y+0.21,z+0.06,cream)
      m.box(8.395,y+0.09,z-0.08,8.425,y+0.11,z+0.08,dark)
    }
  }
  return packTexturedVerts(m.v, new Float32Array(m.v.length / 11 * 2))
}
