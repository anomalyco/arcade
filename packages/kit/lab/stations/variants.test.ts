import { describe, expect, test } from "bun:test"
import type { StationVariant } from "./types"
import { composedSetup, defaultPicks, orderedVariants, pickAfter, variantGroups, variantProblems, VARIANTS_GROUP } from "./variants"

const set = (key: string, value: number | string) => ({ command: "scene.set-param", args: { key, value } })
const v = (id: string, group?: string, ...setup: ReturnType<typeof set>[]): StationVariant => ({ id, label: id, ...(group ? { group } : {}), setup })

const grouped = [
  v("today", "Look", set("look", "today")),
  v("noir", "Look", set("look", "noir")),
  v("from-look", "Hero"),
  v("mannequin", "Hero", set("hero", 1)),
  v("beam-off", "Beam", set("beam", 0)),
  v("beam-high", "Beam", set("beam", 3)),
]

describe("variant groups", () => {
  test("variants without a group are one group; groups keep the order they first appear in", () => {
    expect(variantGroups([v("a"), v("b")]).map(g => [g.id, g.variants.length])).toEqual([[VARIANTS_GROUP, 2]])
    const mixed = [v("a", "Look"), v("b", "Hero"), v("c", "Look")]
    expect(variantGroups(mixed).map(g => g.id)).toEqual(["Look", "Hero"])
    expect(orderedVariants(mixed).map(x => x.id)).toEqual(["a", "c", "b"])
  })

  test("one group opens on its default or nothing; several open with a pick in every group", () => {
    expect(defaultPicks({ variants: [v("a"), v("b")] }).size).toBe(0)
    expect(defaultPicks({ variants: [v("a"), v("b")], defaultVariant: "b" }).get(VARIANTS_GROUP)?.id).toBe("b")
    const picks = defaultPicks({ variants: grouped, defaultVariant: ["noir", "beam-high"] })
    expect(Object.fromEntries([...picks].map(([g, x]) => [g, x.id]))).toEqual({ Look: "noir", Hero: "from-look", Beam: "beam-high" })
  })

  test("a pick in one group keeps the other groups' picks, applied in group order", () => {
    const picks = defaultPicks({ variants: grouped, defaultVariant: "noir" })
    const keys = (variant: StationVariant) => composedSetup({ variants: grouped }, picks, variant).map(c => `${c.args?.key}=${c.args?.value}`)
    // Choosing a Hero re-applies the Look first, so the Hero refines it instead of resetting it.
    expect(keys(grouped[3]!)).toEqual(["look=noir", "hero=1", "beam=0"])
    expect(keys(grouped[5]!)).toEqual(["look=noir", "beam=3"])
    // With one group a variant is a one-shot apply of its own setup.
    const one = v("a", undefined, set("x", 1))
    expect(composedSetup({ variants: [one] }, new Map(), one).length).toBe(1)
  })

  test("pickOne groups are sections of one choice: a pick clears the other groups and runs alone", () => {
    const station = { variants: grouped, pickOne: true, defaultVariant: "noir" }
    const picks = defaultPicks(station)
    expect([...picks.keys()]).toEqual(["Look"])
    expect(composedSetup(station, picks, grouped[3]!).length).toBe(1)
    expect([...pickAfter(station, picks, grouped[3]!).values()].map(x => x.id)).toEqual(["mannequin"])
    expect([...pickAfter({ variants: grouped }, picks, grouped[3]!).values()].map(x => x.id)).toEqual(["noir", "mannequin"])
    expect(variantProblems({ ...station, defaultVariant: ["noir", "beam-off"] }).join()).toContain("opens on one variant")
  })

  test("validation wants every variant grouped or none, and one default per group", () => {
    expect(variantProblems({ variants: grouped, defaultVariant: ["today", "beam-off"] })).toEqual([])
    expect(variantProblems({ variants: [v("a", "Look"), v("b")] }).join()).toContain("every variant a group")
    expect(variantProblems({ variants: grouped, defaultVariant: ["today", "noir"] }).join()).toContain('two variants in group "Look"')
    expect(variantProblems({ variants: grouped, defaultVariant: "nope" }).join()).toContain('"nope" is not one of its variants')
  })
})
