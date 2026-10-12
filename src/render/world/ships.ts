// Carrier strike groups: all FLEET ships, instanced per ship kind and material.
// Static hull parts are baked per kind into InstancedMeshes (one per material); team stripes
// (`livery_*`) share one InstancedMesh per kind with per-instance team colours. Turrets are drawn
// instanced too, driven by logical yaw/pitch Object3Ds the client can aim (getShipTurret).
// A clean placeholder ship is shown until the GLB models load.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh,
  MeshLambertMaterial, Object3D, PlaneGeometry, ShaderMaterial, type Material,
} from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { FLEET, SHIP_SPECS, type Ship, type ShipKind, type TurretKind } from "../../sim/fleet"
import { PALETTE, TEAM_COLORS } from "./palette"

export interface TurretHandle {
  /** Rotate about Y (ship-relative yaw, 0 = toward the bow). */
  yaw: Object3D
  /** Rotate about X (elevation, positive = up). Child of yaw. */
  pitch: Object3D
}

interface PartGroup { geometry: BufferGeometry; color: Color; livery: boolean }
interface TurretTemplate { yawParts: PartGroup[]; pitchParts: PartGroup[]; pitchOffset: [number, number, number] }
interface KindTemplate { parts: PartGroup[]; turrets: Partial<Record<TurretKind, TurretTemplate>> }

const SHIP_KINDS: ShipKind[] = ["carrier", "destroyer"]

/** Collect meshes under `root` (excluding `skip` subtrees), baked into `space`'s local frame, grouped by colour/livery. */
function collect(root: Object3D, space: Object3D, skip: Set<Object3D>): PartGroup[] {
  root.updateWorldMatrix(true, true)
  const inv = new Matrix4().copy(space.matrixWorld).invert()
  const groups = new Map<string, { geos: BufferGeometry[]; color: Color; livery: boolean }>()
  const visit = (o: Object3D, livery: boolean) => {
    if (skip.has(o)) return
    const isLivery = livery || o.name.startsWith("livery_")
    const m = o as Mesh
    if (m.isMesh && m.geometry) {
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as Material & { color?: Color }
      const color = mat?.color ? mat.color.clone() : new Color(PALETTE.offWhite)
      let g = m.geometry.clone()
      g = g.index ? g.toNonIndexed() : g
      for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name)
      if (!g.getAttribute("normal")) g.computeVertexNormals()
      g.applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld))
      // Bake a muted vertex colour so all non-livery parts share one material/draw call.
      const hsl = { h: 0, s: 0, l: 0 }
      const col = color.clone()
      col.getHSL(hsl)
      col.setHSL(hsl.h, hsl.s * 0.75, hsl.l)
      const n = g.getAttribute("position").count
      const ca = new Float32Array(n * 3)
      for (let q = 0; q < n; q++) { ca[q * 3] = col.r; ca[q * 3 + 1] = col.g; ca[q * 3 + 2] = col.b }
      g.setAttribute("color", new BufferAttribute(ca, 3))
      const key = isLivery ? "livery" : "body"
      const e = groups.get(key) ?? { geos: [], color, livery: isLivery }
      e.geos.push(g)
      groups.set(key, e)
    }
    for (const c of o.children) visit(c, isLivery)
  }
  visit(root, false)
  const out: PartGroup[] = []
  for (const e of groups.values()) {
    const geometry = mergeGeometries(e.geos, false)
    for (const g of e.geos) g.dispose()
    if (geometry) out.push({ geometry, color: e.color, livery: e.livery })
  }
  return out
}

function findTurretNodes(root: Object3D, id: string): { yaw: Object3D; pitch: Object3D | null } | null {
  const yaw = root.getObjectByName(id) ?? root.getObjectByName(`${id}_yaw`) ?? root.getObjectByName(`turret_${id}`)
  if (!yaw) return null
  let pitch: Object3D | null = null
  yaw.traverse(o => { if (!pitch && o !== yaw && /pitch|elev|barrel/i.test(o.name)) pitch = o })
  return { yaw, pitch }
}

