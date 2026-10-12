import {
  AdditiveBlending, BoxGeometry, FrontSide, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Float32BufferAttribute,
  Group, IcosahedronGeometry, Matrix4, Mesh, MeshLambertMaterial, ShaderMaterial, SphereGeometry,
} from "three"
import { AIRBASES, BASE_LAYOUT, SAFE_ZONE_HEIGHT, type Airbase } from "../../sim/geography"
import { PALETTE, TEAM_COLORS, TEAM_PASTELS } from "./palette"
import { merge, painted } from "./trees"

// Base-local frame: local +X = right (c), local -Z = forward (a). Geometry is baked into world space.
const L = (a: number, c: number): [number, number] => [c, -a]

function baseMatrix(base: Airbase) {
  return new Matrix4().makeRotationY(base.heading).setPosition(base.center[0], base.center[1], base.center[2])
}

/** Flat colored quads/discs (pavement and paint). */
class FlatBuilder {
  pos: number[] = []
  col: number[] = []
  quad(a0: number, a1: number, c0: number, c1: number, y: number, color: string) {
    const k = new Color(color)
    const [x0, z0] = L(a0, c0), [x1, z1] = L(a1, c1)
    const xs = [Math.min(x0, x1), Math.max(x0, x1)], zs = [Math.min(z0, z1), Math.max(z0, z1)]
    // CCW seen from above (+Y).
    const v = [[xs[0], zs[0]], [xs[0], zs[1]], [xs[1], zs[1]], [xs[0], zs[0]], [xs[1], zs[1]], [xs[1], zs[0]]]
    for (const [x, z] of v) { this.pos.push(x, y, z); this.col.push(k.r, k.g, k.b) }
  }
  disc(a: number, c: number, r0: number, r1: number, y: number, color: string, seg = 12) {
    const k = new Color(color)
    const [cx, cz] = L(a, c)
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2
      const o0 = [cx + Math.cos(t0) * r1, cz + Math.sin(t0) * r1], o1 = [cx + Math.cos(t1) * r1, cz + Math.sin(t1) * r1]
      const i0 = [cx + Math.cos(t0) * r0, cz + Math.sin(t0) * r0], i1 = [cx + Math.cos(t1) * r0, cz + Math.sin(t1) * r0]
      for (const p of [i0, o1, o0, i0, i1, o1]) { this.pos.push(p[0], y, p[1]); this.col.push(k.r, k.g, k.b) }
    }
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3))
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3))
    const nrm = new Float32Array(this.pos.length)
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
    g.setAttribute("normal", new Float32BufferAttribute(nrm, 3))
    return g
  }
}

function pavement(team: number): BufferGeometry {
  const b = new FlatBuilder()
  const rw = BASE_LAYOUT.runway
  const paint = PALETTE.marking
  // Runway slab + simple white markings.
  b.quad(rw.a0, rw.a1, rw.c0, rw.c1, 0.06, PALETTE.concrete)
  b.quad(rw.a0 + 20, rw.a1 - 20, -28, -26.5, 0.12, paint)
  b.quad(rw.a0 + 20, rw.a1 - 20, 26.5, 28, 0.12, paint)
  for (let a = rw.a0 + 90; a < rw.a1 - 90; a += 60) b.quad(a, a + 30, -0.6, 0.6, 0.12, paint)
  for (const end of [-1, 1]) {
    const a0 = end < 0 ? rw.a0 + 12 : rw.a1 - 52
    for (let c = -24; c <= 24; c += 4) if (Math.abs(c) > 2) b.quad(a0, a0 + 40, c - 1, c + 1, 0.12, paint)
    const aim = end < 0 ? rw.a0 + 340 : rw.a1 - 400
    b.quad(aim, aim + 60, -15, -7, 0.12, paint)
    b.quad(aim, aim + 60, 7, 15, 0.12, paint)
  }
  // Team band across the start of the runway.
  b.quad(rw.a0, rw.a0 + 8, rw.c0, rw.c1, 0.12, TEAM_PASTELS[team])
  for (const r of BASE_LAYOUT.paved) b.quad(r.a0, r.a1, r.c0, r.c1, r.kind === "apron" ? 0.05 : 0.04, r.kind === "apron" ? PALETTE.paving : PALETTE.pavingDark)
  for (const [a, c] of BASE_LAYOUT.helipads) {
    const R = BASE_LAYOUT.helipadRadius
    b.disc(a, c, 0, R, 0.09, PALETTE.pavingDark)
    b.disc(a, c, R - 1.4, R - 0.5, 0.12, paint)
    b.quad(a - 5, a + 5, c - 4, c - 2.6, 0.12, paint)
    b.quad(a - 5, a + 5, c + 2.6, c + 4, 0.12, paint)
    b.quad(a - 0.7, a + 0.7, c - 2.6, c + 2.6, 0.12, paint)
  }
  return b.geometry()
}

