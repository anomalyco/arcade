// The night's lines for `night-voices.ts` (NIGHT.md): each searcher's reaction to finding each clue, the dawn lines,
// Barbara's voice on the cassette, and the extra searcher's call from the ridge (STORY.md key moment 5). Same shape
// as `voice-specs.ts`: the words a subtitle shows, the directed text Eleven v4 reads (square-bracket directions, never
// spoken), its pool and how loud.
import type { Loudness, Pool, Voice } from "../../shared/voices"

export type NightLineSpec = { id: string; cast: Voice; pool: Pool; loud: Loudness; text: string; direct: string }

/** Barbara K. Nakamura, 38 (STORY.md): Bella, a premade voice like the searchers'. */
export const BARBARA = { id: "barbara", name: "Barbara", voiceId: "hpp4J3VqNfWAUOO0d1Us", voice: "Bella", brief: "38, groupware administrator; clear, warm, a little guarded, dictating into a microcassette recorder" } as const

const VOICE_IDS: Record<Voice, string> = {
  walt: "pqHfZKP75CvOlQylNhV4", joyce: "XrExE9yKIg1WjnnlVkGX", gary: "N2lVS1w4EtoT3dr4eOWO", dale: "iP95p4xoKVk53GoZ742B",
  tess: "EXAVITQu4vr4xnSDxMaL", owen: "bIHbv24MWmeRgasZH58o", barbara: BARBARA.voiceId,
}
export const voiceIdOf = (v: Voice) => VOICE_IDS[v]

const CALL = "[calling out loudly across the dark woods to someone forty metres away]"
const SHAKEN = "[quiet, close, shaken, almost a whisper, in a dark forest at night]"
const TAPE = "[quietly, close to a small tape recorder, a little out of breath]"

type Row = [Pool, Loudness, string, string?]
const lines = (cast: Voice, rows: Row[]): NightLineSpec[] => {
  const n: Record<string, number> = {}
  return rows.map(([pool, loud, text, direct]) => {
    n[pool] = (n[pool] ?? 0) + 1
    const tag = direct ?? (loud === "talk" || loud === "quiet" ? SHAKEN : CALL)
    return { id: `night.${cast}.${pool}.${n[pool]}`, cast, pool, loud, text, direct: `${tag} ${text}` }
  })
}

export const NIGHT_LINES: readonly NightLineSpec[] = [
  ...lines("walt", [
    ["car", "call", "Her door's open! Somebody's been at this car!"],
    ["page", "call", "Got a page here, tied up with tape. That's not our tape."],
    ["badge", "call", "Over here! It's her badge. Lanyard's snapped."],
    ["cassette", "call", "Tape recorder! There's still a tape in it!"],
    ["strip", "talk", "That's my knot. That's how I tie it. I never tied this one."],
    ["extra", "shout", "Over here! Over here!", "[shouting from far off across the dark woods, urgent, as if he has found something]"],
    ["dawn", "call", "Sky's getting light. Sheriff'll be up the road by seven."],
    ["daylight", "shout", "That's daylight! Everybody back to the cars!", "[shouting hoarsely across the woods, tired]"],
  ]),
  ...lines("joyce", [
    ["car", "call", "Her door's open! Barb? Barb!"],
    ["page", "call", "That's her writing! That's Barb's writing!"],
    ["badge", "talk", "Oh God. That's her badge. That's her work badge."],
    ["cassette", "call", "A tape recorder! It's hers, she always had one!"],
    ["strip", "quiet", "Who called? Somebody called us up here."],
    ["dawn", "talk", "No. No, not yet. Keep going.", "[quietly insistent, holding back tears]"],
  ]),
  ...lines("gary", [
    ["car", "call", "That door was locked! I checked it myself!"],
    ["page", "call", "Paper, tied to this tree! With tape that isn't ours!"],
    ["badge", "call", "Badge! In the mud here!"],
    ["cassette", "call", "Recorder! Somebody dropped a recorder!"],
    ["strip", "quiet", "Nobody of ours has been up here. Nobody."],
    ["dawn", "talk", "That's dawn coming.", "[dry, muttering to himself]"],
  ]),
  ...lines("dale", [
    ["car", "call", "Uh, guys? Her car door's open! Was it open before?"],
    ["page", "call", "It's a page out of a planner! Somebody tied it up here!"],
    ["badge", "call", "That's a Northstar badge! That's one of ours!"],
    ["cassette", "call", "Tape recorder! Should I... should I play it?"],
    ["strip", "quiet", "It's just tape. But somebody said over here. I heard it."],
  ]),
  ...lines("tess", [
    ["car", "call", "The driver's door is open! It wasn't this afternoon!"],
    ["page", "talk", "That's from her book. Sunday. Eleven, hike. Six, R."],
    ["badge", "call", "It's her badge! Executive Systems. It's hers!"],
    ["cassette", "call", "It's her recorder! She dictates everything!"],
    ["strip", "quiet", "One strip. Tied like Walt ties it. Walt was with us."],
  ]),
  ...lines("owen", [
    ["car", "call", "Hey! The car! The door's open!"],
    ["page", "call", "There's a paper tied to this tree! Like a note!"],
    ["badge", "call", "I found an ID! Barbara Nakamura!"],
    ["cassette", "call", "There's a tape recorder over here!"],
    ["strip", "quiet", "It's only tape. Then who was calling?"],
  ]),
  // The cassette, rewound and played: about eleven seconds of wind and Barbara saying she was going up to the radio tower.
  ...lines("barbara", [
    ["tape-tower", "talk", "Note to self. Sunday, about eleven. I'm at the camp lot. I'm walking up to the radio tower, the one with the red light. R. said he'd be there. If this is another one of his... okay. Okay. Going.", TAPE],
  ]),
]
