import type { Prop } from "@arcade/kit/sim/props"
import { CENTER, propLayout } from "../../shared/arena"
import { CHARACTERS, ROSTER } from "../../shared/characters"
import { STOCKS } from "../../shared/config"
import type { Brain, Fighter, Intent, World } from "../../shared/world"
import { LocalSession } from "../session"

export type LabScene = "gallery" | "props" | "bots"
type Point = { x: number; y: number }

const toward = (from: Point, to: Point, i: Intent) => {
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1
  i.mx = dx / d
  i.my = dy / d
}

/**
 * Casts its character's abilities in turn at the nearest fighter (or prop): steps into each ability's `botRange`,
 * casts once it is ready, waits for the cast, dash or carry to finish, then walks back to its mark.
 */
export class LoopBrain implements Brain {
  /** The slot being cast (-1 between casts), for the ability bar. */
  active = -1
  private i = 0
  private nextAt = 0

  constructor(public slots: number[], private home: Point | null, private targets: "fighters" | "props", private gap = 0.8) {}

  think(w: World, me: Fighter): Intent {
    const now = w.time
    const i: Intent = { mx: 0, my: 0, aim: me.aim, tx: me.x, ty: me.y, cast: -1 }
    const target = this.targets === "props" ? nearestProp(w, me) : nearestFighter(w, me)
    if (me.ab.carry) {
      // Throw toward the middle of the ring.
      i.aim = Math.atan2(CENTER.y - me.y, CENTER.x - me.x)
      return i
    }
    if (target) {
      i.aim = Math.atan2(target.y - me.y, target.x - me.x)
      i.tx = target.x
      i.ty = target.y
    }
    if (me.ab.cast || me.ab.dash) return i
    if (this.active >= 0) {
      this.active = -1
      this.i++
      this.nextAt = now + this.gap
    }
    const slot = this.slots[this.i % this.slots.length] ?? 0
    const def = w.def(me).abilities[slot]!
    const reach = (def.botRange ?? 1.5) || 0
    const far = target ? Math.hypot(target.x - me.x, target.y - me.y) : 0
    if (now < this.nextAt || now < (me.ab.ready[slot] ?? 0)) {
      if (this.home && Math.hypot(this.home.x - me.x, this.home.y - me.y) > 0.4) toward(me, this.home, i)
      return i
    }
    if (target && reach > 0 && far > reach * 0.9) {
      toward(me, target, i)
      return i
    }
    i.cast = slot
    this.active = slot
    return i
  }
}

/** Stands on its mark facing whoever is nearest, and walks back when knocked off it. */
export class DummyBrain implements Brain {
  constructor(private home: Point) {}

  think(w: World, me: Fighter): Intent {
    const i: Intent = { mx: 0, my: 0, aim: me.aim, tx: me.x, ty: me.y, cast: -1 }
    const t = nearestFighter(w, me)
    if (t) i.aim = Math.atan2(t.y - me.y, t.x - me.x)
    if (Math.hypot(this.home.x - me.x, this.home.y - me.y) > 0.35) toward(me, this.home, i)
    return i
  }
}

function nearestFighter(w: World, me: Fighter): Fighter | null {
  let best: Fighter | null = null
  let bd = Infinity
  for (const f of w.actors) {
    if (f === me || !f.alive || f.fallAt) continue
    const d = Math.hypot(f.x - me.x, f.y - me.y)
    if (d < bd) [best, bd] = [f, d]
  }
  return best
}

function nearestProp(w: World, me: Fighter): Prop | null {
  let best: Prop | null = null
  let bd = Infinity
  for (const p of w.props.list) {
    if (!p.alive || p.held || w.props.def(p).heavy) continue
    const d = Math.hypot(p.x - me.x, p.y - me.y)
    if (d < bd) [best, bd] = [p, d]
  }
  return best
}

const GALLERY_STAR = { x: 10, y: 10.5 }
const GALLERY_DUMMIES = [{ x: 14.6, y: 9.1 }, { x: 14.6, y: 11.9 }]
const GALLERY_PROPS = [
  { kind: "crate", x: 12.6, y: 7.6, h: 0.2 },
  { kind: "crate", x: 12.6, y: 13.4, h: -0.2 },
  { kind: "barrel", x: 17.6, y: 10.5, h: 0 },
  { kind: "cart", x: 17, y: 7.4, h: 0.6 },
]
const PLAYGROUND_EXTRA = [
  { kind: "crate", x: 11.2, y: 12.4, h: 0.4 },
  { kind: "crate", x: 16.8, y: 8.6, h: -0.3 },
  { kind: "barrel", x: 9.2, y: 10.5, h: 0 },
  { kind: "barrel", x: 18.8, y: 10.5, h: 0 },
]

