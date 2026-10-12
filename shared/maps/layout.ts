import type { Rng } from "../rng"

export type Side = "n" | "s" | "e" | "w"

export type RoomKind =
  | "office"
  | "manager"
  | "storage"
  | "closet"
  | "server"
  | "bathroom"
  | "kitchen"
  | "copy"
  | "meeting"
  | "boardroom"
  | "lounge"
  | "cubicles"
  | "empty"
  | "hall"
  | "core"

/** Inclusive cell rectangle [x0, y0, x1, y1]. */
export type CellRect = [number, number, number, number]

export type Room = {
  id: number
  kind: RoomKind
  /** The first rect is the room proper and gets furnished; later ones are slivers merged into it. */
  rects: CellRect[]
}

/** What stands on a cell edge between two zones. */
export const EDGE = { none: 0, wall: 1, door: 2, glass: 3, open: 4 } as const
export type EdgeKind = (typeof EDGE)[keyof typeof EDGE]

/**
 * A floor plan on an irregular grid. Cell (x, y) spans xs[x]..xs[x+1] by ys[y]..ys[y+1] metres. Zone 0 is corridor,
 * zone k > 0 is rooms[k]. Edge h[y * gw + x] runs along the top of cell (x, y) for y in 0..gh; edge v[y * (gw + 1) + x]
 * runs down the left of cell (x, y) for x in 0..gw. Outer edges stay EDGE.none; the builder walls them.
 */
export type Plan = {
  gw: number
  gh: number
  xs: number[]
  ys: number[]
  zone: Int32Array
  rooms: Room[]
  h: Uint8Array
  v: Uint8Array
}

type Node = { i: number; j: number; x: number; y: number; alive: boolean; fixed: boolean }
type Link = { a: number; b: number; horiz: boolean; used: boolean }
type Special = { i0: number; j0: number; i1: number; j1: number; kind: "hall" | "core" }

const round2 = (v: number) => Math.round(v * 100) / 100

/** Cell boundaries with widths between 2.0 and 2.5 m, so corridors are 1.7 to 2.2 m clear between walls. */
function bounds(r: Rng, n: number): number[] {
  const out = [0]
  for (let i = 0; i < n; i++) out.push(round2(out[i]! + 2 + r.int(6) * 0.1))
  return out
}

/** Grid lines of the corridor lattice: 4 to 6 cells apart, 3 to 4 cells in from the outer walls. */
function lines(r: Rng, n: number): number[] {
  const a = 3 + r.int(2)
  const b = n - 4 - r.int(2)
  const k = Math.max(2, Math.round((b - a) / 4.4) + 1)
  const out: number[] = []
  for (let i = 0; i < k; i++) out.push(Math.round(a + ((b - a) * i) / (k - 1)))
  for (let i = 1; i < k - 1; i++) {
    const d = r.int(3) - 1
    if (out[i]! + d - out[i - 1]! >= 4 && out[i + 1]! - out[i]! - d >= 4) out[i]! += d
  }
  return out
}

export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1)
    ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
  }
  return xs
}

function weighted<T extends string>(r: Rng, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((s, [, w]) => s + w, 0)
  let x = r.next() * total
  for (const [v, w] of table) {
    x -= w
    if (x < 0) return v
  }
  return table[table.length - 1]![0]
}

/**
 * Lays out a labyrinthine office floor:
 * 1. A lattice of corridor junctions with jittered positions, so corridors between them dogleg.
 * 2. A few lattice faces become landmarks: open-plan halls and a lift core.
 * 3. A growing-tree spanning tree over the lattice gives long winding corridors with T-junctions and dead ends; part of
 *    the dead ends are braided into loops, and unused edges sprout short dead-end stubs.
 * 4. Everything that isn't corridor is tiled greedily into rooms, which get doors onto corridors or, when they have no
 *    corridor frontage, onto a neighbouring room that is already connected (office suites), plus a few extra
 *    room-to-room doors for flanking loops.
 */
