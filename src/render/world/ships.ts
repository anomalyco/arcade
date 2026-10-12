/// <reference types="vite/client" />
// Carrier strike groups: all FLEET ships, instanced per ship kind and material.
// Static hull parts are baked per kind into InstancedMeshes (one per material); team stripes
// (`livery_*`) share one InstancedMesh per kind with per-instance team colours. Turrets are drawn
// instanced too, driven by logical yaw/pitch Object3Ds the client can aim (getShipTurret).
// A clean placeholder ship is shown until the GLB models load. Ships follow their fleet-clock poses
// (geography.setFleetState) every frame; inactive teams' ships are hidden.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  MeshLambertMaterial, Object3D, Quaternion, Vector3, type Material,
} from "three"
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { FLEET, SHIP_SPECS, type Ship, type ShipKind, type TurretKind } from "../../sim/fleet"
import { fleetState, posedShip } from "../../sim/geography"
import type { ShipState } from "../../sim/protocol"
import { EmitterKind, createFireSystem } from "./fire"
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

const ZERO = new Matrix4().makeScale(0, 0, 0)
const WHITE = new Color(1, 1, 1)
const CHAR = new Color(0.12, 0.11, 0.1)

export interface FleetView {
  root: Group
  readonly loadedModels: string[]
  getShipTurret(shipId: string, turretId: string): TurretHandle | null
  update(camera?: Vector3, dt?: number): void
  /** Ship damage/sinking state from the latest snapshot. `now` = room time (for sinking progress). */
  applyStates(ships: readonly ShipState[] | undefined, now?: number): void
  dispose(): void
}

/** Seconds a sunk ship takes to disappear below the surface. */
const SINK_TIME = 20

interface DamageView {
  hp: number
  sunk: boolean
  /** Local clock time the sinking started. */
  sinkStart: number
  damage: Vector3[]
  deadTurrets: Set<string>
  /** Per-ship random list direction (±1) and bow/stern bias. */
  side: number
}