export type LabSceneOptions = { char: string; slots: number[]; bots: number; seed: number }

/**
 * The Lab's scenes on the production World: `gallery` (one character looping its abilities at two dummies and a few
 * props), `props` (you and a prop-throwing Big Slab among every prop), `bots` (a bots-only round with real BotBrains).
 * Rounds never end and stocks are topped up, so a scene runs for as long as it is open.
 */
export class LabSession extends LocalSession {
  readonly brain: LoopBrain | null
  readonly star: Fighter | null
  private propsAt = 0

  constructor(readonly scene: LabScene, opts: LabSceneOptions) {
    const made: { brain: LoopBrain | null; star: Fighter | null } = { brain: null, star: null }
    super(scene === "props" ? "you" : "", {
      watch: scene !== "props",
      pick: opts.char,
      bots: opts.bots,
      seed: opts.seed,
      stage: scene === "bots" ? undefined : (w) => stage(w, scene, opts, made),
    })
    this.brain = made.brain
    this.star = made.star
  }

  protected override afterStep(): void {
    const w = this.world
    if (this.scene === "bots") return
    for (const f of w.actors) {
      f.stocks = STOCKS
      if (this.scene === "gallery" && f.damage > 60) f.damage = 0
    }
    // Put the props back once enough of them have broken, fallen off or wandered away.
    if (w.time < this.propsAt) return
    this.propsAt = w.time + 6
    const homes = this.scene === "gallery" ? GALLERY_PROPS : null
    const gone = w.props.list.filter((p, i) => !p.alive || (homes && Math.hypot(p.x - homes[i]!.x, p.y - homes[i]!.y) > 2.5)).length
    if (gone > (homes ? 0 : w.props.list.length * 0.4)) layProps(w, this.scene)
  }

  resetProps(): void {
    layProps(this.world, this.scene)
  }
}

function layProps(w: World, scene: LabScene): void {
  if (scene === "gallery") {
    w.props.clear()
    for (const p of GALLERY_PROPS) w.props.add(p.kind, p.x, p.y, p.h)
  } else {
    w.props.clear()
    for (const p of propLayout(w.rng)) w.props.add(p.kind, p.x, p.y, p.h)
    if (scene === "props") for (const p of PLAYGROUND_EXTRA) w.props.add(p.kind, p.x, p.y, p.h)
  }
}

/** A bot of the World's own making, given this character and brain. */
function addBot(w: World, brain: Brain, char: string, name: string): Fighter {
  w.fill(w.players.size + 1)
  const f = w.actors[w.actors.length - 1]!
  f.brain = brain
  f.pick = f.char = char
  f.name = name
  return f
}

function stage(w: World, scene: LabScene, opts: LabSceneOptions, made: { brain: LoopBrain | null; star: Fighter | null }): void {
  const marks: [Fighter, Point][] = []
  if (scene === "gallery") {
    const char = CHARACTERS[opts.char] ? opts.char : ROSTER[0]!.id
    made.brain = new LoopBrain(opts.slots, GALLERY_STAR, "fighters")
    made.star = addBot(w, made.brain, char, CHARACTERS[char]!.name.split(" ")[0]!)
    marks.push([made.star, GALLERY_STAR])
    const others = ROSTER.filter((c) => c.id !== char)
    GALLERY_DUMMIES.forEach((at, i) => marks.push([addBot(w, new DummyBrain(at), others[i * 2]!.id, "dummy"), at]))
  } else {
    w.botFill = 0
    w.addHuman("you", "you", opts.char)
    made.brain = new LoopBrain([1, 0, 1, 2], null, "props", 1.2)
    made.star = addBot(w, made.brain, "slab", "Slab")
  }
  w.startRound()
  w.goAt = w.time
  w.phaseEnd = Infinity
  for (const [f, at] of marks) {
    f.x = at.x
    f.y = at.y
    f.aim = Math.atan2(CENTER.y - at.y, CENTER.x - at.x)
  }
  for (const e of w.events) {
    if (e.k !== "spawn") continue
    const f = w.players.get(e.id)!
    e.x = f.x
    e.y = f.y
  }
  layProps(w, scene)
}