export function layout(r: Rng): Plan {
  const gw = 46 + r.int(9)
  const gh = 32 + r.int(7)
  const xs = bounds(r, gw)
  const ys = bounds(r, gh)
  const cols = lines(r, gw)
  const rows = lines(r, gh)
  const NX = cols.length
  const NY = rows.length

  // Landmarks on lattice faces, kept a face apart from each other.
  const specials: Special[] = []
  const overlaps = (s: Special) => specials.some((o) => s.i0 <= o.i1 + 1 && s.i1 >= o.i0 - 1 && s.j0 <= o.j1 + 1 && s.j1 >= o.j0 - 1)
  const midI = Math.floor((NX - 1) / 2)
  const midJ = Math.floor((NY - 1) / 2)
  specials.push({ i0: midI - r.int(2), j0: midJ - r.int(2), i1: 0, j1: 0, kind: "core" })
  specials[0]!.i1 = specials[0]!.i0
  specials[0]!.j1 = specials[0]!.j0
  const halls = 2 + r.int(2)
  for (let tries = 0; tries < 60 && specials.length < 1 + halls; tries++) {
    const long = 2 + (r.next() < 0.35 ? 1 : 0)
    const short = 1 + (r.next() < 0.35 ? 1 : 0)
    const [w, h] = r.next() < 0.5 ? [long, short] : [short, long]
    if (w >= NX - 1 || h >= NY - 1) continue
    const i0 = r.int(NX - w)
    const j0 = r.int(NY - h)
    const s: Special = { i0, j0, i1: i0 + w - 1, j1: j0 + h - 1, kind: "hall" }
    if (!overlaps(s)) specials.push(s)
  }
  const inside = (s: Special, i: number, j: number) => i > s.i0 && i < s.i1 + 1 && j > s.j0 && j < s.j1 + 1
  const onEdge = (s: Special, i: number, j: number) => i >= s.i0 && i <= s.i1 + 1 && j >= s.j0 && j <= s.j1 + 1

  const nodes: Node[] = []
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      const fixed = specials.some((s) => onEdge(s, i, j))
      const alive = !specials.some((s) => inside(s, i, j))
      nodes.push({ i, j, x: cols[i]!, y: rows[j]!, alive, fixed })
    }
  // Jitter free junctions by a cell so corridors between them dogleg.
  // Jitter free junctions by a cell so corridors between them dogleg, keeping neighbours at least 3 cells apart.
  for (const n of nodes) {
    if (n.fixed) continue
    const near = (di: number, dj: number) => nodes[(n.j + dj) * NX + n.i + di]
    if (r.next() < 0.6) {
      const x = n.x + (r.next() < 0.5 ? -1 : 1)
      const L = n.i > 0 ? near(-1, 0)!.x : -9
      const R = n.i < NX - 1 ? cols[n.i + 1]! + 1 : 99
      if (x - L >= 3 && R - x >= 4) n.x = x
    }
    if (r.next() < 0.6) {
      const y = n.y + (r.next() < 0.5 ? -1 : 1)
      const U = n.j > 0 ? near(0, -1)!.y : -9
      const D = n.j < NY - 1 ? rows[n.j + 1]! + 1 : 99
      if (y - U >= 3 && D - y >= 4) n.y = y
    }
  }

  const links: Link[] = []
  const at = (i: number, j: number) => j * NX + i
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      if (!nodes[at(i, j)]!.alive) continue
      if (i + 1 < NX && nodes[at(i + 1, j)]!.alive && !specials.some((s) => i + 0.5 > s.i0 && i + 0.5 < s.i1 + 1 && j > s.j0 && j < s.j1 + 1))
        links.push({ a: at(i, j), b: at(i + 1, j), horiz: true, used: false })
      if (j + 1 < NY && nodes[at(i, j + 1)]!.alive && !specials.some((s) => i > s.i0 && i < s.i1 + 1 && j + 0.5 > s.j0 && j + 0.5 < s.j1 + 1))
        links.push({ a: at(i, j), b: at(i, j + 1), horiz: false, used: false })
    }
  const adj: number[][] = nodes.map(() => [])
  links.forEach((l, k) => {
    adj[l.a]!.push(k)
    adj[l.b]!.push(k)
  })
  const other = (l: Link, n: number) => (l.a === n ? l.b : l.a)
  const degree = (n: number) => adj[n]!.filter((k) => links[k]!.used).length

  // Growing tree: mostly extend the newest branch (long winding corridors), sometimes a random one (side branches).
  const inTree = new Uint8Array(nodes.length)
  const alive = nodes.map((n, k) => (n.alive ? k : -1)).filter((k) => k >= 0)
  const start = alive[r.int(alive.length)]!
  inTree[start] = 1
  const active = [start]
  while (active.length) {
    const ai = r.next() < 0.75 ? active.length - 1 : r.int(active.length)
    const n = active[ai]!
    const opts = adj[n]!.filter((k) => !inTree[other(links[k]!, n)])
    if (!opts.length) {
      active.splice(ai, 1)
      continue
    }
    const k = opts[r.int(opts.length)]!
    links[k]!.used = true
    const m = other(links[k]!, n)
    inTree[m] = 1
    active.push(m)
  }
  // Braid about half the dead ends into loops, and add a few more cross links.
  for (const n of shuffle(r, [...alive])) {
    if (degree(n) !== 1 || r.next() < 0.7) continue
    const opts = adj[n]!.filter((k) => !links[k]!.used)
    if (opts.length) links[opts[r.int(opts.length)]!]!.used = true
  }
  for (const l of links) if (!l.used && r.next() < 0.03) l.used = true
  // Every landmark opens onto at least two corridors.
  for (const s of specials) {
    const rim = links.filter((l) => {
      const a = nodes[l.a]!
      const b = nodes[l.b]!
      return onEdge(s, a.i, a.j) && onEdge(s, b.i, b.j)
    })
    let used = rim.filter((l) => l.used).length
    for (const l of shuffle(r, rim)) {
      if (used >= 2 + (s.kind === "hall" ? 1 : 0)) break
      if (!l.used) {
        l.used = true
        used++
      }
    }
  }

  const zone = new Int32Array(gw * gh).fill(-1)
  const carve = (cells: [number, number][]) => {
    for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < gw && y < gh) zone[y * gw + x] = 0
  }
  /** Cells from node a to node b: straight, or a dogleg when their positions are offset. */
  const route = (l: Link, from: number): [number, number][] => {
    const a = nodes[from]!
    const b = nodes[other(l, from)]!
    const out: [number, number][] = []
    const run = (x0: number, y0: number, x1: number, y1: number) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
      for (let k = 0; k <= n; k++) out.push([x0 + Math.sign(x1 - x0) * k, y0 + Math.sign(y1 - y0) * k])
    }
    if (l.horiz) {
      const lo = Math.min(a.x, b.x)
      const hi = Math.max(a.x, b.x)
      const mx = a.y === b.y ? a.x : lo + 1 + r.int(Math.max(1, hi - lo - 1))
      run(a.x, a.y, mx, a.y)
      run(mx, a.y, mx, b.y)
      run(mx, b.y, b.x, b.y)
    } else {
      const lo = Math.min(a.y, b.y)
      const hi = Math.max(a.y, b.y)
      const my = a.x === b.x ? a.y : lo + 1 + r.int(Math.max(1, hi - lo - 1))
      run(a.x, a.y, a.x, my)
      run(a.x, my, b.x, my)
      run(b.x, my, b.x, b.y)
    }
    return out
  }
  for (const l of links) {
    if (l.used) carve(route(l, l.a))
    else if (r.next() < 0.3) {
      // A dead-end stub partway along an unused link.
      const from = r.next() < 0.5 ? l.a : l.b
      const cells = route(l, from)
      carve(cells.slice(0, 2 + r.int(Math.max(1, Math.floor(cells.length / 2) - 1))))
    }
  }
  // Now and then a corridor runs out to the outer wall and stops.
  for (const n of nodes) {
    if (!n.alive || n.fixed || r.next() > 0.14) continue
    if (n.i === 0) carve(Array.from({ length: n.x + 1 }, (_, k): [number, number] => [k, n.y]))
    else if (n.i === NX - 1) carve(Array.from({ length: gw - n.x }, (_, k): [number, number] => [n.x + k, n.y]))
    else if (n.j === 0) carve(Array.from({ length: n.y + 1 }, (_, k): [number, number] => [n.x, k]))
    else if (n.j === NY - 1) carve(Array.from({ length: gh - n.y }, (_, k): [number, number] => [n.x, n.y + k]))
  }

  const rooms: Room[] = [{ id: 0, kind: "empty", rects: [] }]
  const addRoom = (kind: RoomKind, rc: CellRect): Room => {
    const room: Room = { id: rooms.length, kind, rects: [rc] }
    rooms.push(room)
    for (let y = rc[1]; y <= rc[3]; y++) for (let x = rc[0]; x <= rc[2]; x++) zone[y * gw + x] = room.id
    return room
  }
  for (const s of specials) {
    const a = nodes[at(s.i0, s.j0)]!
    const b = nodes[at(s.i1 + 1, s.j1 + 1)]!
    addRoom(s.kind, [a.x + 1, a.y + 1, b.x - 1, b.y - 1])
  }
  // Tile the rest into rooms, scanning row by row and growing each room right then down.
  const dim = () => {
    const t = r.next()
    return t < 0.07 ? 1 : t < 0.5 ? 2 : t < 0.86 ? 3 : 4
  }
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      if (zone[y * gw + x] !== -1) continue
      const tw = dim()
      const th = dim()
      let w = 1
      while (w < tw && x + w < gw && zone[y * gw + x + w] === -1) w++
      let h = 1
      while (h < th && y + h < gh) {
        let ok = true
        for (let k = 0; k < w; k++) if (zone[(y + h) * gw + x + k] !== -1) ok = false
        if (!ok) break
        h++
      }
      addRoom("empty", [x, y, x + w - 1, y + h - 1])
    }

  const area = (room: Room) => room.rects.reduce((s, c) => s + (c[2] - c[0] + 1) * (c[3] - c[1] + 1), 0)
  const neighbours = (room: Room): Map<number, number> => {
    const out = new Map<number, number>()
    for (const c of room.rects)
      for (let y = c[1]; y <= c[3]; y++)
        for (let x = c[0]; x <= c[2]; x++)
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
            const z = zone[ny * gw + nx]!
            if (z !== room.id) out.set(z, (out.get(z) ?? 0) + 1)
          }
    return out
  }
  // Fold single cells into the smallest neighbouring ordinary room.
  for (const room of rooms) {
    if (room.id === 0 || room.kind !== "empty" || area(room) !== 1 || !room.rects.length) continue
    let best: Room | null = null
    for (const z of neighbours(room).keys()) {
      const o = rooms[z]
      if (!o || z === 0 || o.kind !== "empty" || o === room) continue
      if (!best || area(o) < area(best)) best = o
    }
    if (!best) continue
    const c = room.rects[0]!
    best.rects.push(c)
    zone[c[1] * gw + c[0]] = best.id
    room.rects = []
  }

  // Room kinds by size; repeated small offices make corridors look alike.
  for (const room of rooms) {
    if (room.id === 0 || room.kind !== "empty" || !room.rects.length) continue
    const c = room.rects[0]!
    const w = c[2] - c[0] + 1
    const h = c[3] - c[1] + 1
    const a = w * h
    if (Math.min(w, h) === 1)
      room.kind = weighted(r, [
        ["closet", 6],
        ["bathroom", Math.max(w, h) >= 2 ? 2 : 0],
        ["server", 1],
        ["empty", 1],
      ])
    else if (a <= 6)
      room.kind = weighted(r, [
        ["office", 9],
        ["storage", 2.5],
        ["copy", 1.2],
        ["server", 1.5],
        ["bathroom", 1.5],
        ["kitchen", 0.8],
        ["empty", 1.5],
      ])
    else if (a <= 12)
      room.kind = weighted(r, [
        ["manager", 2],
        ["meeting", 2],
        ["kitchen", 1.4],
        ["lounge", 1],
        ["storage", 1.2],
        ["server", 1],
        ["bathroom", 1],
        ["cubicles", 1],
        ["office", 1],
        ["empty", 0.6],
      ])
    else
      room.kind = weighted(r, [
        ["cubicles", 3],
        ["boardroom", 2],
        ["storage", 1.5],
        ["meeting", 1],
        ["kitchen", 0.6],
        ["empty", 0.6],
      ])
  }
  // Every floor has somewhere to eat, a server room and toilets.
  for (const kind of ["kitchen", "server", "bathroom"] as const) {
    if (rooms.some((x) => x.kind === kind)) continue
    const pool = rooms.filter((x) => x.id > 0 && x.rects.length && (x.kind === "office" || x.kind === "empty" || x.kind === "storage"))
    if (pool.length) pool[r.int(pool.length)]!.kind = kind
  }

  // Doors ------------------------------------------------------------------------------------------------------------

  const h = new Uint8Array((gh + 1) * gw)
  const v = new Uint8Array(gh * (gw + 1))
  /** Shared edges between zone pairs, keyed lo * 4096 + hi. */
  const shared = new Map<number, { kind: "h" | "v"; i: number }[]>()
  const key = (a: number, b: number) => Math.min(a, b) * 4096 + Math.max(a, b)
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const z = zone[y * gw + x]!
      if (x + 1 < gw) {
        const o = zone[y * gw + x + 1]!
        if (o !== z) {
          const list = shared.get(key(z, o)) ?? []
          list.push({ kind: "v", i: y * (gw + 1) + x + 1 })
          shared.set(key(z, o), list)
          v[y * (gw + 1) + x + 1] = EDGE.wall
        }
      }
      if (y + 1 < gh) {
        const o = zone[(y + 1) * gw + x]!
        if (o !== z) {
          const list = shared.get(key(z, o)) ?? []
          list.push({ kind: "h", i: (y + 1) * gw + x })
          shared.set(key(z, o), list)
          h[(y + 1) * gw + x] = EDGE.wall
        }
      }
    }
  const set = (e: { kind: "h" | "v"; i: number }, k: EdgeKind) => ((e.kind === "h" ? h : v)[e.i] = k)
  const edgesOf = (a: number, b: number) => shared.get(key(a, b)) ?? []
  /** Splits a list of edges into runs of adjacent edges along one line. */
  const runs = (list: { kind: "h" | "v"; i: number }[]) => {
    const sorted = [...list].sort((p, q) => (p.kind === q.kind ? p.i - q.i : p.kind < q.kind ? -1 : 1))
    const out: { kind: "h" | "v"; i: number }[][] = []
    for (const e of sorted) {
      const last = out[out.length - 1]
      const prev = last?.[last.length - 1]
      const step = e.kind === "h" ? 1 : gw + 1
      if (prev && prev.kind === e.kind && e.i - prev.i === step) last!.push(e)
      else out.push([e])
    }
    return out
  }

  const connected = new Uint8Array(rooms.length)
  connected[0] = 1
  const live = rooms.filter((x) => x.id > 0 && x.rects.length)
  for (const room of live) {
    const front = edgesOf(0, room.id)
    if (!front.length) continue
    if (room.kind === "hall" || room.kind === "core") {
      // A door on most stretches of corridor frontage; halls sometimes open right up.
      const rs = shuffle(r, runs(front))
      rs.forEach((run, k) => {
        if (k >= 2 && r.next() < 0.35) return
        if (room.kind === "hall" && run.length >= 3 && r.next() < 0.3) {
          const s = r.int(run.length - 1)
          set(run[s]!, EDGE.open)
          set(run[s + 1]!, EDGE.open)
        } else set(run[r.int(run.length)]!, EDGE.door)
      })
      connected[room.id] = 1
      continue
    }
    // Some rooms with frontage are inner offices, reached through a neighbour.
    const roomNeighbours = [...neighbours(room).keys()].filter((z) => z > 0)
    if (roomNeighbours.length && r.next() < 0.14 && room.kind !== "kitchen") continue
    const first = front[r.int(front.length)]!
    set(first, EDGE.door)
    connected[room.id] = 1
    if (area(room) >= 8 && front.length >= 4 && r.next() < 0.45) {
      // A second door, well away from the first.
      const far = runs(front).filter((run) => !run.includes(first)).flat()
      if (far.length) set(far[r.int(far.length)]!, EDGE.door)
    }
    if ((room.kind === "meeting" || room.kind === "boardroom") && r.next() < 0.7) for (const e of front) if ((e.kind === "h" ? h : v)[e.i] === EDGE.wall) set(e, EDGE.glass)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const room of shuffle(r, [...live])) {
      if (connected[room.id]) continue
      const opts = [...neighbours(room).keys()].filter((z) => z > 0 && connected[z])
      if (!opts.length) continue
      const o = opts[r.int(opts.length)]!
      const es = edgesOf(room.id, o)
      set(es[r.int(es.length)]!, EDGE.door)
      connected[room.id] = 1
      changed = true
    }
    if (changed) continue
    // Inner offices that only border each other: open one onto its corridor and go again.
    const stranded = live.find((x) => !connected[x.id] && edgesOf(0, x.id).length)
    if (stranded) {
      const front = edgesOf(0, stranded.id)
      set(front[r.int(front.length)]!, EDGE.door)
      connected[stranded.id] = 1
      changed = true
    }
  }
  // A few extra doors between rooms, for loops and flanks through suites.
  for (const room of live) {
    if (room.kind === "core" || room.kind === "closet") continue
    for (const z of neighbours(room).keys()) {
      if (z <= room.id || rooms[z]!.kind === "core" || rooms[z]!.kind === "closet" || r.next() > 0.08) continue
      const es = edgesOf(room.id, z)
      if (es.some((e) => (e.kind === "h" ? h : v)[e.i] === EDGE.door)) continue
      set(es[r.int(es.length)]!, EDGE.door)
    }
  }

  return { gw, gh, xs, ys, zone, rooms, h, v }
}
