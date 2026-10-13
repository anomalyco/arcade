import { castleHall } from "../maps/castle-hall"
import { bareKit } from "./kit"
import { MODE_FACTORIES, Mode } from "./modes"
import { SpellState } from "./spells"
import type { Intent, Player, World } from "./world"

class Wizards extends Mode {
  override readonly id = "wizards" as const
  override start(w: World) { w.setMap(castleHall(w.map.seed)); w.spells = new SpellState(w.map); super.start(w) }
  override spawnAt(w: World,p: Player) { return w.map.spawns[Math.max(0,w.order.indexOf(p.id)) % w.map.spawns.length]! }
  override loadout(w: World,p: Player) { w.spells?.spawn(p); return bareKit({id:"staff",label:"STAFF BONK",damage:18,regen:false}) }
  override intent(w: World,p: Player,i: Intent) { return w.spells?.intent(w,p,i) ?? i }
  override killed(w: World,p: Player) { w.spells?.death(w,p) }
  override leave(w: World,p: Player) { w.spells?.remove(p.id) }
  override step(w: World) { w.spells?.step(w) }
  override canRide() { return false }
}
MODE_FACTORIES.wizards = () => new Wizards()
