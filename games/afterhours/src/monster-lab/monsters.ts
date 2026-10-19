// The Monster Lab registry: one entry per monster. To drop a real model in, put it at
// public/models/monsters/<id>.glb (metres, Y up, facing +Z, skinned, clips inside) and fill each clip's `file` with the
// clip's name in that glb. Until then (or for any clip whose `file` is missing) the lab shows a grey-clay STAND-IN: the
// Mixamo mannequin (models/characters/remy.glb) re-proportioned by `standIn` and playing the `standIn` clip from
// models/characters/anims.glb.

/** A clip the monster needs. Behaviour steps refer to clips by `id`. */
export type MonsterClip = {
  id: string
  /** Clip name inside the monster's own glb (TBD until the model exists). */
  file?: string
  /** Mixamo clip from anims.glb played by the stand-in (or by a real model with a Mixamo-named skeleton). */
  standIn: string
  /**
   * Ground speed in m/s at timeScale 1 for a 1.8 m human stride, used when the clip has no root motion of its own.
   * Scaled by the monster's leg length, so feet roughly keep contact at any height. 0 = stationary.
   */
  speed?: number
}

/** One approved SFX category from games/afterhours/audio-lab (sfx/<id>/<variant>.mp3); a variant is picked at random. */
export type MonsterSound = {
  id: string
  label: string
  variants: string[]
  /** Volume 0..1. */
  gain?: number
  /** Distance (m) at which the sound is at full level; it falls off beyond (inverse model). */
  ref?: number
}

/** One step of a scripted behaviour preview. Everything except `clip` and `duration` blends in over `fade`. */
export type BehaviourStep = {
  label: string
  clip: string
  /** Seconds (at playback speed 1). */
  duration: number
  /** Clip playback rate (1 = authored). 0 freezes the pose. */
  timeScale?: number
  /** Travel along the scene path in m/s; default the clip's own ground speed × timeScale. */
  speed?: number
  /** Sounds started (positionally, from the head) when the step begins. */
  sounds?: string[]
  /** Feet above the ground (banshee float), metres. */
  hover?: number
  /** Jaw opening 0..1 (only if the skeleton has a jaw bone). */
  jaw?: number
  /** Extra forward bend through the spine, radians (negative arches back); the head counter-rotates to look ahead. */
  bend?: number
  /** Extra head pitch, radians (negative tips the face up). */
  headPitch?: number
  /** Cross-fade into the step, seconds. */
  fade?: number
}

/** Stand-in proportions: bone length multipliers on the Mixamo mannequin; `thin` scales girth (1 = Remy). */
export type StandInShape = {
  arms?: number
  forearms?: number
  hands?: number
  fingers?: number
  thighs?: number
  shins?: number
  spine?: number
  neck?: number
  head?: number
  thin?: number
  limbThin?: number
}

export type Monster = {
  id: string
  name: string
  /** Relative to the public folder. May be missing (stand-in). */
  glb: string
  /** Standing height in metres (crown of the head; antlers excluded). The model is scaled to it. */
  height: number
  /** Concept art for the lab's reference thumbnail (relative to the page). */
  concept: string
  /** Bone names on the real model, when they differ from Mixamo's. Jaw is optional. */
  bones?: { head?: string; jaw?: string; spine?: string[]; neck?: string }
  standIn: StandInShape
  /** Clip ids: `idle` and `move` are used by the manual clip picker's path/root-motion modes. */
  clips: MonsterClip[]
  sounds: MonsterSound[]
  /** Sounds that recur at random while the monster is shown (positional, from the head). */
  ambient?: { sounds: string[]; every: [number, number] }
  behaviour: { name: string; loop: boolean; steps: BehaviourStep[] }
}

