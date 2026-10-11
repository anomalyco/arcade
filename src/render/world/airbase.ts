import {
  AdditiveBlending, BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh,
  MeshToonMaterial, PlaneGeometry, ShaderMaterial, SphereGeometry, UniformsLib, UniformsUtils, type DataTexture,
} from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { AIRBASES, BASE_LAYOUT, SAFE_ZONE_HEIGHT, type Airbase } from "../../sim/geography"
import { NOISE_GLSL } from "./glsl"
import { TEAM_COLORS } from "./settings"
import { LIGHTING_GLSL, type LightingUniforms } from "./terrain-material"
import { painted } from "./trees"

// Base-local frame: the base group is rotated by heading, so local +X = right (c), local -Z = forward (a).
const L = (a: number, c: number): [number, number] => [c, -a]

function runwayMaterial(lighting: LightingUniforms, team: number) {
  return new ShaderMaterial({
    name: "World · runway",
    toneMapped: false,
    fog: true,
    uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...lighting, team: { value: new Color(TEAM_COLORS[team]) } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vLocal;
      varying vec2 vWorldXZ;
      void main() {
        vLocal = vec2(position.x, -position.z); // (c, a)
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldXZ = world.xz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 team;
      varying vec2 vLocal;
      varying vec2 vWorldXZ;
      ${NOISE_GLSL}
      ${LIGHTING_GLSL}
      float box(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }
      void main() {
        #include <logdepthbuf_fragment>
        float c = vLocal.x, a = vLocal.y;
        float ac = abs(c), aa = abs(a);
        vec3 asphalt = vec3(0.16, 0.17, 0.19) * (0.9 + 0.15 * wNoise(vWorldXZ * 0.08) + 0.06 * wNoise(vWorldXZ * 0.9));
        // Tire marks near the touchdown zones.
        float tz = smoothstep(700.0, 1100.0, aa) * (1.0 - smoothstep(1100.0, 1180.0, aa));
        asphalt *= 1.0 - 0.25 * tz * smoothstep(0.55, 0.8, wNoise(vec2(c * 0.6, a * 0.02))) * (1.0 - smoothstep(4.0, 12.0, ac));
        float paint = 0.0;
        paint += step(26.5, ac) * step(ac, 28.0); // edge lines
        paint += step(ac, 0.6) * step(fract(a / 60.0), 0.5) * step(aa, 1080.0); // centre dashes
        // Threshold "piano keys".
        float keys = step(1150.0, aa) * step(aa, 1188.0) * step(4.0, ac) * step(ac, 25.0) * step(fract((ac - 4.0) / 3.0), 0.6);
        paint += keys;
        // Aiming point blocks and touchdown zone bars.
        paint += box(vec2(ac, aa), vec2(6.0, 830.0), vec2(14.0, 880.0));
        paint += box(vec2(ac, aa), vec2(7.0, 1040.0), vec2(9.0, 1065.0)) + box(vec2(ac, aa), vec2(11.0, 1040.0), vec2(13.0, 1065.0));
        paint += box(vec2(ac, aa), vec2(7.0, 980.0), vec2(9.0, 1000.0)) + box(vec2(ac, aa), vec2(11.0, 980.0), vec2(13.0, 1000.0));
        paint = clamp(paint, 0.0, 1.0);
        vec3 col = mix(asphalt, vec3(0.92), paint);
        // Team-coloured chevrons on the start end (a < 0) before the threshold.
        float chev = step(1188.0, aa) * step(a, 0.0) * step(fract((-a + ac * 0.8) / 8.0), 0.45) * step(ac, 25.0);
        col = mix(col, team, chev);
        gl_FragColor = vec4(col * worldLight(vec3(0.0, 1.0, 0.0)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  })
}

/** Flat colored quads/discs for taxiways, aprons and helipads. */
class FlatBuilder {
  pos: number[] = []
  col: number[] = []
  quad(a0: number, a1: number, c0: number, c1: number, y: number, color: Color) {
    const [x0, z0] = L(a0, c0), [x1, z1] = L(a1, c1)
    const p = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
    const tris = [0, 2, 1, 0, 3, 2]
    // Ensure upward winding.
    const cross = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])
    const order = cross > 0 ? tris : [0, 1, 2, 0, 2, 3]
    for (const i of order) { this.pos.push(p[i][0], y, p[i][1]); this.col.push(color.r, color.g, color.b) }
  }
  disc(a: number, c: number, r0: number, r1: number, y: number, color: Color, seg = 28) {
    const [cx, cz] = L(a, c)
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2
      const o0 = [cx + Math.cos(t0) * r1, cz + Math.sin(t0) * r1], o1 = [cx + Math.cos(t1) * r1, cz + Math.sin(t1) * r1]
      const i0 = [cx + Math.cos(t0) * r0, cz + Math.sin(t0) * r0], i1 = [cx + Math.cos(t1) * r0, cz + Math.sin(t1) * r0]
      for (const v of [i0, o1, o0, i0, i1, o1]) { this.pos.push(v[0], y, v[1]); this.col.push(color.r, color.g, color.b) }
    }
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3))
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3))
    const normals = new Float32Array(this.pos.length)
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1
    g.setAttribute("normal", new Float32BufferAttribute(normals, 3))
    return g
  }
}