/** Crisp face normals for deliberately angular shapes (hip/gable roofs). */
function hard(g: BufferGeometry): BufferGeometry {
  const h = g.index ? g.toNonIndexed() : g
  h.computeVertexNormals()
  return h
}

/** Chunky low-poly base buildings: off-white walls, team-coloured roofs. */
function buildings(team: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const roof = TEAM_PASTELS[team]
  const put = (g: BufferGeometry, a: number, c: number, y: number, color: string, rotY = 0) => {
    g.rotateY(rotY)
    const [x, z] = L(a, c)
    g.translate(x, y, z)
    parts.push(painted(g, color))
  }
  for (let i = 0; i < 3; i++) {
    const a = -360 + i * 140
    put(new BoxGeometry(56, 12, 58), a, 370, 6, PALETTE.offWhite)
    // Faceted barrel roof: a 6-sided half cylinder along the hangar depth.
    const r = new CylinderGeometry(28, 28, 58, 18, 1, false, -Math.PI / 2, Math.PI)
    r.rotateX(-Math.PI / 2)
    r.scale(1, 0.55, 1)
    put(r, a, 370, 12, roof, Math.PI / 2)
    put(new BoxGeometry(1, 10, 40), a, 340.6, 6, PALETTE.glass)
  }
  // Control tower.
  put(new CylinderGeometry(5, 6.5, 30, 16), 110, 380, 15, PALETTE.offWhite)
  put(new CylinderGeometry(9.5, 7.5, 7, 16), 110, 380, 33.5, PALETTE.glass)
  put(new ConeGeometry(11, 5, 16), 110, 380, 39.5, roof)
  put(new BoxGeometry(26, 9, 22), 110, 380, 4.5, PALETTE.offWhite)
  put(hard(new ConeGeometry(18, 6, 4)), 110, 380, 12, roof, Math.PI / 4)
  // Little crew houses.
  for (let i = 0; i < 4; i++) {
    const a = -640 + i * 40
    put(new BoxGeometry(18, 8, 14), a, 390, 4, PALETTE.offWhite)
    const gable = new CylinderGeometry(11, 11, 15, 3, 1)
    gable.rotateZ(Math.PI / 2)
    gable.scale(1, 0.5, 1)
    put(hard(gable), a, 390, 9.5, roof)
  }
  // Fuel tanks.
  for (let i = 0; i < 3; i++) {
    put(new CylinderGeometry(8, 8, 10, 20), 560 + i * 22, 330, 5, PALETTE.offWhite)
    put(new ConeGeometry(8.4, 3, 20), 560 + i * 22, 330, 11.5, roof)
  }
  // Radar dome.
  put(new CylinderGeometry(2, 3, 12, 10), 760, 380, 6, PALETTE.paving)
  put(new IcosahedronGeometry(7.5, 3), 760, 380, 17, PALETTE.offWhite)
  // Windsock.
  put(new CylinderGeometry(0.3, 0.35, 9, 8), -650, -70, 4.5, PALETTE.offWhite)
  const sock = new ConeGeometry(1.1, 5, 10, 1, true)
  sock.rotateZ(Math.PI / 2)
  put(sock, -650, -67.5, 8.6, roof)
  return merge(parts)
}