/** Build a per-kind template (static parts + turret parts) from a model scene. */
function buildTemplate(kind: ShipKind, model: Object3D): KindTemplate {
  model.updateWorldMatrix(true, true)
  const spec = SHIP_SPECS[kind]
  const skip = new Set<Object3D>()
  const turrets: Partial<Record<TurretKind, TurretTemplate>> = {}
  for (const t of spec.turrets) {
    const nodes = findTurretNodes(model, t.id)
    if (!nodes) continue
    skip.add(nodes.yaw)
    if (turrets[t.kind]) continue
    const pitchSkip = new Set<Object3D>(nodes.pitch ? [nodes.pitch] : [])
    const yawParts = collect(nodes.yaw, nodes.yaw, pitchSkip)
    let pitchParts: PartGroup[] = [], pitchOffset: [number, number, number] = [0, 0, 0]
    if (nodes.pitch) {
      pitchParts = collect(nodes.pitch, nodes.pitch, new Set())
      const p = nodes.pitch.getWorldPosition(new Object3D().position)
      nodes.yaw.worldToLocal(p)
      pitchOffset = [p.x, p.y, p.z]
    }
    turrets[t.kind] = { yawParts, pitchParts, pitchOffset }
  }
  return { parts: collect(model, model, skip), turrets }
}

/** Clean placeholder model with the contract's dimensions and named turret pivots. */
function placeholderModel(kind: ShipKind): Object3D {
  const spec = SHIP_SPECS[kind]
  const root = new Group()
  const mat = (hex: string) => new MeshLambertMaterial({ color: hex })
  const hullH = spec.deckHeight + 6
  const hull = new Mesh(new BoxGeometry(spec.halfWidth * 2 * (kind === "carrier" ? 0.82 : 1), hullH, spec.halfLength * 2 * 0.96), mat("#7d8287"))
  hull.position.y = spec.deckHeight - hullH / 2
  root.add(hull)
  // Tapered bow.
  const bow = new Mesh(new CylinderGeometry(0, spec.halfWidth * (kind === "carrier" ? 0.82 : 1), spec.halfLength * 0.16, 4, 1), mat("#7d8287"))
  bow.rotation.set(Math.PI / 2, Math.PI / 4, 0)
  bow.scale.set(1, 1, hullH / (spec.halfWidth * 2))
  bow.position.set(0, spec.deckHeight - hullH / 2, -spec.halfLength * 0.96 - spec.halfLength * 0.07)
  root.add(bow)
  const deck = new Mesh(new BoxGeometry(spec.halfWidth * 2, 1, spec.halfLength * 2), mat(kind === "carrier" ? "#6e7378" : "#8d9296"))
  deck.position.y = spec.deckHeight - 0.5
  root.add(deck)
  const I = spec.island
  const island = new Mesh(new BoxGeometry(I.half[0] * 2, I.half[1] * 2, I.half[2] * 2), mat(PALETTE.offWhite))
  island.position.set(...I.center)
  root.add(island)
  const stripe = new Mesh(new BoxGeometry(spec.halfWidth * 2 + 0.4, 1.6, 8), mat("#ffffff"))
  stripe.name = "livery_stripe"
  stripe.position.set(0, spec.deckHeight - 3, -spec.halfLength * 0.7)
  root.add(stripe)
  if (kind === "carrier") {
    const paint = new Mesh(new BoxGeometry(1.2, 0.2, spec.halfLength * 1.7), mat(PALETTE.marking))
    paint.position.set(-4, spec.deckHeight + 0.05, 0)
    root.add(paint)
  }
  for (const t of spec.turrets) {
    const yaw = new Group()
    yaw.name = t.id
    yaw.position.set(...t.offset)
    const base = new Mesh(new CylinderGeometry(t.kind === "gun" ? 3 : 1.4, t.kind === "gun" ? 3.4 : 1.6, t.kind === "gun" ? 2.4 : 2.6, 12), mat("#c9ccc9"))
    base.position.y = 1.2
    yaw.add(base)
    const pitch = new Group()
    pitch.name = `${t.id}_pitch`
    pitch.position.y = t.kind === "gun" ? 1.6 : 2.2
    const barrel = new Mesh(new CylinderGeometry(t.kind === "gun" ? 0.35 : 0.25, t.kind === "gun" ? 0.45 : 0.3, t.kind === "gun" ? 7 : 3, 8), mat("#5a5f63"))
    barrel.rotation.x = Math.PI / 2
    barrel.position.z = t.kind === "gun" ? -3.5 : -1.5
    pitch.add(barrel)
    yaw.add(pitch)
    root.add(yaw)
  }
  return root
}