function pavement(): BufferGeometry {
  const b = new FlatBuilder()
  const concrete = new Color("#8e9296"), asphalt = new Color("#3a3d42"), yellow = new Color("#f2c53d"), white = new Color("#f4f4f2")
  for (const r of BASE_LAYOUT.paved) b.quad(r.a0, r.a1, r.c0, r.c1, r.kind === "apron" ? 0.06 : 0.05, r.kind === "apron" ? concrete : asphalt)
  // Taxiway centrelines.
  for (const r of BASE_LAYOUT.paved) {
    if (r.kind !== "taxiway") continue
    const along = r.a1 - r.a0 > r.c1 - r.c0
    if (along) { const m = (r.c0 + r.c1) / 2; b.quad(r.a0 + 12, r.a1 - 12, m - 0.4, m + 0.4, 0.09, yellow) }
    else { const m = (r.a0 + r.a1) / 2; b.quad(m - 0.4, m + 0.4, r.c0, r.c1 - 12, 0.09, yellow) }
  }
  // Apron parking boxes.
  for (let a = -440; a < 240; a += 70) b.quad(a, a + 1, 190, 300, 0.09, yellow)
  for (const [a, c] of BASE_LAYOUT.helipads) {
    const R = BASE_LAYOUT.helipadRadius
    b.disc(a, c, 0, R, 0.1, new Color("#6d7176"))
    b.disc(a, c, R - 1.2, R - 0.4, 0.12, yellow)
    // "H" (legs along a, crossbar along c).
    b.quad(a - 5, a + 5, c - 4, c - 2.6, 0.13, white)
    b.quad(a - 5, a + 5, c + 2.6, c + 4, 0.13, white)
    b.quad(a - 0.7, a + 0.7, c - 2.6, c + 2.6, 0.13, white)
  }
  return b.geometry()
}

/** Cartoon base buildings, merged into one vertex-coloured geometry per base. */
function buildings(team: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const teamCol = TEAM_COLORS[team]
  const put = (g: BufferGeometry, a: number, c: number, y: number, rotY = 0) => {
    g.rotateY(rotY)
    const [x, z] = L(a, c)
    g.translate(x, y, z)
    return g
  }
  // Hangars: half-cylinder roofs facing the apron.
  for (let i = 0; i < 3; i++) {
    const a = -380 + i * 190
    const roof = new CylinderGeometry(26, 26, 54, 16, 1, false, 0, Math.PI)
    roof.rotateZ(Math.PI / 2)
    roof.rotateY(Math.PI / 2)
    parts.push(painted(put(roof, a, 395, 10), "#b9c2c9"))
    const walls = new BoxGeometry(52, 10, 54)
    parts.push(painted(put(walls, a, 395, 5), "#d8d2c4"))
    const stripe = new CylinderGeometry(26.6, 26.6, 6, 16, 1, false, 0, Math.PI)
    stripe.rotateZ(Math.PI / 2)
    stripe.rotateY(Math.PI / 2)
    parts.push(painted(put(stripe, a, 395, 10), teamCol))
    const door = new BoxGeometry(40, 18, 1)
    parts.push(painted(put(door, a, 367.6, 9, Math.PI / 2), "#3c4350"))
  }
  // Control tower.
  const shaft = new CylinderGeometry(4.5, 6, 30, 10)
  parts.push(painted(put(shaft, 300, 380, 15), "#e8e1d2"))
  const cab = new CylinderGeometry(9, 7, 7, 10)
  parts.push(painted(put(cab, 300, 380, 33.5), "#2b4766"))
  const cabTop = new CylinderGeometry(10, 9.2, 2.2, 10)
  parts.push(painted(put(cabTop, 300, 380, 38), teamCol))
  const beacon = new SphereGeometry(1.4, 8, 6)
  parts.push(painted(put(beacon, 300, 380, 40.5), "#ff5640"))
  const base = new BoxGeometry(22, 8, 22)
  parts.push(painted(put(base, 300, 380, 4), "#d8d2c4"))
  // Fuel tanks.
  for (let i = 0; i < 3; i++) {
    const tank = new CylinderGeometry(8, 8, 10, 14)
    parts.push(painted(put(tank, 380 + i * 22, 420, 5), "#eef0ee"))
    const cap = new SphereGeometry(8, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2)
    cap.scale(1, 0.35, 1)
    parts.push(painted(put(cap, 380 + i * 22, 420, 10), teamCol))
  }
  // Radar dome on a stand.
  const stand = new CylinderGeometry(1.6, 2.4, 12, 8)
  parts.push(painted(put(stand, 680, 360, 6), "#9aa1a8"))
  const dome = new SphereGeometry(7, 14, 10)
  parts.push(painted(put(dome, 680, 360, 16), "#f4f2ea"))
  // Windsock pole + sock near the threshold.
  const pole = new CylinderGeometry(0.25, 0.3, 9, 5)
  parts.push(painted(put(pole, -1100, -70, 4.5), "#d0d0d0"))
  const sock = new CylinderGeometry(0.4, 1.1, 5, 8, 1, true)
  sock.rotateZ(Math.PI / 2)
  parts.push(painted(put(sock, -1100, -67, 8.6), "#ff7a2e"))
  // Runway edge lights (small posts).
  for (let a = -1200; a <= 1200; a += 100) for (const c of [-31.5, 31.5]) {
    const light = new BoxGeometry(0.6, 0.7, 0.6)
    parts.push(painted(put(light, a, c, 0.35), a === -1200 ? "#4ef06a" : a === 1200 ? "#ff4848" : "#fff6c8"))
  }
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!merged) throw new Error("airbase merge failed")
  return merged
}

