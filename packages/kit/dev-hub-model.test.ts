import { describe, expect, test } from "bun:test"
import { catalogueLights, filterAssets, gameHref, hubCommands, hubGames } from "./dev-hub-model"

describe("developer hub", () => {
  test("navigation stays relative to each game prefix", () => {
    for (const host of ["getaway", "blackout"]) for (const command of hubCommands) {
      expect(new URL(command.href, `https://anoma.ly/arcade/${host}/lab.html`).pathname).toStartWith(`/arcade/${host}/`)
    }
  })
  test("all installed games have production links, prototypes remain separate", () => {
    expect(hubGames.map(game => game.id).sort()).toEqual(["blackout", "carrier", "getaway", "outbreak", "wings"])
    expect(hubGames.filter(game => game.prototype).map(game => game.id)).toEqual(["outbreak"])
    expect(gameHref("wings")).toBe("https://anoma.ly/arcade/wings/")
  })
  test("only explicitly configured named Nexus previews override production", () => {
    expect(gameHref("getaway", { getaway: "http://hub-test.localhost:1355/arcade/getaway/" })).toBe("http://hub-test.localhost:1355/arcade/getaway/")
    for (const value of ["javascript:alert(1)", "http://localhost:5173", "https://example.com", "http://user:pass@hub.localhost:1355", "http://hub.localhost:1356"]) expect(gameHref("getaway", { getaway: value })).toBe("https://anoma.ly/arcade/getaway/")
  })
  test("ID, label and category search intersect", () => {
    const assets = [{ id: "getaway:compact", label: "Compact", category: "vehicle" as const }, { id: "getaway:prop:cone", label: "Cone", category: "prop" as const }]
    expect(filterAssets(assets, "GETAWAY compact", "vehicle").map(asset => asset.id)).toEqual(["getaway:compact"])
    expect(filterAssets(assets, "compact", "prop")).toEqual([])
    expect(filterAssets(assets, "", "all")).toHaveLength(2)
  })
  test("lighting setups are distinct finite recipes", () => {
    expect(Object.keys(catalogueLights)).toEqual(["neutral", "day", "night", "interior"])
    expect(new Set(Object.values(catalogueLights).map(recipe => JSON.stringify(recipe))).size).toBe(4)
    for (const recipe of Object.values(catalogueLights)) expect(Number.isFinite(recipe.moonPower)).toBe(true)
  })
})
