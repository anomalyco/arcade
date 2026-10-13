# Ship feedback

Notes the designer left in the ship viewer (`ship.html`). Generated from `feedback/ship.jsonl`; do not edit by hand.
Paths are relative to `games/carrier/`. Pin coordinates are ship-local metres of the carrier named first in the part
(`procedural` = `buildCarrier()`, `blender` = `art/carrier.glb`, `hornet` = `art/hornet.glb`), whatever the viewer layout was.
A part like `procedural · hornet · body` is the Hornet parked on that carrier (point in the carrier's frame).

When a note is addressed, resolve it (kept in history) with:
`curl -X DELETE 'http://localhost:5197/__feedback/ship?id=<id>&by=agent&reply=<what+changed>'`

## Open (0)

Nothing open.
