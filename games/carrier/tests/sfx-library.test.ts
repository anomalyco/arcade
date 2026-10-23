import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { sfxEntry } from "@arcade/kit/audio/library"
import { CARRIER_MIX, Mixer } from "../src/audio/mixer"
import { SfxBank } from "../src/audio/sfx-bank"
import { SLOT_LIBRARY_ID, SLOTS } from "../src/audio/sfx-slots"

describe("recorded slots in the shared sound library", () => {
  test("every slot has a library id whose files are exactly the takes Carrier plays with its shipped picks", () => {
    const bank = new SfxBank(new Mixer(false))
    bank.shipped = JSON.parse(readFileSync(new URL("../public/sfx/picks.json", import.meta.url), "utf8"))
    bank.picks = { ...bank.shipped }
    for (const slot of SLOTS) {
      const id = SLOT_LIBRARY_ID[slot.id]
      expect(id, slot.id).toBeDefined()
      const entry = sfxEntry(id!)
      expect(entry.usedBy, id).toContain("carrier")
      expect(entry.files.map((f) => f.path).sort(), slot.id).toEqual(bank.takesFor(slot.id).map((t) => `games/carrier/public/sfx/v3/${slot.id}-${t}.ogg`).sort())
      expect(Boolean(entry.loop), slot.id).toBe(slot.loop)
    }
  })
})

describe("the mix on the kit runtime", () => {
  test("every cue category lands on a Carrier bus and the reverb is a send", () => {
    for (const bus of Object.values(CARRIER_MIX.route)) expect(CARRIER_MIX.buses[bus]).toBeDefined()
    expect(CARRIER_MIX.sends[CARRIER_MIX.reverb]).toBeDefined()
    expect(CARRIER_MIX.sends.echo.feed?.send).toBe("reverb")
  })
})