export function createFleet(): FleetView {
  const root = new Group()
  root.name = "World · fleet"
  const drawRoot = new Group()
  root.add(drawRoot)
  // Wet painted steel: fairly smooth so the deck and hull pick up sky/lightning reflections.
  const bodyMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35 })
  bodyMaterial.name = "World · ship hull"
  const liveryMaterial = new MeshStandardNodeMaterial({ color: "#ffffff", roughness: 0.5, metalness: 0.2 })
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
      turretHandles.set(`${sh.id}/${t.id}`, { yaw, pitch, kind: t.kind, ship: sh, id: t.id } as TurretHandle & { kind: TurretKind; ship: Ship })
    }
  }

  let meshes: InstancedMesh[] = []
  let hullMeshes: { mesh: InstancedMesh; ships: Ship[] }[] = []
  let turretMeshes: { mesh: InstancedMesh; handles: (TurretHandle & { ship: Ship })[]; part: "yaw" | "pitch" }[] = []
  const tmp = new Matrix4()

  function build(templates: Record<ShipKind, KindTemplate>) {
    for (const m of meshes) { drawRoot.remove(m); m.geometry.dispose(); m.dispose() }
    meshes = []
    hullMeshes = []
    turretMeshes = []
    for (const kind of SHIP_KINDS) {
      const ships = FLEET.filter(s => s.kind === kind)
      const t = templates[kind]
      for (const part of t.parts) {
        const mesh = new InstancedMesh(part.geometry, matFor(part.color, part.livery), ships.length)
        if (part.livery) ships.forEach((sh, i) => mesh.setColorAt(i, new Color(TEAM_COLORS[sh.team])))
        mesh.frustumCulled = false
        hullMeshes.push({ mesh, ships })
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
          else handles.forEach((_, i) => mesh.setColorAt(i, WHITE))
          mesh.castShadow = true
          mesh.frustumCulled = false
          mesh.name = `turret ${tk} ${partName}`
          drawRoot.add(mesh)
          meshes.push(mesh)
          turretMeshes.push({ mesh, handles, part: partName })
        }
      }
    }
    sync()
  }

  const shipGroups = new Map<string, Group>()
  root.children.forEach(c => { if (c instanceof Group && c !== drawRoot) shipGroups.set(c.name, c) })

  /** Move every ship to its current pose (fleet clock), hide inactive teams, update turrets/wakes. */
  function sync() {
    const teams = fleetState().teams
    // Knocked-out turrets slump (overrides any aim the client set this frame).
    for (const h of turretHandles.values()) {
      const tid = (h as { id?: string }).id ?? ""
      if (states.get(h.ship.id)?.deadTurrets.has(tid)) { h.pitch.rotation.set(-0.45, 0, 0); h.yaw.rotation.z = 0.12 }
      else if (h.yaw.rotation.z !== 0) h.yaw.rotation.z = 0
    }
    for (const [id, g] of shipGroups) {
      const p = posedShip(id)
      if (!p) continue
      const st = states.get(id)
      const sp = SHIP_SPECS[p.kind]
      let settle = 0, roll = 0, pitch = 0, hidden = false
      if (st) {
        const dmg = 1 - Math.max(0, Math.min(1, st.hp))
        // Health-based list and settling.
        roll = st.side * dmg * 0.07
        settle = -dmg * 1.6
        if (st.sunk) {
          const k = Math.max(0, clock - st.sinkStart) / SINK_TIME
          const e = k * k * (3 - 2 * k)
          settle -= e * (sp.deckHeight + (p.kind === "carrier" ? 34 : 24) + 10)
          roll += st.side * e * 0.22
          pitch = -e * 0.09 * st.side
          hidden = k >= 1.15
        }
      }
      g.position.set(p.position[0], settle, p.position[2])
      g.rotation.set(pitch, p.heading, roll, "YXZ")
      g.visible = p.team < teams && !hidden
    }
    root.updateMatrixWorld(true)
    for (const hm of hullMeshes) {
      hm.ships.forEach((sh, i) => {
        const g = shipGroups.get(sh.id)!
        hm.mesh.setMatrixAt(i, g.visible ? g.matrixWorld : ZERO)
      })
      hm.mesh.instanceMatrix.needsUpdate = true
    }
    for (const tm of turretMeshes) {
      tm.handles.forEach((h, i) => {
        const vis = shipGroups.get(h.ship.id)!.visible
        tm.mesh.setMatrixAt(i, !vis ? ZERO : tm.part === "yaw" ? h.yaw.matrixWorld : h.pitch.matrixWorld)
        const dead = states.get(h.ship.id)?.deadTurrets.has((h as { id?: string }).id ?? "") ?? false
        if (tm.mesh.instanceColor && tm.mesh.material !== liveryMaterial) tm.mesh.setColorAt(i, dead ? CHAR : WHITE)
      })
      tm.mesh.instanceMatrix.needsUpdate = true
      if (tm.mesh.instanceColor) tm.mesh.instanceColor.needsUpdate = true
    }
    syncLights()
    syncDamage()
  }

  // Nav / deck lights: small emissive points (HDR for bloom), grown with distance so they stay visible.
  const lightDefs: { ship: Ship; local: Vector3; color: Color }[] = []
  for (const sh of FLEET) {
    const sp = SHIP_SPECS[sh.kind], I = sp.island
    const top = I.center[1] + I.half[1]
    const warm = new Color("#ffb46a").multiplyScalar(6), white = new Color("#fff3e0").multiplyScalar(7)
    lightDefs.push({ ship: sh, local: new Vector3(I.center[0], top + 6, I.center[2]), color: white })
    lightDefs.push({ ship: sh, local: new Vector3(I.center[0] - I.half[0] - 0.5, top - 3, I.center[2]), color: new Color("#ff3a2a").multiplyScalar(6) })
    lightDefs.push({ ship: sh, local: new Vector3(I.center[0] + I.half[0] + 0.5, top - 3, I.center[2]), color: new Color("#3aff6a").multiplyScalar(5) })
    lightDefs.push({ ship: sh, local: new Vector3(0, sp.deckHeight + 1.5, sp.halfLength - 4), color: white })
    const n = sh.kind === "carrier" ? 10 : 3
    for (let k = 0; k < n; k++) {
      const z = -sp.halfLength * 0.85 + (k / Math.max(1, n - 1)) * sp.halfLength * 1.7
      lightDefs.push({ ship: sh, local: new Vector3(k % 2 ? sp.halfWidth - 1 : -sp.halfWidth + 1, sp.deckHeight + 0.8, z), color: warm })
      if (sh.kind === "carrier") lightDefs.push({ ship: sh, local: new Vector3(-4, sp.deckHeight + 0.15, z), color: warm.clone().multiplyScalar(0.6) })
    }
  }
  const lightMaterial = new MeshBasicNodeMaterial({ fog: true })
  lightMaterial.name = "World · ship lights"
  const lights = new InstancedMesh(new IcosahedronGeometry(0.6, 1), lightMaterial, lightDefs.length)
  lightDefs.forEach((d, i) => lights.setColorAt(i, d.color))
  lights.frustumCulled = false
  lights.name = "World · ship lights"
  root.add(lights)
  const lp = new Vector3(), lm = new Matrix4()
  function syncLights() {
    const teams = fleetState().teams
    lightDefs.forEach((d, i) => {
      const g = shipGroups.get(d.ship.id)!
      const st = states.get(d.ship.id)
      if (d.ship.team >= teams || !g.visible || (st && (st.sunk || st.hp < 0.15) && (i * 7919) % 3 !== 0)) { lights.setMatrixAt(i, ZERO); return }
      lp.copy(d.local).applyMatrix4(g.matrixWorld)
      const s = Math.max(1, lp.distanceTo(cameraPos) * 0.0022)
      lm.makeScale(s, s, s).setPosition(lp)
      lights.setMatrixAt(i, lm)
    })
    lights.instanceMatrix.needsUpdate = true
  }
  const cameraPos = new Vector3()

  // ---- damage: states, fires/smoke, scorch decals ----
  const states = new Map<string, DamageView>()
  let clock = 0
  const fire = createFireSystem()
  for (const m of fire.meshes) root.add(m)
  const MAX_SCORCH = 160
  const scorchMat = new MeshStandardNodeMaterial({ color: "#0d0c0b", roughness: 0.35, metalness: 0.1 })
  scorchMat.name = "World · scorch"
  const scorch = new InstancedMesh(new IcosahedronGeometry(1, 2), scorchMat, MAX_SCORCH)
  scorch.frustumCulled = false
  scorch.name = "World · ship scorch"
  root.add(scorch)
  const wp = new Vector3(), sm = new Matrix4(), sq = new Quaternion(), ss = new Vector3()

  function syncDamage() {
    fire.begin()
    let nScorch = 0
    for (const [id, st] of states) {
      const g = shipGroups.get(id)
      const p = posedShip(id)
      if (!g || !p || !g.visible) continue
      const sp = SHIP_SPECS[p.kind]
      const dmg = 1 - Math.max(0, Math.min(1, st.hp))
      const big = p.kind === "carrier" ? 1 : 0.7
      g.getWorldQuaternion(sq)
      // Fires + smoke columns at the hit points (stronger with damage).
      st.damage.forEach((d, k) => {
        wp.copy(d).applyMatrix4(g.matrixWorld)
        const sinkingFade = st.sunk ? Math.max(0, 1 - (clock - st.sinkStart) / (SINK_TIME * 0.6)) : 1
        if (k < 6 && wp.y > 0.5) fire.emit(wp.x, wp.y + 1, wp.z, EmitterKind.Fire, (5 + 7 * dmg) * big, (0.6 + 0.6 * dmg) * sinkingFade, 160 + 140 * dmg)
        if (nScorch < MAX_SCORCH) {
          const r = (6 + 6 * dmg) * big
          ss.set(r, Math.max(0.6, r * 0.12), r)
          sm.compose(wp, sq, ss)
          scorch.setMatrixAt(nScorch++, sm)
        }
      })
      // Knocked-out turrets smoulder.
      for (const t of sp.turrets) if (st.deadTurrets.has(t.id)) {
        wp.set(...t.offset).applyMatrix4(g.matrixWorld)
        fire.emit(wp.x, wp.y + 1.5, wp.z, EmitterKind.Fire, 2.5, 0.8, 90)
      }
      if (st.sunk) {
        const k = Math.max(0, clock - st.sinkStart) / SINK_TIME
        // Heavy smoke from the hull and churned foam/bubbles around it while it goes down.
        for (const z of [-0.5, 0, 0.5]) {
          wp.set(0, sp.deckHeight, z * sp.halfLength).applyMatrix4(g.matrixWorld)
          fire.emit(wp.x, Math.max(wp.y, 1), wp.z, EmitterKind.Smoke, 16 * big, 1.1 * Math.max(0.2, 1 - k * 0.6), 320)
          wp.set(st.side * sp.halfWidth * 0.8, 0, z * sp.halfLength * 1.1).applyMatrix4(g.matrixWorld)
          fire.emit(wp.x, 0.6, wp.z, EmitterKind.Foam, 22 * big, Math.min(1, 0.4 + k), 0)
        }
      }
    }
    fire.end()
    for (let i = nScorch; i < MAX_SCORCH; i++) scorch.setMatrixAt(i, ZERO)
    scorch.instanceMatrix.needsUpdate = true
  }

  function applyStates(ships: readonly ShipState[] | undefined, now?: number) {
    if (!ships) return
    for (const s of ships) {
      let st = states.get(s.id)
      if (!st) {
        let h = 0
        for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) | 0
        st = { hp: 1, sunk: false, sinkStart: 0, damage: [], deadTurrets: new Set(), side: h & 1 ? 1 : -1 }
        states.set(s.id, st)
      }
      st.hp = s.maxHp > 0 ? s.hp / s.maxHp : 1
      if (s.sunk && !st.sunk) st.sinkStart = now !== undefined && s.sunkAt > 0 ? clock - Math.max(0, now - s.sunkAt) : clock
      st.sunk = s.sunk
      st.damage = s.damage.slice(0, 12).map(d => new Vector3(d[0], d[1], d[2]))
      st.deadTurrets.clear()
      for (const [tid, t] of Object.entries(s.turrets)) if (t.hp <= 0) st.deadTurrets.add(tid)
    }
  }

  const placeholder = { carrier: buildTemplate("carrier", placeholderModel("carrier")), destroyer: buildTemplate("destroyer", placeholderModel("destroyer")) }
  build(placeholder)

  // Lazy, non-blocking model load; keep the placeholder if a model is missing.
  let disposed = false
  let modelsLoaded: string[] = []
  void (async () => {
    try {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
      const loader = new GLTFLoader()
      const base = import.meta.env.BASE_URL ?? "/"
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
        } catch (e) { console.warn(`[world] ship model ${kind} failed to load`, e) }
      }))
      if (disposed || (!loaded.carrier && !loaded.destroyer)) return
      build({ carrier: loaded.carrier ?? placeholder.carrier, destroyer: loaded.destroyer ?? placeholder.destroyer })
      modelsLoaded = Object.keys(loaded)
    } catch (e) { console.warn("[world] GLTFLoader unavailable", e) }
  })()

  return {
    root,
    get loadedModels() { return modelsLoaded },
    getShipTurret(shipId, turretId) {
      const h = turretHandles.get(`${shipId}/${turretId}`)
      return h ? { yaw: h.yaw, pitch: h.pitch } : null
    },
    applyStates,
    update(camera?: Vector3, dt = 0) { clock += Math.max(0, dt); if (camera) cameraPos.copy(camera); sync() },
    dispose() {
      disposed = true
      for (const m of meshes) { m.geometry.dispose(); m.dispose() }
      bodyMaterial.dispose(); liveryMaterial.dispose()
      lights.geometry.dispose(); lightMaterial.dispose()
      fire.dispose(); scorch.geometry.dispose(); scorchMat.dispose(); scorch.dispose()
      root.removeFromParent()
    },
  }
}