export const MONSTERS: Monster[] = [
  {
    id: "wendigo",
    name: "Wendigo",
    glb: "models/monsters/wendigo.glb",
    height: 3.0,
    concept: "concept/monsters/wendigo-1.png",
    standIn: { arms: 1.45, forearms: 1.6, hands: 1.5, fingers: 2.2, thighs: 1.25, shins: 1.35, spine: 1.15, neck: 1.6, head: 0.95, thin: 0.6, limbThin: 0.55 },
    clips: [
      { id: "idle", standIn: "breathing-idle" },
      { id: "stalk", standIn: "crouched-walking", speed: 0.85 },
      { id: "walk", standIn: "walking", speed: 1.4 },
      { id: "lunge", standIn: "running", speed: 4.2 },
      { id: "turn", standIn: "left-turn-90" },
    ],
    sounds: [
      { id: "wen-distant-moan", label: "Distant moan", variants: ["v2", "v3"], ref: 12 },
      { id: "wen2-starving-groan", label: "Starving groan", variants: ["v1"], ref: 4 },
      { id: "wen2-chatter", label: "Chatter", variants: ["v3"], ref: 3 },
      { id: "wen2-huge-scream", label: "Huge scream", variants: ["v1"], ref: 8 },
    ],
    ambient: { sounds: ["wen2-starving-groan", "wen-distant-moan"], every: [9, 18] },
    behaviour: {
      name: "Stalk · freeze · lunge",
      loop: true,
      steps: [
        { label: "stalk", clip: "stalk", duration: 8, timeScale: 0.6, bend: 0.25, sounds: ["wen2-starving-groan"] },
        { label: "freeze", clip: "idle", duration: 3, timeScale: 0, bend: 0.15, headPitch: 0.1, sounds: ["wen2-chatter"], fade: 0.12 },
        { label: "stalk", clip: "stalk", duration: 5, timeScale: 0.6, bend: 0.25 },
        { label: "lunge", clip: "lunge", duration: 0.9, timeScale: 1.5, bend: 0.45, sounds: ["wen2-huge-scream"], fade: 0.1 },
        { label: "loom", clip: "idle", duration: 3, timeScale: 0.5, bend: 0.35, headPitch: 0.25 },
      ],
    },
  },
  {
    id: "shapeshifter",
    name: "Shapeshifter",
    glb: "models/monsters/shapeshifter.glb",
    height: 2.2,
    concept: "concept/monsters/shapeshifter-1.png",
    standIn: { arms: 1.25, forearms: 1.35, hands: 1.25, fingers: 1.5, thighs: 1.05, shins: 1.15, spine: 1.05, neck: 1.35, head: 1.0, thin: 0.75, limbThin: 0.7 },
    clips: [
      { id: "idle", standIn: "breathing-idle" },
      { id: "walk", standIn: "walking", speed: 1.4 },
      { id: "drop", standIn: "crouch-idle" },
      { id: "crawl", standIn: "crouched-walking", speed: 0.85 },
      { id: "sprint", standIn: "running", speed: 4.2 },
    ],
    sounds: [
      { id: "skin-call-far", label: "Call (far)", variants: ["v2"], ref: 14 },
      { id: "skin-wrong-laugh", label: "Wrong laugh", variants: ["v2"], ref: 5 },
      { id: "skin-cry-growl", label: "Cry into growl", variants: ["v2"], ref: 5 },
      { id: "skin-animal-human", label: "Animal-human", variants: ["v2"], ref: 5 },
      { id: "skin2-breath-pant", label: "Breath pant", variants: ["v3"], ref: 3 },
      { id: "skin2-woman-fox", label: "Woman-fox scream", variants: ["v1"], ref: 8 },
      { id: "skin2-howl-sob", label: "Howl-sob", variants: ["v3"], ref: 8 },
    ],
    ambient: { sounds: ["skin-call-far", "skin-wrong-laugh"], every: [10, 20] },
    behaviour: {
      name: "Walk upright · drop · sprint on all fours",
      loop: true,
      steps: [
        { label: "walk upright", clip: "walk", duration: 6, timeScale: 0.85, sounds: ["skin-wrong-laugh"] },
        { label: "stop", clip: "idle", duration: 1.5, timeScale: 0.6, headPitch: 0.15 },
        { label: "drop to all fours", clip: "drop", duration: 1.4, timeScale: 1, bend: 1.0, sounds: ["skin-cry-growl"], fade: 0.5 },
        { label: "sprint", clip: "sprint", duration: 2, timeScale: 1.35, bend: 1.15, hover: -0.25, sounds: ["skin2-breath-pant"], fade: 0.3 },
        { label: "crouch", clip: "drop", duration: 3, timeScale: 1, bend: 0.9, sounds: ["skin-animal-human"] },
      ],
    },
  },
  {
    id: "banshee",
    name: "Banshee",
    glb: "models/monsters/banshee.glb",
    height: 2.2,
    concept: "concept/monsters/banshee-1.png",
    bones: { jaw: "Jaw" },
    standIn: { arms: 1.3, forearms: 1.4, hands: 1.3, fingers: 1.7, thighs: 1.08, shins: 1.1, spine: 1.12, neck: 1.3, head: 0.95, thin: 0.68, limbThin: 0.6 },
    clips: [
      { id: "idle", standIn: "breathing-idle" },
      { id: "float", standIn: "falling-idle" },
      { id: "drift", standIn: "breathing-idle", speed: 0 },
      { id: "scream", standIn: "breathing-idle" },
    ],
    sounds: [
      { id: "ban-presence", label: "Presence", variants: ["v2"], ref: 6 },
      { id: "ban-keen-wail", label: "Keening wail", variants: ["v1", "v2", "v3"], ref: 10 },
      { id: "ban-scream-far", label: "Scream (far)", variants: ["v2", "v3"], ref: 16 },
      { id: "ban-scream-near", label: "Scream (near)", variants: ["v3"], ref: 6 },
      { id: "ban2-scream-tear", label: "Tearing scream", variants: ["v1", "v3"], ref: 6 },
    ],
    ambient: { sounds: ["ban-presence", "ban-keen-wail"], every: [8, 15] },
    behaviour: {
      name: "Float · drift · scream",
      loop: true,
      steps: [
        { label: "float", clip: "drift", duration: 4, timeScale: 0.4, hover: 0.35, headPitch: 0.25, sounds: ["ban-presence"], fade: 1 },
        { label: "drift", clip: "drift", duration: 10, timeScale: 0.4, hover: 0.45, speed: 1.4, headPitch: 0.15, sounds: ["ban-keen-wail"], fade: 1 },
        { label: "scream", clip: "scream", duration: 3.2, timeScale: 0.2, hover: 0.55, jaw: 1, bend: -0.25, headPitch: -0.45, sounds: ["ban-scream-near"], fade: 0.25 },
        { label: "hang", clip: "drift", duration: 2.5, timeScale: 0.3, hover: 0.45, headPitch: 0.2, fade: 1 },
      ],
    },
  },
]

/** Where the approved monster SFX are served from in dev (Vite serves the game folder as the root). */
export const soundUrl = (id: string, variant: string) => `${import.meta.env.BASE_URL}audio-lab/sfx/${id}/${variant}.mp3`