function domeMaterial(team: number) {
  return new ShaderMaterial({
    name: "World · safe zone dome",
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    fog: false,
    uniforms: { color: { value: new Color(TEAM_COLORS[team]) }, strength: { value: 0.5 }, time: { value: 0 }, baseY: { value: 20 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform float strength, time, baseY;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vLocal;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 toEye = cameraPosition - vWorld;
        float dist = length(toEye);
        vec3 n = normalize(vNormalW);
        float facing = abs(dot(n, toEye / dist));
        float rim = pow(1.0 - facing, 3.0);
        // Thin latitude/longitude lines that slowly drift upward.
        vec3 d = normalize(vLocal);
        float lat = asin(clamp(d.y, 0.0, 1.0));
        float lon = atan(d.z, d.x);
        float grid = smoothstep(0.96, 1.0, sin(lat * 26.0 - time * 0.4) * 0.5 + 0.5) + smoothstep(0.985, 1.0, sin(lon * 24.0) * 0.5 + 0.5);
        float ground = 1.0 - smoothstep(0.0, 25.0, vWorld.y - baseY);
        float fade = 1.0 - smoothstep(6000.0, 13000.0, dist);
        float near = smoothstep(0.0, 120.0, dist); // avoid a flash when flying through the shell
        float a = (0.02 + rim * 0.2 + grid * 0.035 + ground * 0.3) * strength * fade * near;
        gl_FragColor = vec4(color * a, 1.0);
      }
    `,
  })
}

export interface AirbaseViews {
  root: Group
  domes: { mesh: Mesh; material: ShaderMaterial }[]
  setHighlight(team: number | null): void
  update(time: number): void
  dispose(): void
}

export function createAirbases(lighting: LightingUniforms, ramp: DataTexture): AirbaseViews {
  const root = new Group()
  root.name = "World · airbases"
  const disposables: { dispose(): void }[] = []
  const propMaterial = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp, toneMapped: false })
  propMaterial.name = "World · base props"
  const padMaterial = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp, toneMapped: false })
  padMaterial.name = "World · pavement"
  disposables.push(propMaterial, padMaterial)
  const padGeometry = pavement()
  disposables.push(padGeometry)
  const domeGeometry = new SphereGeometry(1, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2)
  disposables.push(domeGeometry)
  const domes: AirbaseViews["domes"] = []

  for (const base of AIRBASES as Airbase[]) {
    const g = new Group()
    g.name = `Airbase ${base.team}`
    g.position.set(base.center[0], base.center[1], base.center[2])
    g.rotation.y = base.heading
    const rw = BASE_LAYOUT.runway
    const runwayGeo = new PlaneGeometry(rw.c1 - rw.c0, rw.a1 - rw.a0, 1, 1)
    runwayGeo.rotateX(-Math.PI / 2)
    const rmat = runwayMaterial(lighting, base.team)
    const runway = new Mesh(runwayGeo, rmat)
    runway.position.y = 0.07
    runway.name = "runway"
    g.add(runway)
    disposables.push(runwayGeo, rmat)
    const pads = new Mesh(padGeometry, padMaterial)
    pads.name = "pavement"
    g.add(pads)
    const bgeo = buildings(base.team)
    disposables.push(bgeo)
    const b = new Mesh(bgeo, propMaterial)
    b.name = "buildings"
    g.add(b)
    root.add(g)

    const dmat = domeMaterial(base.team)
    dmat.uniforms.baseY.value = base.center[1]
    const dome = new Mesh(domeGeometry, dmat)
    dome.name = `Safe zone ${base.team}`
    dome.position.set(base.center[0], base.center[1] - 5, base.center[2])
    dome.scale.set(base.safeRadius, SAFE_ZONE_HEIGHT, base.safeRadius)
    dome.renderOrder = 5
    root.add(dome)
    disposables.push(dmat)
    domes.push({ mesh: dome, material: dmat })
  }
  return {
    root, domes,
    setHighlight(team) {
      domes.forEach((d, i) => { d.material.uniforms.strength.value = team === null ? 0.5 : i === team ? 1 : 0.35 })
    },
    update(time) { for (const d of domes) d.material.uniforms.time.value = time % 1000 },
    dispose() { for (const d of disposables) d.dispose() },
  }
}