/** Shallow static wake + waterline foam around each hull (one draw call for the whole fleet). */
function createWake(): InstancedMesh {
  const geometry = new PlaneGeometry(1, 1)
  geometry.rotateX(-Math.PI / 2)
  const material = new ShaderMaterial({
    name: "World · ship wake",
    transparent: true,
    depthWrite: false,
    fog: true,
    toneMapped: false,
    uniforms: { foam: { value: new Color(PALETTE.foam).convertLinearToSRGB() }, fogColor: { value: new Color() }, fogNear: { value: 1 }, fogFar: { value: 1000 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute vec2 hullSize;
      varying vec2 vUv;
      varying vec2 vHull;
      void main() {
        vUv = position.xz;
        vHull = hullSize;
        vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 foam;
      varying vec2 vUv;
      varying vec2 vHull;
      void main() {
        #include <logdepthbuf_fragment>
        // vUv in [-0.5, 0.5]; quad spans 3× hull width, 2.2× hull length (stern at +z).
        vec2 p = vUv * vec2(3.0 * vHull.x, 2.2 * vHull.y);
        float hz = vHull.y * 0.5;
        float hx = vHull.x * 0.5;
        // Thin foam band along the waterline.
        vec2 q = vec2(abs(p.x) - hx, abs(p.y + 0.6 * hz) - hz * 1.0);
        float dHull = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        // Soft foam hugging the stern half only (bow shapes vary per model).
        float ring = (1.0 - smoothstep(0.0, 6.0, max(dHull, 0.0))) * smoothstep(-0.2, 0.6, p.y / hz) * 0.35;
        // Stern wake: widening, fading trail behind the ship.
        float behind = p.y - hz * 0.4;
        float trail = 0.0;
        if (behind > 0.0) {
          float len = 2.2 * vHull.y * 0.5 - hz * 0.4;
          float w = hx * (0.7 + behind / len * 1.1);
          trail = (1.0 - smoothstep(w * 0.4, w, abs(p.x))) * (1.0 - behind / len) * 0.45;
          trail *= 0.75 + 0.25 * sin(behind * 0.12 + p.x * 0.05);
        }
        float a = clamp(max(ring, trail), 0.0, 1.0);
        if (a < 0.01) discard;
        gl_FragColor = vec4(foam, a);
        #include <fog_fragment>
      }
    `,
  })
  const mesh = new InstancedMesh(geometry, material, FLEET.length)
  const hull = new Float32Array(FLEET.length * 2)
  const m = new Matrix4(), rot = new Matrix4(), scale = new Matrix4()
  FLEET.forEach((sh, i) => {
    const sp = SHIP_SPECS[sh.kind]
    hull[i * 2] = sp.halfWidth * 2
    hull[i * 2 + 1] = sp.halfLength * 2
    rot.makeRotationY(sh.heading).setPosition(sh.position[0], 0.15, sh.position[2])
    // Shift the quad aft so most of it trails behind the stern.
    scale.makeScale(sp.halfWidth * 6, 1, sp.halfLength * 4.4).setPosition(0, 0, sp.halfLength * 0.6)
    m.multiplyMatrices(rot, scale)
    mesh.setMatrixAt(i, m)
  })
  geometry.setAttribute("hullSize", new InstancedBufferAttribute(hull, 2))
  mesh.frustumCulled = false
  mesh.renderOrder = 1
  mesh.name = "World · ship wakes"
  return mesh
}

export interface FleetView {
  root: Group
  getShipTurret(shipId: string, turretId: string): TurretHandle | null
  update(): void
  dispose(): void
}

export function createFleet(): FleetView {
  const root = new Group()
  root.name = "World · fleet"
  const drawRoot = new Group()
  root.add(drawRoot)
  const bodyMaterial = new MeshLambertMaterial({ vertexColors: true, toneMapped: false })
  bodyMaterial.name = "World · ship hull"
  const liveryMaterial = new MeshLambertMaterial({ color: "#ffffff", toneMapped: false })
  liveryMaterial.name = "World · ship livery"
  const matFor = (_c: Color, livery: boolean) => livery ? liveryMaterial : bodyMaterial

  // Logical ship + turret pivots (never rendered); the client aims these.
  const turretHandles = new Map<string, TurretHandle & { kind: TurretKind; ship: Ship }>()
  for (const sh of FLEET) {
    const g = new Group()
    g.name = sh.id
    g.position.set(sh.position[0], sh.position[1], sh.position[2])
    g.rotation.y = sh.heading
    root.add(g)
    for (const t of SHIP_SPECS[sh.kind].turrets) {
      const yaw = new Object3D()
      yaw.name = `${sh.id}:${t.id}`
      yaw.position.set(...t.offset)
      const pitch = new Object3D()
      yaw.add(pitch)
      g.add(yaw)
      turretHandles.set(`${sh.id}/${t.id}`, { yaw, pitch, kind: t.kind, ship: sh })
    }
  }

  let meshes: InstancedMesh[] = []
  let turretMeshes: { mesh: InstancedMesh; handles: TurretHandle[]; part: "yaw" | "pitch" }[] = []
  const tmp = new Matrix4()

  function build(templates: Record<ShipKind, KindTemplate>) {
    for (const m of meshes) { drawRoot.remove(m); m.geometry.dispose(); m.dispose() }
    meshes = []
    turretMeshes = []
    for (const kind of SHIP_KINDS) {
      const ships = FLEET.filter(s => s.kind === kind)
      const t = templates[kind]
      for (const part of t.parts) {
        const mesh = new InstancedMesh(part.geometry, matFor(part.color, part.livery), ships.length)
        ships.forEach((sh, i) => {
          tmp.makeRotationY(sh.heading).setPosition(sh.position[0], sh.position[1], sh.position[2])
          mesh.setMatrixAt(i, tmp)
          if (part.livery) mesh.setColorAt(i, new Color(TEAM_COLORS[sh.team]))
        })
        mesh.computeBoundingSphere()
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.name = `${kind} ${part.livery ? "livery" : "hull"}`
        drawRoot.add(mesh)
        meshes.push(mesh)
      }
    }
    // Turrets: one InstancedMesh per (turret kind, part, colour) across the whole fleet.
    for (const tk of ["ciws", "gun"] as TurretKind[]) {
      const tpl = templates.carrier.turrets[tk] ?? templates.destroyer.turrets[tk]
      if (!tpl) continue
      const handles = [...turretHandles.values()].filter(h => h.kind === tk)
      for (const h of handles) h.pitch.position.set(...tpl.pitchOffset)
      for (const [partName, parts] of [["yaw", tpl.yawParts], ["pitch", tpl.pitchParts]] as const) {
        for (const part of parts) {
          const mesh = new InstancedMesh(part.geometry, matFor(part.color, part.livery), handles.length)
          if (part.livery) handles.forEach((h, i) => mesh.setColorAt(i, new Color(TEAM_COLORS[(h as { ship: Ship }).ship.team])))
          mesh.castShadow = true
          mesh.frustumCulled = false
          mesh.name = `turret ${tk} ${partName}`
          drawRoot.add(mesh)
          meshes.push(mesh)
          turretMeshes.push({ mesh, handles, part: partName })
        }
      }
    }
    syncTurrets()
  }

  function syncTurrets() {
    root.updateMatrixWorld(true)
    for (const tm of turretMeshes) {
      tm.handles.forEach((h, i) => tm.mesh.setMatrixAt(i, tm.part === "yaw" ? h.yaw.matrixWorld : h.pitch.matrixWorld))
      tm.mesh.instanceMatrix.needsUpdate = true
    }
  }

  const placeholder = { carrier: buildTemplate("carrier", placeholderModel("carrier")), destroyer: buildTemplate("destroyer", placeholderModel("destroyer")) }
  build(placeholder)

  const wake = createWake()
  root.add(wake)

  // Lazy, non-blocking model load; keep the placeholder if a model is missing.
  let disposed = false
  void (async () => {
    try {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
      const loader = new GLTFLoader()
      const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"
      const loaded: Partial<Record<ShipKind, KindTemplate>> = {}
      await Promise.all(SHIP_KINDS.map(async kind => {
        try {
          const gltf = await loader.loadAsync(base + SHIP_SPECS[kind].model)
          const model = gltf.scene.getObjectByName(kind) ?? gltf.scene
          // Template space = the model root (origin at the waterline centre, bow -Z).
          const holder = new Group()
          holder.add(model)
          model.updateWorldMatrix(true, true)
          loaded[kind] = buildTemplate(kind, holder)
        } catch { /* model not available yet */ }
      }))
      if (disposed || (!loaded.carrier && !loaded.destroyer)) return
      build({ carrier: loaded.carrier ?? placeholder.carrier, destroyer: loaded.destroyer ?? placeholder.destroyer })
    } catch { /* loader unavailable */ }
  })()

  return {
    root,
    getShipTurret(shipId, turretId) {
      const h = turretHandles.get(`${shipId}/${turretId}`)
      return h ? { yaw: h.yaw, pitch: h.pitch } : null
    },
    update: syncTurrets,
    dispose() {
      disposed = true
      for (const m of meshes) { m.geometry.dispose(); m.dispose() }
      bodyMaterial.dispose(); liveryMaterial.dispose()
      wake.geometry.dispose(); (wake.material as Material).dispose()
      root.removeFromParent()
    },
  }
}
