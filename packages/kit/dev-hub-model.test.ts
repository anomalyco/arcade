import { describe, expect, test } from "bun:test"
import { labUrl } from "./lab-url"
import { catalogueHash, catalogueLights, devRoute, filterAssets, gameLink, hubCommands, hubGames, hubPath, hubTargets, parseHubHash } from "./dev-hub-model"

const router = JSON.stringify({ games: ["getaway", "blackout", "outbreak", "carrier"], workers: false })

describe("developer hub", () => {
  test("navigation stays relative to each game prefix; the Lab is its own app", () => {
    for (const host of ["getaway", "blackout"]) for (const command of hubCommands) {
      const expected = command.id === "lab" ? "/arcade/lab/" : `/arcade/${host}/`
      expect(new URL(command.href, `https://anoma.ly/arcade/${host}/dev.html`).pathname).toStartWith(expected)
      expect(new URL(command.href, `http://arcade.localhost:1355/arcade/${host}/dev.html`).pathname).toStartWith(expected)
    }
  })
  test("prototypes remain separate", () => {
    expect(hubGames.map(game => game.id).sort()).toEqual(["blackout", "carrier", "getaway", "outbreak", "wings"])
    expect(hubGames.filter(game => game.prototype).map(game => game.id)).toEqual(["carrier", "outbreak"])
  })
  test("router pages link mounted games on this origin and fall back to production for the rest", () => {
    const targets = hubTargets("/arcade/getaway/dev.html", router)
    expect(targets).toEqual({ kind: "router", local: ["getaway", "blackout", "outbreak", "carrier"], workers: false })
    for (const id of ["getaway", "blackout", "outbreak", "carrier"]) expect(gameLink(id, targets)).toEqual({ href: `/arcade/${id}/`, source: "local" })
    expect(gameLink("wings", targets)).toEqual({ href: "https://anoma.ly/arcade/wings/", source: "production" })
  })
  test("production pages link same-origin siblings; standalone servers link production", () => {
    expect(gameLink("blackout", hubTargets("/arcade/getaway/dev.html", null))).toEqual({ href: "/arcade/blackout/", source: "production" })
    expect(gameLink("blackout", hubTargets("/dev.html", null))).toEqual({ href: "https://anoma.ly/arcade/blackout/", source: "production" })
    for (const meta of ["", "not json", "{}", '{"games":"getaway"}']) expect(hubTargets("/dev.html", meta).kind).toBe("standalone")
  })
  test("router paths mirror production prefixes", () => {
    const mounted = ["getaway", "blackout"]
    expect(devRoute("/", mounted)).toEqual({ kind: "redirect", location: hubPath })
    expect(devRoute("/arcade/", mounted)).toEqual({ kind: "redirect", location: hubPath })
    expect(devRoute("/arcade/blackout?practice", mounted)).toEqual({ kind: "redirect", location: "/arcade/blackout/?practice" })
    expect(devRoute("/arcade/blackout/?practice", mounted)).toEqual({ kind: "vite", game: "blackout", path: "/?practice" })
    expect(devRoute("/arcade/getaway/@vite/client", mounted)).toEqual({ kind: "vite", game: "getaway", path: "/@vite/client" })
    expect(devRoute("/arcade/getaway/audio-assets/a.mp3", mounted)).toEqual({ kind: "vite", game: "getaway", path: "/audio-assets/a.mp3" })
    for (const path of ["/arcade/getaway/api/quick", "/arcade/getaway/ws/ABCD", "/arcade/getaway/ws", "/arcade/getaway/ws?room=A"]) expect(devRoute(path, mounted)).toEqual({ kind: "worker", game: "getaway" })
    expect(devRoute("/arcade/getaway/wsx.ts", mounted).kind).toBe("vite")
    for (const path of ["/arcade/wings/", "/arcade/landing", "/src/main.ts", "/arcade/../etc"]) expect(devRoute(path, mounted).kind).not.toBe("vite")
  })
  test("old per-game Lab pages redirect to the single Lab with that game chosen", () => {
    const mounted = ["getaway", "blackout", "outbreak", "lab"]
    expect(devRoute("/arcade/getaway/lab.html", mounted)).toEqual({ kind: "redirect", location: "/arcade/lab/?game=getaway" })
    expect(devRoute("/arcade/outbreak/lab.html?section=outbreak-vignette&game=x", mounted)).toEqual({ kind: "redirect", location: "/arcade/lab/?game=outbreak&section=outbreak-vignette" })
    expect(devRoute("/arcade/lab/?game=blackout", mounted)).toEqual({ kind: "vite", game: "lab", path: "/?game=blackout" })
    expect(labUrl("https://anoma.ly/arcade/blackout/lab.html?bench", "blackout")).toBe("https://anoma.ly/arcade/lab/?game=blackout&bench=")
  })
  test("catalogue selection round-trips through the hash", () => {
    for (const id of ["getaway:compact", "getaway:prop:cone", "blackout:soldier"]) expect(parseHubHash(catalogueHash(id))).toEqual({ page: "catalogue", assetId: id })
    expect(parseHubHash("#catalogue")).toEqual({ page: "catalogue", assetId: undefined })
    expect(parseHubHash("#games").page).toBe("games")
    expect(parseHubHash("").page).toBe("games")
    expect(parseHubHash("#catalogue/%E0").page).toBe("catalogue")
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