function domeMaterial() {
  return new ShaderMaterial({
    name: "World · safe zone domes",
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: { strength: { value: [1, 1, 1, 1] }, outside: { value: [1, 1, 1, 1] }, time: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 color;
      attribute vec3 local;
      attribute float team;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying float vTeam;
      void main() {
        vLocal = local; vColor = color; vTeam = team;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float strength[4];
      uniform float outside[4];
      uniform float time;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying float vTeam;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 toEye = cameraPosition - vWorld;
        float dist = length(toEye);
        vec3 n = normalize(vec3(vLocal.x, vLocal.y * ${(AIRBASES[0].safeRadius / SAFE_ZONE_HEIGHT).toFixed(4)}, vLocal.z));
        float facing = abs(dot(n, toEye / dist));
        float rim = pow(1.0 - facing, 4.0);
        float fade = 1.0 - smoothstep(2500.0, 6000.0, dist);
        int t = int(vTeam + 0.5);
        float s = t == 0 ? strength[0] : t == 1 ? strength[1] : t == 2 ? strength[2] : strength[3];
        float o = t == 0 ? outside[0] : t == 1 ? outside[1] : t == 2 ? outside[2] : outside[3];
        // Rim-only shell; disappears while the camera is inside it.
        float a = rim * 0.09 * s * fade * o;
        // Encode the colour first, then scale: additive blending happens in display space.
        gl_FragColor = vec4(vColor, 1.0);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= a;
      }
    `,
  })
}

/** Capsule-shaped domes hugging each runway (matches inSafeZone). */
function domes(): BufferGeometry {
  const parts: BufferGeometry[] = []
  for (const base of AIRBASES) {
    const g = new SphereGeometry(1, 48, 14, 0, Math.PI * 2, 0, Math.PI / 2)
    g.deleteAttribute("uv")
    g.deleteAttribute("normal")
    const local = g.getAttribute("position").clone()
    g.setAttribute("local", local)
    const pos = g.getAttribute("position")
    const half = base.runwayLength / 2
    for (let i = 0; i < pos.count; i++) {
      const lz = pos.getZ(i)
      pos.setXYZ(i, pos.getX(i) * base.safeRadius, pos.getY(i) * SAFE_ZONE_HEIGHT, lz * base.safeRadius + Math.sign(Math.round(lz * 1e6)) * half)
    }
    g.applyMatrix4(baseMatrix(base))
    g.translate(0, -5, 0)
    const n = pos.count
    const col = new Color("#ffffff").lerp(new Color(TEAM_COLORS[base.team]), 0.55)
    g.setAttribute("color", new Float32BufferAttribute(new Float32Array(n * 3).map((_, i) => [col.r, col.g, col.b][i % 3]), 3))
    g.setAttribute("team", new Float32BufferAttribute(new Float32Array(n).fill(base.team), 1))
    parts.push(g)
  }
  return merge(parts)
}

export interface AirbaseViews {
  root: Group
  setHighlight(team: number | null): void
  update(time: number, camera?: { x: number; y: number; z: number }): void
  dispose(): void
}

/** All four airbases: 3 draw calls (pavement, buildings, domes). */
export function createAirbases(): AirbaseViews {
  const root = new Group()
  root.name = "World · airbases"
  const material = new MeshLambertMaterial({ vertexColors: true, toneMapped: false })
  material.name = "World · base props"
  const pave: BufferGeometry[] = [], build: BufferGeometry[] = []
  for (const base of AIRBASES) {
    const m = baseMatrix(base)
    pave.push(pavement(base.team).applyMatrix4(m))
    build.push(buildings(base.team).applyMatrix4(m))
  }
  const paveGeo = merge(pave), buildGeo = merge(build)
  const paveMesh = new Mesh(paveGeo, material)
  paveMesh.name = "pavement"
  const buildMesh = new Mesh(buildGeo, material)
  buildMesh.name = "buildings"
  const domeGeo = domes()
  const dmat = domeMaterial()
  const domeMesh = new Mesh(domeGeo, dmat)
  domeMesh.name = "Safe zones"
  domeMesh.renderOrder = 5
  domeMesh.frustumCulled = false
  paveMesh.receiveShadow = true
  buildMesh.castShadow = true
  buildMesh.receiveShadow = true
  root.add(paveMesh, buildMesh, domeMesh)
  return {
    root,
    setHighlight(team) {
      dmat.uniforms.strength.value = [0, 1, 2, 3].map(i => team === null ? 0.8 : i === team ? 1 : 0.55)
    },
    update(time, camera) {
      dmat.uniforms.time.value = time % 1000
      if (!camera) return
      dmat.uniforms.outside.value = AIRBASES.map(b => {
        const half = b.runwayLength / 2
        const a = -(camera.x - b.center[0]) * Math.sin(b.heading) - (camera.z - b.center[2]) * Math.cos(b.heading)
        const c = (camera.x - b.center[0]) * Math.cos(b.heading) - (camera.z - b.center[2]) * Math.sin(b.heading)
        const da = Math.max(0, Math.abs(a) - half)
        const d = Math.hypot(da, c) / b.safeRadius, y = Math.max(0, camera.y - b.center[1]) / SAFE_ZONE_HEIGHT
        const r = Math.sqrt(d * d + y * y) // < 1 inside the shell
        return Math.min(1, Math.max(0, (r - 0.95) / 0.25))
      })
    },
    dispose() { paveGeo.dispose(); buildGeo.dispose(); domeGeo.dispose(); material.dispose(); dmat.dispose() },
  }
}
