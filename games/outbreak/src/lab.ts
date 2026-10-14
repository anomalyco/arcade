import { mat4 } from "wgpu-matrix"
import { lab } from "@arcade/kit/lab/main"
import { MAT } from "@arcade/kit/gpu/mesh"

if (!location.hash && !new URLSearchParams(location.search).has("section") && !new URLSearchParams(location.search).has("bench")) {
  location.hash = "#foliage"
}

void lab({
  materials: [{ game: "Outbreak", codes: MAT }],
  camera: (width, height, vp, inverse, eye, focus) => {
    eye.set([focus[0], focus[1] + 22, focus[2] + 23])
    mat4.multiply(mat4.perspective(0.65, width / height, 0.1, 150), mat4.lookAt(eye, focus, [0, 1, 0]), vp)
    mat4.inverse(vp, inverse)
  },
}).catch(error => {
  console.error(error)
  document.body.textContent = String(error)
})
