import { AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, ShaderMaterial } from "three"
import { WORLD_HALF } from "../../sim/geography"

/** Faint violet haze curtain at the map edge; only visible when the camera is near it. */
export function createBoundary() {
  const H = 5000, h = WORLD_HALF
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]]
  const pos: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i], [x1, z1] = corners[(i + 1) % 4]
    pos.push(x0, 0, z0, x1, 0, z1, x1, H, z1, x0, 0, z0, x1, H, z1, x0, H, z0)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(pos, 3))
  const material = new ShaderMaterial({
    name: "World · boundary haze",
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float time;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        // Distance from the camera to this wall plane, measured horizontally.
        float onXWall = step(abs(abs(vWorld.x) - ${WORLD_HALF.toFixed(1)}), 1.0);
        float wallDist = mix(abs(vWorld.z - cameraPosition.z), abs(vWorld.x - cameraPosition.x), onXWall);
        float near = 1.0 - smoothstep(0.0, 1500.0, wallDist);
        float height = 1.0 - smoothstep(0.0, 3500.0, vWorld.y);
        float a = near * height * height * 0.04;
        gl_FragColor = vec4(vec3(0.85, 0.92, 1.0), 1.0);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= a;
      }
    `,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · boundary"
  mesh.frustumCulled = false
  mesh.renderOrder = 6
  return {
    mesh,
    update(time: number) { material.uniforms.time.value = time % 1000 },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
